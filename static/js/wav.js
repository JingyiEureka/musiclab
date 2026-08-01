// 16-bit PCM WAV encoding, for the local export and the dev harness.

// Encode [t0, t1) of an AudioBuffer as a WAV blob. Omit t0/t1 for the whole buffer.
export function audioBufferToWav(buffer, t0 = 0, t1 = buffer.duration) {
    const sr = buffer.sampleRate;
    const start = Math.floor(t0 * sr);
    const end = Math.min(buffer.length, Math.ceil(t1 * sr));
    const frames = Math.max(0, end - start);
    const channels = Math.min(2, buffer.numberOfChannels);
    const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) data.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    data.setUint32(4, 36 + frames * channels * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true); // PCM
    data.setUint16(22, channels, true);
    data.setUint32(24, sr, true);
    data.setUint32(28, sr * channels * 2, true);
    data.setUint16(32, channels * 2, true);
    data.setUint16(34, 16, true);
    writeStr(36, 'data');
    data.setUint32(40, frames * channels * 2, true);
    const chans = [];
    for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const v = Math.max(-1, Math.min(1, chans[c][start + i]));
            data.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
            off += 2;
        }
    }
    return new Blob([data.buffer], { type: 'audio/wav' });
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
