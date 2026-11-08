// Tunables and fixed strings shared across modules.
export const CONFIG = {
    // the page is served by the API itself, so requests are same-origin.
    // The only server call is /extract-audio/ for video files.
    API_BASE_URL: '',
    MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
    WAVEFORM_COLOR_PLAYED: '#d4a0b5',
    WAVEFORM_COLOR_UNPLAYED: '#666666',
    WAVEFORM_PX_PER_SEC: 13,
};

// The saved session expires a week after the last edit (sliding window, so
// active editing never expires mid-work).
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The Python pipeline encoded with `ffmpeg -q:a 2`, VBR averaging roughly
// 190 kbps, so 192 keeps exported files the size and quality users expect.
export const MP3_KBPS = 192;

// A seam is the transition at a section boundary: a gain ramp where the two
// volumes differ, and a dip through a cut left behind by skipped sections.
// 20 ms matches the fixed crossfade of the Python pipeline, so projects made
// before the move to the browser sound unchanged.
export const SEAM_CURVES = ['equalPower', 'linear', 'smooth'];
export const SEAM_DEFAULT = { ms: 20, curve: 'equalPower' };
export const SEAM_MAX_MS = 1000;
