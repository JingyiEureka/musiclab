// Canvas waveform: a pre-rendered bar cache plus the per-frame playhead draw.
import { CONFIG } from './config.js';
import { state, getCurrentTime } from './state.js';
import { formatTime } from './ui.js';

export function getWaveWidth() {
    const viewW = document.getElementById('waveform-wrap').clientWidth;
    return Math.max(viewW, Math.ceil(state.totalDuration * CONFIG.WAVEFORM_PX_PER_SEC * state.waveformZoom));
}

// Bar colours come from the stylesheet (--wave-played, --wave-unplayed) so the
// canvas follows the theme instead of keeping its own copy of the palette.
function cssColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Pre-rendered waveform bars; rebuilt only when zoom, size, or file changes
// so the per-frame playhead redraw is a cheap copy instead of a full rescan.
let waveformCache = null;

function buildWaveformCache(waveW, backingW, H, dpr) {
    const off = document.createElement('canvas');
    off.width = backingW;
    off.height = H * dpr;
    const ctx = off.getContext('2d');
    ctx.setTransform(backingW / waveW, 0, 0, dpr, 0, 0);

    const data = state.audioBuffer.getChannelData(0);
    const mid = H / 2;
    const MAX_BARS = 15000;
    const barStep = waveW > MAX_BARS ? Math.ceil(waveW / MAX_BARS) : 1;
    const sampleStep = Math.ceil(data.length / waveW);

    ctx.fillStyle = cssColor('--wave-unplayed');
    for (let x = 0; x < waveW; x += barStep) {
        let min = 1, max = -1;
        const end = Math.min(data.length, (x + barStep) * sampleStep);
        for (let j = x * sampleStep; j < end; j++) {
            const d = data[j] || 0;
            if (d < min) min = d;
            if (d > max) max = d;
        }
        const barH = Math.max(1, (max - min) * mid * 0.9);
        ctx.fillRect(x, mid - barH, barStep, barH * 2);
    }
    waveformCache = { canvas: off, waveW, height: H * dpr, buffer: state.audioBuffer, played: cssColor('--wave-played') };
}

export function drawWaveform() {
    const canvas = document.getElementById('waveform-canvas');
    const inner = document.getElementById('waveform-inner');
    const dpr = window.devicePixelRatio || 1;
    const waveW = getWaveWidth();
    const H = inner.clientHeight;
    // clamp the backing store: iOS Safari silently blanks very wide canvases
    const backingW = Math.min(waveW * dpr, 16384);

    if (!waveformCache || waveformCache.waveW !== waveW
        || waveformCache.height !== H * dpr || waveformCache.buffer !== state.audioBuffer) {
        buildWaveformCache(waveW, backingW, H, dpr);
    }
    // resizing a canvas clears and reallocates it, so only do it on change
    if (canvas.width !== backingW) canvas.width = backingW;
    if (canvas.height !== H * dpr) canvas.height = H * dpr;
    canvas.style.width = waveW + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(waveformCache.canvas, 0, 0);

    // recolor the bars behind the playhead
    const playheadX = state.totalDuration > 0 ? (getCurrentTime() / state.totalDuration) * waveW : 0;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = waveformCache.played;
    ctx.fillRect(0, 0, playheadX * (backingW / waveW), canvas.height);
    ctx.restore();
}

export function updatePlayheadUI() {
    const t = getCurrentTime();
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const viewW = wrap.clientWidth;
    const waveW = getWaveWidth();
    const playheadX = state.totalDuration > 0 ? (t / state.totalDuration) * waveW : 0;

    document.getElementById('playhead').style.left = playheadX + 'px';
    const timeLabel = document.getElementById('player-current');
    timeLabel.textContent = formatTime(t);
    timeLabel.style.left = (playheadX - inner.scrollLeft) + 'px';
    document.getElementById('player-total').textContent = formatTime(state.totalDuration);

    const viewEnd = inner.scrollLeft + viewW;
    if (playheadX > viewEnd - 40) inner.scrollLeft = playheadX - viewW + 40;
    if (playheadX < inner.scrollLeft) inner.scrollLeft = playheadX;

    drawWaveform();
}
