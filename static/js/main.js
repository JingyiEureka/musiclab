// Entry point: file loading, the editor reveal, and all DOM event wiring.
import { CONFIG } from './config.js';
import { state, getCurrentTime } from './state.js';
import {
    setBusy, showUploadError, hideUploadError, setUploadLoading, loadingHold,
    showResumeModal, hideResumeModal, formatTime,
} from './ui.js';
import {
    saveBlob, saveMeta, armExpiry, idbClear, checkForSavedSession,
} from './session.js';
import { drawWaveform, updatePlayheadUI, getWaveWidth } from './waveform.js';
import { togglePlay, playFromStart, seekTo, updatePlayUI } from './player.js';
import {
    renderSegments, renderSectionLane, addSegment, mergeWithNext, highlightSegmentRow,
    clampSegmentEnd, updateSegmentEnd, updateSegmentSpeed, commitSegmentSpeed,
    updateSegmentVolume, commitSegmentVolume, newSegment, normalizeSegments,
    commitSeamMs, updateSeamCurve,
} from './segments.js';
import { invalidateTimeline } from './timeline.js';
import { runAndExport } from './export.js';

// Reveal the editor UI and sync the header, zoom, and waveform to the current
// state. Shared by a fresh upload (handleFile) and a restored session.
function revealEditor(filename) {
    hideResumeModal();
    document.getElementById('upload-zone').style.display = 'none';
    document.getElementById('player-section').style.display = 'block';
    document.getElementById('sections-block').style.display = 'block';
    document.getElementById('output-block').style.display = 'block';
    document.getElementById('player-filename').textContent = '— ' + filename;
    document.getElementById('player-total').textContent = formatTime(state.totalDuration);
    document.getElementById('zoom-slider').value = state.waveformZoom;
    document.getElementById('zoom-value').textContent = state.waveformZoom.toFixed(1) + 'x';
    updatePlayUI();
    drawWaveform();
    updatePlayheadUI();
    renderSegments();
}

async function restoreSession(saved) {
    hideResumeModal();
    setBusy(true);
    setUploadLoading(true);
    const loadStart = performance.now();
    let ctx;
    try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Read the stored blob into memory once and build the upload File from
        // those bytes: WebKit (all iPhone browsers) can fail to POST a File
        // still backed by IndexedDB blob storage with a generic "Load failed".
        const bytes = await saved.blob.arrayBuffer();
        const upload = new File([bytes], saved.filename, { type: saved.blob.type });
        state.audioBuffer = await ctx.decodeAudioData(bytes);
        if (state.audioCtx) state.audioCtx.close();
        state.audioCtx = ctx;
        state.audioFile = upload;
        state.totalDuration = state.audioBuffer.duration;
        state.playOffset = 0;
        state.isPlaying = false;
        state.waveformZoom = saved.waveformZoom || 1;
        state.segments = normalizeSegments(saved.segments);
        state.sessionSavedAt = saved.savedAt || Date.now();
        await loadingHold(loadStart);
        revealEditor(saved.filename);
        armExpiry(state.sessionSavedAt);
    } catch (e) {
        if (ctx) ctx.close();
        await idbClear().catch(() => {});
        showUploadError('Could not restore your previous session - please re-upload.');
    } finally {
        setUploadLoading(false);
        setBusy(false);
    }
}

