// Preview = a real export of a short window around the playhead, through the
// exact same server pipeline, played inline. Same engine, same sound.
import { CONFIG } from './config.js';
import { state, getCurrentTime } from './state.js';
import { setBusy, showNotification } from './ui.js';
import { pause, playPreviewBytes } from './player.js';
import { submitJob, pollStatus, networkErrorMessage } from './export.js';

const PREVIEW_SPAN = 16; // seconds

// Encode a [t0, t1) slice of an AudioBuffer as a 16-bit PCM WAV blob.
function audioBufferToWav(buffer, t0, t1) {
    const sr = buffer.sampleRate;
    const start = Math.floor(t0 * sr);
    const end = Math.min(buffer.length, Math.ceil(t1 * sr));
    const frames = end - start;
    const channels = Math.min(2, buffer.numberOfChannels);
    const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) data.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    data.setUint32(4, 36 + frames * channels * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true); // PCM
    data.setUint16(22, channels, true);
    data.setUint32(24, sr, true);
    data.setUint32(28, sr * channels * 2, true);
    data.setUint16(32, channels * 2, true);
    data.setUint16(34, 16, true);
    writeStr(36, 'data');
    data.setUint32(40, frames * channels * 2, true);
    const chans = [];
    for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const v = Math.max(-1, Math.min(1, chans[c][start + i]));
            data.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
            off += 2;
        }
    }
    return new Blob([data.buffer], { type: 'audio/wav' });
}

// A PREVIEW_SPAN window centred on t, with each edge snapped outward to a
// nearby section boundary: full sections preview identically to the export
// (the RMS gain compensation in the backend is computed per section).
function previewWindow(t) {
    let w0 = Math.max(0, t - PREVIEW_SPAN / 2);
    let w1 = Math.min(state.totalDuration, w0 + PREVIEW_SPAN);
    let start = 0;
    state.segments.forEach(seg => {
        const end = seg.endTime ?? state.totalDuration;
        if (w0 > start && w0 < end && w0 - start <= 4) w0 = start;
        if (w1 > start && w1 < end && end - w1 <= 4) w1 = end;
        start = end;
    });
    return [w0, w1];
}

// Map the sections overlapping [w0, w1) to slice-relative arrays in the same
// shape runAndExport builds for the full file.
function buildWindowParams(w0, w1) {
    const timestamps = [], speeds = [], volumes = [];
    let start = 0;
    state.segments.forEach(seg => {
        const end = seg.endTime ?? state.totalDuration;
        if (end > w0 && start < w1) {
            speeds.push(seg.skip ? 0 : seg.speed);
            volumes.push(seg.volume);
            if (end < w1) timestamps.push(end - w0);
        }
        start = end;
    });
    return { timestamps, speeds, volumes };
}

// setBusy owns the button's disabled state; only the label changes here
function resetPreviewUI() {
    document.getElementById('preview-btn').textContent = '[ Preview ]';
    setBusy(false);
}

export async function runPreview() {
    if (!state.audioBuffer || state.isBusy || state.sessionExpired) return;
    // resume inside the click gesture so playback is unlocked on iOS
    if (state.audioCtx && state.audioCtx.state !== 'running') state.audioCtx.resume().catch(() => {});
    const [w0, w1] = previewWindow(getCurrentTime());
    const params = buildWindowParams(w0, w1);
    if (params.speeds.length === 0 || params.speeds.every(s => s === 0)) {
        showNotification('All sections in the preview window are skipped.');
        return;
    }
    if (state.isPlaying) pause();
    document.getElementById('preview-btn').textContent = '[ Preview... ]';
    setBusy(true);
    try {
        const wav = new File([audioBufferToWav(state.audioBuffer, w0, w1)], 'preview.wav', { type: 'audio/wav' });
        const taskId = await submitJob(wav, params.timestamps, params.speeds, params.volumes);
        pollStatus(taskId, {
            onDone: async d => {
                try {
                    const mp3 = await fetch(CONFIG.API_BASE_URL + d.file_url);
                    await playPreviewBytes(await mp3.arrayBuffer());
                } catch (e) {
                    showNotification('Preview failed - please try again.');
                }
                resetPreviewUI();
            },
            onFail: msg => {
                showNotification(msg);
                resetPreviewUI();
            },
        });
    } catch (e) {
        showNotification(networkErrorMessage(e));
        resetPreviewUI();
    }
}
