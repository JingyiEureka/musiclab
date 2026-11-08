// Section editing: the table rows, the labeled lane above the waveform, and
// the clamping rules that keep split points valid.
import { SEAM_CURVES, SEAM_DEFAULT, SEAM_MAX_MS } from './config.js';
import { state, getCurrentTime } from './state.js';
import { formatTime, showNotification } from './ui.js';
import { getWaveWidth } from './waveform.js';
import { applyGainSchedule } from './player.js';
import { saveMeta } from './session.js';
import { invalidateTimeline } from './timeline.js';

export function clampSpeed(mult) {
    return Math.max(0.25, Math.min(8.0, mult));
}

export function clampVolume(mult) {
    return Math.max(0, Math.min(4.0, mult));
}

export function clampSeamMs(ms) {
    const n = Math.round(Number(ms));
    if (isNaN(n)) return SEAM_DEFAULT.ms;
    return Math.max(0, Math.min(SEAM_MAX_MS, n));
}

export function newSeam(overrides = {}) {
    return { ...SEAM_DEFAULT, ...overrides };
}

// seg.seam describes the boundary at this section's END. The last section's
// value is unused.
export function newSegment(overrides = {}) {
    return { endTime: null, speed: 1.0, volume: 1.0, skip: false, seam: newSeam(), ...overrides };
}

// Sessions saved before seams existed have no seam field, and a hand-edited
// IndexedDB record could carry an unknown curve name.
export function normalizeSegments(segments) {
    return (segments || []).map(seg => newSegment({
        ...seg,
        seam: newSeam({
            ms: clampSeamMs(seg.seam?.ms ?? SEAM_DEFAULT.ms),
            curve: SEAM_CURVES.includes(seg.seam?.curve) ? seg.seam.curve : SEAM_DEFAULT.curve,
        }),
    }));
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
            // Seam ramp indicator, drawn before the handle so the handle stays on
            // top. Non-interactive: the handle already owns this x position.
            const next = state.segments[i + 1];
            if (!seg.skip && !next.skip && seamIsActive(i)) {
                const seam = seg.seam ?? SEAM_DEFAULT;
                // seam.ms is output time; the lane is source time, so each half
                // scales by the speed of the section it falls in
                const halfOut = seam.ms / 2000;
                const from = Math.max(0, end - halfOut * (seg.speed ?? 1));
                const to = Math.min(state.totalDuration, end + halfOut * (next.speed ?? 1));
                const x0 = (from / state.totalDuration) * waveW;
                const x1 = (to / state.totalDuration) * waveW;
                const ramp = document.createElement('div');
                ramp.className = 'lane-seam';
                ramp.style.left = x0 + 'px';
                ramp.style.width = Math.max(4, x1 - x0) + 'px';
                // shade in the direction of the level change
                ramp.classList.add(next.volume > seg.volume ? 'rising' : 'falling');
                lane.appendChild(ramp);
            }
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

// A seam only does audible work when the two volumes differ; when they match the
// control is shown but dimmed rather than hidden, so it stays discoverable.
function seamIsActive(i) {
    const next = state.segments[i + 1];
    return !!next && Math.abs((state.segments[i].volume ?? 1) - (next.volume ?? 1)) > 1e-6;
}

const CURVE_LABELS = { equalPower: 'equal-power', linear: 'linear', smooth: 'smooth' };

function seamControlHTML(i) {
    const seam = state.segments[i].seam ?? SEAM_DEFAULT;
    const options = SEAM_CURVES.map(c =>
        `<option value="${c}"${c === seam.curve ? ' selected' : ''}>${CURVE_LABELS[c]}</option>`
    ).join('');
    return `<span class="seam-ctl${seamIsActive(i) ? '' : ' inactive'}" data-index="${i}"
            title="volume transition across this boundary; dimmed when the two volumes match">
            <span class="seam-label">seam</span>
            <button class="stepper" data-kind="seam" data-step="-10" data-index="${i}">&lt;</button>
            <input type="number" class="seg-seam-ms" data-index="${i}"
                value="${seam.ms}" min="0" max="${SEAM_MAX_MS}" step="5" />
            <span class="seam-unit">ms</span>
            <button class="stepper" data-kind="seam" data-step="10" data-index="${i}">&gt;</button>
            <select class="seg-seam-curve" data-index="${i}">${options}</select>
        </span>`;
}

// Volume edits do not re-render the table, so refresh just the dimming.
export function refreshSeamActivity() {
    document.querySelectorAll('.seam-ctl').forEach(el => {
        el.classList.toggle('inactive', !seamIsActive(parseInt(el.dataset.index, 10)));
    });
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

        // The divider sits on a boundary between two kept sections, which is
        // exactly where a volume ramp can apply, so the seam control lives here
        // rather than in a section column.
        if (!isLast && !skipped && !state.segments[i + 1].skip) {
            const divider = document.createElement('div');
            divider.className = 'seg-merge-divider';
            divider.innerHTML = `<button class="btn-merge" data-index="${i}"
                    title="Merge these two sections (remove split)">merge</button>
                ${seamControlHTML(i)}`;
            container.appendChild(divider);
        }

        prevEnd = seg.endTime ?? state.totalDuration;
    });

    renderSectionLane();
    updatePredictedDuration();
    if (state.isPlaying) applyGainSchedule();
    saveMeta();
    invalidateTimeline();
}

export function addSegment() {
    if (!state.totalDuration) {
        showNotification('Upload an audio file first.');
        return;
    }
    if (state.segments.length === 0) {
        state.segments = [newSegment()];
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
            // The inserted section is the first half, so it owns the new
            // boundary and gets a default seam. Section j keeps its own seam,
            // which still describes the outer boundary it already ended at.
            state.segments.splice(j, 0, newSegment({
                endTime: t,
                speed: state.segments[j].speed,
                volume: state.segments[j].volume,
                skip: state.segments[j].skip,
            }));
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
    // The surviving boundary is i+1's old end, so its seam has to come along
    // with the endTime. Keeping i's own seam would silently move the setting
    // from the boundary it was authored for to a different one.
    state.segments[i].seam = state.segments[i + 1].seam;
    state.segments.splice(i + 1, 1);
    renderSegments();
}

export function updateSeamMs(i, ms) {
    state.segments[i].seam = newSeam({ ...state.segments[i].seam, ms: clampSeamMs(ms) });
}

export function updateSeamCurve(i, curve) {
    if (!SEAM_CURVES.includes(curve)) return;
    state.segments[i].seam = newSeam({ ...state.segments[i].seam, curve });
}

// Read the input back, clamp it, and redraw the lane indicator. Deliberately
// does not re-render the table, so the field keeps focus while editing.
export function commitSeamMs(i) {
    const input = document.querySelector(`.seg-seam-ms[data-index="${i}"]`);
    if (!input) return;
    const raw = input.value.trim();
    const ms = clampSeamMs(raw === '' ? SEAM_DEFAULT.ms : raw);
    updateSeamMs(i, ms);
    input.value = ms;
    renderSectionLane();
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
    refreshSeamActivity();
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
    refreshSeamActivity();
    renderSectionLane();
    if (state.isPlaying) applyGainSchedule();
}
