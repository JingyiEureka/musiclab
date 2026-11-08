# 0011. Keep the Python path as an offline script, not a server path

Date: 2026-10-05
Status: Accepted. Implemented.

## Context

0001 moved processing into the browser and planned to delete `process_audio`
once the client path was verified (Step 4). The user asked to keep the Python
path as a fallback for working without a network.

The server endpoints cannot serve that purpose. Without a network the hosted
site is unreachable, so `/upload-audio/` fails together with the page. When the
server runs locally instead, the page loads from `127.0.0.1`, which is a secure
context, and the browser path already works fully offline: rendering and MP3
encoding are local and the frontend loads nothing from a CDN. In neither case
does a server-side processing path add anything.

What does work without a network, a browser, or a server is running
`app/speed_changer.py` directly with the cuts and speeds written into its
`__main__` block. That is how it was already being used.

## Decision

Keep `app/speed_changer.py` as a standalone command-line script. Delete
everything that made it a server path: `/upload-audio/`, `/check-status/{id}`,
`/download/{id}`, `TASKS_DB`, the background task, the job cap, the session
cookie, and the `outputs/` volume. `app/main.py` no longer imports it.

Its dependencies (librosa, numpy, soundfile) move from `requirements.txt` to
`requirements-cli.txt`, so the server image no longer installs them.

## Consequences

Positive:

- An offline route exists that needs nothing but Python and ffmpeg.
- The server is reduced to static files and `/extract-audio/`. The one-job cap
  and the stuck-task slot leak stop existing.
- The Python implementation stays available as a reference for A/B comparison
  against the browser engine, which 0001's notes asked for. It carries the
  mid/side and stretch-context loudness fixes of 2026-08-19.

Negative:

- Two implementations of the same edit now exist and can drift. The script has
  no seam control and is not held to the browser's output; it is a fallback,
  not a second product. Changes to the browser engine do not need to be ported.
- `tests/test_speed_changer.py` needs librosa, so the dev environment still has
  to install `requirements-cli.txt` even though the server does not.
- The script still lives under `app/`, next to the server. It is kept out of
  the image by `.dockerignore`; moving it was judged not worth the churn.
