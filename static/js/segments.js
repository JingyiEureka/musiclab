// Section editing: the table rows, the labeled lane above the waveform, and
// the clamping rules that keep split points valid.
import { state, getCurrentTime } from './state.js';
import { formatTime, showNotification } from './ui.js';
import { getWaveWidth } from './waveform.js';
import { applyGainSchedule } from './player.js';
import { saveMeta } from './session.js';

export function clampSpeed(mult) {
    return Math.max(0.25, Math.min(8.0, mult));
}

export function clampVolume(mult) {
    return Math.max(0, Math.min(4.0, mult));
}

// A, B, ... Z, AA, AB ... (spreadsheet-style)
export function segLabel(i) {
    let label = '';
    i += 1;
    while (i > 0) {
        i -= 1;
        label = String.fromCharCode(65 + (i % 26)) + label;
        i = Math.floor(i / 26);
    }
    return label;
}

// ── Duration prediction ─────────────────────────────────────────
export function getFinalTotalDuration() {
    if (!state.totalDuration) return 0;
    if (state.segments.length === 0) return state.totalDuration;
    let finalDur = 0, prevOrig = 0;
    state.segments.forEach(seg => {
        const origEnd = seg.endTime !== null ? seg.endTime : state.totalDuration;
        if (!seg.skip) finalDur += (origEnd - prevOrig) / seg.speed;
        prevOrig = origEnd;
    });
    return finalDur;
}

export function updatePredictedDuration() {
    const el = document.getElementById('predicted-duration-text');
    if (el) el.textContent = formatTime(getFinalTotalDuration());
}

// ── Section lane (labeled blocks above the waveform) ───────────
export function renderSectionLane() {
    const lane = document.getElementById('section-lane-content');
    lane.innerHTML = '';
    if (!state.totalDuration || state.segments.length === 0) return;
    const waveW = getWaveWidth();
    lane.style.width = waveW + 'px';
    let start = 0;
    state.segments.forEach((seg, i) => {
        const end = seg.endTime ?? state.totalDuration;
        const block = document.createElement('div');
        block.className = 'lane-block' + (seg.skip ? ' skipped' : '');
        block.dataset.index = i;
        block.style.left = (start / state.totalDuration) * waveW + 'px';
        block.style.width = ((end - start) / state.totalDuration) * waveW + 'px';
        block.textContent = segLabel(i);
        block.title = 'click to show this section in the table';
        lane.appendChild(block);
        if (i < state.segments.length - 1) {
            const handle = document.createElement('div');
            handle.className = 'lane-handle';
            handle.dataset.index = i;
            handle.title = 'drag to move this split';
            handle.style.left = (end / state.totalDuration) * waveW + 'px';
            lane.appendChild(handle);
        }
        start = end;
    });
}

export function highlightSegmentRow(i) {
    const row = document.querySelector(`.segment-row[data-index="${i}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('highlight');
    setTimeout(() => row.classList.remove('highlight'), 1200);
}

export function renderSegments() {
    const container = document.getElementById('segments-container');
    container.innerHTML = '';

    if (state.segments.length > 0) {
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
    state.segments.forEach((seg, i) => {
        const isLast = i === state.segments.length - 1;
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
                    ? `<span class="seg-end-static">${state.totalDuration.toFixed(2)}</span>`
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

        if (!isLast && !skipped && !state.segments[i + 1].skip) {
            const divider = document.createElement('div');
            divider.className = 'seg-merge-divider';
            divider.innerHTML = `<button class="btn-merge" data-index="${i}"
                title="Merge these two sections (remove split)">merge</button>`;
            container.appendChild(divider);
        }

        prevEnd = seg.endTime ?? state.totalDuration;
    });

    renderSectionLane();
    updatePredictedDuration();
    if (state.isPlaying) applyGainSchedule();
    saveMeta();
}

export function addSegment() {
    if (!state.totalDuration) {
        showNotification('Upload an audio file first.');
        return;
    }
    if (state.segments.length === 0) {
        state.segments = [{ endTime: null, speed: 1.0, volume: 1.0, skip: false }];
    }
    const t = parseFloat(Math.max(0, Math.min(state.totalDuration, getCurrentTime())).toFixed(2));
    let prevEnd = 0;
    for (let j = 0; j < state.segments.length; j++) {
        const end = state.segments[j].endTime ?? state.totalDuration;
        if (t < end) {
            if (t <= prevEnd + 0.5 || t >= end - 0.5) {
                showNotification('Split must be at least 0.5s from existing boundaries.');
                return;
            }
            state.segments.splice(j, 0, {
                endTime: t,
                speed: state.segments[j].speed,
                volume: state.segments[j].volume,
                skip: state.segments[j].skip,
            });
            renderSegments();
            return;
        }
        prevEnd = end;
    }
    showNotification('Split must be at least 0.5s from existing boundaries.');
}

export function mergeWithNext(i) {
    if (i >= state.segments.length - 1) return;
    state.segments[i].endTime = state.segments[i + 1].endTime;
    state.segments.splice(i + 1, 1);
    renderSegments();
}

// Clamp a boundary time for segment i to 0.5s from its neighbours;
// returns the rounded value, or null if the boundary cannot move.
export function clampSegmentEnd(i, t) {
    const segments = state.segments;
    const prevBound = i === 0 ? 0 : (segments[i - 1].endTime ?? state.totalDuration);
    const nextBound = i >= segments.length - 1 ? state.totalDuration : (segments[i + 1].endTime ?? state.totalDuration);
    const minEnd = prevBound + 0.5;
    const maxEnd = nextBound - 0.5;
    if (minEnd > maxEnd) return null;
    return parseFloat(Math.max(minEnd, Math.min(maxEnd, t)).toFixed(2));
}

export function updateSegmentEnd(i, val) {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return;
    const clamped = clampSegmentEnd(i, num);
    if (clamped === null) return;
    state.segments[i].endTime = clamped;
    renderSegments();
}

export function updateSegmentSpeed(i, val) {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    state.segments[i].speed = clampSpeed(num / 100);
    updatePredictedDuration();
}

export function commitSegmentSpeed(i) {
    const input = document.querySelector(`.seg-speed[data-index="${i}"]`);
    if (!input) return;
    const trimmed = input.value.trim();
    if (trimmed === '') {
        input.value = ((state.segments[i]?.speed ?? 1.0) * 100).toFixed(0);
        return;
    }
    let num = parseFloat(trimmed);
    if (isNaN(num)) num = 100;
    const raw = num / 100;
    const speed = clampSpeed(raw);
    if (speed !== raw) {
        showNotification('Speed range: 25% to 800%');
    }
    state.segments[i].speed = speed;
    input.value = (speed * 100).toFixed(0);
    updatePredictedDuration();
}

export function updateSegmentVolume(i, val) {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    state.segments[i].volume = clampVolume(num / 100);
    if (state.isPlaying) applyGainSchedule();
}

export function commitSegmentVolume(i) {
    const input = document.querySelector(`.seg-volume[data-index="${i}"]`);
    if (!input) return;
    const trimmed = input.value.trim();
    if (trimmed === '') {
        input.value = ((state.segments[i]?.volume ?? 1.0) * 100).toFixed(0);
        return;
    }
    let num = parseFloat(trimmed);
    if (isNaN(num)) num = 100;
    const raw = num / 100;
    const volume = clampVolume(raw);
    if (volume !== raw) {
        showNotification('Volume range: 0% to 400%');
    }
    state.segments[i].volume = volume;
    input.value = (volume * 100).toFixed(0);
    if (state.isPlaying) applyGainSchedule();
}
