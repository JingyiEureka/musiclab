// ── Configuration ──────────────────────────────────────────────
const CONFIG = {
    API_BASE_URL: window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '',
    POLLING_INTERVAL_MS: 2000,
    WAVEFORM_COLOR_PLAYED: '#d4a0b5',
    WAVEFORM_COLOR_UNPLAYED: '#666666',
    WAVEFORM_PX_PER_SEC: 13,
};

// ── Audio State ─────────────────────────────────────────────────
let audioFile = null;
let audioBuffer = null;
let totalDuration = 0;

// ── Player State ─────────────────────────────────────────────────
let audioCtx = null;
let sourceNode = null;
let isPlaying = false;
let playStartTime = 0;
let playOffset = 0;
let animFrameId = null;

// ── Segments State ─────────────────────────────────────────────
let segments = [];

// ── Helpers ─────────────────────────────────────────────────────
function formatTime(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const dec = Math.floor((s % 1) * 10);
    return `${m}:${sec.toString().padStart(2, '0')}.${dec}`;
}

// ── Duration Prediction ─────────────────────────────────────────
function showNotification(msg) {
    const el = document.getElementById('seg-notification');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

function getFinalTotalDuration() {
    if (!totalDuration) return 0;
    if (segments.length === 0) return totalDuration;
    let finalDur = 0, prevOrig = 0;
    segments.forEach(seg => {
        const origEnd = seg.endTime !== null ? seg.endTime : totalDuration;
        if (seg.speed > 0) finalDur += (origEnd - prevOrig) / seg.speed;
        prevOrig = origEnd;
    });
    return finalDur;
}

function updatePredictedDuration() {
    const el = document.getElementById('predicted-duration-text');
    if (el) el.textContent = formatTime(getFinalTotalDuration());
}

function getCurrentTime() {
    if (isPlaying) return audioCtx.currentTime - playStartTime;
    return playOffset;
}

// ── Waveform ────────────────────────────────────────────────────
function drawWaveform() {
    const canvas = document.getElementById('waveform-canvas');
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const dpr = window.devicePixelRatio || 1;
    const viewW = wrap.clientWidth;
    const waveW = Math.max(viewW, Math.ceil(totalDuration * CONFIG.WAVEFORM_PX_PER_SEC));
    const H = inner.clientHeight;
    canvas.width = waveW * dpr;
    canvas.height = H * dpr;
    canvas.style.width = waveW + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const data = audioBuffer.getChannelData(0);
    const mid = H / 2;
    const playheadX = totalDuration > 0
        ? (getCurrentTime() / totalDuration) * waveW
        : 0;

    ctx.clearRect(0, 0, waveW, H);

    const MAX_BARS = 15000;
    const barStep = waveW > MAX_BARS ? Math.ceil(waveW / MAX_BARS) : 1;
    const sampleStep = Math.ceil(data.length / waveW);

    for (let x = 0; x < waveW; x += barStep) {
        let min = 1, max = -1;
        const end = Math.min(data.length, (x + 1) * sampleStep);
        for (let j = x * sampleStep; j < end; j++) {
            const d = data[j] || 0;
            if (d < min) min = d;
            if (d > max) max = d;
        }
        const barH = Math.max(1, (max - min) * mid * 0.9);
        ctx.fillStyle = x <= playheadX
            ? CONFIG.WAVEFORM_COLOR_PLAYED
            : CONFIG.WAVEFORM_COLOR_UNPLAYED;
        ctx.fillRect(x, mid - barH, barStep, barH * 2);
    }
}

function updatePlayheadUI() {
    const t = getCurrentTime();
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const viewW = wrap.clientWidth;
    const waveW = Math.max(viewW, Math.ceil(totalDuration * CONFIG.WAVEFORM_PX_PER_SEC));
    const playheadX = totalDuration > 0 ? (t / totalDuration) * waveW : 0;

    document.getElementById('playhead').style.left = playheadX + 'px';
    const timeLabel = document.getElementById('player-current');
    timeLabel.textContent = formatTime(t);
    timeLabel.style.left = (playheadX - inner.scrollLeft) + 'px';
    document.getElementById('player-total').textContent = formatTime(totalDuration);

    const viewEnd = inner.scrollLeft + viewW;
    if (playheadX > viewEnd - 40) inner.scrollLeft = playheadX - viewW + 40;
    if (playheadX < inner.scrollLeft) inner.scrollLeft = playheadX;

    drawWaveform();
}

// ── Player ──────────────────────────────────────────────────────
function togglePlay() {
    if (!audioBuffer) return;
    if (isPlaying) {
        pause();
    } else {
        play();
    }
}

function play() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(audioCtx.destination);
    sourceNode.start(0, playOffset);
    sourceNode.onended = () => {
        if (isPlaying) {
            playOffset = 0;
            isPlaying = false;
            cancelAnimationFrame(animFrameId);
            updatePlayUI();
            updatePlayheadUI();
        }
    };
    playStartTime = audioCtx.currentTime - playOffset;
    isPlaying = true;
    updatePlayUI();
    animate();
}

