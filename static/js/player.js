// Web Audio playback. One path: the transport plays the rendered timeline.
//
// The transport plays the rendered timeline whenever a speed or skip is set, so
// what you hear matches the export (ADR 0009). Volume-only edits stay on the raw
// buffer with a live gain schedule, which is instant and already accurate.
import { state, getCurrentTime } from './state.js';
import { getWaveWidth, updatePlayheadUI } from './waveform.js';
import { needsRender, sourceToOutput, fadeCurve, curvePoints } from './stretch.js';
import { SEAM_DEFAULT } from './config.js';
import { getTimeline } from './timeline.js';
import { showNotification, formatTime } from './ui.js';

// Bumped by anything that supersedes an in-flight render, so a slow render
// cannot start playing after the user paused or seeked away.
let playToken = 0;

// ?timing=1 keeps every figure on screen and reports the cases that normally
// stay silent, so a render can be timed on a phone with no console. Off by
// default: during ordinary listening these lines are noise.
const TIMING = new URLSearchParams(location.search).has('timing');

// A cache hit returns in about no time, so a figure worth reporting means work
// actually happened. Without the flag, only a real render is announced, and
// only to explain a wait the user already noticed.
function reportRenderTime(ms, map, buffer) {
    const rendered = ms > 200;
    if (!rendered && !TIMING) return;
    const speed = map.outputDuration / (ms / 1000);
    showNotification(
        rendered
            ? `rendered ${formatTime(map.outputDuration)} in ${(ms / 1000).toFixed(2)}s`
              + ` (${speed.toFixed(0)}x realtime)${TIMING ? ', ' + memoryNote(buffer) : ''}`
            : `cache hit, no render (${ms.toFixed(0)}ms)`,
        TIMING,
    );
}

// iOS has no memory API, and a tab killed for running out leaves no trace, so
// the sizes are reported instead: they say how close a file is to the ceiling
// rather than only whether this one survived. Export is the peak, holding the
// source and the render at once before the encoder adds its output.
export function memoryNote(rendered) {
    const mb = b => (b.length * Math.min(2, b.numberOfChannels) * 4) / 1048576;
    const src = state.audioBuffer ? mb(state.audioBuffer) : 0;
    const out = rendered ? mb(rendered) : 0;
    return `${(src + out).toFixed(0)} MB live (source ${src.toFixed(0)} + render ${out.toFixed(0)})`;
}

export function togglePlay() {
    if (!state.audioBuffer) return;
    if (state.isPlaying) {
        pause();
    } else {
        play();
    }
}

// Hear the per-segment volume settings during raw playback by scheduling gain
// changes at the segment boundaries ahead of the playhead. Not used once the
// timeline is rendered, since the render already carries volume.
// Half-width of the ramp at the boundary ending section j, shortened so two
// adjacent ramps cannot overlap. Mirrors clampedHalf() in stretch.js; this path
// only runs unstretched with nothing skipped, so source time is output time.
function rampHalf(segs, j) {
    const wanted = ((segs[j].seam ?? SEAM_DEFAULT).ms ?? 0) / 2000;
    if (wanted <= 0) return 0;
    const at = segs[j].endTime;
    const prev = j > 0 ? (segs[j - 1].endTime ?? 0) : 0;
    const next = segs[j + 1].endTime ?? state.totalDuration;
    return Math.max(0, Math.min(wanted, (at - prev) / 2, (next - at) / 2));
}

export function applyGainSchedule() {
    if (!state.gainNode || !state.audioCtx) return;
    // rendered audio already has volume baked in; applying it again would square it
    if (state.playMap) return;
    const now = state.audioCtx.currentTime;
    const t = getCurrentTime();
    const segs = state.segments;
    const gain = state.gainNode.gain;
    gain.cancelScheduledValues(now);
    if (segs.length === 0) {
        gain.setValueAtTime(1, now);
        return;
    }
    const vol = s => s.volume ?? 1;
    let idx = segs.findIndex(s => t < (s.endTime ?? state.totalDuration));
    if (idx === -1) idx = segs.length - 1;
    gain.setValueAtTime(vol(segs[idx]), now);

    for (let j = idx; j < segs.length - 1; j++) {
        const boundary = segs[j].endTime;
        if (boundary === null || boundary <= t) continue;
        const from = vol(segs[j]);
        const to = vol(segs[j + 1]);
        if (from === to) continue;
        const at = now + boundary - t;
        // Ramp across the boundary with the seam the user configured, matching
        // what the render bakes in. A step here would be the very click seams
        // exist to prevent, and would ignore the seam control (step 3 plan 2.1).
        const half = rampHalf(segs, j);
        const start = Math.max(now, at - half);
        const dur = at + half - start;
        if (dur <= 0) {
            gain.setValueAtTime(to, at);
            continue;
        }
        // Truncated when the playhead already sits inside the ramp. Safe: the
        // curve opens at `from`, which is the value currently scheduled.
        gain.setValueCurveAtTime(
            fadeCurve((segs[j].seam ?? SEAM_DEFAULT).curve, curvePoints(dur), from, to),
            start, dur,
        );
    }
}

