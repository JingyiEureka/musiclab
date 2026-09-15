# Handoff: client-side DSP refactor

Sessions of 2026-08-01 / 08-02 / 08-18 / 08-19. Branch `restructure-layout`,
**not pushed and not merged to `main`**. Steps 1-3 are committed and step 4 is
the remaining work; every technical risk the refactor opened is now closed
(sections 5a-5c). Section 6 lists what is left.

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
7 mp3) via `static/dev/stretch-test.html`, plus **98 pytest**. All green. Export
was also driven end to end through the real UI, and measured on the phone -- see
`design/step3-plan.md` section 5.1 and section 5c below.

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
25963ea  Revert the upload zone to a div with a click handler
630e835  Restore the upload zone's layout after the label change
ab75a0b  Fix a stray character that broke every module, and guard against the next
476abb6  Keep TLS out of the app in the phone-testing notes
64a9ffa  Report memory alongside timing under ?timing=1
fa0e830  Encode MP3 in the browser; drop the server export round trip   (step 3)
92cdca2  Plan step 3, and record the licence ADR 0006 left out
2cb5b0a  Correct the production TLS note in the handoff
f92de83  Make client-side rendering work off the dev machine   (secure context)
181704a  Move audio processing into the browser (steps 1-2)
```

`tests/test_js_syntax.py` parses every frontend module with `node --check`. It
exists because a stray U+00B7 in `stretch.js` shipped in `476abb6` under a commit
message claiming "No code change": ES modules fail as a graph, so one unparseable
file left the whole page without event handlers, and ruff and pytest read only
Python. Read the diff before committing, and do not trust `git add -A`.

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

### Testing on a phone: the setup that worked

An http LAN IP can never work, so device testing needs TLS. Two things went wrong
before this worked, both worth not repeating.

**Do not put TLS in uvicorn.** It accepts `--ssl-keyfile/--ssl-certfile` and it
was used once, but production is `browser --https--> nginx --http--> uvicorn:8000`
and the app carries no TLS anywhere. Terminating it in the app means certificate
debugging happens at a layer the deployment does not have.

**A one-command self-signed certificate is not enough for iOS.** Safari lands on
`about:blank` after "visit this website", with no request reaching the server.
Since iOS 13 a TLS server certificate must carry `extendedKeyUsage = serverAuth`;
`openssl req -x509` alone emits none, and marks the certificate `CA:TRUE`, which
is wrong for a leaf. What works is a root CA plus a leaf signed by it.

`dev-tls/` (gitignored) held the working setup: `nginx.conf`, `Dockerfile`,
`certs/`, `capub/` with only the public CA in it, and `hello/index.html`.

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
cp ca-cert.pem ../capub/musiclab-ca.crt
```

nginx ran in Docker, listening 8443 for TLS and 8080 to hand over the CA:

- `proxy_pass http://host.docker.internal:8000/` -- on macOS the container cannot
  reach the host on `127.0.0.1`, and uvicorn must be started with
  `--host 0.0.0.0` for it to be reachable at all.
- **Bake the files into the image, do not bind-mount them.** Docker Desktop
  cannot read `~/Desktop` without Full Disk Access, and a mount there fails with
  `Operation not permitted`.
- Serve the CA over plain http from a directory holding **only** the public
  certificate. Pointing a static server at the directory with `ca-key.pem` in it
  publishes a CA the phone trusts to everyone on the network. That mistake was
  made here.
- `.crt` must be served as `application/x-x509-ca-cert` or iOS downloads it as a
  file instead of offering to install it. nginx's mime.types does this already.

On the phone, in **Safari**: fetch `http://<lan-ip>:8080/musiclab-ca.crt`, install
it (Settings -> General -> VPN & Device Management), then **enable it under
Settings -> General -> About -> Certificate Trust Settings**. That switch is a
different screen from the install and nothing prompts for it; skipping it fails
with `ERR_CERT_AUTHORITY_INVALID`. Delete the profile when finished -- it is a
trusted root whose private key is sitting on the dev machine.

**Verify the certificate with a static page before opening the app.** `hello/`
reported `isSecureContext` and `audioWorklet` on both context types and nothing
else. Doing this first is what finally separated the certificate problem from the
app problem: with them mixed together, an app that would not respond looked like
a trust failure, and it was actually an unrelated syntax error.

Desktop needs none of this -- `http://127.0.0.1:8000` is a secure context by the
localhost exemption. On Android, `adb reverse tcp:8000 tcp:8000` sidesteps
certificates entirely.

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

The app reports these figures itself -- open it with `?timing=1`:

- every render prints duration, wall time, throughput, **and how many MB are
  live**, staying on screen instead of vanishing after 2.5 s;
- export prints mp3 size, encode time, and the peak memory triple (source +
  render + mp3), which is the highest the app ever gets;
- the two cases that are silent by default are surfaced -- a cache hit, and a
  volume-only edit that never renders. Both were mistaken for a failed
  measurement before the flag existed.

The MB figures exist because iOS has no memory API and a tab killed for running
out leaves no trace. Knowing a 12 s file sits at 9 MB and a 5-minute one at
~230 MB says how close the ceiling is, rather than only whether this attempt
survived.

## 5c. Memory ceiling: cleared, and the heavy direction is slowing down

Measured at the export, which is the peak: source buffer, rendered timeline and
encoded mp3 are all live at once. A 3:11 source at 48 kHz stereo, slowed to
**0.38x**:

