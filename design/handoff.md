# Handoff

Last updated 2026-11-23 (UI redesign merged and live, PR #3). The browser refactor is merged to `main` (PR #1) and
**deployed to production** on 2026-11-09. On 2026-11-15 the server was removed
from the code in favour of GitHub Pages (ADR 0012); since 2026-11-22 the live
domain is served by Pages and the old server is shut down (section 2b).

## 1. Where things stand

The refactor that moved audio processing from the FastAPI/librosa backend into
the browser is finished. `ARCHITECTURE.md` describes the result; `docs/adr/`
records why (read `docs/adr/README.md` first). The step plans for it were
deleted once their work shipped and are in git history.

- Rendering, playback and MP3 export all run in the browser. One render, at the
  export preset, serves both playback and export (ADR 0010).
- There is no server: `static/` is the whole site, published to GitHub Pages
  (ADR 0012). Video files load only where the browser decodes them.
- `app/speed_changer.py` is an offline command-line script (ADR 0011).

Verification: **37 browser tests** (5 single-rate, 11 timeline, 14 data model,
7 mp3) in `static/dev/stretch-test.html`, plus **74 pytest**. All green.

## 2. Open items

- [ ] **UI redesign, merged 2026-11-23 (PR #3) and live.** Studio look in our own
      CSS, no library or framework (ADR 0013). Verified in headless Chromium at
      320 / 375 / 390 / 601 / 640 / 768 / 1280 px: no sideways page scroll,
      split / stepper / merge / drag / skip / play / export with report /
      resume all work, 37 browser tests and pytest green. Before merge the
      user asked to drop the "About sections" panel and to calm the colours
      (sections dusty rose / slate blue, numbers off-white). Live check after
      deploy: 4 browser suites green, real-UI export works. **Not yet checked
      on a real iPhone** (Safari is the only engine not covered).
- [ ] **Try Peaks.js for the waveform** only if dragging still feels clumsy
      after the redesign (deferred by the user on 2026-11-22).

- [ ] **Check the browser engine for the two loudness defects fixed in the
      Python script** on 2026-08-19. Deferred by the user on 2026-11-15: a
      check, not a fix; do it if dancers report loud section starts or a
      thinner sound. Neither has been measured in
      `static/js/stretch.js`; the script is the known-good reference for an A/B.
  1. *Independent L/R stretching.* Stretching each channel separately
     decorrelated them (L/R correlation ~0.45 to ~0.00) and the phantom centre
     lost ~1.5 dB, while per-channel level looked unchanged. Signalsmith
     processes channels as a linked pair, so the browser is probably clear.
  2. *Onset burst at every section start.* A hard-cut slice made the stretcher
     read the edge as a transient: the first 0.25 s came out 2.5-3.5 LU too
     loud. The script fixed it by carrying 1 s of neighbouring audio into the
     stretcher. The browser renders one continuous time map (ADR 0005) rather
     than slices, which should avoid it, but that is not measured.
- [ ] **Verify the seam UI by eye.** Looked at in screenshots during the
      redesign (desktop row, phone cards down to 320 px); still to be judged on
      a real phone with real volume changes.
- [ ] **Pre-warm the WASM module** on file open. Low value: the whole render is
      2.4-3.2 s on the phone, which caps what it can recover.
- **Product direction:** decided 2026-11-08 to ship and gather feedback from
  the dancers before planning new features.

## 2a. Old production server (retired 2026-11-22)

The Docker deployment on xkec2 that served the site from 2026-11-09 to
2026-11-22 is gone: container, both `kakakakakaka/music_lab` images (including
`rollback-20261108`), `/home/ubuntu/jingyi`, the nginx server blocks, the
password file and the Let's Encrypt certificate. What is kept on xkec2:

- `~/jingyi-pre-browser-20261109.tgz`: the whole folder plus
  `musiclab.htpasswd`.
- `/etc/nginx/sites-available/default.bak-20261122-musiclab`: the nginx config
  before the blocks were removed.

The images are still on Docker Hub. Rollback is no longer a one-liner: restore
the folder and the nginx blocks, `docker compose up -d`, re-issue the
certificate with certbot, and point DNS back at `54.153.163.10`.

## 2b. Cutover to GitHub Pages

- [x] 1. Code: server removed, relative paths, Pages workflow, ADR 0012.
- `main` has a ruleset ("protect main") blocking force pushes and deletion,
  since a push to `main` is now a deploy.
- [x] 2. Repo public, Pages source "GitHub Actions", PR #2 merged. On
      github.io: all files 200, 4 browser suites green, a real-UI export at 95%
      (90.13 s to 94.90 s), mp4 loads in Chrome.
- [x] 3. Custom domain `musiclab.jyylab.cc` set in Pages, and the Cloudflare
      record changed to `CNAME jingyieureka.github.io`, DNS only (2026-11-15).
      The certificate stayed null for a week; removing and re-adding the
      custom domain in Settings > Pages got it issued within minutes
      (2026-11-22). "Enforce HTTPS" is on. On the live domain: secure
      context, 4 browser suites green, a real-UI export at 95% (105.56 s to
      111.10 s). http redirects to https (301). The user tested on their iPhone
      on 2026-11-22: passes.
      **This drops the password.** The old site sits behind nginx basic auth
      (`auth_basic "MusicLab"`, `/etc/nginx/musiclab.htpasswd`, added around
      2026-11-09); Pages cannot do auth. The user chose on 2026-11-15 to drop
      it. If a gate is wanted later: Cloudflare Pages plus Cloudflare Access.
- [x] 4. Old server shut down on the user's go-ahead (2026-11-22); see 2a.
      The other sites on xkec2 (ys, file, pass, loc) still answer as before;
      `nginx -t` passed before the reload.

## 3. Vendored libraries

`static/vendor/PATCHES.md` is the record: licences of both dependencies and
every patch.

- **lamejs** (LGPL-3.0) is vendored **unmodified and must stay that way**. Only
  `static/js/mp3.js` may reference it, which keeps the encoder replaceable.
  `tests/test_player_ui.py` enforces both.
- **signalsmith-stretch.mjs** (MIT) carries two patches to re-apply on upgrade:
  `setTimeMap` (without it, test 5.2 fails loudly; the app fails *silently*,
  rendering one plausible-sounding section) and a cached worklet blob URL.

## 4. Measurements

All at the export preset, with `?timing=1`, which keeps render time, throughput
and live memory on screen and reports the silent cases (cache hit, volume-only
edit).

- **Phone render speed:** 54-75x realtime (2:58 in 2.38 s, 2:50 in 3.15 s).
  Different files, and neither confirmed cold: the engine is module state that
  only a page reload clears.
- **Memory peak** is at export, with source, render and mp3 all live. Two runs
  on the user's iPhone (iOS 18.7, Safari), both completed, same 3:11 source at
  48 kHz stereo:
  - 0.38x: `252 MB live (source 70 + render 182) + 11.4 MB mp3`, 263 MB.
  - 0.25x (2026-11-08): `350 MB live (source 70 + render 280) + 17.5 MB mp3`,
    367 MB. Rendered 12:45 in 10.6 s (72x); the mp3 encode took 23 s.
- **Slowing down is what costs memory**, not file length: the render is sized
  by output duration. Peak is (source + output duration) x sample rate x
  channels x 4 bytes, plus the mp3; this reproduces both runs within 1%.
  25% is the slowest speed the UI allows.
- **No memory warning.** One was built (warn before a render projected above
  300 MB) and removed on 2026-11-08: the phone survived 367 MB, the notice sat
  where it went unseen during testing, and the user judged it unneeded. Where
  older phones fail is unmeasured. If tab crashes are ever reported, revisit
  that; chunked export stays rejected, since it breaks the single time map
  (ADR 0005) and the guarantee that the export is the buffer playback used
  (ADR 0010).

## 5. Running and testing

```
# app
python3 -m http.server 8000 -d static

# browser test harness (needs HTTP, not file://)
http://127.0.0.1:8000/dev/stretch-test.html
```

Before committing, per `CLAUDE.md`:

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . \
  && conda run -n librosa python -m pytest -v
```

The browser suite is not in that command. Run it from the harness page, or
headless: start Chrome with `--headless=new --remote-debugging-port=<port>`,
open the harness with `PUT /json/new?<url>`, and `Runtime.evaluate` each of
`window.runStretchTests` / `runTimelineTests` / `runModelTests` /
`runMp3Tests` with `awaitPromise`. Node's built-in `WebSocket` and `fetch` are
enough; about 30 lines, no dependencies.

The harness also has two manual tools: **cut A/B** (0 ms vs 60 ms seam on a
real file) and **real file** (stretch at a given rate, downloads WAV).

Gotchas:

- `tests/test_js_syntax.py` runs `node --check` on every frontend module. ES
  modules fail as a graph, so one unparseable file leaves the whole page with no
  event handlers, and ruff and pytest only read Python. A stray U+00B7 once
  shipped this way under a commit claiming "No code change". Read the diff
  before committing; do not trust `git add -A`.
- Serve `static/` (`-d static`), as Pages does; the harness is then at
  `/dev/stretch-test.html`, not `/static/dev/...`.
- Module tests are not product tests. A feature once passed 26 tests while its
  button was hidden by an inline style. `TestSinglePlaybackPath` exists because
  of that; drive changes through the real UI as well.

## 6. Secure context and phone testing

`audioWorklet` is `[SecureContext]`, so the whole client-side render path is
dead over plain http on anything but `localhost` / `127.0.0.1`. Startup shows a
banner when `!window.isSecureContext`. Production is fine: GitHub Pages serves https.

Testing on a phone over the LAN therefore needs TLS. On Android,
`adb reverse tcp:8000 tcp:8000` avoids it. For iOS, what worked:

**Keep TLS out of the app server.** Terminate it in nginx for testing: an nginx
container listening on 8443, with `proxy_pass http://host.docker.internal:8000/`
(`python3 -m http.server 8000 -d static --bind 0.0.0.0`). Bake files into the image: Docker Desktop cannot bind-mount
from `~/Desktop` without Full Disk Access.

**iOS needs a CA plus a leaf with `extendedKeyUsage = serverAuth`.** A one-line
`openssl req -x509` certificate lands Safari on `about:blank`.

```
IP=$(ipconfig getifaddr en0)

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout ca-key.pem -out ca-cert.pem -subj "/CN=MusicLab Dev CA" \
  -addext "basicConstraints=critical,CA:true" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -newkey rsa:2048 -nodes -keyout dev-key.pem -out dev.csr -subj "/CN=$IP"
cat > ext.cnf <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost
EOF
openssl x509 -req -in dev.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out dev-cert.pem -days 380 -sha256 -extfile ext.cnf
cat dev-cert.pem ca-cert.pem > dev-chain.pem
```

- Serve the CA over plain http from a directory holding **only**
  `ca-cert.pem` (as `.crt`, type `application/x-x509-ca-cert`). Serving the
  directory that also holds `ca-key.pem` publishes a CA the phone trusts; that
  mistake was made once.
- On the phone, in Safari: install the profile, then **enable it under
  Settings -> General -> About -> Certificate Trust Settings**, a separate
  screen nothing prompts for. Delete the profile when finished.
- Check the certificate with a static page reporting `isSecureContext` and
  `audioWorklet` before opening the app, so a trust problem and an app problem
  are not mistaken for each other.

`dev-tls/` (gitignored) is the place for this setup.
