// MP3 encoding in the browser, via the vendored lamejs.
//
// This is the only module allowed to know which encoder is used. Callers see
// encodeMp3() and nothing else, so the implementation can be swapped in one
// place if lamejs's LGPL ever becomes a problem (ADR 0006 amendment).
//
// Levels are not touched here. renderTimeline already applied peak safety, and
// scaling again would undo it.
import { MP3_KBPS } from './config.js';

// lamejs is a classic script that defines a global and calls it to attach
// Mp3Encoder, so it cannot be `import`ed. Injected once and cached; 530 KB is
// not worth paying on a page load that never exports.
let loading = null;
function loadEncoder() {
    if (!loading) {
        loading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            // resolved against this module, not the document: index.html and the
            // dev harness sit at different depths
            s.src = new URL('../vendor/lamejs.js', import.meta.url).href;
            s.onload = () => window.lamejs
                ? resolve(window.lamejs)
                : reject(new Error('lamejs loaded but exposed no global'));
            s.onerror = () => {
                loading = null; // let a later export retry
                reject(new Error('could not load the mp3 encoder'));
            };
            document.head.appendChild(s);
        });
    }
    return loading;
}

// lamejs's granule size. Feeding it whole multiples keeps every call aligned to
// a frame boundary.
const FRAME = 1152;
// Frames per turn of the event loop. Measured at ~0.85 ms of work per frame on
// an M-series Mac (26.5x realtime), so 48 frames is ~40 ms - short enough that
// the page keeps painting, long enough that the yield itself is not the cost.
// An earlier 200 blocked the main thread for 169 ms per turn, which stutters.
const FRAMES_PER_TURN = 48;

function toInt16(src, from, count, out) {
    for (let i = 0; i < count; i++) {
        const v = Math.max(-1, Math.min(1, src[from + i]));
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
}

// Encode an AudioBuffer as an MP3 Blob. onProgress receives 0..1.
export async function encodeMp3(buffer, { kbps = MP3_KBPS, onProgress } = {}) {
    const lame = await loadEncoder();
    const channels = Math.min(2, buffer.numberOfChannels);
    const left = buffer.getChannelData(0);
    const right = channels > 1 ? buffer.getChannelData(1) : null;
    const total = buffer.length;

    const encoder = new lame.Mp3Encoder(channels, buffer.sampleRate, kbps);
    const parts = [];
    // Reused per chunk so a long file does not allocate a second full-length
    // copy of itself - the whole point of encoding incrementally.
    const bufL = new Int16Array(FRAME);
    const bufR = channels > 1 ? new Int16Array(FRAME) : null;

    let at = 0;
    let sinceYield = 0;
    while (at < total) {
        const count = Math.min(FRAME, total - at);
        // a short final chunk must not carry stale samples from the last one
        const l = count === FRAME ? toInt16(left, at, count, bufL)
            : toInt16(left, at, count, new Int16Array(count));
        let block;
        if (right) {
            const r = count === FRAME ? toInt16(right, at, count, bufR)
                : toInt16(right, at, count, new Int16Array(count));
            block = encoder.encodeBuffer(l, r);
        } else {
            block = encoder.encodeBuffer(l);
        }
        if (block.length > 0) parts.push(new Uint8Array(block));
        at += count;

        if (++sinceYield >= FRAMES_PER_TURN) {
            sinceYield = 0;
            if (onProgress) onProgress(at / total);
            // setTimeout, not microtask: a resolved promise would not let the
            // browser paint between batches
            await new Promise(r => setTimeout(r));
        }
    }

    const tail = encoder.flush();
    if (tail.length > 0) parts.push(new Uint8Array(tail));
    if (onProgress) onProgress(1);
    return new Blob(parts, { type: 'audio/mpeg' });
}