```
mp3 11.4 MB in 13.7s · 252 MB live (source 70 + render 182) + 11.4 MB mp3
```

**263 MB peak, and it completed.** That is above the ~227 MB this document
previously projected as the 5-minute worst case, so the ceiling that ADR 0001,
0009 and 0010 all flagged is cleared with margin.

Every figure cross-checks: 70 MB of source is 3:11 at 48 kHz stereo, 182 MB of
render is 8:17, and 11.4 MB of mp3 at 192 kbps is 8:18 -- one second more than
the render, which is the encoder's padding. Encoding ran at 36x realtime.

**Slowing down is the direction that costs memory, not length.** 0.38x turned a
70 MB source into a 182 MB render; the render is sized by *output* duration. This
is also the app's real use -- a dancer rehearsing slowly -- so the worst case in
practice is a slow variation, not a long one. Chasing the longest file was the
wrong instinct.

Two things this does not establish:

- Whether it ran on the phone. The 36x encode is faster than the 23.6x measured
  on the dev Mac, which fits the pattern where the phone's render figures
  (54-75x) also beat the desktop's 30x, but the numbers alone cannot prove it.
- The true instantaneous peak may be slightly higher than 263 MB: `new Blob(parts)`
  can briefly hold the chunk array and the blob together, adding up to another
  11 MB.

## 6. Open items

Every risk the refactor opened is closed. What is left is deletion, one decision,
and two small things.

### 6.1 Step 4 -- the only remaining work

Pure deletion, nothing in it changes behaviour:

- [ ] Delete `process_audio` and `app/speed_changer.py`.
- [ ] Delete the endpoints `/upload-audio/`, `/check-status/{id}`, `/download/{id}`
      and `TASKS_DB`. **Keep `/extract-audio/`** -- video containers Safari cannot
      decode still need it (ADR 0001). It is the only server call the app makes.
- [ ] Drop librosa, numpy and soundfile from `requirements.txt`. Keep ffmpeg for
      the video extraction above.
- [ ] Update `ARCHITECTURE.md`: its diagrams still show the upload/poll pipeline,
      and known issues 1 and 3 (the one-job concurrency cap, and stuck tasks
      holding the slot) stop existing once `TASKS_DB` goes.
- [ ] Check nothing else imports what is being deleted, and re-run the browser
      suite as well as pytest -- the pre-commit command is Python-only.

### 6.1b Two DSP defects fixed in `speed_changer.py` -- check the browser path

Found from a report that tempo-changed sections sounded louder. Both were real,
both are fixed in the Python path, and **neither has been checked in
`static/js/stretch.js`**. Worth measuring a browser export before Step 4 deletes
the Python path and takes the only known-good reference with it.

1. **Independent L/R stretching.** `stretch()` ran `time_stretch` separately on
   each channel, so the phase vocoder gave each its own phase advance. L/R
   correlation collapsed from ~0.45 to ~0.00 on every stretched section. Per
   channel the level was untouched -- which is why the RMS compensation saw
   nothing wrong -- but the phantom centre lost ~1.5 dB. Fixed by stretching
   mid/side and rebuilding L/R, so both outputs come from one mid signal.
   Signalsmith processes channels as a linked pair, so the browser is probably
   clear, but it has not been measured.
2. **Onset burst at every section start.** Sections were sliced with a hard cut
   and handed straight to the stretcher, so the phase vocoder read the edge as a
   broadband transient. The first 0.25s of every stretched section came out
   2.5-3.5 LU too loud, decaying over ~0.5s -- far longer than the 20 ms
   crossfade can mask. Fixed by carrying `STRETCH_CONTEXT_SEC` (1.0s) of
   neighbouring audio into the stretcher and discarding it after. Worst onset
   error is now 1.10 LU, worst whole-section error 0.16 LU.

Any stretcher fed hard-cut slices can show defect 2; it is not librosa-specific.

### 6.2 One decision: memory on other people's phones

Nothing is broken; this is about devices that are not the one measured. Memory
scales with **output** duration, so it is the slowdown that costs, not the file
length. Projected peaks for a 3-minute 48 kHz stereo source:

| speed | output | peak |
|---|---|---|
| 1.0x | 3:00 | ~140 MB |
| 0.5x | 6:00 | ~280 MB |
| 0.38x (measured, fine) | 8:17 | 263 MB |
| 0.33x | 9:00 | ~390 MB |

A 5-minute variation at 0.5x projects to roughly 450 MB, which is where an older
iPhone would be at risk. iOS gives no memory API and kills the tab silently, so
the failure leaves no evidence.

Two options, **not yet decided**:

- **Warn before exporting.** Project the peak from the segment state and say so
  when it is large. Perhaps 20 lines, no architectural change, and it converts a
  silent death into a clear message. Recommended.
- **Chunked export.** Render and encode in windows, discarding each -- peak drops
  from 182 MB to tens. But it reintroduces a phase discontinuity at every chunk
  boundary, which is exactly what ADR 0005 avoids, and breaks the guarantee that
  the exported bytes come from the buffer playback used, which ADR 0010 rests on.
  Needs its own ADR.

### 6.3 Two small things

- [ ] **Pre-warm the WASM module** on file open. Low value now: the whole render
      is 2.4-3.2 s on the phone, which caps what pre-warming can recover.
- [ ] **Verify the seam UI by eye.** The seam control and lane ramp pass
      structural tests, but gradient weight and crowding on a narrow screen have
      never been looked at.

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
