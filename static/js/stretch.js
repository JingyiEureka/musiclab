// Time stretching in the browser: Signalsmith Stretch (WASM) driven from an
// OfflineAudioContext.
//
// The library only ships an AudioWorkletNode factory, so there is no plain
// "process this array" entry point - offline renders run the worklet inside an
// OfflineAudioContext instead of a Web Worker.
//
// Its `rate` is source seconds per output second, which is the same convention
// as segment.speed, so speeds are passed through without inversion.
//
// The whole timeline goes through one node as a single time map. That keeps the
// stream continuous, so a rate change with nothing removed between needs no
// crossfade, and the stretcher's window ramp-in happens once instead of at
// every boundary. Loading the map needs the setTimeMap patch in
// static/vendor/PATCHES.md.
import { SEAM_DEFAULT } from './config.js';

// PRESET_EXPORT is what both playback and export use, so the two cannot
// diverge (ADR 0010). PRESET_PREVIEW is kept for the dev harness and as the
// escape hatch if mobile render times force a cheaper playback path.
export const PRESET_PREVIEW = 'cheaper';
export const PRESET_EXPORT = 'default';

// Loaded on first render rather than at import time: the vendored module is
// 111 KB and most page loads never render anything.
let stretchFactory = null;
async function loadFactory() {
    if (!stretchFactory) {
        stretchFactory = (await import('../vendor/signalsmith-stretch.mjs')).default;
    }
    return stretchFactory;
}

// Enough points that setValueCurveAtTime's linear interpolation is inaudible,
// without allocating a per-sample array for a long fade.
const CURVE_POINTS_PER_SEC = 2000;
const CURVE_MAX_POINTS = 8192;

export function stretchedDuration(seconds, rate) {
    return rate > 0 ? seconds / rate : 0;
}

// ── curve shapes ────────────────────────────────────────────────
// p runs 0..1; the result runs `from`..`to`.
function shapeGain(kind, from, to, p) {
    if (kind === 'equalPower') {
        // constant-power interpolation: dips less than linear at the midpoint
        return Math.sqrt(from * from * (1 - p) + to * to * p);
    }
    if (kind === 'smooth') {
        const s = (1 - Math.cos(Math.PI * p)) / 2;
        return from + (to - from) * s;
    }
    return from + (to - from) * p;
}

function curvePoints(seconds) {
    return Math.max(2, Math.min(CURVE_MAX_POINTS, Math.round(seconds * CURVE_POINTS_PER_SEC)));
}

function fadeCurve(kind, points, from, to) {
    const c = new Float32Array(points);
    const last = points - 1;
    for (let i = 0; i < points; i++) c[i] = shapeGain(kind, from, to, i / last);
    return c;
}

// 1 at the edges, 0 at the centre: hides the discontinuity at a cut.
function dipCurve(kind, points) {
    const c = new Float32Array(points);
    const last = points - 1;
    for (let i = 0; i < points; i++) {
        const d = Math.abs(i / last - 0.5) * 2;
        c[i] = shapeGain(kind, 1, 0, 1 - d);
    }
    return c;
}

// ── time map ────────────────────────────────────────────────────
// Pure function: sections in, breakpoints out. No audio involved, so it is
// cheap to test directly.
export function buildTimeMap(segments, totalDuration) {
    const list = segments && segments.length
        ? segments
        : [{ endTime: null, speed: 1, volume: 1, skip: false, seam: SEAM_DEFAULT }];

    // Skip means the section is removed, so the output gets shorter. It is an
    // input jump, not `active: false` - that would emit silence and leave the
    // output the same length.
    const kept = [];
    let sourceStart = 0;
    list.forEach(seg => {
        const end = seg.endTime ?? totalDuration;
        if (!seg.skip && end > sourceStart) {
            kept.push({
                start: sourceStart,
                end,
                rate: seg.speed ?? 1,
                volume: seg.volume ?? 1,
                seam: seg.seam ?? SEAM_DEFAULT,
            });
        }
        sourceStart = end;
    });
    if (kept.length === 0) throw new Error('all sections are skipped, nothing to render');

    const breakpoints = [];
    const cuts = [];
    const volumeRamps = [];
    let out = 0;
    kept.forEach((k, i) => {
        breakpoints.push({ output: out, input: k.start, rate: k.rate, volume: k.volume, active: true });
        if (i > 0) {
            const prev = kept[i - 1];
            // the seam belongs to the last kept section before the boundary
            const seam = prev.seam ?? SEAM_DEFAULT;
            if (Math.abs(k.start - prev.end) > 1e-6) cuts.push({ at: i, output: out, seam });
            if (Math.abs(k.volume - prev.volume) > 1e-6) {
                volumeRamps.push({ at: i, output: out, from: prev.volume, to: k.volume, seam });
            }
        }
        out += (k.end - k.start) / k.rate;
    });

    return { breakpoints, cuts, volumeRamps, outputDuration: out, sections: kept };
}

// ── time domain mapping ─────────────────────────────────────────
// The waveform, the section lane and every boundary are in source time; a
// rendered timeline is in output time. These two convert between them using the
// same breakpoints the render used.

// Output -> source. Keeps the playhead on the waveform while rendered audio plays.
export function outputToSource(map, tOut) {
    const bps = map.breakpoints;
    let i = 0;
    while (i + 1 < bps.length && bps[i + 1].output <= tOut) i++;
    const bp = bps[i];
    return bp.input + (tOut - bp.output) * bp.rate;
}

