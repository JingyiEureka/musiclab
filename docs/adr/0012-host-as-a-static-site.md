# 0012. Host as a static site on GitHub Pages; drop server-side video extraction

Date: 2026-11-15
Status: Accepted.

## Context

After 0001 and 0011 the FastAPI server did two things: serve the frontend, and
`POST /extract-audio/`, which ran ffmpeg on video files that iPhone Safari
cannot decode. All processing already ran in the browser.

Keeping it meant a Docker image, an amd64 build from an arm64 Mac, an EC2 box,
and nginx with a certificate, for a site that is otherwise static files. In the
six days after the 2026-11-09 deploy `/extract-audio/` was called once, and that
call failed (400), against 7 page loads.

## Decision

Publish `static/` to GitHub Pages from a GitHub Actions workflow on every push
to `main`, at the existing address `musiclab.jyylab.cc`. The repository is made
public, which free Pages requires.

Delete the server: `app/main.py`, `Dockerfile`, `docker-compose.yml`,
`requirements.txt`, `.dockerignore`, `tests/test_api.py`. Asset paths in
`index.html` become relative, so the site works at the domain root and at the
`github.io/musiclab/` subpath.

Video files are decoded only where the browser can (Chrome, Android). Where it
cannot, the user is asked for an audio file. No in-browser demuxer is added.

## Consequences

Positive:

- Nothing to build, patch or keep running. A push to `main` is a deploy.
- HTTPS, required for `audioWorklet`, comes with Pages.
- No file is ever uploaded anywhere; 0001's privacy point now holds without
  exception.

Negative:

- iPhone Safari users can no longer load a video file.
- Pages serves everything with a 10-minute cache. For up to 10 minutes after a
  deploy a visitor can receive old files, possibly a mix of old and new
  modules. The server's `no-cache` on modules cannot be reproduced.
- Deploys are no longer gated on a manual step; the workflow only runs
  `node --check`. The pre-commit checks in `CLAUDE.md` are the gate.
- The source is public. It already was in practice, since the page serves it.
