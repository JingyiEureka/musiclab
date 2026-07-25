// ── Configuration ──────────────────────────────────────────────
const CONFIG = {
    // the page is always served by the API itself, so requests are same-origin
    API_BASE_URL: '',
    POLLING_INTERVAL_MS: 2000,
    MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
    WAVEFORM_COLOR_PLAYED: '#d4a0b5',
    WAVEFORM_COLOR_UNPLAYED: '#666666',
    WAVEFORM_PX_PER_SEC: 13,
};

const ERROR_MESSAGES = {
    decode_failed: 'This file format is not supported - try a different file or convert it to MP3/WAV.',
    encode_failed: 'Could not create the MP3 - please try again.',
    invalid_params: 'Section settings are invalid - check your split points and speeds.',
    server_error: 'Something went wrong on the server - please try again.',
};

// ── Audio State ─────────────────────────────────────────────────
let audioFile = null;
let audioBuffer = null;
let totalDuration = 0;

// ── Player State ─────────────────────────────────────────────────
let audioCtx = null;
let sourceNode = null;
let gainNode = null;
let isPlaying = false;
let playStartTime = 0;
let playOffset = 0;
let animFrameId = null;
let waveformZoom = 1;

// ── Segments State ─────────────────────────────────────────────
let segments = [];

// ── Busy State ──────────────────────────────────────────────────
let isBusy = false;

function setBusy(busy) {
    isBusy = busy;
    // once the session has expired, export stays disabled regardless of busy
    document.getElementById('export-btn').disabled = busy || sessionExpired;
    document.getElementById('preview-btn').disabled = busy;
    document.getElementById('audio-file-input').disabled = busy;
    document.getElementById('upload-zone').classList.toggle('disabled', busy);
}

// ── Session persistence (client-side) ───────────────────────────
// The whole edit lives in the browser; export re-uploads the file each time,
// so nothing of the session is on the server. We save the uploaded file and
// the edit metadata to IndexedDB so a refresh or crash does not lose the work.
// The session expires a week after the last edit (sliding window, so active
// editing never expires mid-work). This is client-only and re-decodes its own
// stored file, so it is independent of the shorter server file sweep.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DB_NAME = 'musiclab';
const STORE = 'session';
const BLOB_KEY = 'blob'; // written once per file: the raw upload, re-decoded on restore
const META_KEY = 'meta'; // written on every edit: segments, zoom, savedAt

let saveTimer = null;
let expiryTimer = null;
let sessionSavedAt = 0;
let sessionExpired = false;
let pendingSession = null;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(key, value) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    }));
}

function idbGet(key) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    }));
}

function idbClear() {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    }));
}

// Store the raw upload once; safe to fire-and-forget (private mode may reject).
function saveBlob(file) {
    idbPut(BLOB_KEY, { blob: file, filename: file.name }).catch(() => {});
}

// Persist edit metadata, debounced so rapid edits do not hammer IndexedDB.
// Each save resets the sliding expiry window.
function saveMeta() {
    if (!audioFile || sessionExpired) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        sessionSavedAt = Date.now();
        idbPut(META_KEY, { segments, waveformZoom, savedAt: sessionSavedAt }).catch(() => {});
        armExpiry(sessionSavedAt);
    }, 500);
}

// Schedule the expiry flip for when the session crosses its one-week window.
// A backstop check in runAndExport covers the case where the device slept
// through this timer.
function armExpiry(savedAt) {
    clearTimeout(expiryTimer);
    const remaining = Math.max(0, SESSION_TTL_MS - (Date.now() - savedAt));
    expiryTimer = setTimeout(expireSession, remaining);
}

function expireSession() {
    clearTimeout(expiryTimer);
    sessionExpired = true;
    idbClear().catch(() => {});
    if (isPlaying) pause();
    stopPet();
    document.getElementById('export-btn').disabled = true;
    const banner = document.getElementById('status-banner');
    clearTimeout(bannerHideTimer);
    banner.style.display = 'block';
    banner.className = 'fail';
    document.getElementById('status-text').textContent =
        'previous edit has expired, please refresh the page and re-upload.';
}

// On load, offer to resume a saved session unless it has expired.
async function checkForSavedSession() {
    let blobRec, meta;
    try {
        blobRec = await idbGet(BLOB_KEY);
        meta = await idbGet(META_KEY);
    } catch (e) {
        return;
    }
    if (!blobRec || !blobRec.blob || !meta) return;
    if (Date.now() - (meta.savedAt || 0) >= SESSION_TTL_MS) {
        await idbClear().catch(() => {});
        return;
    }
    pendingSession = { ...blobRec, ...meta };
    document.getElementById('resume-modal-text').textContent =
        'You have a previous edit: ' + pendingSession.filename;
    document.getElementById('resume-modal').style.display = 'flex';
}

function hideResumeModal() {
    document.getElementById('resume-modal').style.display = 'none';
}

