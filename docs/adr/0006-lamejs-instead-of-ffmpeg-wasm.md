# 0006. Encode MP3 with lamejs instead of ffmpeg.wasm

Date: 2026-08-01
Status: Accepted. Not yet implemented (Step 3).

## Context

Client-side export (0001) needs to turn a rendered `AudioBuffer` into a
downloadable file. The brief named `ffmpeg.wasm`.

MusicLab exports two formats: WAV and MP3. Nothing else.

`ffmpeg.wasm` costs:

- A ~25-30 MB core download.
- The fast multithreaded core requires `SharedArrayBuffer`, which requires
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` response headers. That is a real
  change to `app/main.py` and it breaks any cross-origin asset added later. The
  single-threaded core avoids the headers but is slow.
- Its own GPL/LGPL build questions, which is the trap 0002 exists to avoid.
- Awkward loading with no bundler, since this project serves plain ES modules
  off disk.

## Decision

- **WAV**: hand-rolled. The encoder already existed inside `preview.js` and was
  extracted to `static/js/wav.js`. Zero dependencies.
- **MP3**: `lamejs`, ~50 KB, encodes MP3 directly from Float32 chunks.

Do not adopt `ffmpeg.wasm` unless a format beyond WAV/MP3 is actually required.

## Consequences

Positive:

- Roughly 500x smaller than the ffmpeg.wasm core for the formats we ship.
- No COOP/COEP headers, so no server-side change and no cross-origin fallout.
- `lamejs` encodes in chunks, which suits the streaming export needed for long
  files on mobile (a 5-minute stereo 48 kHz buffer is ~115 MB of Float32, so
  handing the encoder one monolithic buffer is not viable on iOS).

Negative:

- No other output containers or codecs without revisiting this.
- MP3 only; if AAC/Opus is ever wanted, that is a new decision.

## Notes

Export must also apply peak safety: Signalsmith overshoots peaks by up to
+1.6 dB, so a source near 0 dBFS would clip. Measure the rendered buffer's true
peak and apply a single makeup gain when it exceeds 1.0, rather than hard
clipping as the old Python did.
