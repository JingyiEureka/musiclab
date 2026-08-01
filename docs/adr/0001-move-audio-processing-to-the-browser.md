# 0001. Move audio processing from the server to the browser

Date: 2026-08-01
Status: Accepted. Partially implemented (see `design/step2-plan.md` section 1.3).

## Context

All DSP ran server-side: `POST /upload-audio/` took the file, a background task
ran `process_audio` (librosa for time-stretching, ffmpeg for MP3), and the
browser polled `GET /check-status/{id}` every two seconds.

On the production box (2 vCPU / 1 GB) this forced a concurrency cap of one job.
Three costs followed:

1. A second user's export waits for the first, and a task that fails outside the
   `except HTTPException` path holds the slot for up to 24 hours.
2. Every preview is a full round trip. `preview.js` sliced a 16-second window,
   encoded it as WAV, uploaded it, and ran the complete export pipeline just to
   hear a few seconds of adjusted audio.
3. Task state lives in memory (`TASKS_DB`, lost on restart) and renders
   accumulate in `outputs/` behind a cleanup sweep.

The editing loop -- adjust a section, listen, adjust again -- was gated on server
capacity, which is the opposite of what an editor needs.

## Decision

Move time-stretching, mixing, and export into the browser using the Web Audio
API and a WASM stretcher. The backend keeps only static file serving and
video-to-audio extraction.

## Consequences

Positive:

- The job cap, the poll loop, the task table, and `outputs/` disk usage all stop
  being needed.
- Preview becomes local, so the adjust-listen loop no longer involves a network.
- Audio never leaves the device, which is a privacy improvement we did not
  originally set out to make.
- Dropping librosa, numpy, and soundfile from `requirements.txt` substantially
  shrinks the container image (librosa pulls numba).

Negative:

- Processing moves to the weakest device in the chain. A 5-minute stereo 48 kHz
  render is ~115 MB of Float32 before encoding, which is uncomfortable on iOS
  Safari; long files need chunked export.
- Output will not be bit-identical to previous server renders, so existing
  exports are not reproducible byte-for-byte. See 0002 and 0005.
- Correctness-sensitive code moves into the least-tested layer. The project had
  no JS test infrastructure; a browser-driven harness
  (`static/dev/stretch-test.html`) was added to compensate.
- ffmpeg stays in the image regardless, for video extraction.

## Notes

`process_audio` should not be deleted until the client path is verified on real
iOS and Android hardware. It is also the only reference implementation available
for A/B comparison against the new engine.
