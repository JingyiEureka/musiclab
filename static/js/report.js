// A human-readable summary of the current edit: file, lengths, and the
// per-section breakdown. Downloaded alongside the export so the user has a
// record they can match to the exported mp3.
import { state } from './state.js';
import { formatTime } from './ui.js';
import { segLabel, getFinalTotalDuration } from './segments.js';

const MUSICLAB_LOGO = [
    '█▀▄▀█ █ █ █▀▀ █ █▀▀   █   █▀█ █▀▄',
    '█ ▀ █ █ █ ▀▀█ █ █     █   █▀█ █▀▄',
    '█   █ █▄█ ▄▄█ █ █▄▄   █▄▄ █ █ █▄▀',
];

export function buildReportText(exportedAt) {
    const filename = state.audioFile ? state.audioFile.name : '(unknown)';
    const orig = state.totalDuration;
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
        'Sections:        ' + state.segments.length,
        '',
        '  ' + pad('#', 4) + pad('Time (original)', 20) + pad('Speed', 8) + pad('Volume', 9) + 'Output',
    ];

    let prev = 0;
    state.segments.forEach((seg, i) => {
        const end = seg.endTime ?? state.totalDuration;
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
// not overwrite each other and each matches its mp3. The body was snapshotted
// at submit time; only the export timestamp is stamped now.
export function downloadReport(body) {
    const stamps = reportStamps();
    const base = (state.audioFile ? state.audioFile.name : 'project').replace(/\.[^.]+$/, '');
    const blob = new Blob([body.replace('@EXPORT_TIME@', stamps.human)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base + '_report_' + stamps.file + '.txt';
    a.click();
    // revoking synchronously can abort the download in some browsers
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