// Safari cannot decode video containers; extract the audio track server-side.
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
    setUploadLoading(true);
    const loadStart = performance.now();
    let ctx;
    try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        try {
            state.audioFile = file;
            state.audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
        } catch (err) {
            state.audioFile = await extractAudioOnServer(file);
            state.audioBuffer = await ctx.decodeAudioData(await state.audioFile.arrayBuffer());
        }
        if (state.audioCtx) state.audioCtx.close();
        state.sourceNode = null;
        state.audioCtx = ctx;
        state.totalDuration = state.audioBuffer.duration;
        state.playOffset = 0;
        state.isPlaying = false;
        state.waveformZoom = 1;
        state.segments = [newSegment()];
        await loadingHold(loadStart);
        revealEditor(file.name);
        saveBlob(state.audioFile);
        saveMeta();
    } catch (e) {
        if (ctx) ctx.close();
        const zone = document.getElementById('upload-zone');
        if (zone) zone.style.display = 'block';
        const section = document.getElementById('player-section');
        if (section) section.style.display = 'none';
        document.getElementById('sections-block').style.display = 'none';
        document.getElementById('output-block').style.display = 'none';
        state.audioFile = null;
        state.audioBuffer = null;
        state.totalDuration = 0;
        showUploadError('Could not load this file - try a different one or convert it to MP3/WAV.');
    } finally {
        setUploadLoading(false);
        setBusy(false);
    }
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    state.segments = [];
    renderSegments();

    // Upload zone
    const zone = document.getElementById('upload-zone');
    zone.addEventListener('click', () => {
        if (state.isBusy) return;
        document.getElementById('audio-file-input').click();
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('drag-over');
        if (state.isBusy) return;
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    document.getElementById('audio-file-input').addEventListener('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
    });

    // Returning-user modal
    let pendingSession = null;
    document.getElementById('resume-continue-btn').addEventListener('click', () => {
        if (pendingSession) restoreSession(pendingSession);
    });
    document.getElementById('resume-newedit-btn').addEventListener('click', () => {
        // Keep the saved session until a new upload overwrites it, so an
        // accidental tap here is recoverable by refreshing the page.
        hideResumeModal();
    });
    checkForSavedSession().then(saved => {
        if (!saved) return;
        pendingSession = saved;
        showResumeModal(saved.filename);
    });

    // Player
    document.getElementById('restart-btn').addEventListener('click', playFromStart);
    document.getElementById('play-btn').addEventListener('click', togglePlay);
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
        const playheadX = state.totalDuration > 0
            ? (getCurrentTime() / state.totalDuration) * oldWaveW - inner.scrollLeft
            : 0;
        const anchor = playheadX >= 0 && playheadX <= viewW ? playheadX : viewW / 2;
        const anchorTime = ((inner.scrollLeft + anchor) / oldWaveW) * state.totalDuration;
        state.waveformZoom = parseFloat(zoomSlider.value);
        document.getElementById('zoom-value').textContent = state.waveformZoom.toFixed(1) + 'x';
        if (!state.audioBuffer) return;
        drawWaveform(); // resize the canvas first so the new scrollLeft is not clamped
        renderSectionLane();
        inner.scrollLeft = (anchorTime / state.totalDuration) * getWaveWidth() - anchor;
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
            const t = ((ev.clientX - rect.left + waveInner.scrollLeft) / waveW) * state.totalDuration;
            const clamped = clampSegmentEnd(i, t);
            if (clamped === null) return;
            state.segments[i].endTime = clamped;
            // move just the handle and its two blocks; full re-render on release
            const x = (clamped / state.totalDuration) * waveW;
            const leftStart = ((i === 0 ? 0 : (state.segments[i - 1].endTime ?? state.totalDuration)) / state.totalDuration) * waveW;
            const rightEnd = (((state.segments[i + 1].endTime ?? state.totalDuration)) / state.totalDuration) * waveW;
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
            state.segments[parseInt(e.target.dataset.index, 10)].skip = e.target.checked;
            renderSegments();
        }
        if (e.target.classList.contains('seg-seam-ms')) {
            commitSeamMs(parseInt(e.target.dataset.index, 10));
        }
        if (e.target.classList.contains('seg-seam-curve')) {
            updateSeamCurve(parseInt(e.target.dataset.index, 10), e.target.value);
        }
        // commitSegmentSpeed/Volume do not re-render, so persist and re-warm here too
        saveMeta();
        invalidateTimeline();
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
            const base = isNaN(cur) ? (state.segments[i].speed * 100) : cur;
            input.value = Math.round(base + step);
            commitSegmentSpeed(i);
        } else if (btn.dataset.kind === 'volume') {
            const base = isNaN(cur) ? (state.segments[i].volume * 100) : cur;
            input.value = Math.round(base + step);
            commitSegmentVolume(i);
        } else if (btn.dataset.kind === 'seam') {
            const base = isNaN(cur) ? (state.segments[i].seam?.ms ?? 20) : cur;
            input.value = Math.round(base + step);
            commitSeamMs(i);
        } else {
            const base = isNaN(cur) ? (state.segments[i].endTime ?? state.totalDuration) : cur;
            updateSegmentEnd(i, (base + step).toFixed(2));
        }
        // commitSegmentSpeed/Volume do not re-render, so persist and re-warm here too
        saveMeta();
        invalidateTimeline();
    });
});
