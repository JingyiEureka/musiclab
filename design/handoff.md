# Handoff: client-side DSP refactor

Sessions of 2026-08-01 / 08-02 / 08-18. Branch `restructure-layout`, **not
pushed and not merged to `main`**. Steps 1-3 are committed; step 4 is the
remaining work. Section 6 lists what is open.

## 1. Where the refactor stands

Moving audio processing from the FastAPI/librosa backend into the browser.
Original four-step plan, plus transport work that emerged from testing:

| Step | Scope | State |
|---|---|---|
| 1 | Vendor the stretch engine; single-rate offline render | **done** |
| 2 | Full timeline: time map, per-section volume, seam fades, UI | **done** |
| -- | Transport plays the rendered timeline (ADR 0009, 0010) | **done** |
| 3 | MP3 encode + local download, no server round trip | **done** |
| 4 | Delete `process_audio`, trim `requirements.txt`, update `ARCHITECTURE.md` | **not started** |

Verification: **37 browser tests** (5 single-rate, 11 timeline, 14 data model,
7 mp3) via `static/dev/stretch-test.html`, plus **68 pytest**. All green.
Export was also driven end to end through the real UI -- see
`design/step3-plan.md` section 5.1.

## 2. What the app does now

- Upload, split into sections, set per-section speed / volume / skip -- unchanged.
- **Seam control** on each boundary between two kept sections: volume transition
  duration (0-1000 ms) and curve (equal-power / linear / smooth), with a shaded
  ramp indicator in the section lane.
- **`[ Play ]` / `[ |< ]` play the rendered timeline**, so playback matches the
  export exactly. Volume-only edits still skip rendering and use the live gain
  schedule -- which now ramps each boundary with the configured seam, built from
  the same `fadeCurve` the render uses. It used to step, so a volume-only edit
  played differently from how it exported and ignored the seam control entirely
  (`design/step3-plan.md` section 2.1).
- **No `[ Preview ]` button.** Retired; there is one playback path.
- **Export is local.** `[ Export ]` encodes the cached playback render to MP3 at
  192 kbps with lamejs and saves it. Nothing is uploaded. The mp3 is the audio
  that was auditioned, because both come from the same `getTimeline()` buffer.
- The only server call left is `POST /extract-audio/`, for video containers
  Safari cannot decode. That one stays (ADR 0001).
- `/upload-audio/`, `/check-status/` and `/download/` are now unreachable from
  the UI but still exist. Deleting them is Step 4.

## 3. Decisions locked (do not re-litigate)

All in `docs/adr/`. Read `docs/adr/README.md` first. The load-bearing ones:

- **0002** Signalsmith Stretch, not Rubber Band -- Rubber Band is GPL/commercial
  and would force copyleft on the frontend. Do not swap without settling licensing.
- **0003** Single-file consecutive section model. Not a multi-track DAW.
- **0005** One time map through one stretcher node. Requires the `setTimeMap`
  patch in `static/vendor/PATCHES.md`.
- **0007** Cut fades stay engine-internal at 20 ms. Measured *and* heard to make no
  audible difference, so they get no UI.
- **0010** One playback path, rendered at the export preset.

## 4. Vendored libraries

`static/vendor/PATCHES.md` is the record: it opens with a table of both
dependencies and their licences, and documents every patch.

**lamejs** (LGPL-3.0) is vendored **unmodified and must stay that way** -- LAME's
licence requires modifications to be released back upstream. Only
`static/js/mp3.js` may reference it, which is what keeps the encoder replaceable
if the licence is ever ruled out. `tests/test_player_ui.py` enforces both.

**signalsmith-stretch.mjs** (MIT) is patched twice. Re-apply on upgrade:

1. **`setTimeMap`** -- `schedule()` cannot pre-load a multi-entry time map (it
   prunes relative to each call's `outputTime`, keeping at most two entries). Test
   5.2 fails loudly if this patch is missing; the failure without it is *silent*,
   producing a plausible-sounding one-section render.
2. **Cache the worklet blob URL** -- every offline render created a new context and
   leaked another ~111 KB blob URL.

## 5. Commit history and how to check the tree

```
2cb5b0a  Correct the production TLS note in the handoff
f92de83  Make client-side rendering work off the dev machine   (secure context)
181704a  Move audio processing into the browser (steps 1-2)
```

Per `CLAUDE.md`, before committing:

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . \
  && conda run -n librosa python -m pytest -v
```

The browser suite is not in that command and has to be run separately -- start
the server, open `static/dev/stretch-test.html`, or drive
`window.runStretchTests` / `runTimelineTests` / `runModelTests` / `runMp3Tests`
over CDP (section 7).

`design/` and `docs/adr/` are committed deliberately; `CLAUDE.md` explains why.

## 5a. The app now requires a secure context

`audioWorklet` is `[SecureContext]` in the Web Audio spec, so it is absent over
plain http on a browser that otherwise supports it fully. Rendering an edit goes
through an AudioWorklet, so **the whole client-side DSP path is dead over http**.

This is easy to miss because `localhost` and `127.0.0.1` count as secure. Measured
on one Chrome build, same page, only the origin differing:

| origin | `isSecureContext` | `ctx.audioWorklet` |
|---|---|---|
| `http://127.0.0.1:8000` | true | present |
| `http://172.20.10.2:8000` (LAN IP) | **false** | **absent** |
| `https://172.20.10.2:8443` (self-signed) | true | present |

The backend never needed this -- it is a constraint the client-DSP move
introduced, and it did not exist before step 1.

- Startup shows a banner when `!window.isSecureContext`, rather than letting the
  first Play fail after a file has been uploaded and split.
- `renderTimeline` distinguishes "no AudioWorklet support" from "loaded over
  http" so the message does not blame the browser for the origin.
- **Production is already fine.** `musiclab.jyylab.cc` is an nginx vhost proxying
  to `localhost:8000`, with a Let's Encrypt certificate and a Certbot-managed
  `301` from port 80. Verified: `http://musiclab.jyylab.cc/` redirects, and
  https answers 200 with a valid chain. An earlier note here claimed port 80
  served the app without redirecting -- that was a `curl` against the bare IP,
  which hits the `default_server` vhost and its `/var/www/html` welcome page, not
  MusicLab. Only the LAN-IP dev case needs the certificate work above.

### Testing on a phone: what iOS actually requires

An http LAN IP can never work, so device testing needs TLS. A plain one-command
self-signed cert is **not** enough -- iOS rejects it and Safari lands on
`about:blank` after "visit this website", with no request reaching the server.
Since iOS 13 a TLS server certificate must carry an `extendedKeyUsage` extension
containing `serverAuth`; `openssl req -x509` alone emits none, and also marks the
cert `CA:TRUE`, which is wrong for a leaf.

What works is a root CA plus a leaf signed by it. Substitute your LAN IP:

```
cd certs
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
  -out dev-cert.pem -days 398 -sha256 -extfile ext.cnf
cat dev-cert.pem ca-cert.pem > dev-chain.pem
cp ca-cert.pem musiclab-ca.crt
```

Serve with the chain, from the repo root -- a background uvicorn started from
`certs/` dies on `ModuleNotFoundError` and serves nothing (see section 7):

```
conda run --no-capture-output -n librosa python -m uvicorn app.main:app \
  --host 0.0.0.0 --port 8443 \
  --ssl-keyfile certs/dev-key.pem --ssl-certfile certs/dev-chain.pem
```

On the phone: download `musiclab-ca.crt`, install it (Settings -> General ->
VPN & Device Management), then **enable it under Settings -> General -> About ->
Certificate Trust Settings** -- installing without that switch still fails.
Delete the profile when finished.

To hand the CA to the phone, serve *only that file* over http. Do not point a
static server at `certs/`: it contains `ca-key.pem`, and anyone on the network can
then take a CA the phone trusts and sign any domain with it. That mistake was made
during this session, hence `certs/` being deleted rather than reused.

`certs/` is gitignored, and worth deleting after a test session rather than
keeping a trusted CA's private key lying around. On Android none of this applies:
`adb reverse tcp:8000 tcp:8000` makes the phone see `http://localhost:8000`, which
counts as a secure context.

## 5b. Phone measurement: the mobile concern was unfounded

Measured 2026-08-18 on the user's phone, over https on the LAN, at
`PRESET_EXPORT` -- the same preset the export uses:

```
rendered 2:58.73 in 2.38s (75x realtime)
rendered 2:50.42 in 3.15s (54x realtime)   # after re-uploading a different file
```

The fear was that desktop's 8.2 s cold, extrapolated 4-5x, put mobile at 30-40 s
and past tolerable. It is off by an order of magnitude in the good direction.
**Export-quality playback is viable on mobile**, so ADR 0010 stands as written
and needs no mobile escape hatch.

Two caveats on reading these numbers:

- Not like-for-like against the desktop figure, or against each other: different
  files, different sectioning. Treat 54-75x as a throughput band, not a
  head-to-head.
- **Neither is confirmed cold.** Re-uploading does not reset the engine --
  `stretchFactory` is module state that only a page reload clears. Unless the page
  was reloaded between them, both are warm and the cold cost is still unmeasured.
  The worst case actually observed is 3.15 s, which is why this no longer blocks
  anything.

The transport reports these figures itself -- open the app with `?timing=1` and
every render prints duration, wall time and throughput, and stays on screen. That
flag also surfaces the two cases that are silent by default: a cache hit, and a
volume-only edit that never enters the render path. Both were mistaken for a
failed measurement before the flag existed.

## 6. Open items, roughly in priority order

1. ~~**Measure on a real phone.**~~ Done -- see section 5b. Serve over https
   (section 5a) or it cannot run at all.
2. **Pre-warm the WASM module** on file open, so the first play does not pay WASM
   compile + worklet registration. Now low value: the whole render is 2.38 s on
   the phone, which caps what pre-warming can recover. Worth doing only if a
   clean cold measurement comes in far above that.
3. ~~**Mobile fallback**~~ -- dropped. It existed for a 30-40 s mobile render
   that does not happen. `PRESET_PREVIEW` stays in the code for the dev harness.
   The progressive-playback plan remains in git history if it is ever needed.
4. **Memory ceiling -- now the only untested risk.** Source plus rendered
   timeline is ~230 MB of Float32 for 5 minutes stereo 48 kHz, and **export is
   where it peaks**, since the encoder output lives alongside both. The encoder
   itself is incremental and adds no full-length copy, so the ceiling is
   unchanged from playback -- but it has still only been exercised at 3 minutes.
   Try the longest variation available, on the phone. Flagged in ADR 0001, 0009,
   0010.
5. ~~**Step 3**~~ done. `static/js/mp3.js` wraps lamejs; `design/step3-plan.md`
   has the detail, including why lamejs's LGPL-3.0 is acceptable here and what
   would need to change if it stopped being (ADR 0006 amendment).
6. **Step 4**: delete `process_audio`, drop librosa/numpy/soundfile from
   `requirements.txt` (keep ffmpeg for video extraction), update `ARCHITECTURE.md`
   -- its diagrams still show the upload/poll pipeline, and known issues 1 and 3
   become moot once `TASKS_DB` goes.
7. **Verify 4C by eye.** The seam control and lane ramp pass structural tests, but
   gradient weight and crowding on a narrow screen were never looked at.

## 7. Running things

```
# app -- --no-capture-output or uvicorn's logs are swallowed and it looks hung
conda run --no-capture-output -n librosa python -m uvicorn app.main:app --port 8000

# test harness (needs HTTP, not file://)
http://127.0.0.1:8000/static/dev/stretch-test.html
```

The harness has three suites plus two manual tools: **cut A/B** (0 ms vs 60 ms
seam on a real file) and **real file** (stretch at a given rate, downloads WAV).

Headless runs used Chrome via CDP over a WebSocket with node built-ins only -- no
new dependencies. Scripts were in the session scratchpad and are gone; they were
~40 lines each (`Runtime.evaluate` against `window.runStretchTests` /
`runTimelineTests` / `runModelTests`, which the harness exposes).

**Gotcha that cost time twice:** `conda run` without `--no-capture-output` hides
all output, and the shell's working directory persists between commands. A
background uvicorn started from the wrong directory dies with
`ModuleNotFoundError: No module named 'app'` and *silently* serves nothing -- the
symptom was `window.runStretchTests is not a function`, which looks like a module
error and is not.

## 8. Corrections made this session, worth not repeating

Three claims in earlier plans were wrong and were fixed after measurement:

1. `active: false` is **not** skip -- it mutes while output time advances. Skip is
   an input jump. (ADR 0005)
2. `schedule()` **cannot** pre-load a time map by passing an explicit `outputTime`.
   The arithmetic is in `PATCHES.md`. Hence the patch.
3. Cut dips do **not** remove clicks, because there is no click -- the continuous
   overlap-add stream already blends an input jump. (ADR 0007)

Also: 4D was built and tested against a preview button that was hidden by an
inline style, so 26 tests passed while the feature was unreachable. Module tests
are not product tests. `TestSinglePlaybackPath` exists because of that.
