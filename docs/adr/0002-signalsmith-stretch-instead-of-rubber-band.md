# 0002. Use Signalsmith Stretch instead of Rubber Band

Date: 2026-08-01
Status: Accepted. Implemented in `static/js/stretch.js`.

## Context

Moving DSP to the browser (0001) needs a time-stretcher that changes speed
without changing pitch. The original plan named Rubber Band Library, compiled to
WASM, on quality grounds.

**Rubber Band is dual-licensed: GPLv2+ or a paid commercial licence.** Shipping
it as WASM to browsers is distribution, so MusicLab's frontend would have to be
GPL, or we would have to buy a licence. Every `rubberband-wasm` port on npm
inherits this.

The alternatives:

| Library | Licence | Notes |
|---|---|---|
| Signalsmith Stretch | MIT | Quality competitive for speed-change-without-pitch-shift |
| SoundTouch (`soundtouchjs`) | LGPL-2.1 | Mature; dynamic-linking caveats; weaker on transients |
| Rubber Band | GPL / commercial | Best quality, licence cost or copyleft |

## Decision

Use Signalsmith Stretch (MIT), vendored at v1.3.2 as
`static/vendor/signalsmith-stretch.mjs`.

## Consequences

Positive:

- No copyleft obligation and no licence cost.
- The entire library is one 111 KB `.mjs` with the WASM base64-inlined: no
  separate binary, no MIME configuration, no `SharedArrayBuffer`, and therefore
  no COOP/COEP response headers. This matters because the project has no build
  step -- modules are served straight off disk.
- Measured better than the outgoing implementation, not merely equal. librosa's
  phase vocoder needed RMS renormalisation because it did not preserve loudness;
  Signalsmith holds RMS to within 0.3% at every rate tested, so that compensation
  hack is gone.
- Throughput ~22x realtime (2 s stereo in ~90 ms on an M-series Mac).

Negative:

- Documented quality band for time-stretching is ~0.75x-1.5x output-length
  ratio. The UI permits 25%-800%, which is far outside it.
- Peaks overshoot by up to +1.6 dB (0.500 in, 0.603 out), so export needs peak
  safety rather than the old hard clip.
- The web release exposes only `createNode(audioContext, opts)` returning an
  `AudioWorkletNode` -- there is no offline batch API, so offline rendering must
  run the worklet inside an `OfflineAudioContext` rather than a plain Web Worker.

## On the quality band

Actual usage, from filenames in `archive/outputs/`:

```
speed:  50  70  75  80  84  85  87  91  92  93  95  96  98 100 103 105 108
count:   1   2   1   7   1   2   1   2   3   1   4   3   2  24   1   1   1
```

Since `speed` is source-seconds per output-second, output-length ratio is its
reciprocal: real usage spans 0.93x-1.43x, comfortably inside the recommended
band. The single 0.50 (ratio 2.0x) is the only case outside it. The 800% ceiling
is theoretical and librosa degraded there too, so this is not a regression.

## Revisiting

If Rubber Band's quality is later judged necessary, this decision reverses only
by either open-sourcing the frontend under GPL or purchasing a commercial
licence. Do not swap the library without settling that first.
