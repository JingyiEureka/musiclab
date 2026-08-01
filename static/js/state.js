// Mutable state shared between modules. Held in one object rather than as
// separate exported bindings so any module can both read and write it, and so
// the modules stay free of circular imports.
export const state = {
    // audio
    audioFile: null,
    audioBuffer: null,
    totalDuration: 0,

    // player
    audioCtx: null,
    sourceNode: null,
    gainNode: null,
    previewSource: null,
    isPlaying: false,
    playStartTime: 0,
    playOffset: 0,
    animFrameId: null,
    waveformZoom: 1,

    // editing
    segments: [],

    // ui
    isBusy: false,

    // session persistence
    sessionSavedAt: 0,
    sessionExpired: false,
};

export function getCurrentTime() {
    if (state.isPlaying) return state.audioCtx.currentTime - state.playStartTime;
    return state.playOffset;
}
