// Submitting a job to the server, polling it, and delivering the result.
import { CONFIG, ERROR_MESSAGES, SESSION_TTL_MS } from './config.js';
import { state } from './state.js';
import { banner, setBusy, startPet, stopPet, renderProgress, showNotification } from './ui.js';
import { buildReportText, downloadReport } from './report.js';
import { expireSession } from './session.js';

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

// TypeError = network-level failure; WebKit says "Load failed", Chromium
// "Failed to fetch" - show an actionable message instead of either.
export function networkErrorMessage(e) {
    return e instanceof TypeError
        ? 'connection failed - check your network and try again.'
        : 'error: ' + e.message;
}

// POST a processing job to the server; returns the task_id or throws.
// The client_ref lets the server recognise a retried upload and return the
// already-created task instead of processing the same job twice.
export async function submitJob(file, timestamps, speeds, volumes) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('timestamps_str', JSON.stringify(timestamps));
    fd.append('speeds_str', JSON.stringify(speeds));
    fd.append('overall_factor', 1.0);
    fd.append('volumes_str', JSON.stringify(volumes));
    fd.append('client_ref', crypto.randomUUID ? crypto.randomUUID()
        : Date.now() + '-' + Math.random());
    const resp = await fetchWithRetry(`${CONFIG.API_BASE_URL}/upload-audio/`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    return data.task_id;
}

// Poll /check-status/ until the task ends; the callbacks decide what the
// result means.
// The first check fires immediately so short jobs are not stuck waiting a
// full poll interval; a `finished` flag guarantees onDone/onFail run once
// even if a slow response overlaps the next tick.
export function pollStatus(taskId, { onProgress, onDone, onFail }) {
    let pollFailures = 0;
    let inFlight = false;
    let finished = false;
    let interval = null;

    function finish(cb, arg) {
        if (finished) return;
        finished = true;
        clearInterval(interval);
        cb(arg);
    }

    async function tick() {
        if (inFlight || finished) return;
        inFlight = true;
        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/check-status/${taskId}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            pollFailures = 0;

            if (data.status === 'done') {
                finish(onDone, data);
            } else if (data.status === 'failed') {
                finish(onFail, ERROR_MESSAGES[data.error] || ERROR_MESSAGES.server_error);
            } else if (onProgress) {
                onProgress(data.progress);
            }
        } catch (err) {
            // a brief network blip should not kill the poll while the server
            // is still processing (give up after 3 in a row), but an HTTP
            // error is a real answer - fail immediately
            pollFailures++;
            if (!(err instanceof TypeError) || pollFailures >= 3) {
                finish(onFail, networkErrorMessage(err));
            }
        }
        inFlight = false;
    }

    tick();
    interval = setInterval(tick, CONFIG.POLLING_INTERVAL_MS);
}

export async function runAndExport() {
    const segments = state.segments;
    const timestamps = segments.length > 0 ? segments.slice(0, -1).map(s => s.endTime ?? 0) : [];
    // speed 0 tells the backend to drop the section (process_audio skips speed-0 segments)
    const speeds = segments.length > 0 ? segments.map(s => s.skip ? 0 : s.speed) : [1.0];
    const volumes = segments.length > 0 ? segments.map(s => s.volume) : [1.0];

    if (!state.audioFile) {
        alert('Upload an audio file first.');
        return;
    }
    // Backstop for the expiry timer (which a sleeping device can miss): block
    // export of a session past its one-week window and show the expired notice.
    if (state.sessionExpired
        || (state.sessionSavedAt && Date.now() - state.sessionSavedAt >= SESSION_TTL_MS)) {
        expireSession();
        return;
    }
    if (segments.length > 0 && segments.every(s => s.skip)) {
        showNotification('All sections are skipped - nothing to export.');
        return;
    }
    setBusy(true);

    // Snapshot the report now so it describes exactly what was submitted,
    // even if the user keeps editing sections while the export runs; the
    // export timestamp is filled in when the mp3 actually arrives.
    const reportBody = document.getElementById('export-report-check').checked
        ? buildReportText('@EXPORT_TIME@')
        : null;

    banner.show('proc', 'processing...');
    startPet();

    try {
        const taskId = await submitJob(state.audioFile, timestamps, speeds, volumes);
        checkTaskProgress(taskId, reportBody);
    } catch (e) {
        stopPet();
        banner.show('fail', networkErrorMessage(e));
        setBusy(false);
    }
}

function checkTaskProgress(taskId, reportBody) {
    pollStatus(taskId, {
        onProgress: p => {
            banner.setText('processing...');
            renderProgress(p);
        },
        onDone: data => {
            stopPet();
            const fileUrl = CONFIG.API_BASE_URL + data.file_url;
            banner.show('ok', '');
            banner.setHTML(`done &mdash; <a href="${fileUrl}">download mp3</a>`);
            const a = document.createElement('a');
            a.href = fileUrl;
            a.download = `musiclab_${taskId}.mp3`;
            a.click();
            // the report downloads together with the mp3 so both filenames
            // carry (nearly) the same timestamp; staggered because browsers
            // flag simultaneous automatic downloads, with a manual link as
            // the fallback in case the second download is still blocked
            if (reportBody) {
                setTimeout(() => downloadReport(reportBody), 800);
                const link = document.createElement('a');
                link.href = '#';
                link.textContent = 'report';
                link.addEventListener('click', e => {
                    e.preventDefault();
                    downloadReport(reportBody);
                });
                banner.textEl().append(' · ');
                banner.textEl().append(link);
            }
            setBusy(false);
            // keep the banner longer when it carries the report link
            banner.hideAfter(reportBody ? 15000 : 5000);
        },
        onFail: msg => {
            stopPet();
            banner.show('fail', msg);
            setBusy(false);
        },
    });
}
