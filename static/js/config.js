// Tunables and fixed strings shared across modules.
export const CONFIG = {
    // the page is always served by the API itself, so requests are same-origin
    API_BASE_URL: '',
    POLLING_INTERVAL_MS: 2000,
    MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
    WAVEFORM_COLOR_PLAYED: '#d4a0b5',
    WAVEFORM_COLOR_UNPLAYED: '#666666',
    WAVEFORM_PX_PER_SEC: 13,
};

export const ERROR_MESSAGES = {
    decode_failed: 'This file format is not supported - try a different file or convert it to MP3/WAV.',
    encode_failed: 'Could not create the MP3 - please try again.',
    invalid_params: 'Section settings are invalid - check your split points and speeds.',
    server_error: 'Something went wrong on the server - please try again.',
};

// The saved session expires a week after the last edit (sliding window, so
// active editing never expires mid-work).
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
