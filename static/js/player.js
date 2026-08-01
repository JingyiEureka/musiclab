// Web Audio playback: the main track plus the inline preview clip.
import { state, getCurrentTime } from './state.js';
import { getWaveWidth, updatePlayheadUI } from './waveform.js';

export function togglePlay() {
    if (!state.audioBuffer) return;
    if (state.isPlaying) {
        pause();
    } else {
        play();
    }
}

// Preview the per-segment volume settings during playback by scheduling
// gain changes at the segment boundaries ahead of the playhead.
export function applyGainSchedule() {
    if (!state.gainNode || !state.audioCtx) return;
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
    stopPreviewPlayback();
    if (state.sourceNode) { state.sourceNode.disconnect(); state.sourceNode = null; }
    if (!state.gainNode || state.gainNode.context !== state.audioCtx) {
        state.gainNode = state.audioCtx.createGain();
        state.gainNode.connect(state.audioCtx.destination);
    }
    state.sourceNode = state.audioCtx.createBufferSource();
    state.sourceNode.buffer = state.audioBuffer;
    state.sourceNode.connect(state.gainNode);
    state.sourceNode.start(0, state.playOffset);
    state.sourceNode.onended = () => {
        if (state.isPlaying) {
            state.playOffset = 0;
            state.isPlaying = false;
            cancelAnimationFrame(state.animFrameId);
            updatePlayUI();
            updatePlayheadUI();
        }
    };
    state.playStartTime = state.audioCtx.currentTime - state.playOffset;
    state.isPlaying = true;
    applyGainSchedule();
    updatePlayUI();
    animate();
}

export function pause() {
    state.playOffset = Math.min(state.audioCtx.currentTime - state.playStartTime, state.totalDuration);
    if (state.sourceNode) { state.sourceNode.onended = null; state.sourceNode.stop(); state.sourceNode = null; }
    state.isPlaying = false;
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
        play();
    } else {
        updatePlayheadUI();
    }
}

// ── Preview clip playback ───────────────────────────────────────
export function stopPreviewPlayback() {
    if (state.previewSource) {
        state.previewSource.onended = null;
        state.previewSource.stop();
        state.previewSource = null;
    }
}

export async function playPreviewBytes(bytes) {
    await ensureAudioContext();
    const buffer = await state.audioCtx.decodeAudioData(bytes);
    // the user may have resumed the original track while the render ran
    if (state.isPlaying) pause();
    stopPreviewPlayback();
    state.previewSource = state.audioCtx.createBufferSource();
    state.previewSource.buffer = buffer;
    state.previewSource.connect(state.audioCtx.destination);
    state.previewSource.onended = () => { state.previewSource = null; };
    state.previewSource.start();
}
