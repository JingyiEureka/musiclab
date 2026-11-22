// Small DOM helpers: busy state, notifications, the loading spinner, and the
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

// sticky keeps an error on screen instead of hiding it after 2.5s, so it can be
// read or screenshotted on a device with no console.
export function showNotification(msg, sticky = false) {
    const el = document.getElementById('seg-notification');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    if (!sticky) el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
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

// ── Spinner + progress bar (shown in the status banner) ─────────
// The names startPet/stopPet are kept from the ASCII pet they replaced, so the
// callers in export.js and session.js did not change.
let spinnerEl = null;

export function startPet(elId = 'pet-frame') {
    if (spinnerEl) spinnerEl.hidden = true;
    spinnerEl = document.getElementById(elId);
    spinnerEl.hidden = false;
}

export function stopPet() {
    if (spinnerEl) spinnerEl.hidden = true;
    spinnerEl = null;
    renderProgress(null);
}

const UPLOAD_HINT = 'Drop a song here or tap to choose one';

// Loading state inside the upload zone, used while a file is being read
// and decoded (which can take a while for big files) so the zone does not
// just look frozen.
export function setUploadLoading(loading) {
    document.getElementById('upload-hint').textContent =
        loading ? 'Loading your file...' : UPLOAD_HINT;
    if (loading) startPet('upload-pet'); else stopPet();
}

// Fast decodes would flash the spinner for a single frame, which looks
// like a glitch; hold it briefly so the state change is perceivable.
const MIN_LOADING_MS = 600;

export function loadingHold(t0) {
    const remain = MIN_LOADING_MS - (performance.now() - t0);
    return remain > 0 ? new Promise(r => setTimeout(r, remain)) : Promise.resolve();
}

export function renderProgress(progress) {
    const bar = document.getElementById('progress-bar');
    const text = document.getElementById('progress-text');
    bar.hidden = !progress;
    if (!progress) { text.textContent = ''; return; }
    bar.value = progress.frac;
    text.textContent = Math.round(progress.frac * 100) + '% - ' + progress.stage;
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