async function restoreSession(saved) {
    hideResumeModal();
    setBusy(true);
    let ctx;
    try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Read the stored blob into memory once and build the upload File from
        // those bytes: WebKit (all iPhone browsers) can fail to POST a File
        // still backed by IndexedDB blob storage with a generic "Load failed".
        const bytes = await saved.blob.arrayBuffer();
        const upload = new File([bytes], saved.filename, { type: saved.blob.type });
        audioBuffer = await ctx.decodeAudioData(bytes);
        if (audioCtx) audioCtx.close();
        audioCtx = ctx;
        audioFile = upload;
        totalDuration = audioBuffer.duration;
        playOffset = 0;
        isPlaying = false;
        waveformZoom = saved.waveformZoom || 1;
        segments = saved.segments || [];
        sessionSavedAt = saved.savedAt || Date.now();
        revealEditor(saved.filename);
        armExpiry(sessionSavedAt);
    } catch (e) {
        if (ctx) ctx.close();
        await idbClear().catch(() => {});
        showUploadError('Could not restore your previous session - please re-upload.');
    } finally {
        setBusy(false);
    }
}

// ── Processing report ───────────────────────────────────────────
// A human-readable summary of the current edit: file, lengths, and the
// per-section breakdown. Downloaded alongside the export so the user has a
// record they can match to the exported mp3.
const MUSICLAB_LOGO = [
    '█▀▄▀█ █ █ █▀▀ █ █▀▀   █   █▀█ █▀▄',
    '█ ▀ █ █ █ ▀▀█ █ █     █   █▀█ █▀▄',
    '█   █ █▄█ ▄▄█ █ █▄▄   █▄▄ █ █ █▄▀',
];

function buildReportText(exportedAt) {
    const filename = audioFile ? audioFile.name : '(unknown)';
    const orig = totalDuration;
    const out = getFinalTotalDuration();
    const delta = Math.round(out - orig);
    const factor = orig > 0 ? out / orig : 1;
    const pad = (v, n) => String(v).padEnd(n);

    const lines = [
        ...MUSICLAB_LOGO,
        '',
        'processing report',
        '=================',
        'Original file:   ' + filename,
        'Exported:        ' + exportedAt,
        'Original length: ' + formatTime(orig),
        'Output length:   ' + formatTime(out) +
            '  (' + (delta >= 0 ? '+' : '-') + Math.abs(delta) + 's, ' +
            factor.toFixed(2) + 'x overall)',
        'Sections:        ' + segments.length,
        '',
        '  ' + pad('#', 4) + pad('Time (original)', 20) + pad('Speed', 8) + pad('Volume', 9) + 'Output',
    ];

    let prev = 0;
    segments.forEach((seg, i) => {
        const end = seg.endTime ?? totalDuration;
        const range = formatTime(prev) + ' - ' + formatTime(end);
        let row = '  ' + pad(segLabel(i), 4) + pad(range, 20);
        if (seg.skip) {
            row += pad('SKIP', 8) + pad('-', 9) + '-';
        } else {
            row += pad(Math.round(seg.speed * 100) + '%', 8) +
                pad(Math.round(seg.volume * 100) + '%', 9) +
                formatTime((end - prev) / seg.speed);
        }
        lines.push(row);
        prev = end;
    });

    lines.push('');
    lines.push('Made with MusicLab - https://musiclab.jyylab.cc');
    return lines.join('\n');
}

// Two-digit padded date parts for filename + in-report timestamps.
function reportStamps() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const ymd = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    return {
        human: ymd + ' ' + hm,
        file: ymd.replace(/-/g, '') + '_' + hm.replace(':', ''),
    };
}

