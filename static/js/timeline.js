// The full rendered timeline the transport plays, cached between play/pause/seek
// cycles and dropped on any edit.
//
// Deliberately the same preset the export uses. This is the only playback path,
// so what you hear has to be what you get -- a cheaper preset here would make
// playback subtly different from the exported file (ADR 0010).
import { state } from './state.js';
import { buildTimeMap, renderTimeline, PRESET_EXPORT } from './stretch.js';

let cache = null; // { key, buffer, map }
let pending = null; // { key, promise }

function keyFor() {
    return state.totalDuration.toFixed(3) + ':' + JSON.stringify(state.segments);
}

export function invalidateTimeline() {
    cache = null;
    pending = null;
}

// Resolves to { buffer, map }. Throws if every section is skipped.
export async function getTimeline() {
    const key = keyFor();
    if (cache && cache.key === key) return cache;
    if (pending && pending.key === key) return pending.promise;

    const map = buildTimeMap(state.segments, state.totalDuration);
    const promise = renderTimeline(state.audioBuffer, state.segments, {
        preset: PRESET_EXPORT,
    }).then(buffer => {
        const entry = { key, buffer, map };
        // a later edit may have invalidated this render while it ran
        if (pending && pending.key === key) {
            cache = entry;
            pending = null;
        }
        return entry;
    }).catch(err => {
        if (pending && pending.key === key) pending = null;
        throw err;
    });

    pending = { key, promise };
    return promise;
}
