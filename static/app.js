// ── Configuration ──────────────────────────────────────────────
const CONFIG = {
    API_BASE_URL: 'http://127.0.0.1:8000',
    POLLING_INTERVAL_MS: 2000,
    WAVEFORM_COLOR_PLAYED: '#d4a0b5',
    WAVEFORM_COLOR_UNPLAYED: '#666666',
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
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Duration Prediction ─────────────────────────────────────────
function getFinalTotalDuration() {
    if (!totalDuration) return 0;
    if (segments.length === 0) return totalDuration;
    let finalDur = 0, prevOrig = 0;
    segments.forEach(seg => {
        const origEnd = seg.endTime !== null ? seg.endTime : totalDuration;
        finalDur += (origEnd - prevOrig) / seg.speed;
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
    const dpr = window.devicePixelRatio || 1;
    canvas.width = wrap.offsetWidth * dpr;
    canvas.height = wrap.offsetHeight * dpr;
    canvas.style.width = wrap.offsetWidth + 'px';
    canvas.style.height = wrap.offsetHeight + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = wrap.offsetWidth;
    const H = wrap.offsetHeight;

    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / W);
    const mid = H / 2;
    const playheadX = (getCurrentTime() / totalDuration) * W;

    ctx.clearRect(0, 0, W, H);

    for (let x = 0; x < W; x++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
            const d = data[x * step + j] || 0;
            if (d < min) min = d;
            if (d > max) max = d;
        }
        const barH = Math.max(1, (max - min) * mid * 0.9);
        ctx.fillStyle = x <= playheadX
            ? CONFIG.WAVEFORM_COLOR_PLAYED
            : CONFIG.WAVEFORM_COLOR_UNPLAYED;
        ctx.fillRect(x, mid - barH, 1, barH * 2);
    }
}

function updatePlayheadUI() {
    const t = getCurrentTime();
    const pct = (t / totalDuration) * 100;
    document.getElementById('playhead').style.left = pct + '%';
    document.getElementById('player-current').textContent = formatTime(t);
    document.getElementById('player-total').textContent = formatTime(totalDuration);
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
    playOffset = audioCtx.currentTime - playStartTime;
    if (sourceNode) { sourceNode.stop(); sourceNode = null; }
    isPlaying = false;
    cancelAnimationFrame(animFrameId);
    updatePlayUI();
    updatePlayheadUI();
}

function updatePlayUI() {
    document.getElementById('play-btn').textContent = isPlaying ? '||' : '>';
}

function animate() {
    updatePlayheadUI();
    if (isPlaying) animFrameId = requestAnimationFrame(animate);
}

function seekTo(e) {
    const wrap = document.getElementById('waveform-wrap');
    const rect = wrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playOffset = pct * totalDuration;
    if (isPlaying) {
        if (sourceNode) { sourceNode.onended = null; sourceNode.stop(); sourceNode = null; }
        play();
    } else {
        updatePlayheadUI();
    }
}

// ── Segments ────────────────────────────────────────────────────
function renderSegments() {
    const container = document.getElementById('segments-container');
    container.innerHTML = '';

    segments.forEach((seg, i) => {
        const isLast = i === segments.length - 1;
        const row = document.createElement('div');
        row.className = 'segment-row';
        row.dataset.index = i;
        row.innerHTML = `
            <span class="seg-idx">[${i + 1}]</span>
            <span class="seg-field"><label>end:</label>
                <input type="number" class="seg-end" data-index="${i}"
                    value="${seg.endTime ?? ''}" placeholder="end" step="0.1"
                    ${isLast ? 'disabled' : ''} />
            </span>
            <span class="seg-field"><label>speed:</label>
                <input type="number" class="seg-speed" data-index="${i}"
                    value="${seg.speed.toFixed(2)}" min="0.5" max="2.0" step="0.01" />
            </span>
            ${isLast
                ? '<span class="seg-last">(last)</span>'
                : '<button class="btn-remove">X</button>'}
        `;
        if (!isLast) {
            const btn = row.querySelector('.btn-remove');
            btn.addEventListener('click', function() { removeSegment(i); });
        }
        container.appendChild(row);
    });

    updatePredictedDuration();
}

function addSegment() {
    if (!totalDuration) {
        alert('Upload an audio file first.');
        return;
    }
    if (segments.length === 0) {
        const mid = parseFloat((totalDuration / 2).toFixed(1));
        segments = [
            { endTime: mid, speed: 1.0 },
            { endTime: null, speed: 1.0 },
        ];
    } else {
        const lastSeg = segments[segments.length - 1];
        const prevSeg = segments.length >= 2 ? segments[segments.length - 2] : { endTime: 0 };
        const lastEnd = prevSeg.endTime || 0;
        const mid = parseFloat(((lastEnd + totalDuration) / 2).toFixed(1));
        if (mid <= lastEnd + 0.5 || mid >= totalDuration - 0.5) {
            alert('Not enough room for another segment.');
            return;
        }
        lastSeg.endTime = mid;
        segments.push({ endTime: null, speed: lastSeg.speed });
    }
    renderSegments();
}

function removeSegment(i) {
    if (segments.length <= 1) return;
    if (i === segments.length - 1) {
        segments[i - 1].endTime = null;
        segments.pop();
    } else {
        segments.splice(i, 1);
        for (let j = i; j < segments.length - 1; j++) {
            if (segments[j].endTime === null) {
                segments[j].endTime = segments[j - 1]?.endTime || totalDuration;
            }
        }
    }
    renderSegments();
}

function updateSegmentEnd(i, val) {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return;
    segments[i].endTime = parseFloat(num.toFixed(1));
    updatePredictedDuration();
}

function updateSegmentSpeed(i, val) {
    let num = parseFloat(val);
    if (isNaN(num)) num = 1.0;
    num = Math.max(0.5, Math.min(2.0, num));
    segments[i].speed = num;
    document.querySelector(`.seg-speed[data-index="${i}"]`).value = num.toFixed(2);
    updatePredictedDuration();
}

// ── File Handling ────────────────────────────────────────────────
async function handleFile(file) {
    audioFile = file;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx = ctx;
    audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
    totalDuration = audioBuffer.duration;
    playOffset = 0;
    isPlaying = false;
    updatePlayUI();

    document.getElementById('upload-zone').style.display = 'none';
    document.getElementById('player-section').style.display = 'block';
    document.getElementById('player-filename').textContent = '— ' + file.name;
    document.getElementById('player-total').textContent = formatTime(totalDuration);

    drawWaveform();
    updatePlayheadUI();
    segments = [];
    renderSegments();
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

    banner.style.display = 'block';
    banner.className = 'status proc';
    statusText.textContent = '[*] Uploading & Processing...';

    try {
        const fd = new FormData();
        fd.append('file', audioFile);
        fd.append('timestamps_str', JSON.stringify(timestamps));
        fd.append('speeds_str', JSON.stringify(speeds));
        fd.append('overall_factor', globalSpeed);

        const resp = await fetch(`${CONFIG.API_BASE_URL}/upload-audio/`, { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

        statusText.textContent = `[*] Processing... task: ${data.task_id}`;
        checkTaskProgress(data.task_id);
    } catch (e) {
        banner.className = 'status fail';
        statusText.textContent = e.message.includes('fetch') || e.message.includes('Failed')
            ? '[FAIL] Cannot connect to server. Run: uvicorn main:app --port 8000'
            : `[FAIL] ${e.message}`;
        btn.disabled = false;
    }
}

function checkTaskProgress(taskId) {
    const btn = document.getElementById('export-btn');
    const banner = document.getElementById('status-banner');
    const statusText = document.getElementById('status-text');

    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/check-status/${taskId}`);
            const data = await res.json();

            if (data.status === 'processing') {
                statusText.textContent = `[*] Processing... task: ${taskId}`;
            } else if (data.status === 'done') {
                clearInterval(interval);
                const fileUrl = CONFIG.API_BASE_URL + data.file_url;
                banner.className = 'status ok';
                statusText.innerHTML = `[OK] <a href="${fileUrl}">Download MP3</a>`;
                const a = document.createElement('a');
                a.href = fileUrl;
                a.download = `tempotailor_${taskId}.mp3`;
                a.click();
                btn.disabled = false;
            } else if (data.status === 'failed') {
                clearInterval(interval);
                banner.className = 'status fail';
                statusText.textContent = '[FAIL] Processing error. Check server logs.';
                btn.disabled = false;
            }
        } catch (err) {
            clearInterval(interval);
            banner.className = 'status fail';
            statusText.textContent = '[FAIL] ' + err.message;
            btn.disabled = false;
        }
    }, CONFIG.POLLING_INTERVAL_MS);
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    segments = [];
    renderSegments();
    document.getElementById('player-section').style.display = 'none';

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
    });

    // Add segment
    document.getElementById('btn-add-segment').addEventListener('click', addSegment);

    // Export
    document.getElementById('export-btn').addEventListener('click', runAndExport);

    // Segment events (delegation)
    const segContainer = document.getElementById('segments-container');
    segContainer.addEventListener('change', e => {
        if (e.target.classList.contains('seg-end')) {
            updateSegmentEnd(parseInt(e.target.dataset.index), e.target.value);
        }
        if (e.target.classList.contains('seg-speed')) {
            updateSegmentSpeed(parseInt(e.target.dataset.index), e.target.value);
        }
    });
});
