// Web Audio playback. One path: the transport plays the rendered timeline.
//
// The transport plays the rendered timeline whenever a speed or skip is set, so
// what you hear matches the export (ADR 0009). Volume-only edits stay on the raw
// buffer with a live gain schedule, which is instant and already accurate.
import { state, getCurrentTime } from './state.js';
import { getWaveWidth, updatePlayheadUI } from './waveform.js';
import { needsRender, sourceToOutput } from './stretch.js';
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
function reportRenderTime(ms, map) {
    const rendered = ms > 200;
    if (!rendered && !TIMING) return;
    const speed = map.outputDuration / (ms / 1000);
    showNotification(
        rendered
            ? `rendered ${formatTime(map.outputDuration)} in ${(ms / 1000).toFixed(2)}s`
              + ` (${speed.toFixed(0)}x realtime)`
            : `cache hit, no render (${ms.toFixed(0)}ms)`,
        TIMING,
    );
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
export function applyGainSchedule() {
    if (!state.gainNode || !state.audioCtx) return;
    // rendered audio already has volume baked in; applying it again would square it
    if (state.playMap) return;
    const now = state.audioCtx.currentTime;
    const t = getCurrentTime();
    const segments = state.segments;
    state.gainNode.gain.cancelScheduledValues(now);
    if (segments.length === 0) {
        state.gainNode.gain.setValueAtTime(1, now);
        return;
    }
    let idx = segments.findIndex(s => t < (s.endTime ?? state.totalDuration));
    if (idx === -1) idx = segments.length - 1;
    state.gainNode.gain.setValueAtTime(segments[idx].volume ?? 1, now);
    for (let j = idx; j < segments.length - 1; j++) {
        const boundary = segments[j].endTime;
        if (boundary === null || boundary <= t) continue;
        state.gainNode.gain.setValueAtTime(segments[j + 1].volume ?? 1, now + boundary - t);
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
            reportRenderTime(performance.now() - startedAt, map);
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
