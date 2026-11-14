# Handoff

Last updated 2026-11-15. The browser refactor is merged to `main` (PR #1) and
**deployed to production** on 2026-11-09. On 2026-11-15 the server was removed
from the code in favour of GitHub Pages (ADR 0012); the cutover is in progress,
see section 2b.

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
- [ ] **Verify the seam UI by eye.** It passes structural tests, but gradient
      weight and crowding on a narrow screen have never been looked at.
- [ ] **Pre-warm the WASM module** on file open. Low value: the whole render is
      2.4-3.2 s on the phone, which caps what it can recover.
- **Product direction:** decided 2026-11-08 to ship and gather feedback from
  the dancers before planning new features.

## 2a. Production (old server, being retired)

Deployed 2026-11-09 from `main` (`51524f0`). Verified on
the live site: new modules served, `/upload-audio/` 404, `/extract-audio/`
answers, and a full render and export in headless Chrome.

- The pre-browser image is kept on the server as
  `kakakakakaka/music_lab:rollback-20261108`. To roll back:
  `docker tag kakakakakaka/music_lab:rollback-20261108 kakakakakaka/music_lab:latest`
  then `docker compose up -d` in `/home/ubuntu/jingyi`. Remove the tag once the
  new version has run without complaints for a while.
- A browser tab holding the old page will fail to export until reloaded.
- The folder still holds July copies of the old code and an empty root-owned
  `outputs/`. Not tidied separately: it is archived and deleted as a whole in
  2b step 4.

## 2b. Cutover to GitHub Pages

- [x] 1. Code: server removed, relative paths, Pages workflow, ADR 0012.
- [ ] 2. Make the repo public; enable Pages with source "GitHub Actions"; merge;
      check `https://jingyieureka.github.io/musiclab/` (browser suite, an
      export, the iPhone).
- [ ] 3. Set the custom domain `musiclab.jyylab.cc` in the Pages settings and
      change its DNS record to `CNAME jingyieureka.github.io`; enable "Enforce
      HTTPS" once the certificate is issued. The old server keeps answering
      until DNS has moved.
- [ ] 4. After a quiet period, and only on the user's go-ahead: on xkec2,
      archive `/home/ubuntu/jingyi` to `~/jingyi-pre-browser-20261109.tgz`,
      `docker compose down`, delete the folder (`outputs/` needs sudo), remove
      both `kakakakakaka/music_lab` images and the nginx site for
      `musiclab.jyylab.cc`.

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
