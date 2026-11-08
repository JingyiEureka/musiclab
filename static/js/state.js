// Mutable state shared between modules. Held in one object rather than as
// separate exported bindings so any module can both read and write it, and so
// the modules stay free of circular imports.
import { outputToSource } from './stretch.js';

export const state = {
    // audio
    audioFile: null,
    audioBuffer: null,
    totalDuration: 0,

    // player
    audioCtx: null,
    sourceNode: null,
    gainNode: null,
    isPlaying: false,
    playStartTime: 0,
    playOffset: 0, // always source time, even while rendered audio plays
    animFrameId: null,
    waveformZoom: 1,

    // set while the transport is playing a rendered timeline rather than the
    // raw upload; null means playback is 1:1 with the source
    playMap: null,
    playOutputStart: 0,

    // editing
    segments: [],

    // ui
    isBusy: false,

    // session persistence
    sessionSavedAt: 0,
    sessionExpired: false,
};

// Always source time: the waveform, the section lane and every boundary live in
// that domain, so rendered playback is mapped back before anyone sees it.
export function getCurrentTime() {
    if (!state.isPlaying) return state.playOffset;
    if (state.playMap) {
        return outputToSource(state.playMap, state.audioCtx.currentTime - state.playOutputStart);
    }
    return state.audioCtx.currentTime - state.playStartTime;
}