function pause() {
    playOffset = Math.min(audioCtx.currentTime - playStartTime, totalDuration);
    if (sourceNode) { sourceNode.onended = null; sourceNode.stop(); sourceNode = null; }
    isPlaying = false;
    cancelAnimationFrame(animFrameId);
    updatePlayUI();
    updatePlayheadUI();
}

function updatePlayUI() {
    document.getElementById('play-btn').textContent = isPlaying ? 'Pause' : 'Play';
}

function animate() {
    updatePlayheadUI();
    if (isPlaying) animFrameId = requestAnimationFrame(animate);
}

function seekTo(e) {
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const rect = wrap.getBoundingClientRect();
    const viewW = wrap.clientWidth;
    const waveW = Math.max(viewW, Math.ceil(totalDuration * CONFIG.WAVEFORM_PX_PER_SEC));
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left + inner.scrollLeft) / waveW));
    playOffset = pct * totalDuration;
    if (isPlaying) {
        cancelAnimationFrame(animFrameId);
        if (sourceNode) { sourceNode.onended = null; sourceNode.stop(); sourceNode = null; }
        play();
    } else {
        updatePlayheadUI();
    }
}

// ── Segments ────────────────────────────────────────────────────
function isMuted(seg) {
    return seg.speed === 0;
}

function clampSpeed(mult) {
    return mult === 0 ? 0 : Math.max(0.25, Math.min(8.0, mult));
}

function renderSegments() {
    const container = document.getElementById('segments-container');
    container.innerHTML = '';

    if (segments.length > 0) {
        const header = document.createElement('div');
        header.className = 'seg-header';
        header.innerHTML = `
            <span class="seg-idx"></span>
            <span class="seg-start">start</span>
            <span class="seg-field">end</span>
            <span class="seg-field">speed (%)</span>
        `;
        container.appendChild(header);
    }

    let prevEnd = 0;
    segments.forEach((seg, i) => {
        const isLast = i === segments.length - 1;
        const muted = isMuted(seg);
        const displayStart = i === 0 ? 0 : prevEnd + 0.1;
        const row = document.createElement('div');
        row.className = 'segment-row' + (muted ? ' muted' : '');
        row.dataset.index = i;
        row.innerHTML = `
            <span class="seg-idx">[${i + 1}]</span>
            <span class="seg-start">${displayStart.toFixed(1)}</span>
            <span class="seg-field">
                ${isLast
                    ? `<span class="seg-end-static">${totalDuration.toFixed(1)}</span>`
                    : `<button class="stepper" data-kind="end" data-step="-0.1" data-index="${i}"
                        ${muted ? 'disabled' : ''}>&lt;</button>
                       <input type="number" class="seg-end" data-index="${i}"
                        value="${seg.endTime !== null ? seg.endTime.toFixed(1) : ''}" placeholder="end" step="0.1"
                        ${muted ? 'disabled' : ''} />
                       <button class="stepper" data-kind="end" data-step="0.1" data-index="${i}"
                        ${muted ? 'disabled' : ''}>&gt;</button>`
                }
            </span>
            <span class="seg-field">
                <button class="stepper" data-kind="speed" data-step="-5" data-index="${i}">&lt;</button>
                <input type="number" class="seg-speed" data-index="${i}"
                    value="${muted ? '0' : (seg.speed * 100).toFixed(0)}"
                    min="0" max="800" step="1" />
                <button class="stepper" data-kind="speed" data-step="5" data-index="${i}">&gt;</button>
            </span>
        `;
        container.appendChild(row);

        if (!isLast && !muted && !isMuted(segments[i + 1])) {
            const divider = document.createElement('div');
            divider.className = 'seg-merge-divider';
            divider.innerHTML = `<button class="btn-merge" data-index="${i}"
                title="Merge these two sections (remove split)">merge</button>`;
            container.appendChild(divider);
        }

        prevEnd = seg.endTime ?? totalDuration;
    });

    updatePredictedDuration();
}

