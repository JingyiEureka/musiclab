# Handoff: client-side DSP refactor

Session of 2026-08-01 / 08-02. Branch `restructure-layout`. **Nothing is
committed** -- see section 5 before doing anything else.

## 1. Where the refactor stands

Moving audio processing from the FastAPI/librosa backend into the browser.
Original four-step plan, plus transport work that emerged from testing:

| Step | Scope | State |
|---|---|---|
| 1 | Vendor the stretch engine; single-rate offline render | **done** |
| 2 | Full timeline: time map, per-section volume, seam fades, UI | **done** |
| -- | Transport plays the rendered timeline (ADR 0009, 0010) | **done** |
| 3 | MP3 encode + local download; chunked export for long files | **not started** |
| 4 | Delete `process_audio`, trim `requirements.txt`, update `ARCHITECTURE.md` | **not started** |

Verification: **30 browser tests** (5 single-rate, 11 timeline, 14 data model) via
`static/dev/stretch-test.html`, plus **61 pytest**. All green at session end.

## 2. What the app does now

- Upload, split into sections, set per-section speed / volume / skip -- unchanged.
- **Seam control** on each boundary between two kept sections: volume transition
  duration (0-1000 ms) and curve (equal-power / linear / smooth), with a shaded
  ramp indicator in the section lane.
- **`[ Play ]` / `[ |< ]` play the rendered timeline**, so playback matches the
  export exactly. Volume-only edits skip rendering and use the live gain schedule.
- **No `[ Preview ]` button.** Retired; there is one playback path.
- Export still goes through the server (`POST /upload-audio/`). That is Step 3.

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

## 4. Two vendor patches -- re-apply on upgrade

`static/vendor/signalsmith-stretch.mjs` is patched. Both are documented with
rationale in `static/vendor/PATCHES.md`:

1. **`setTimeMap`** -- `schedule()` cannot pre-load a multi-entry time map (it
   prunes relative to each call's `outputTime`, keeping at most two entries). Test
   5.2 fails loudly if this patch is missing; the failure without it is *silent*,
   producing a plausible-sounding one-section render.
2. **Cache the worklet blob URL** -- every offline render created a new context and
   leaked another ~111 KB blob URL.

## 5. Uncommitted work

17 modified/deleted, 4 untracked paths. Per `CLAUDE.md`, before committing:

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . \
  && conda run -n librosa python -m pytest -v
```

`CLAUDE.md` also says to delete `design/` before committing. Note that would
remove `design/step2-plan.md` **and this file**. The ADRs in `docs/adr/` are *not*
development artifacts and should be committed -- they exist precisely so the
reasoning survives `design/` being deleted.

Files:

```
M  static/dev/stretch-test.html      test harness (3 suites + cut A/B tool)
M  static/index.html                 preview button removed; styles.css?v=17
M  static/js/config.js               SEAM_* constants
M  static/js/main.js                 seam events, newSegment/normalizeSegments
M  static/js/player.js               renders the timeline; one playback path
M  static/js/segments.js             seam model, UI, mergeWithNext fix
M  static/js/state.js                playMap/playOutputStart; source-time getCurrentTime
M  static/js/stretch.js              engine: time map, curves, mappings, peak safety
M  static/js/ui.js, session.js       preview button refs removed
M  static/js/report.js               seam column
M  static/js/wav.js                  WAV encoder extracted from preview.js
M  static/styles.css                 seam control + lane ramp
M  static/vendor/signalsmith-stretch.mjs   two patches
M  tests/test_player_ui.py           TestSinglePlaybackPath guard
D  static/js/preview.js              retired
?? static/js/timeline.js             render cache for the transport
?? static/vendor/PATCHES.md          patch documentation
?? docs/adr/                         10 ADRs + index
?? design/                           step 2 plan + this handoff
```

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
- **Production**: nginx on the box terminates TLS, but plain http on port 80
  also answers. Confirm the URL people actually use is `https://`, and add an
  http -> https redirect so it cannot silently degrade.

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
4. **Memory ceiling.** Source plus rendered timeline is ~230 MB of Float32 for
   5 minutes stereo 48 kHz. Untested and the largest unknown on mobile. Flagged in
   ADR 0001, 0009, 0010; not addressed.
5. **Step 3**: MP3 via `lamejs` (ADR 0006 -- explicitly *not* ffmpeg.wasm), chunked
   so a long file does not need one monolithic buffer. Also apply peak safety.
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
