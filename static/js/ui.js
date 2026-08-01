// Small DOM helpers: busy state, notifications, the loading pet, and the
// status banner. Everything here is presentation only.
import { state } from './state.js';

export function formatTime(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const dec = Math.floor((s % 1) * 100);
    return `${m}:${sec.toString().padStart(2, '0')}.${dec.toString().padStart(2, '0')}`;
}

export function setBusy(busy) {
    state.isBusy = busy;
    // once the session has expired, export stays disabled
    document.getElementById('export-btn').disabled = busy || state.sessionExpired;
    document.getElementById('audio-file-input').disabled = busy;
    document.getElementById('upload-zone').classList.toggle('disabled', busy);
}

export function showNotification(msg) {
    const el = document.getElementById('seg-notification');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

export function showUploadError(msg) {
    const el = document.getElementById('upload-error');
    el.textContent = msg;
    el.style.display = 'block';
}

export function hideUploadError() {
    document.getElementById('upload-error').style.display = 'none';
}

// ── Returning-user modal ────────────────────────────────────────
export function showResumeModal(filename) {
    document.getElementById('resume-modal-text').textContent =
        'You have a previous edit: ' + filename;
    document.getElementById('resume-modal').style.display = 'flex';
}

export function hideResumeModal() {
    document.getElementById('resume-modal').style.display = 'none';
}

// ── Lab pet + progress bar (shown in the status banner) ─────────
const PET_FRAMES = [
    ' /\\_/\\  .♪ \nd( o.o )b',
    ' /\\_/\\  ♪. \nd( o.o )b',
    ' /\\_/\\ ♪ .*\nd( -.- )b',
    ' /\\_/\\  .♫ \nd( ^.^ )b',
];
let petTimer = null;
let petEl = null;

export function startPet(elId = 'pet-frame') {
    petEl = document.getElementById(elId);
    petEl.style.display = 'block';
    petEl.textContent = PET_FRAMES[0];
    let i = 1;
    clearInterval(petTimer);
    petTimer = setInterval(() => {
        petEl.textContent = PET_FRAMES[i % PET_FRAMES.length];
        i++;
    }, 500);
}

export function stopPet() {
    clearInterval(petTimer);
    petTimer = null;
    if (petEl) petEl.style.display = 'none';
    petEl = null;
    document.getElementById('progress-line').textContent = '';
}

// Loading state inside the upload zone, used while a file is being read
// and decoded (which can take a while for big files) so the zone does not
// just look frozen.
export function setUploadLoading(loading) {
    document.getElementById('upload-hint').textContent =
        loading ? 'loading your file...' : 'Drop or select audio / video';
    if (loading) startPet('upload-pet'); else stopPet();
}

// Fast decodes would flash the loading pet for a single frame, which looks
// like a glitch; hold it briefly so the state change is perceivable.
const MIN_LOADING_MS = 600;

export function loadingHold(t0) {
    const remain = MIN_LOADING_MS - (performance.now() - t0);
    return remain > 0 ? new Promise(r => setTimeout(r, remain)) : Promise.resolve();
}

export function renderProgress(progress) {
    const el = document.getElementById('progress-line');
    if (!progress) { el.textContent = ''; return; }
    const width = 16;
    const filled = Math.round(progress.frac * width);
    el.textContent = '[' + '#'.repeat(filled) + '.'.repeat(width - filled) + '] '
        + Math.round(progress.frac * 100) + '% - ' + progress.stage;
}

// ── Status banner ───────────────────────────────────────────────
// The auto-hide timer lives here so export and session expiry cannot leave a
// stale one running against each other.
let bannerHideTimer = null;

export const banner = {
    show(cls, text) {
        clearTimeout(bannerHideTimer);
        const el = document.getElementById('status-banner');
        el.style.display = 'block';
        el.className = cls;
        this.textEl().textContent = text;
    },
    setText(text) {
        this.textEl().textContent = text;
    },
    setHTML(html) {
        this.textEl().innerHTML = html;
    },
    textEl() {
        return document.getElementById('status-text');
    },
    hideAfter(ms) {
        clearTimeout(bannerHideTimer);
        bannerHideTimer = setTimeout(() => {
            document.getElementById('status-banner').style.display = 'none';
        }, ms);
    },
};
