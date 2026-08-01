// Time stretching in the browser: Signalsmith Stretch (WASM) driven from an
// OfflineAudioContext.
//
// The library only ships an AudioWorkletNode factory, so there is no plain
// "process this array" entry point - offline renders run the worklet inside an
// OfflineAudioContext instead of a Web Worker.
//
// Its `rate` is source seconds per output second, which is the same convention
// as segment.speed, so speeds are passed through without inversion.
import SignalsmithStretch from '../vendor/signalsmith-stretch.mjs';

// 'cheaper' trades quality for CPU; use it for preview on mobile.
export const PRESET_PREVIEW = 'cheaper';
export const PRESET_EXPORT = 'default';

export function stretchedDuration(seconds, rate) {
    return rate > 0 ? seconds / rate : 0;
}

function copyChannels(buffer, channels) {
    const out = [];
    for (let c = 0; c < channels; c++) {
        // slice() so the transfer below detaches our copy, not the source buffer
        out.push(buffer.getChannelData(c % buffer.numberOfChannels).slice());
    }
    return out;
}

// Render `buffer` at a single constant rate. The whole-timeline version lands
// in step 2; this is the primitive it will be built from.
export async function renderStretched(buffer, rate, { preset = PRESET_EXPORT } = {}) {
    if (rate <= 0) throw new Error('rate must be greater than 0');
    const channels = Math.min(2, buffer.numberOfChannels);
    const frames = Math.ceil(stretchedDuration(buffer.duration, rate) * buffer.sampleRate);
    if (frames <= 0) throw new Error('nothing to render');

    const ctx = new OfflineAudioContext(channels, frames, buffer.sampleRate);
    const node = await SignalsmithStretch(ctx, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
    });
    await node.configure({ preset });

    const chans = copyChannels(buffer, channels);
    await node.addBuffers(chans, chans.map(a => a.buffer));
    await node.schedule({ active: true, output: 0, input: 0, rate });

    node.connect(ctx.destination);
    return ctx.startRendering();
}