function addSegment() {
    if (!totalDuration) {
        showNotification('Upload an audio file first.');
        return;
    }
    if (segments.length === 0) {
        segments = [{ endTime: null, speed: 1.0 }];
    }
    const t = parseFloat(Math.max(0, Math.min(totalDuration, getCurrentTime())).toFixed(1));
    let prevEnd = 0;
    for (let j = 0; j < segments.length; j++) {
        const end = segments[j].endTime ?? totalDuration;
        if (t < end) {
            if (t <= prevEnd + 0.5 || t >= end - 0.5) {
                showNotification('Split must be at least 0.5s from existing boundaries.');
                return;
            }
            segments.splice(j, 0, { endTime: t, speed: segments[j].speed });
            renderSegments();
            return;
        }
        prevEnd = end;
    }
    showNotification('Split must be at least 0.5s from existing boundaries.');
}

function mergeWithNext(i) {
    if (i >= segments.length - 1) return;
    segments[i].endTime = segments[i + 1].endTime;
    segments.splice(i + 1, 1);
    renderSegments();
}

function updateSegmentEnd(i, val) {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return;
    const prevBound = i === 0 ? 0 : (segments[i - 1].endTime ?? totalDuration);
    const nextBound = i >= segments.length - 1 ? totalDuration : (segments[i + 1].endTime ?? totalDuration);
    const minEnd = prevBound + 0.5;
    const maxEnd = nextBound - 0.5;
    if (minEnd > maxEnd) return;
    const clamped = Math.max(minEnd, Math.min(maxEnd, num));
    const rounded = parseFloat(clamped.toFixed(1));
    segments[i].endTime = rounded;
    renderSegments();
}

function updateSegmentSpeed(i, val) {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    segments[i].speed = clampSpeed(num / 100);
    updatePredictedDuration();
}

function commitSegmentSpeed(i) {
    const input = document.querySelector(`.seg-speed[data-index="${i}"]`);
    if (!input) return;
    const trimmed = input.value.trim();
    if (trimmed === '') {
        input.value = ((segments[i]?.speed ?? 1.0) * 100).toFixed(0);
        return;
    }
    let num = parseFloat(trimmed);
    if (isNaN(num)) num = 100;
    const row = input.closest('.segment-row');
    const wasMuted = row !== null && row.classList.contains('muted');
    const raw = num / 100;
    const speed = clampSpeed(raw);
    if (speed !== raw) {
        showNotification('Speed range: 25% to 800%');
    }
    segments[i].speed = speed;
    if (isMuted(segments[i]) !== wasMuted) {
        renderSegments();
    } else {
        input.value = speed === 0 ? '0' : (speed * 100).toFixed(0);
        updatePredictedDuration();
    }
}

