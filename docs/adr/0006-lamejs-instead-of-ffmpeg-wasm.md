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

## Amendment, 2026-08-18: lamejs is LGPL-3.0

The decision stands; this records a fact the original text left out. The Context
above counted `ffmpeg.wasm`'s "GPL/LGPL build questions" against it without
noting that **lamejs is itself LGPL-3.0** (`zhuker/lamejs`, npm v1.2.1). Given
that ADR 0002 exists because a licence disqualified the first choice of stretch
engine, the omission was worth correcting before Step 3 built on it.

Accepted by the user on 2026-08-18, because LGPL is materially different from the
licence that disqualified Rubber Band:

- LGPL's copyleft covers the library and modifications to it, not the work that
  uses it. Rubber Band's terms were full GPL or a paid commercial licence, which
  would have reached the whole frontend. MusicLab's own code is unaffected, and
  commercial use and charging are permitted.
- The replaceability condition that makes LGPL awkward for compiled or bundled
  software is satisfied by construction here: no build step, so the library is
  served as a separate file the user can substitute.
- A browser library *is* conveyed to the user, unlike a server-side one, so the
  obligations do trigger. They are met by vendoring the **unminified** build
  (LGPL asks for the form preferred for modification, which minified JavaScript
  is not), shipping the licence texts, crediting the library, and recording in
  `static/vendor/PATCHES.md` that it is unpatched.

Two consequences for the implementation:

- `encodeMp3()` in `static/js/mp3.js` is the only code that may reference lamejs,
  so the encoder can be replaced in one file if the licence is ever ruled out.
  Ordered fallbacks: server-side ffmpeg (not conveyed, so the question
  disappears), `@mediabunny/mp3-encoder` (MPL-2.0, but requires the mediabunny
  framework), WebCodecs `AudioEncoder` (no dependency, but MP3 encoding support
  is too narrow to rely on).
- MP3 *patents* are not a factor: they expired in 2017 with the termination of
  the Fraunhofer/Technicolor licensing programme. Historically that, not
  licensing, was the obstacle to shipping an MP3 encoder commercially.

Detail in `design/step3-plan.md` section 1.5.