// Source -> output, for turning a seek position into a start offset. A source
// time inside a skipped region maps to the cut, so seeking into removed material
// lands where playback resumes.
export function sourceToOutput(map, tSource) {
    const secs = map.sections;
    const bps = map.breakpoints;
    for (let i = 0; i < secs.length; i++) {
        if (tSource < secs[i].start) return bps[i].output;
        if (tSource <= secs[i].end) {
            return bps[i].output + (tSource - secs[i].start) / secs[i].rate;
        }
    }
    return map.outputDuration;
}

// Volume alone is handled live by the player's gain schedule, so a render is
// only needed once a speed or a skip is in play.
export function needsRender(segments) {
    return (segments || []).some(s => s.skip || (s.speed ?? 1) !== 1);
}

// Half-width of a fade at boundary `at`, in seconds, shortened so two adjacent
// fades cannot overlap and neither runs past the ends of the render.
function clampedHalf(map, at, ms) {
    const wanted = (ms ?? 0) / 2000;
    if (wanted <= 0) return 0;
    const t = map.breakpoints[at].output;
    const prev = map.breakpoints[at - 1].output;
    const next = at + 1 < map.breakpoints.length
        ? map.breakpoints[at + 1].output
        : map.outputDuration;
    return Math.max(0, Math.min(wanted, (t - prev) / 2, (next - t) / 2));
}

// ── automation ──────────────────────────────────────────────────
function applyVolume(param, map) {
    param.setValueAtTime(map.breakpoints[0].volume, 0);
    map.volumeRamps.forEach(r => {
        const half = clampedHalf(map, r.at, r.seam.ms);
        if (half <= 0) {
            param.setValueAtTime(r.to, r.output);
            return;
        }
        const dur = half * 2;
        param.setValueCurveAtTime(
            fadeCurve(r.seam.curve, curvePoints(dur), r.from, r.to),
            r.output - half,
            dur,
        );
    });
}

function applySeamDips(param, map) {
    param.setValueAtTime(1, 0);
    map.cuts.forEach(c => {
        const half = clampedHalf(map, c.at, c.seam.ms);
        if (half <= 0) return; // 0 ms means no dip, and the cut clicks
        const dur = half * 2;
        param.setValueCurveAtTime(
            dipCurve(c.seam.curve, curvePoints(dur)),
            c.output - half,
            dur,
        );
    });
}

// The stretcher overshoots peaks (measured up to +1.6 dB), so a source near
// 0 dBFS would clip. Scale by the measured peak instead of hard clipping.
export function applyPeakSafety(buffer) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
            const a = Math.abs(d[i]);
            if (a > peak) peak = a;
        }
    }
    if (peak <= 1 || peak === 0) return buffer;
    const g = 1 / peak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return buffer;
}

// Copy [t0, t1) into a standalone AudioBuffer, so a range can be rendered with
// the same code path as the whole timeline.
export function sliceBuffer(buffer, t0, t1) {
    const sr = buffer.sampleRate;
    const start = Math.max(0, Math.floor(t0 * sr));
    const end = Math.min(buffer.length, Math.ceil(t1 * sr));
    const frames = Math.max(1, end - start);
    const out = new AudioBuffer({
        length: frames,
        numberOfChannels: buffer.numberOfChannels,
        sampleRate: sr,
    });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        out.copyToChannel(buffer.getChannelData(c).subarray(start, start + frames), c);
    }
    return out;
}

function copyChannels(buffer, channels) {
    const out = [];
    for (let c = 0; c < channels; c++) {
        // slice() so the transfer below detaches our copy, not the source buffer
        out.push(buffer.getChannelData(c % buffer.numberOfChannels).slice());
    }
    return out;
}

// ── render ──────────────────────────────────────────────────────
export async function renderTimeline(buffer, segments, {
    preset = PRESET_EXPORT,
    peakSafe = true,
} = {}) {
    const map = buildTimeMap(segments, buffer.duration);
    const channels = Math.min(2, buffer.numberOfChannels);
    const frames = Math.ceil(map.outputDuration * buffer.sampleRate);
    if (frames <= 0) throw new Error('nothing to render');

    const ctx = new OfflineAudioContext(channels, frames, buffer.sampleRate);
    const createNode = await loadFactory();
    const node = await createNode(ctx, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
    });
    await node.configure({ preset });

    const chans = copyChannels(buffer, channels);
    await node.addBuffers(chans, chans.map(a => a.buffer));
    const loaded = await node.setTimeMap(map.breakpoints);
    if (loaded !== map.breakpoints.length) {
        throw new Error(`time map load failed: ${loaded} of ${map.breakpoints.length}`);
    }

    // Two gain stages: overlapping automation on one AudioParam is where
    // setValueCurveAtTime and setValueAtTime interact badly.
    const volumeGain = ctx.createGain();
    const seamGain = ctx.createGain();
    applyVolume(volumeGain.gain, map);
    applySeamDips(seamGain.gain, map);
    node.connect(volumeGain).connect(seamGain).connect(ctx.destination);

    const rendered = await ctx.startRendering();
    return peakSafe ? applyPeakSafety(rendered) : rendered;
}

// Single constant rate - the step 1 primitive, now a thin wrapper.
export async function renderStretched(buffer, rate, opts = {}) {
    if (rate <= 0) throw new Error('rate must be greater than 0');
    return renderTimeline(
        buffer,
        [{ endTime: null, speed: rate, volume: 1, skip: false, seam: SEAM_DEFAULT }],
        opts,
    );
}