// ── Export ──────────────────────────────────────────────────────
async function runAndExport() {
    const timestamps = segments.length > 0 ? segments.slice(0, -1).map(s => s.endTime ?? 0) : [];
    const speeds = segments.length > 0 ? segments.map(s => s.speed) : [1.0];
    const globalSpeed = 1.0;

    const btn = document.getElementById('export-btn');
    const banner = document.getElementById('status-banner');
    const statusText = document.getElementById('status-text');

    btn.disabled = true;
    if (!audioFile) {
        btn.disabled = false;
        alert('Upload an audio file first.');
        return;
    }
    if (segments.length > 0 && segments.every(isMuted)) {
        btn.disabled = false;
        showNotification('All sections are removed - nothing to export.');
        return;
    }

    clearTimeout(bannerHideTimer);
    banner.style.display = 'block';
    banner.className = 'proc';
    statusText.textContent = 'processing...';

    try {
        const fd = new FormData();
        fd.append('file', audioFile);
        fd.append('timestamps_str', JSON.stringify(timestamps));
        fd.append('speeds_str', JSON.stringify(speeds));
        fd.append('overall_factor', globalSpeed);

        const resp = await fetch(`${CONFIG.API_BASE_URL}/upload-audio/`, { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

        checkTaskProgress(data.task_id);
    } catch (e) {
        banner.className = 'fail';
        statusText.textContent = e.message.includes('fetch') || e.message.includes('Failed')
            ? 'error: cannot connect to server (run: uvicorn main:app --port 8000)'
            : `error: ${e.message}`;
        btn.disabled = false;
    }
}

let bannerHideTimer = null;

function checkTaskProgress(taskId) {
    const btn = document.getElementById('export-btn');
    const banner = document.getElementById('status-banner');
    const statusText = document.getElementById('status-text');

    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/check-status/${taskId}`);
            const data = await res.json();

            if (data.status === 'processing') {
                statusText.textContent = 'processing...';
            } else if (data.status === 'done') {
                clearInterval(interval);
                const fileUrl = CONFIG.API_BASE_URL + data.file_url;
                banner.className = 'ok';
                statusText.innerHTML = `done &mdash; <a href="${fileUrl}">download mp3</a>`;
                const a = document.createElement('a');
                a.href = fileUrl;
                a.download = `musiclab_${taskId}.mp3`;
                a.click();
                btn.disabled = false;
                clearTimeout(bannerHideTimer);
                bannerHideTimer = setTimeout(() => { banner.style.display = 'none'; }, 5000);
            } else if (data.status === 'failed') {
                clearInterval(interval);
                banner.className = 'fail';
                statusText.textContent = 'error: processing failed, check server logs';
                btn.disabled = false;
            }
        } catch (err) {
            clearInterval(interval);
            banner.className = 'fail';
            statusText.textContent = 'error: ' + err.message;
            btn.disabled = false;
        }
    }, CONFIG.POLLING_INTERVAL_MS);
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    segments = [];
    renderSegments();

    // Upload zone
    const zone = document.getElementById('upload-zone');
    zone.addEventListener('click', () => document.getElementById('audio-file-input').click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    document.getElementById('audio-file-input').addEventListener('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
    });

    // Player
    document.getElementById('play-btn').addEventListener('click', togglePlay);
    document.getElementById('waveform-wrap').addEventListener('click', seekTo);
    document.addEventListener('keydown', e => {
        if (e.code === 'Space' && document.activeElement === document.body) {
            e.preventDefault();
            togglePlay();
        }
        if ((e.code === 'Enter' || e.code === 'NumpadEnter') && document.activeElement === document.body) {
            e.preventDefault();
            addSegment();
        }
    });

    // Add segment
    document.getElementById('btn-add-segment').addEventListener('click', addSegment);

    // Export
    document.getElementById('export-btn').addEventListener('click', runAndExport);

    // Segment events (delegation)
    const segContainer = document.getElementById('segments-container');
    segContainer.addEventListener('change', e => {
        if (e.target.classList.contains('seg-end')) {
            updateSegmentEnd(parseInt(e.target.dataset.index, 10), e.target.value);
        }
        if (e.target.classList.contains('seg-speed')) {
            commitSegmentSpeed(parseInt(e.target.dataset.index, 10));
        }
    });
    segContainer.addEventListener('input', e => {
        if (e.target.classList.contains('seg-speed')) {
            updateSegmentSpeed(parseInt(e.target.dataset.index, 10), e.target.value);
        }
    });
    segContainer.addEventListener('click', e => {
        const merge = e.target.closest('.btn-merge');
        if (merge) {
            mergeWithNext(parseInt(merge.dataset.index, 10));
            return;
        }
        const btn = e.target.closest('.stepper');
        if (!btn || btn.disabled) return;
        const i = parseInt(btn.dataset.index, 10);
        const input = btn.parentElement.querySelector('input');
        if (!input) return;
        const step = parseFloat(btn.dataset.step);
        const cur = parseFloat(input.value);
        if (btn.dataset.kind === 'speed') {
            const base = isNaN(cur) ? (segments[i].speed * 100) : cur;
            if (base === 0 && step < 0) return;
            input.value = Math.round(base + step);
            commitSegmentSpeed(i);
        } else {
            const base = isNaN(cur) ? (segments[i].endTime ?? totalDuration) : cur;
            updateSegmentEnd(i, (base + step).toFixed(1));
        }
    });

    // Header greeting with typewriter effect
    const tipEl = document.getElementById('tip-text');
    const typeSpeed = 150;

    function typeWriter(text, i) {
        if (i < text.length) {
            tipEl.textContent = text.slice(0, i + 1);
            setTimeout(() => typeWriter(text, i + 1), typeSpeed);
        }
    }

    typeWriter('Welcome to MusicLab!', 0);

    // ── File Handling ────────────────────────────────────────────────
    async function handleFile(file) {
        let ctx;
        try {
            audioFile = file;
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
            if (audioCtx) audioCtx.close();
            sourceNode = null;
            audioCtx = ctx;
            totalDuration = audioBuffer.duration;
            playOffset = 0;
            isPlaying = false;
            updatePlayUI();

            document.getElementById('upload-zone').style.display = 'none';
            document.getElementById('player-section').style.display = 'block';
            document.getElementById('sections-block').style.display = 'block';
            document.getElementById('output-block').style.display = 'block';
            document.getElementById('player-filename').textContent = '— ' + file.name;
            document.getElementById('player-total').textContent = formatTime(totalDuration);

            drawWaveform();
            updatePlayheadUI();
            segments = [{ endTime: null, speed: 1.0 }];
            renderSegments();
        } catch (e) {
            if (ctx) ctx.close();
            const zone = document.getElementById('upload-zone');
            if (zone) zone.style.display = 'block';
            const section = document.getElementById('player-section');
            if (section) section.style.display = 'none';
            document.getElementById('sections-block').style.display = 'none';
            document.getElementById('output-block').style.display = 'none';
            audioFile = null;
            audioBuffer = null;
            totalDuration = 0;
            alert('Failed to load audio file: ' + e.message);
        }
    }
});
