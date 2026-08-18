// Export: render the timeline, encode it, hand the file to the browser.
//
// Nothing leaves the device. The render comes from getTimeline(), the same
// cache the transport plays from, so the exported file is the audio the user
// auditioned - parity by construction rather than by claim (ADR 0010).
import { state } from './state.js';
import { SESSION_TTL_MS } from './config.js';
import { banner, setBusy, startPet, stopPet, renderProgress } from './ui.js';
import { buildReportText, downloadReport, exportBaseName, reportStamps } from './report.js';
import { expireSession } from './session.js';
import { getTimeline } from './timeline.js';
import { encodeMp3 } from './mp3.js';
import { downloadBlob } from './wav.js';
import { memoryNote } from './player.js';

const TIMING = new URLSearchParams(location.search).has('timing');

export async function runAndExport() {
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
    setBusy(true);

    // Snapshot the report now so it describes exactly what was exported, even
    // if the user keeps editing while the encode runs; the export timestamp is
    // filled in when the file is actually delivered.
    const reportBody = document.getElementById('export-report-check').checked
        ? buildReportText('@EXPORT_TIME@')
        : null;

    startPet();
    // The render has no progress event of its own, so it reads as an
    // indeterminate phase and the bar belongs to the encode.
    banner.show('proc', 'rendering...');

    try {
        const { buffer } = await getTimeline();
        banner.setText('encoding mp3...');
        const startedAt = performance.now();
        const blob = await encodeMp3(buffer, { onProgress: renderProgress });
        deliver(blob, reportBody, performance.now() - startedAt, buffer);
    } catch (e) {
        stopPet();
        banner.show('fail', e && e.code === 'all-skipped'
            ? 'all sections are skipped - nothing to export.'
            : `export failed: ${(e && e.message) || e}`);
        if (!(e && e.code === 'all-skipped')) console.error('export failed', e);
        setBusy(false);
    }
}

function deliver(blob, reportBody, encodeMs, rendered) {
    stopPet();
    const name = `${exportBaseName()}_${reportStamps().file}.mp3`;
    downloadBlob(blob, name);
    banner.show('ok', '');
    // ?timing=1 also reports the export figures, since this is the peak memory
    // moment of the whole app and a phone gives no other way to see it
    if (TIMING) {
        const mb = (blob.size / 1048576).toFixed(1);
        banner.setText(`mp3 ${mb} MB in ${(encodeMs / 1000).toFixed(1)}s`
            + ` · ${memoryNote(rendered)} + ${mb} MB mp3`);
    } else {
        banner.setHTML('done &mdash; mp3 saved');
    }

    // the report downloads together with the mp3 so both filenames carry
    // (nearly) the same timestamp; staggered because browsers flag simultaneous
    // automatic downloads, with a manual link as the fallback in case the
    // second download is still blocked
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
    // keep the banner longer when it carries the report link, and much longer
    // when it carries figures someone is trying to read off a phone
    banner.hideAfter(TIMING ? 120000 : (reportBody ? 15000 : 5000));
}
