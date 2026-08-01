// Client-side session persistence.
// The whole edit lives in the browser; export re-uploads the file each time,
// so nothing of the session is on the server. We save the uploaded file and
// the edit metadata to IndexedDB so a refresh or crash does not lose the work.
// The session expires a week after the last edit (sliding window, so active
// editing never expires mid-work). This is client-only and re-decodes its own
// stored file, so it is independent of the shorter server file sweep.
import { SESSION_TTL_MS } from './config.js';
import { state } from './state.js';
import { banner, stopPet } from './ui.js';
import { pause } from './player.js';

const DB_NAME = 'musiclab';
const STORE = 'session';
const BLOB_KEY = 'blob'; // written once per file: the raw upload, re-decoded on restore
const META_KEY = 'meta'; // written on every edit: segments, zoom, savedAt

let saveTimer = null;
let expiryTimer = null;

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

export function idbClear() {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    }));
}

// Store the raw upload once; safe to fire-and-forget (private mode may reject).
export function saveBlob(file) {
    idbPut(BLOB_KEY, { blob: file, filename: file.name }).catch(() => {});
}

// Persist edit metadata, debounced so rapid edits do not hammer IndexedDB.
// Each save resets the sliding expiry window.
export function saveMeta() {
    if (!state.audioFile || state.sessionExpired) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        state.sessionSavedAt = Date.now();
        idbPut(META_KEY, {
            segments: state.segments,
            waveformZoom: state.waveformZoom,
            savedAt: state.sessionSavedAt,
        }).catch(() => {});
        armExpiry(state.sessionSavedAt);
    }, 500);
}

// Schedule the expiry flip for when the session crosses its one-week window.
// A backstop check in runAndExport covers the case where the device slept
// through this timer.
export function armExpiry(savedAt) {
    clearTimeout(expiryTimer);
    const remaining = Math.max(0, SESSION_TTL_MS - (Date.now() - savedAt));
    expiryTimer = setTimeout(expireSession, remaining);
}

export function expireSession() {
    clearTimeout(expiryTimer);
    state.sessionExpired = true;
    idbClear().catch(() => {});
    if (state.isPlaying) pause();
    stopPet();
    document.getElementById('export-btn').disabled = true;
    banner.show('fail', 'previous edit has expired, please refresh the page and re-upload.');
}

// On load, return the saved session to offer for resuming, or null if there
// is nothing usable stored.
export async function checkForSavedSession() {
    let blobRec, meta;
    try {
        blobRec = await idbGet(BLOB_KEY);
        meta = await idbGet(META_KEY);
    } catch (e) {
        return null;
    }
    if (!blobRec || !blobRec.blob || !meta) return null;
    if (Date.now() - (meta.savedAt || 0) >= SESSION_TTL_MS) {
        await idbClear().catch(() => {});
        return null;
    }
    return { ...blobRec, ...meta };
}
