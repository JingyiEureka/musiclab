// ── Configuration ──────────────────────────────────────────────
const CONFIG = {
    API_BASE_URL: 'http://127.0.0.1:8000',
    POLLING_INTERVAL_MS: 2000,
    CROSSFADE_MS: 100,
    SEG_COLORS: [
        'linear-gradient(135deg, #7c3aed, #6d28d9)',
        'linear-gradient(135deg, #2563eb, #1d4ed8)',
        'linear-gradient(135deg, #059669, #047857)',
        'linear-gradient(135deg, #d97706, #b45309)',
        'linear-gradient(135deg, #db2777, #be185d)',
        'linear-gradient(135deg, #0891b2, #0e7490)',
        'linear-gradient(135deg, #7c3aed, #db2777)',
    ],
    SEG_LABELS: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
};

// ── Audio Player State ─────────────────────────────────────────
const Player = {
    buffer: null,
    ctx: null,
    source: null,
    isPlaying: false,
    startTimestamp: 0,
    startOffset: 0,
    animFrame: null,
    totalDuration: 0,

    initCtx() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    },
};

// ── Segments State ─────────────────────────────────────────────
let segments = []; // Each: { endTime: number|null, speed: number }
let draggingMarkerIndex = -1;

// ── Helpers ─────────────────────────────────────────────────────
function formatTime(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function getColor(i) {
    return CONFIG.SEG_COLORS[i % CONFIG.SEG_COLORS.length]
        .replace('linear-gradient(135deg, ', '').split(',')[0].trim();
}

function getGlobalSpeed() {
    return parseFloat(document.getElementById('global-slowdown-input')?.value) || 1.0;
}

// ── Time Mapping ────────────────────────────────────────────────
function getFinalTotalDuration() {
    if (!Player.buffer) return 0;
    const gs = getGlobalSpeed();
    if (segments.length === 0) return Player.totalDuration / gs;
    let finalDur = 0, prevOrig = 0;
    segments.forEach(seg => {
        const origEnd = seg.endTime !== null ? seg.endTime : Player.totalDuration;
        finalDur += (origEnd - prevOrig) / seg.speed;
        prevOrig = origEnd;
    });
    return finalDur / gs;
}

// ── Waveform ────────────────────────────────────────────────────
function drawWaveform() {
    const canvas = document.getElementById('waveform-canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = canvas.offsetWidth, H = canvas.offsetHeight;

    const data = Player.buffer.getChannelData(0);
    const step = Math.ceil(data.length / W);
    const mid = H / 2;

    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#7c3aed');
    grad.addColorStop(0.5, '#2563eb');
    grad.addColorStop(1, '#db2777');
    ctx.fillStyle = grad;

    for (let x = 0; x < W; x++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
            const d = data[x * step + j] || 0;
            if (d < min) min = d;
            if (d > max) max = d;
        }
        const barH = Math.max(1, (max - min) * mid * 0.9);
        ctx.fillRect(x, mid - barH, 1, barH * 2);
    }

    drawTimelineAxis();
}

function drawTimelineAxis() {
    const axis = document.getElementById('timeline-axis');
    if (!axis) return;
    axis.innerHTML = '';
    const dur = Player.totalDuration;

    let tickInterval = 5;
    if (dur > 120) tickInterval = 10;
    if (dur > 300) tickInterval = 30;
    if (dur > 600) tickInterval = 60;

    for (let t = 0; t <= dur; t += tickInterval) {
        const tick = document.createElement('div');
        tick.className = 'time-tick';
        tick.style.left = (t / dur) * 100 + '%';
        tick.innerHTML = `<span>${formatTime(t)}</span>`;
        axis.appendChild(tick);
    }
    document.getElementById('duration-time').textContent = formatTime(dur);
    updatePredictedDuration();
}

function updatePredictedDuration() {
    const el = document.getElementById('predicted-duration-text');
    if (el) el.textContent = formatTime(getFinalTotalDuration());
}

// ── Cut Markers ─────────────────────────────────────────────────
function drawCutMarkers() {
    if (!Player.buffer) return;
    const layer = document.getElementById('cut-markers-layer');
    layer.innerHTML = '';

    segments.slice(0, -1).forEach((seg, i) => {
        const pct = (seg.endTime / Player.totalDuration) * 100;
        const color = getColor(i);

        const marker = document.createElement('div');
        marker.className = 'cut-marker interactive-marker';
        marker.style.cssText = `left:${pct}%; pointer-events:auto; cursor:ew-resize;`;
        marker.dataset.index = i;

        const delBtn = document.createElement('div');
        delBtn.className = 'cut-marker-delete';
        delBtn.dataset.action = 'delete-marker';
        delBtn.dataset.index = i;
        delBtn.textContent = '✕';
        delBtn.style.cssText = 'background:#ef4444;color:white;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;position:absolute;top:22px;left:50%;transform:translateX(-50%);opacity:0;transition:opacity 0.2s;';

        marker.innerHTML = `
            <div class="cut-marker-line" style="background:${color};box-shadow:0 0 6px ${color}88;pointer-events:none;"></div>
            <div class="cut-marker-label" style="background:${color};color:#fff;pointer-events:none;">${seg.endTime.toFixed(1)}s</div>
        `;
        marker.appendChild(delBtn);

        marker.addEventListener('mouseenter', () => delBtn.style.opacity = '1');
        marker.addEventListener('mouseleave', () => delBtn.style.opacity = '0');
        marker.addEventListener('mousedown', onMarkerMousedown);

        layer.appendChild(marker);
    });
}

function onMarkerMousedown(e) {
    if (e.target.dataset.action === 'delete-marker') return; // handled by delegation
    e.stopPropagation();
    draggingMarkerIndex = parseInt(e.currentTarget.dataset.index);
    document.addEventListener('mousemove', onMarkerDrag);
    document.addEventListener('mouseup', onMarkerDragEnd);
}

function onMarkerDrag(e) {
    if (draggingMarkerIndex === -1 || !Player.buffer) return;
    const container = document.getElementById('waveform-container');
    const rect = container.getBoundingClientRect();
    let x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    let timeSec = parseFloat(((x / rect.width) * Player.totalDuration).toFixed(1));

    const minTime = draggingMarkerIndex > 0 ? segments[draggingMarkerIndex - 1].endTime + 0.1 : 0.1;
    const maxTime = draggingMarkerIndex < segments.length - 2
        ? segments[draggingMarkerIndex + 1].endTime - 0.1
        : Player.totalDuration - 0.1;

    segments[draggingMarkerIndex].endTime = parseFloat(Math.max(minTime, Math.min(timeSec, maxTime)).toFixed(1));
    drawWaveform();
    drawCutMarkers();
}

function onMarkerDragEnd() {
    if (draggingMarkerIndex === -1) return;
    draggingMarkerIndex = -1;
    document.removeEventListener('mousemove', onMarkerDrag);
    document.removeEventListener('mouseup', onMarkerDragEnd);
    renderSegments();
    updateTimeline();
}

// ── Playback ────────────────────────────────────────────────────
function togglePlay() {
    if (!Player.buffer) return;
    Player.isPlaying ? pauseAudio() : playAudio(Player.startOffset);
}

function playAudio(offset = 0) {
    Player.initCtx();
    if (Player.ctx.state === 'suspended') Player.ctx.resume();
    if (Player.source) { Player.source.disconnect(); Player.source = null; }
    Player.source = Player.ctx.createBufferSource();
    Player.source.buffer = Player.buffer;
    Player.source.connect(Player.ctx.destination);
    Player.source.start(0, offset);
    Player.source.onended = () => {
        if (Player.isPlaying) { Player.isPlaying = false; Player.startOffset = 0; updatePlayUI(); }
    };
    Player.startTimestamp = Player.ctx.currentTime - offset;
    Player.startOffset = offset;
    Player.isPlaying = true;
    updatePlayUI();
    animateProgress();
}

function pauseAudio() {
    if (Player.source) { Player.source.stop(); Player.source = null; }
    Player.startOffset = Player.ctx.currentTime - Player.startTimestamp;
    Player.isPlaying = false;
    cancelAnimationFrame(Player.animFrame);
    updatePlayUI();
}

function updatePlayUI() {
    document.getElementById('play-icon').innerHTML = Player.isPlaying
        ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
        : '<path d="M8 5v14l11-7z"/>';
}

function animateProgress() {
    const current = Player.ctx.currentTime - Player.startTimestamp;
    const pct = Math.min(100, (current / Player.totalDuration) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('current-time').textContent = formatTime(current);
    const ph = document.getElementById('playhead');
    if (ph) ph.style.left = pct + '%';
    if (Player.isPlaying) Player.animFrame = requestAnimationFrame(animateProgress);
}

function seekTo(pct) {
    const offset = pct * Player.totalDuration;
    Player.startOffset = offset;
    if (Player.isPlaying) { playAudio(offset); return; }
    document.getElementById('progress-fill').style.width = (pct * 100) + '%';
    document.getElementById('current-time').textContent = formatTime(offset);
    const ph = document.getElementById('playhead');
    if (ph) ph.style.left = (pct * 100) + '%';
}

// ── Segments ────────────────────────────────────────────────────
function renderSegments() {
    const container = document.getElementById('segments-container');
    container.innerHTML = '';

    segments.forEach((seg, i) => {
        const color = CONFIG.SEG_COLORS[i % CONFIG.SEG_COLORS.length];
        const label = CONFIG.SEG_LABELS[i % CONFIG.SEG_LABELS.length];
        const startSec = i === 0 ? 0 : (segments[i - 1].endTime || 0);

        const row = document.createElement('div');
        row.className = 'segment-row';
        row.dataset.index = i;
        row.innerHTML = `
            <div class="segment-label" style="background:${getColor(i)};color:#fff;">${label}</div>
            <div class="field-group">
                <div class="field-label">Start (sec)</div>
                <input type="number" class="field-input field-input-disabled" value="${startSec}" disabled />
            </div>
            <div class="field-group">
                <div class="field-label">End (sec)</div>
                <input type="number" class="field-input seg-end-input" data-index="${i}"
                    value="${seg.endTime ?? ''}" placeholder="End"
                    ${i === segments.length - 1 ? 'disabled' : ''} />
            </div>
            <div class="field-group">
                <div class="field-label">Speed</div>
                <div class="speed-slider-wrapper">
                    <input type="range" class="speed-slider seg-speed-slider" data-index="${i}"
                        min="0.5" max="2.0" step="0.01" value="${seg.speed}" />
                    <input type="number" class="speed-input seg-speed-input" data-index="${i}"
                        min="0.5" max="2.0" step="0.01" value="${seg.speed.toFixed(2)}" />
                </div>
            </div>
            <button class="btn-remove" data-action="remove-segment" data-index="${i}"
                title="Remove Segment" ${segments.length <= 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
            </button>
        `;
        container.appendChild(row);
    });
}

function addCutAt(timeSec) {
    if (!Player.buffer) return;
    const time = parseFloat(timeSec);
    if (time <= 0 || time >= Player.totalDuration) return;

    const existing = segments.slice(0, -1).map(s => s.endTime);
    if (existing.some(t => Math.abs(t - time) < 0.5)) return;

    let insertIdx = segments.length - 1;
    for (let i = 0; i < segments.length - 1; i++) {
        if (time < segments[i].endTime) { insertIdx = i; break; }
    }
    const inheritSpeed = segments[insertIdx]?.speed ?? 1.0;
    segments.splice(insertIdx, 0, { endTime: parseFloat(time.toFixed(1)), speed: inheritSpeed });
    renderSegments();
    updateTimeline();
    drawWaveform();
    drawCutMarkers();
}

function addSegment() {
    if (!Player.buffer) {
        alert('Please upload an audio file first to add a cut point.');
        return;
    }
    let timeSec = Player.isPlaying
        ? Player.ctx.currentTime - Player.startTimestamp
        : Player.startOffset;
    timeSec = parseFloat(timeSec.toFixed(1));

    if (segments.length === 0) {
        segments = [
            { endTime: timeSec, speed: 1.0 },
            { endTime: null, speed: 1.0 },
        ];
        renderSegments();
        updateTimeline();
        drawCutMarkers();
    } else {
        addCutAt(timeSec);
    }
}

function removeSegment(i) {
    if (i === segments.length - 1) {
        if (segments.length === 1) segments.splice(i, 1);
        else return;
    } else {
        segments.splice(i, 1);
    }
    renderSegments();
    drawWaveform();
    drawCutMarkers();
    updateTimeline();
}

function updateSegmentTime(i, val) {
    segments[i].endTime = parseFloat(val) || 0;
    drawCutMarkers();
    drawWaveform();
    updatePredictedDuration();
}

function updateSegmentSpeed(i, val, source) {
    let num = parseFloat(val);
    if (isNaN(num)) num = 1.0;
    num = Math.max(0.5, Math.min(2.0, num));
    segments[i].speed = num;

    if (source === 'slider') {
        const inp = document.querySelector(`.seg-speed-input[data-index="${i}"]`);
        if (inp) inp.value = num.toFixed(2);
    } else {
        const sld = document.querySelector(`.seg-speed-slider[data-index="${i}"]`);
        if (sld) sld.value = num.toFixed(2);
    }
    updatePredictedDuration();
    updateTimeline();
}

function updateGlobalSpeed(val, source) {
    let num = parseFloat(val);
    if (isNaN(num)) num = 1.0;
    num = Math.max(0.5, Math.min(1.5, num));
    if (source === 'slider') {
        document.getElementById('global-slowdown-input').value = num.toFixed(2);
    } else {
        document.getElementById('global-slowdown-slider').value = num.toFixed(2);
    }
    updatePredictedDuration();
}

function updateTimeline() {
    const viz = document.getElementById('timeline-viz');
    if (!viz) return;
    viz.innerHTML = '';
    const totalTime = Player.totalDuration || 100;
    let prevTime = 0;
    segments.forEach((seg, i) => {
        const endTime = i === segments.length - 1 ? totalTime : (seg.endTime || 0);
        const width = Math.max(0, endTime - prevTime) / totalTime * 100;
        const div = document.createElement('div');
        div.className = 'timeline-seg';
        div.style.cssText = `width:${width}%;background:${CONFIG.SEG_COLORS[i % CONFIG.SEG_COLORS.length]};`;
        div.innerHTML = `<span>${CONFIG.SEG_LABELS[i % CONFIG.SEG_LABELS.length]} ${Math.round(seg.speed * 100)}%</span>`;
        viz.appendChild(div);
        prevTime = endTime;
    });
}

// ── File Handling ────────────────────────────────────────────────
async function handleFile(file) {
    document.getElementById('file-name-text').textContent = file.name;
    document.getElementById('file-name-display').style.display = 'block';

    Player.initCtx();
    const arrayBuffer = await file.arrayBuffer();
    Player.buffer = await Player.ctx.decodeAudioData(arrayBuffer);
    Player.totalDuration = Player.buffer.duration;
    document.getElementById('audio-player-section').style.display = 'block';

    drawWaveform();
    drawCutMarkers();
}

// ── Export ──────────────────────────────────────────────────────
async function runAndExport() {
    const timestamps = segments.length > 0 ? segments.slice(0, -1).map(s => s.endTime ?? 0) : [];
    const speeds = segments.length > 0 ? segments.map(s => s.speed) : [1.0];
    const globalSpeed = getGlobalSpeed();

    const btn = document.getElementById('export-btn');
    const banner = document.getElementById('status-banner');
    const spinner = document.getElementById('status-spinner');
    const statusText = document.getElementById('status-text');

    btn.disabled = true;
    const uploadedFile = document.getElementById('audio-file-input').files[0];
    if (!uploadedFile) {
        btn.disabled = false;
        alert('Please upload an audio file first!');
        return;
    }

    banner.style.display = 'flex';
    banner.className = 'processing';
    spinner.style.display = 'block';
    statusText.textContent = '⏳ Uploading & Processing...';

    try {
        const fd = new FormData();
        fd.append('file', uploadedFile);
        fd.append('timestamps_str', JSON.stringify(timestamps));
        fd.append('speeds_str', JSON.stringify(speeds));
        fd.append('overall_factor', globalSpeed);

        const resp = await fetch(`${CONFIG.API_BASE_URL}/upload-audio/`, { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

        statusText.textContent = `⏳ Audio received, Task ID: ${data.task_id}, processing in background...`;
        checkTaskProgress(data.task_id);
    } catch (e) {
        banner.className = 'error';
        spinner.style.display = 'none';
        statusText.textContent = e.message.includes('fetch') || e.message.includes('Failed')
            ? '❌ Cannot connect to local service. Ensure FastAPI backend is running on port 8000.'
            : `❌ Error: ${e.message}`;
        btn.disabled = false;
    }
}

function checkTaskProgress(taskId) {
    const btn = document.getElementById('export-btn');
    const banner = document.getElementById('status-banner');
    const statusText = document.getElementById('status-text');
    const spinner = document.getElementById('status-spinner');

    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/check-status/${taskId}`);
            const statusData = await res.json();

            if (statusData.status === 'processing') {
                statusText.textContent = `⏳ Task processing, Task ID: ${taskId}`;
            } else if (statusData.status === 'done') {
                clearInterval(interval);
                const fileUrl = CONFIG.API_BASE_URL + statusData.file_url;
                banner.className = 'success';
                spinner.style.display = 'none';
                statusText.innerHTML = `✅ Done! <a href="${fileUrl}" style="color:var(--accent);text-decoration:underline;">Download</a>`;
                const a = document.createElement('a');
                a.href = fileUrl;
                a.download = `tempotailor_${taskId}.mp3`;
                a.click();
                btn.disabled = false;
            } else if (statusData.status === 'failed') {
                clearInterval(interval);
                banner.className = 'error';
                spinner.style.display = 'none';
                statusText.textContent = '❌ Processing failed. Check server logs.';
                btn.disabled = false;
            }
        } catch (err) {
            clearInterval(interval);
            banner.className = 'error';
            spinner.style.display = 'none';
            statusText.textContent = '❌ Status poll error: ' + err.message;
            btn.disabled = false;
        }
    }, CONFIG.POLLING_INTERVAL_MS);
}

// ── Event Delegation & Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    segments = [];
    renderSegments();

    // Upload zone drag & drop
    const zone = document.getElementById('upload-zone');
    zone.addEventListener('click', () => document.getElementById('audio-file-input').click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });
    document.getElementById('audio-file-input').addEventListener('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
    });

    // Player controls
    document.getElementById('play-btn').addEventListener('click', togglePlay);
    document.getElementById('btn-split').addEventListener('click', addSegment);
    document.getElementById('progress-bar').addEventListener('click', e => {
        const bar = e.currentTarget;
        seekTo(e.offsetX / bar.offsetWidth);
    });
    document.getElementById('waveform-canvas').addEventListener('click', e => {
        const canvas = e.currentTarget;
        seekTo(e.offsetX / canvas.offsetWidth);
    });

    // Export
    document.getElementById('export-btn').addEventListener('click', runAndExport);

    // Global speed
    document.getElementById('global-slowdown-slider').addEventListener('input', e => updateGlobalSpeed(e.target.value, 'slider'));
    document.getElementById('global-slowdown-input').addEventListener('change', e => updateGlobalSpeed(e.target.value, 'input'));

    // Segment container event delegation
    const segContainer = document.getElementById('segments-container');
    segContainer.addEventListener('click', e => {
        // Delete cut marker button (delegated from cut-markers-layer too)
        const del = e.target.closest('[data-action="delete-marker"]');
        if (del) {
            e.stopPropagation();
            removeSegment(parseInt(del.dataset.index));
            drawWaveform();
            drawCutMarkers();
            return;
        }
        // Remove segment button
        const rem = e.target.closest('[data-action="remove-segment"]');
        if (rem) removeSegment(parseInt(rem.dataset.index));
    });

    // End-time input delegation
    segContainer.addEventListener('change', e => {
        if (e.target.classList.contains('seg-end-input')) {
            updateSegmentTime(parseInt(e.target.dataset.index), e.target.value);
        }
        if (e.target.classList.contains('seg-speed-input')) {
            updateSegmentSpeed(parseInt(e.target.dataset.index), e.target.value, 'input');
        }
    });

    segContainer.addEventListener('input', e => {
        if (e.target.classList.contains('seg-speed-slider')) {
            updateSegmentSpeed(parseInt(e.target.dataset.index), e.target.value, 'slider');
        }
    });

    // Cut-marker layer delete delegation
    document.getElementById('cut-markers-layer').addEventListener('click', e => {
        const del = e.target.closest('[data-action="delete-marker"]');
        if (del) {
            e.stopPropagation();
            removeSegment(parseInt(del.dataset.index));
            drawWaveform();
            drawCutMarkers();
        }
    });
});