// Download as <original-name>_report_<date>_<time>.txt so repeated exports do
// not overwrite each other and each matches its mp3. Client-side only.
function downloadReport() {
    const stamps = reportStamps();
    const base = (audioFile ? audioFile.name : 'project').replace(/\.[^.]+$/, '');
    const blob = new Blob([buildReportText(stamps.human)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base + '_report_' + stamps.file + '.txt';
    a.click();
    // revoking synchronously can abort the download in some browsers
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showUploadError(msg) {
    const el = document.getElementById('upload-error');
    el.textContent = msg;
    el.style.display = 'block';
}

function hideUploadError() {
    document.getElementById('upload-error').style.display = 'none';
}

// ── Helpers ─────────────────────────────────────────────────────
function formatTime(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const dec = Math.floor((s % 1) * 100);
    return `${m}:${sec.toString().padStart(2, '0')}.${dec.toString().padStart(2, '0')}`;
}

// ── Lab pet + progress bar (shown in the status banner) ─────────
const PET_FRAMES = [
    ' /\\_/\\  .♪ \nd( o.o )b',
    ' /\\_/\\  ♪. \nd( o.o )b',
    ' /\\_/\\ ♪ .*\nd( -.- )b',
    ' /\\_/\\  .♫ \nd( ^.^ )b',
];
let petTimer = null;

function startPet() {
    const el = document.getElementById('pet-frame');
    el.style.display = 'block';
    el.textContent = PET_FRAMES[0];
    let i = 1;
    clearInterval(petTimer);
    petTimer = setInterval(() => {
        el.textContent = PET_FRAMES[i % PET_FRAMES.length];
        i++;
    }, 500);
}

function stopPet() {
    clearInterval(petTimer);
    petTimer = null;
    document.getElementById('pet-frame').style.display = 'none';
    document.getElementById('progress-line').textContent = '';
}

function renderProgress(progress) {
    const el = document.getElementById('progress-line');
    if (!progress) { el.textContent = ''; return; }
    const width = 16;
    const filled = Math.round(progress.frac * width);
    el.textContent = '[' + '#'.repeat(filled) + '.'.repeat(width - filled) + '] '
        + Math.round(progress.frac * 100) + '% - ' + progress.stage;
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
        if (!seg.skip) finalDur += (origEnd - prevOrig) / seg.speed;
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
function getWaveWidth() {
    const viewW = document.getElementById('waveform-wrap').clientWidth;
    return Math.max(viewW, Math.ceil(totalDuration * CONFIG.WAVEFORM_PX_PER_SEC * waveformZoom));
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

    const data = audioBuffer.getChannelData(0);
    const mid = H / 2;
    const MAX_BARS = 15000;
    const barStep = waveW > MAX_BARS ? Math.ceil(waveW / MAX_BARS) : 1;
    const sampleStep = Math.ceil(data.length / waveW);

    ctx.fillStyle = CONFIG.WAVEFORM_COLOR_UNPLAYED;
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
    waveformCache = { canvas: off, waveW, height: H * dpr, buffer: audioBuffer };
}

function drawWaveform() {
    const canvas = document.getElementById('waveform-canvas');
    const inner = document.getElementById('waveform-inner');
    const dpr = window.devicePixelRatio || 1;
    const waveW = getWaveWidth();
    const H = inner.clientHeight;
    // clamp the backing store: iOS Safari silently blanks very wide canvases
    const backingW = Math.min(waveW * dpr, 16384);

    if (!waveformCache || waveformCache.waveW !== waveW
        || waveformCache.height !== H * dpr || waveformCache.buffer !== audioBuffer) {
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
    const playheadX = totalDuration > 0 ? (getCurrentTime() / totalDuration) * waveW : 0;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = CONFIG.WAVEFORM_COLOR_PLAYED;
    ctx.fillRect(0, 0, playheadX * (backingW / waveW), canvas.height);
    ctx.restore();
}

function updatePlayheadUI() {
    const t = getCurrentTime();
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const viewW = wrap.clientWidth;
    const waveW = getWaveWidth();
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

// Preview the per-segment volume settings during playback by scheduling
// gain changes at the segment boundaries ahead of the playhead.
function applyGainSchedule() {
    if (!gainNode || !audioCtx) return;
    const now = audioCtx.currentTime;
    const t = getCurrentTime();
    gainNode.gain.cancelScheduledValues(now);
    if (segments.length === 0) {
        gainNode.gain.setValueAtTime(1, now);
        return;
    }
    let idx = segments.findIndex(s => t < (s.endTime ?? totalDuration));
    if (idx === -1) idx = segments.length - 1;
    gainNode.gain.setValueAtTime(segments[idx].volume ?? 1, now);
    for (let j = idx; j < segments.length - 1; j++) {
        const boundary = segments[j].endTime;
        if (boundary === null || boundary <= t) continue;
        gainNode.gain.setValueAtTime(segments[j + 1].volume ?? 1, now + boundary - t);
    }
}

async function play() {
    // A backgrounded tab (especially iOS Safari) can leave the context
    // suspended, interrupted, or fully closed; recover from all three so the
    // play button still works when the user comes back.
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        gainNode = null;
    }
    if (audioCtx.state !== 'running') {
        try { await audioCtx.resume(); } catch (e) { /* resume needs a gesture; ignore */ }
    }
    stopPreviewPlayback();
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (!gainNode || gainNode.context !== audioCtx) {
        gainNode = audioCtx.createGain();
        gainNode.connect(audioCtx.destination);
    }
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(gainNode);
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
    applyGainSchedule();
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

// Skip-to-start: like the |< control in most players, jump to 0 and play.
function playFromStart() {
    if (!audioBuffer) return;
    if (isPlaying) {
        cancelAnimationFrame(animFrameId);
        if (sourceNode) { sourceNode.onended = null; sourceNode.stop(); sourceNode = null; }
    }
    playOffset = 0;
    play();
}

function updatePlayUI() {
    document.getElementById('play-btn').textContent = isPlaying ? '[ Pause ]' : '[ Play ]';
}

function animate() {
    updatePlayheadUI();
    if (isPlaying) animFrameId = requestAnimationFrame(animate);
}

function seekTo(e) {
    const wrap = document.getElementById('waveform-wrap');
    const inner = document.getElementById('waveform-inner');
    const rect = wrap.getBoundingClientRect();
    const waveW = getWaveWidth();
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
function clampSpeed(mult) {
    return Math.max(0.25, Math.min(8.0, mult));
}

function clampVolume(mult) {
    return Math.max(0, Math.min(4.0, mult));
}

// A, B, ... Z, AA, AB ... (spreadsheet-style)
function segLabel(i) {
    let label = '';
    i += 1;
    while (i > 0) {
        i -= 1;
        label = String.fromCharCode(65 + (i % 26)) + label;
        i = Math.floor(i / 26);
    }
    return label;
}

// ── Section lane (labeled blocks above the waveform) ───────────
function renderSectionLane() {
    const lane = document.getElementById('section-lane-content');
    lane.innerHTML = '';
    if (!totalDuration || segments.length === 0) return;
    const waveW = getWaveWidth();
    lane.style.width = waveW + 'px';
    let start = 0;
    segments.forEach((seg, i) => {
        const end = seg.endTime ?? totalDuration;
        const block = document.createElement('div');
        block.className = 'lane-block' + (seg.skip ? ' skipped' : '');
        block.dataset.index = i;
        block.style.left = (start / totalDuration) * waveW + 'px';
        block.style.width = ((end - start) / totalDuration) * waveW + 'px';
        block.textContent = segLabel(i);
        block.title = 'click to show this section in the table';
        lane.appendChild(block);
        if (i < segments.length - 1) {
            const handle = document.createElement('div');
            handle.className = 'lane-handle';
            handle.dataset.index = i;
            handle.title = 'drag to move this split';
            handle.style.left = (end / totalDuration) * waveW + 'px';
            lane.appendChild(handle);
        }
        start = end;
    });
}

function highlightSegmentRow(i) {
    const row = document.querySelector(`.segment-row[data-index="${i}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('highlight');
    setTimeout(() => row.classList.remove('highlight'), 1200);
}

// Reveal the editor UI and sync the header, zoom, and waveform to the current
// state. Shared by a fresh upload (handleFile) and a restored session.
function revealEditor(filename) {
    hideResumeModal();
    document.getElementById('upload-zone').style.display = 'none';
    document.getElementById('player-section').style.display = 'block';
    document.getElementById('sections-block').style.display = 'block';
    document.getElementById('output-block').style.display = 'block';
    document.getElementById('player-filename').textContent = '— ' + filename;
    document.getElementById('player-total').textContent = formatTime(totalDuration);
    document.getElementById('zoom-slider').value = waveformZoom;
    document.getElementById('zoom-value').textContent = waveformZoom.toFixed(1) + 'x';
    updatePlayUI();
    drawWaveform();
    updatePlayheadUI();
    renderSegments();
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
            <span class="seg-field">vol (%)</span>
            <span class="seg-field seg-skip-col">skip</span>
        `;
        container.appendChild(header);
    }

    let prevEnd = 0;
    segments.forEach((seg, i) => {
        const isLast = i === segments.length - 1;
        const skipped = seg.skip;
        const displayStart = i === 0 ? 0 : prevEnd + 0.01;
        const row = document.createElement('div');
        row.className = 'segment-row' + (skipped ? ' skipped' : '');
        row.dataset.index = i;
        row.innerHTML = `
            <span class="seg-idx">[${segLabel(i)}]</span>
            <span class="seg-start">${displayStart.toFixed(2)}</span>
            <span class="seg-field">
                ${isLast
                    ? `<span class="seg-end-static">${totalDuration.toFixed(2)}</span>`
                    : `<button class="stepper" data-kind="end" data-step="-0.1" data-index="${i}"
                        ${skipped ? 'disabled' : ''}>&lt;</button>
                       <input type="number" class="seg-end" data-index="${i}"
                        value="${seg.endTime !== null ? seg.endTime.toFixed(2) : ''}" placeholder="end" step="0.01"
                        ${skipped ? 'disabled' : ''} />
                       <button class="stepper" data-kind="end" data-step="0.1" data-index="${i}"
                        ${skipped ? 'disabled' : ''}>&gt;</button>`
                }
            </span>
            <span class="seg-field">
                <button class="stepper" data-kind="speed" data-step="-5" data-index="${i}"
                    ${skipped ? 'disabled' : ''}>&lt;</button>
                <input type="number" class="seg-speed" data-index="${i}"
                    value="${(seg.speed * 100).toFixed(0)}"
                    min="25" max="800" step="1" ${skipped ? 'disabled' : ''} />
                <button class="stepper" data-kind="speed" data-step="5" data-index="${i}"
                    ${skipped ? 'disabled' : ''}>&gt;</button>
            </span>
            <span class="seg-field">
                <button class="stepper" data-kind="volume" data-step="-10" data-index="${i}"
                    ${skipped ? 'disabled' : ''}>&lt;</button>
                <input type="number" class="seg-volume" data-index="${i}"
                    value="${(seg.volume * 100).toFixed(0)}"
                    min="0" max="400" step="1" ${skipped ? 'disabled' : ''} />
                <button class="stepper" data-kind="volume" data-step="10" data-index="${i}"
                    ${skipped ? 'disabled' : ''}>&gt;</button>
            </span>
            <span class="seg-field seg-skip-col">
                <label class="switch" title="skipped sections are cut from the export">
                    <input type="checkbox" class="seg-skip" data-index="${i}" ${skipped ? 'checked' : ''} />
                    <span class="slider"></span>
                </label>
            </span>
        `;
        container.appendChild(row);

        if (!isLast && !skipped && !segments[i + 1].skip) {
            const divider = document.createElement('div');
            divider.className = 'seg-merge-divider';
            divider.innerHTML = `<button class="btn-merge" data-index="${i}"
                title="Merge these two sections (remove split)">merge</button>`;
            container.appendChild(divider);
        }

        prevEnd = seg.endTime ?? totalDuration;
    });

    renderSectionLane();
    updatePredictedDuration();
    if (isPlaying) applyGainSchedule();
    saveMeta();
}

function addSegment() {
    if (!totalDuration) {
        showNotification('Upload an audio file first.');
        return;
    }
    if (segments.length === 0) {
        segments = [{ endTime: null, speed: 1.0, volume: 1.0, skip: false }];
    }
    const t = parseFloat(Math.max(0, Math.min(totalDuration, getCurrentTime())).toFixed(2));
    let prevEnd = 0;
    for (let j = 0; j < segments.length; j++) {
        const end = segments[j].endTime ?? totalDuration;
        if (t < end) {
            if (t <= prevEnd + 0.5 || t >= end - 0.5) {
                showNotification('Split must be at least 0.5s from existing boundaries.');
                return;
            }
            segments.splice(j, 0, { endTime: t, speed: segments[j].speed, volume: segments[j].volume, skip: segments[j].skip });
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

// Clamp a boundary time for segment i to 0.5s from its neighbours;
// returns the rounded value, or null if the boundary cannot move.
function clampSegmentEnd(i, t) {
    const prevBound = i === 0 ? 0 : (segments[i - 1].endTime ?? totalDuration);
    const nextBound = i >= segments.length - 1 ? totalDuration : (segments[i + 1].endTime ?? totalDuration);
    const minEnd = prevBound + 0.5;
    const maxEnd = nextBound - 0.5;
    if (minEnd > maxEnd) return null;
    return parseFloat(Math.max(minEnd, Math.min(maxEnd, t)).toFixed(2));
}

function updateSegmentEnd(i, val) {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return;
    const clamped = clampSegmentEnd(i, num);
    if (clamped === null) return;
    segments[i].endTime = clamped;
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
    const raw = num / 100;
    const speed = clampSpeed(raw);
    if (speed !== raw) {
        showNotification('Speed range: 25% to 800%');
    }
    segments[i].speed = speed;
    input.value = (speed * 100).toFixed(0);
    updatePredictedDuration();
}

function updateSegmentVolume(i, val) {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    segments[i].volume = clampVolume(num / 100);
    if (isPlaying) applyGainSchedule();
}

function commitSegmentVolume(i) {
    const input = document.querySelector(`.seg-volume[data-index="${i}"]`);
    if (!input) return;
    const trimmed = input.value.trim();
    if (trimmed === '') {
        input.value = ((segments[i]?.volume ?? 1.0) * 100).toFixed(0);
        return;
    }
    let num = parseFloat(trimmed);
    if (isNaN(num)) num = 100;
    const raw = num / 100;
    const volume = clampVolume(raw);
    if (volume !== raw) {
        showNotification('Volume range: 0% to 400%');
    }
    segments[i].volume = volume;
    input.value = (volume * 100).toFixed(0);
    if (isPlaying) applyGainSchedule();
}

// ── Preview render ──────────────────────────────────────────────
// Preview = a real export of a short window around the playhead, through the
// exact same server pipeline, played inline. Same engine, same sound.
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
    let off = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const v = Math.max(-1, Math.min(1, buffer.getChannelData(c)[start + i]));
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
    let w1 = Math.min(totalDuration, w0 + PREVIEW_SPAN);
    let start = 0;
    segments.forEach(seg => {
        const end = seg.endTime ?? totalDuration;
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
    segments.forEach(seg => {
        const end = seg.endTime ?? totalDuration;
        if (end > w0 && start < w1) {
            speeds.push(seg.skip ? 0 : seg.speed);
            volumes.push(seg.volume);
            if (end < w1) timestamps.push(end - w0);
        }
        start = end;
    });
    return { timestamps, speeds, volumes };
}

let previewSource = null;

function stopPreviewPlayback() {
    if (previewSource) {
        previewSource.onended = null;
        previewSource.stop();
        previewSource = null;
    }
}

async function playPreviewBytes(bytes) {
    // the context can be closed if the tab was backgrounded while waiting
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        gainNode = null;
    }
    if (audioCtx.state !== 'running') {
        try { await audioCtx.resume(); } catch (e) { /* ignore */ }
    }
    const buffer = await audioCtx.decodeAudioData(bytes);
    stopPreviewPlayback();
    previewSource = audioCtx.createBufferSource();
    previewSource.buffer = buffer;
    previewSource.connect(audioCtx.destination);
    previewSource.onended = () => { previewSource = null; };
    previewSource.start();
}

function resetPreviewUI() {
    const btn = document.getElementById('preview-btn');
    btn.disabled = false;
    btn.textContent = '[ Preview ]';
    setBusy(false);
}

async function runPreview() {
    if (!audioBuffer || isBusy || sessionExpired) return;
    // resume inside the click gesture so playback is unlocked on iOS
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    const [w0, w1] = previewWindow(getCurrentTime());
    const params = buildWindowParams(w0, w1);
    if (params.speeds.length === 0 || params.speeds.every(s => s === 0)) {
        showNotification('All sections in the preview window are skipped.');
        return;
    }
    if (isPlaying) pause();
    const btn = document.getElementById('preview-btn');
    btn.disabled = true;
    btn.textContent = '[ Preview... ]';
    setBusy(true);
    try {
        const fd = new FormData();
        fd.append('file', audioBufferToWav(audioBuffer, w0, w1), 'preview.wav');
        fd.append('timestamps_str', JSON.stringify(params.timestamps));
        fd.append('speeds_str', JSON.stringify(params.speeds));
        fd.append('overall_factor', 1.0);
        fd.append('volumes_str', JSON.stringify(params.volumes));

        const resp = await fetchWithRetry(`${CONFIG.API_BASE_URL}/upload-audio/`, { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

        pollStatus(data.task_id, {
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
        showNotification(e instanceof TypeError
            ? 'connection failed - check your network and try again.'
            : e.message);
        resetPreviewUI();
    }
}

// ── Export ──────────────────────────────────────────────────────
// fetch() rejects with TypeError only when the request died at the network
// level (no HTTP response at all) - a phone radio waking from idle or a
// wifi/cellular handoff. Those are safe to retry; anything else is rethrown.
async function fetchWithRetry(url, options, retries = 2) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetch(url, options);
        } catch (e) {
            if (!(e instanceof TypeError) || attempt >= retries) throw e;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
}

async function runAndExport() {
    const timestamps = segments.length > 0 ? segments.slice(0, -1).map(s => s.endTime ?? 0) : [];
    // speed 0 tells the backend to drop the section (process_audio skips speed-0 segments)
    const speeds = segments.length > 0 ? segments.map(s => s.skip ? 0 : s.speed) : [1.0];
    const volumes = segments.length > 0 ? segments.map(s => s.volume) : [1.0];
    const globalSpeed = 1.0;

    const banner = document.getElementById('status-banner');
    const statusText = document.getElementById('status-text');

    if (!audioFile) {
        alert('Upload an audio file first.');
        return;
    }
    // Backstop for the expiry timer (which a sleeping device can miss): block
    // export of a session past its one-week window and show the expired notice.
    if (sessionExpired || (sessionSavedAt && Date.now() - sessionSavedAt >= SESSION_TTL_MS)) {
        expireSession();
        return;
    }
    if (segments.length > 0 && segments.every(s => s.skip)) {
        showNotification('All sections are skipped - nothing to export.');
        return;
    }
    setBusy(true);

    clearTimeout(bannerHideTimer);
    banner.style.display = 'block';
    banner.className = 'proc';
    statusText.textContent = 'uploading...';
    startPet();

    try {
        const fd = new FormData();
        fd.append('file', audioFile);
        fd.append('timestamps_str', JSON.stringify(timestamps));
        fd.append('speeds_str', JSON.stringify(speeds));
        fd.append('overall_factor', globalSpeed);
        fd.append('volumes_str', JSON.stringify(volumes));

        const resp = await fetchWithRetry(`${CONFIG.API_BASE_URL}/upload-audio/`, { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);

        statusText.textContent = 'processing...';
        checkTaskProgress(data.task_id);
    } catch (e) {
        stopPet();
        banner.className = 'fail';
        // TypeError = network-level failure (WebKit says "Load failed",
        // Chromium "Failed to fetch") - give an actionable message instead
        statusText.textContent = e instanceof TypeError
            ? 'connection failed - check your network and try again.'
            : `error: ${e.message}`;
        setBusy(false);
    }
}

let bannerHideTimer = null;

// Poll /check-status/ until the task ends; the callbacks decide what the
// result means (export downloads the mp3, preview plays it inline).
function pollStatus(taskId, { onProgress, onDone, onFail }) {
    let pollFailures = 0;
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/check-status/${taskId}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            pollFailures = 0;

            if (data.status === 'done') {
                clearInterval(interval);
                onDone(data);
            } else if (data.status === 'failed') {
                clearInterval(interval);
                onFail(ERROR_MESSAGES[data.error] || ERROR_MESSAGES.server_error);
            } else if (onProgress) {
                onProgress(data.progress);
            }
        } catch (err) {
            // a brief network blip should not kill the poll while the server
            // is still processing; only give up after 3 failures in a row
            pollFailures++;
            if (pollFailures < 3) return;
            clearInterval(interval);
            onFail(err instanceof TypeError
                ? 'connection failed - check your network and try again.'
                : 'error: ' + err.message);
        }
    }, CONFIG.POLLING_INTERVAL_MS);
}

function checkTaskProgress(taskId) {
    const banner = document.getElementById('status-banner');
    const statusText = document.getElementById('status-text');
    pollStatus(taskId, {
        onProgress: p => {
            statusText.textContent = 'processing...';
            renderProgress(p);
        },
        onDone: data => {
            stopPet();
            const fileUrl = CONFIG.API_BASE_URL + data.file_url;
            banner.className = 'ok';
            statusText.innerHTML = `done &mdash; <a href="${fileUrl}">download mp3</a>`;
            const a = document.createElement('a');
            a.href = fileUrl;
            a.download = `musiclab_${taskId}.mp3`;
            a.click();
            // generate the report together with the mp3 so both filenames
            // carry (nearly) the same timestamp; stagger the second download
            // so browsers don't flag simultaneous automatic downloads
            if (document.getElementById('export-report-check').checked) {
                setTimeout(downloadReport, 800);
            }
            setBusy(false);
            clearTimeout(bannerHideTimer);
            bannerHideTimer = setTimeout(() => { banner.style.display = 'none'; }, 5000);
        },
        onFail: msg => {
            stopPet();
            banner.className = 'fail';
            statusText.textContent = msg;
            setBusy(false);
        },
    });
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    segments = [];
    renderSegments();

    // Upload zone
    const zone = document.getElementById('upload-zone');
    zone.addEventListener('click', () => {
        if (isBusy) return;
        document.getElementById('audio-file-input').click();
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (isBusy) return;
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    document.getElementById('audio-file-input').addEventListener('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
    });

    // Returning-user modal
    document.getElementById('resume-continue-btn').addEventListener('click', () => {
        if (pendingSession) restoreSession(pendingSession);
    });
    document.getElementById('resume-newedit-btn').addEventListener('click', () => {
        // Keep the saved session until a new upload overwrites it, so an
        // accidental tap here is recoverable by refreshing the page.
        hideResumeModal();
    });
    checkForSavedSession();

    // Player
    document.getElementById('restart-btn').addEventListener('click', playFromStart);
    document.getElementById('play-btn').addEventListener('click', togglePlay);
    document.getElementById('preview-btn').addEventListener('click', runPreview);
    document.getElementById('waveform-wrap').addEventListener('click', seekTo);

    // Collapsible "learn more" help panels
    function wireInfoToggle(btnId, panelId) {
        document.getElementById(btnId).addEventListener('click', () => {
            const panel = document.getElementById(panelId);
            panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
        });
    }
    wireInfoToggle('shortcuts-toggle', 'shortcuts-panel');
    wireInfoToggle('crossfade-toggle', 'crossfade-panel');

    // Waveform zoom: keep the playhead anchored at its on-screen position,
    // or keep the view centre in place when the playhead is off-screen
    const zoomSlider = document.getElementById('zoom-slider');
    zoomSlider.addEventListener('input', () => {
        const inner = document.getElementById('waveform-inner');
        const viewW = document.getElementById('waveform-wrap').clientWidth;
        const oldWaveW = getWaveWidth();
        const playheadX = totalDuration > 0
            ? (getCurrentTime() / totalDuration) * oldWaveW - inner.scrollLeft
            : 0;
        const anchor = playheadX >= 0 && playheadX <= viewW ? playheadX : viewW / 2;
        const anchorTime = ((inner.scrollLeft + anchor) / oldWaveW) * totalDuration;
        waveformZoom = parseFloat(zoomSlider.value);
        document.getElementById('zoom-value').textContent = waveformZoom.toFixed(1) + 'x';
        if (!audioBuffer) return;
        drawWaveform(); // resize the canvas first so the new scrollLeft is not clamped
        renderSectionLane();
        inner.scrollLeft = (anchorTime / totalDuration) * getWaveWidth() - anchor;
        updatePlayheadUI();
    });

    // Section lane: scroll with the waveform
    const waveInner = document.getElementById('waveform-inner');
    const laneContent = document.getElementById('section-lane-content');
    waveInner.addEventListener('scroll', () => {
        laneContent.style.transform = `translateX(${-waveInner.scrollLeft}px)`;
    });

    // Section lane: click a block to show its row in the table
    laneContent.addEventListener('click', e => {
        e.stopPropagation();
        const block = e.target.closest('.lane-block');
        if (block) highlightSegmentRow(parseInt(block.dataset.index, 10));
    });

    // Section lane: drag a divider to move the split point
    laneContent.addEventListener('pointerdown', e => {
        const handle = e.target.closest('.lane-handle');
        if (!handle) return;
        e.preventDefault();
        e.stopPropagation();
        const i = parseInt(handle.dataset.index, 10);
        const leftBlock = laneContent.querySelector(`.lane-block[data-index="${i}"]`);
        const rightBlock = laneContent.querySelector(`.lane-block[data-index="${i + 1}"]`);
        const endInput = document.querySelector(`.seg-end[data-index="${i}"]`);
        // capture the pointer: events keep arriving outside the lane, and the
        // click fired on release targets the handle instead of the waveform
        handle.setPointerCapture(e.pointerId);

        function onMove(ev) {
            const rect = waveInner.getBoundingClientRect();
            const waveW = getWaveWidth();
            const t = ((ev.clientX - rect.left + waveInner.scrollLeft) / waveW) * totalDuration;
            const clamped = clampSegmentEnd(i, t);
            if (clamped === null) return;
            segments[i].endTime = clamped;
            // move just the handle and its two blocks; full re-render on release
            const x = (clamped / totalDuration) * waveW;
            const leftStart = ((i === 0 ? 0 : (segments[i - 1].endTime ?? totalDuration)) / totalDuration) * waveW;
            const rightEnd = (((segments[i + 1].endTime ?? totalDuration)) / totalDuration) * waveW;
            handle.style.left = x + 'px';
            leftBlock.style.width = (x - leftStart) + 'px';
            rightBlock.style.left = x + 'px';
            rightBlock.style.width = (rightEnd - x) + 'px';
            if (endInput) endInput.value = clamped.toFixed(2);
        }

        function onUp() {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            renderSegments();
        }

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
    document.addEventListener('keydown', e => {
        if (e.code === 'Space' && document.activeElement === document.body) {
            e.preventDefault();
            togglePlay();
        }
        if (e.code === 'ArrowLeft' && document.activeElement === document.body) {
            e.preventDefault();
            playFromStart();
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
        if (e.target.classList.contains('seg-volume')) {
            commitSegmentVolume(parseInt(e.target.dataset.index, 10));
        }
        if (e.target.classList.contains('seg-skip')) {
            segments[parseInt(e.target.dataset.index, 10)].skip = e.target.checked;
            renderSegments();
        }
        // commitSegmentSpeed/Volume do not re-render, so persist here too
        saveMeta();
    });
    segContainer.addEventListener('input', e => {
        if (e.target.classList.contains('seg-speed')) {
            updateSegmentSpeed(parseInt(e.target.dataset.index, 10), e.target.value);
        }
        if (e.target.classList.contains('seg-volume')) {
            updateSegmentVolume(parseInt(e.target.dataset.index, 10), e.target.value);
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
            input.value = Math.round(base + step);
            commitSegmentSpeed(i);
        } else if (btn.dataset.kind === 'volume') {
            const base = isNaN(cur) ? (segments[i].volume * 100) : cur;
            input.value = Math.round(base + step);
            commitSegmentVolume(i);
        } else {
            const base = isNaN(cur) ? (segments[i].endTime ?? totalDuration) : cur;
            updateSegmentEnd(i, (base + step).toFixed(2));
        }
        // commitSegmentSpeed/Volume do not re-render, so persist stepper edits here too
        saveMeta();
    });

    // ── File Handling ────────────────────────────────────────────────
    async function extractAudioOnServer(file) {
        const fd = new FormData();
        fd.append('file', file);
        const resp = await fetch(`${CONFIG.API_BASE_URL}/extract-audio/`, { method: 'POST', body: fd });
        if (!resp.ok) throw new Error('this file could not be decoded');
        const blob = await resp.blob();
        const name = file.name.replace(/\.[^.]+$/, '') + '.mp3';
        return new File([blob], name, { type: 'audio/mpeg' });
    }

    async function handleFile(file) {
        hideUploadError();
        if (file.size > CONFIG.MAX_UPLOAD_BYTES) {
            showUploadError('File is too large - max 50 MB.');
            return;
        }
        setBusy(true);
        let ctx;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            try {
                audioFile = file;
                audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
            } catch (err) {
                // Safari cannot decode video containers; extract the audio track server-side
                audioFile = await extractAudioOnServer(file);
                audioBuffer = await ctx.decodeAudioData(await audioFile.arrayBuffer());
            }
            if (audioCtx) audioCtx.close();
            sourceNode = null;
            audioCtx = ctx;
            totalDuration = audioBuffer.duration;
            playOffset = 0;
            isPlaying = false;
            waveformZoom = 1;
            segments = [{ endTime: null, speed: 1.0, volume: 1.0, skip: false }];
            revealEditor(file.name);
            saveBlob(audioFile);
            saveMeta();
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
            showUploadError('Could not load this file - try a different one or convert it to MP3/WAV.');
        } finally {
            setBusy(false);
        }
    }
});