// A backgrounded tab (especially iOS Safari) can leave the context
// suspended, interrupted, or fully closed; recover from all three so
// playback still works when the user comes back.
export async function ensureAudioContext() {
    if (!state.audioCtx || state.audioCtx.state === 'closed') {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        state.gainNode = null;
    }
    if (state.audioCtx.state !== 'running') {
        try { await state.audioCtx.resume(); } catch (e) { /* resume needs a gesture; ignore */ }
    }
}

export async function play() {
    await ensureAudioContext();
    if (state.sourceNode) { state.sourceNode.disconnect(); state.sourceNode = null; }
    if (!state.gainNode || state.gainNode.context !== state.audioCtx) {
        state.gainNode = state.audioCtx.createGain();
        state.gainNode.connect(state.audioCtx.destination);
    }

    let buffer = state.audioBuffer;
    let map = null;
    let offset = state.playOffset;
    const token = ++playToken;

    if (!needsRender(state.segments)) {
        if (TIMING) showNotification('no render: volume-only edit, playing the source', true);
    } else {
        document.getElementById('play-btn').textContent = '[ Rendering... ]';
        const startedAt = performance.now();
        try {
            const t = await getTimeline();
            if (token !== playToken) return; // paused, seeked, or replaced meanwhile
            buffer = t.buffer;
            map = t.map;
            offset = sourceToOutput(map, state.playOffset);
            reportRenderTime(performance.now() - startedAt, map, buffer);
        } catch (e) {
            if (token === playToken) {
                if (e && e.code === 'all-skipped') {
                    showNotification('Nothing to play - all sections are skipped.');
                } else {
                    // Anything else is a real fault. Report it verbatim and keep
                    // it on screen: on a phone this message is the only evidence.
                    console.error('timeline render failed', e);
                    showNotification(`Could not render: ${(e && e.message) || e}`, true);
                }
                updatePlayUI();
            }
            return;
        }
    }

    state.playMap = map;
    state.sourceNode = state.audioCtx.createBufferSource();
    state.sourceNode.buffer = buffer;
    state.sourceNode.connect(state.gainNode);
    state.sourceNode.start(0, Math.max(0, Math.min(offset, buffer.duration)));
    state.sourceNode.onended = () => {
        if (state.isPlaying) {
            state.playOffset = 0;
            state.isPlaying = false;
            state.playMap = null;
            cancelAnimationFrame(state.animFrameId);
            updatePlayUI();
            updatePlayheadUI();
        }
    };
    if (map) {
        state.playOutputStart = state.audioCtx.currentTime - offset;
        // the rendered buffer carries volume and seams already
        state.gainNode.gain.cancelScheduledValues(state.audioCtx.currentTime);
        state.gainNode.gain.setValueAtTime(1, state.audioCtx.currentTime);
    } else {
        state.playStartTime = state.audioCtx.currentTime - offset;
    }
    state.isPlaying = true;
    applyGainSchedule();
    updatePlayUI();
    animate();
}

export function pause() {
    // getCurrentTime maps rendered output time back to source time
    state.playOffset = Math.max(0, Math.min(getCurrentTime(), state.totalDuration));
    playToken++; // abandon any render still in flight
    if (state.sourceNode) { state.sourceNode.onended = null; state.sourceNode.stop(); state.sourceNode = null; }
    state.isPlaying = false;
    state.playMap = null;
    cancelAnimationFrame(state.animFrameId);
    updatePlayUI();
    updatePlayheadUI();
}

// Skip-to-start: like the |< control in most players, jump to 0 and play.
export function playFromStart() {
    if (!state.audioBuffer) return;
    if (state.isPlaying) {
        cancelAnimationFrame(state.animFrameId);
        if (state.sourceNode) { state.sourceNode.onended = null; state.sourceNode.stop(); state.sourceNode = null; }
        state.isPlaying = false;
        state.playMap = null;
    }
    state.playOffset = 0;
    play();
}

export function updatePlayUI() {
    document.getElementById('play-btn').textContent = state.isPlaying ? '[ Pause ]' : '[ Play ]';
}

function animate() {
    updatePlayheadUI();
    if (state.isPlaying) state.animFrameId = requestAnimationFrame(animate);
}

export function seekTo(e) {
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const rect = wrap.getBoundingClientRect();
    const waveW = getWaveWidth();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left + inner.scrollLeft) / waveW));
    state.playOffset = pct * state.totalDuration;
    if (state.isPlaying) {
        cancelAnimationFrame(state.animFrameId);
        if (state.sourceNode) { state.sourceNode.onended = null; state.sourceNode.stop(); state.sourceNode = null; }
        state.isPlaying = false;
        state.playMap = null;
        play();
    } else {
        updatePlayheadUI();
    }
}
