# Step 3 plan: MP3 export in the browser

## 1. Background

### 1.1 Where Step 3 sits

The refactor moves audio processing from the FastAPI/librosa backend into the
browser, in four steps:

| Step | Scope | State |
|---|---|---|
| 1 | Vendor the stretch engine; single-rate offline render | done |
| 2 | Full timeline: time map, per-section volume, seam fades, UI | done |
| **3** | **MP3 encode and local download; no server round trip** | **this plan** |
| 4 | Delete `process_audio`, trim `requirements.txt`, update `ARCHITECTURE.md` | not started |

Step 3 is the last step that changes what the product does. Step 4 is deletion.

Export is now the **only** thing still going through the server. Steps 1 and 2
moved playback to a local render, so the app currently has the odd shape of
auditioning an edit entirely offline and then uploading the original file to have
the server redo the same work with different code.

### 1.2 What the current export does

`runAndExport()` in `static/js/export.js`:

1. Flattens `state.segments` into three parallel arrays -- `timestamps`,
   `speeds`, `volumes` -- using **speed 0 as the sentinel for skip**, because
   that is what `process_audio` understands.
2. `POST /upload-audio/` with the original file plus those arrays, and a
   `client_ref` so a retried upload does not process twice.
3. Polls `GET /check-status/{id}` every 2 s, driving a progress bar and the
   loading pet.
4. On success, clicks a hidden link to `GET /download/{id}`, and 800 ms later
   downloads the report if that box was ticked.

Server side, `app/speed_changer.py` stretches each section independently with
librosa, renormalises each one's RMS, joins them with a 20 ms equal-power
crossfade, clips to +/-1, writes a temp WAV, and shells out to
`ffmpeg -q:a 2`.

This is a different algorithm from the one the browser now uses for playback, so
**what the user hears and what the user downloads are not the same audio today.**
That is the gap Step 3 closes, and it is the whole point of the step.

### 1.3 What steps 1 and 2 already provide

Most of Step 3 is already built. What remains is an encoder and some wiring.

- `renderTimeline(buffer, segments, {preset, peakSafe})` produces the finished
  `AudioBuffer`: speeds, skips, per-section volume, and seam shaping, all in one
  pass through one stretcher node (ADR 0005).
- `getTimeline()` in `timeline.js` caches that render at `PRESET_EXPORT`, keyed on
  the segment state, and is what the transport plays (ADR 0010). **Export can
  reuse the identical buffer object**, which makes playback/export parity
  structural rather than a claim -- and free when the user has already pressed
  play.
- `applyPeakSafety()` runs inside `renderTimeline`, so ADR 0006's note about
  Signalsmith overshooting peaks by up to +1.6 dB is **already satisfied**. Step 3
  needs no extra peak pass; it must simply not undo it.
- `wav.js` has `audioBufferToWav()` and `downloadBlob()`.
- `report.js` has the filename convention: `{base}_report_{YYYYMMDD_HHMM}.txt`,
  where `base` is the uploaded filename minus its extension.

### 1.4 Constraints

- **No build step.** Plain ES modules served off disk. A vendored dependency has
  to work as a file, loaded by `import` or a `<script>` tag.
- **No new server headers.** ADR 0006 rejected `ffmpeg.wasm` partly because its
  fast core needs COOP/COEP.
- **Memory was the open risk.** A 5-minute stereo 48 kHz render is ~115 MB of
  Float32 with the source alongside it, so ~230 MB before encoding starts. The
  encoder must not add a third full-length copy. **Settled by measurement**: a
  263 MB peak completed on the phone (section 5.2), and the render is sized by
  output duration, so slowing down costs more than length does.
- **The main thread runs the UI.** lamejs claims ~20x realtime, so a 3-minute
  file is several seconds of computation that must not freeze the page.
- Verified on the phone in section 5b of `design/handoff.md`: a ~3 minute
  timeline renders in 2.4-3.2 s, so the render half of export is not a problem.

### 1.5 lamejs is LGPL-3.0, which ADR 0006 does not mention

ADR 0006 chose lamejs and listed `ffmpeg.wasm`'s "own GPL/LGPL build questions"
as a reason against it -- while not recording that **lamejs is itself LGPL-3.0**
(`registry.npmjs.org/lamejs`, v1.2.1, `zhuker/lamejs`). That omission is worth
fixing before building on the decision, because ADR 0002 exists precisely because
a licence killed the first choice of stretch engine.

The conclusion is nonetheless that lamejs is fine here, for a reason specific to
this project:

- **LGPL is not GPL.** Rubber Band's problem (ADR 0002) was full copyleft or a
  paid commercial licence, which would have reached the whole frontend. LGPL
  covers the library alone, provided the user can replace it.
- **This project has no bundler**, so lamejs stays a separate file served as-is.
  The replaceability condition that makes LGPL awkward for compiled or bundled
  software is satisfied by construction.
- Obligations reduce to shipping the licence text and not modifying the library
  silently -- the same discipline `static/vendor/PATCHES.md` already applies to
  Signalsmith.

Alternative checked and rejected: `@mediabunny/mp3-encoder` is MPL-2.0, which is
a weaker licence, but it is an extension requiring the whole `mediabunny`
framework as a peer dependency. That is a much larger surface for a project that
needs one function.

- [x] **Decided: accept LGPL-3.0**, vendored unbundled and unmodified.

#### 1.5.1 What LGPL means if MusicLab is ever commercialised

Not a legal opinion, but the practical engineering read. LGPL permits use in
closed-source and paid software; it does not reach MusicLab's own code, does not
require open-sourcing it, and does not restrict charging for it. The copyleft
covers the library and modifications to the library, nothing more.

One distinction matters here and is easy to get backwards. A server-side GPL or
LGPL library is not *conveyed* to users, so obligations largely do not trigger --
that is the gap AGPL exists to close, and LGPL is not AGPL. **A browser library
is different: the JavaScript is shipped to the user's device, which is
conveying.** So vendoring lamejs in the frontend does trigger LGPL's terms, where
the same library used from `app/` would not.

What that requires, all cheap:

| Obligation | How it is met here |
|---|---|
| State that the library is used and LGPL-covered | An OSS notices section or credit in the UI |
| Ship LGPL-3.0 and GPL-3.0 licence texts | Files in `static/vendor/` |
| Provide the library's Corresponding Source | Vendor the **unminified** file -- see below |
| Let a user substitute a modified library | Satisfied by construction: a separate file, no bundler |
| Publish any modifications to the library | Only if lamejs is ever patched; note it in `PATCHES.md` |

**Corresponding Source is why the checklist below vendors the unminified build.**
LGPL asks for "the preferred form of the work for making modifications", and
minified JavaScript is not that. Since the encoder is lazy-loaded only when an
export runs, the extra bytes cost nothing that matters -- the Signalsmith module
is already 111 KB on the same terms.

Also worth recording, because it is the thing that historically blocked
commercial MP3 encoding: **the MP3 patents expired in 2017**, when the
Fraunhofer/Technicolor licensing programme was terminated. Encoding MP3 carries no
royalty exposure today. The licence is the only remaining consideration.

If LGPL is ever ruled out anyway -- an acquirer's counsel objects, or the project
gains a bundling/minifying build step that makes the replaceability argument
harder -- the exit must be cheap. Hence design decision 8 below: the encoder sits
behind `encodeMp3()` and callers never see the implementation. Swapping it is a
one-file change. Candidates, in order: server-side ffmpeg (no conveying, so the
licence question disappears), `@mediabunny/mp3-encoder` (MPL-2.0, but pulls in the
mediabunny framework), WebCodecs `AudioEncoder` (no dependency at all, but MP3
encoding support is not broad enough to rely on).

### 1.6 Requirements traceability

The original brief's requirement 4 was "zero-server export via
`OfflineAudioContext` + ffmpeg.wasm to MP3". This step delivers the requirement,
with the encoder substituted per ADR 0006.

## 2. A defect found while planning

### 2.1 Volume-only edits have no playback/export parity

`needsRender()` returns false when every section is at speed 1 and none is
skipped, so a volume-only edit never renders. Playback then applies volume live:

```js
// player.js, applyGainSchedule()
state.gainNode.gain.setValueAtTime(segments[j + 1].volume ?? 1, now + boundary - t);
```

A **hard step** at each boundary. But the render applies the same volume change as
a seam-shaped ramp over `seam.ms`:

```js
// stretch.js, applyVolume()
param.setValueCurveAtTime(fadeCurve(r.seam.curve, ...), r.output - half, dur);
```

So for a volume-only edit, playback jumps and the export ramps. This is not
cosmetic: a gain step mid-signal is exactly the click that seams exist to
prevent (ADR 0004), and the seam control the user configured is silently ignored
during playback.

It is invisible today because export goes through entirely different server code,
so there is nothing to compare against. Step 3 makes the two paths comparable and
would leave the discrepancy sitting in the open, so it is in scope here.

Two ways to fix it, and they are not equivalent:

- **(a) Make `applyGainSchedule` ramp**, mirroring `applyVolume`'s curve shapes.
  Keeps volume-only edits render-free and instant. Duplicates the curve logic in
  a second place, where it can drift.
- **(b) Delete the fast path** -- let `needsRender()` always return true, so every
  edit renders and there is exactly one gain implementation. Simplest and most
  honest, and the phone measurement makes it affordable (2.4-3.2 s for 3 minutes).
  Costs an instant volume tweak, which is the loop most likely to be iterated
  quickly.

- [x] **Decided: (a)**, 2026-08-18. `applyGainSchedule` ramps, reusing
  `shapeGain` from `stretch.js` rather than reimplementing it, so each curve has
  one definition and there is no second render path. Volume stays the one control
  that responds instantly; (b) would have traded that away for tidiness.

## 3. Design decisions

1. **Export renders through `getTimeline()`**, not a private render call. Same
   cache, same preset, same buffer object the transport plays. Parity by
   construction, and usually free.
2. **Encode in chunks, yielding to the event loop.** lamejs takes Int16 frames;
   convert one chunk at a time from the existing Float32 channels so no
   full-length Int16 copy is ever materialised. Yield every N chunks so the
   progress bar advances and the tab survives.
3. **No Web Worker in this step.** It would avoid main-thread work entirely, but
   costs a second file, structured-clone or transfer of ~115 MB, and a second
   copy of the encoder. Chunked-with-yield is the simpler shape; the worker stays
   available if measurement shows the UI still stutters.
4. **192 kbps CBR stereo.** The old pipeline used `ffmpeg -q:a 2`, VBR averaging
   roughly 190 kbps, so this keeps output size and quality where users expect.
   Mono sources encode as 1 channel.
5. **Filename `{base}_{YYYYMMDD_HHMM}.mp3`**, matching `report.js`'s existing
   convention so the mp3 and its report sort together. Replaces
   `musiclab_{taskId}.mp3`, since there is no task id any more.
6. **Keep the existing guards and the report flow.** Empty file, expired session,
   all-sections-skipped, the report snapshot taken before work starts, and the
   staggered second download all stay as they are.
7. **The progress bar reports encode progress**, not upload/poll progress. Render
   progress is not available (`OfflineAudioContext` has no progress event), so the
   render shows as an indeterminate phase and encoding fills the bar.
8. **The encoder is swappable.** Callers see only
   `encodeMp3(buffer, {kbps, onProgress}) -> Blob`; nothing outside `mp3.js` may
   reference lamejs, `window.lamejs`, or its frame size. This is what keeps 1.5.1's
   exit cheap, and it costs nothing to hold to from the start.

## 4. Build checklist

### 4A. Vendor lamejs

- [x] Licence settled in 1.5: LGPL-3.0 accepted.
- [x] Vendored `lame.all.js` (530 KB, unminified) as `static/vendor/lamejs.js`,
      unmodified. Tarball shasum checked against the npm registry.
      **ADR 0006's "~50 KB" was wrong**: minified is 156 KB, unminified 530 KB.
- [x] `lamejs-LICENSE.txt` (upstream notice verbatim, plus provenance),
      `LGPL-3.0.txt`, `GPL-3.0.txt`.
- [x] `PATCHES.md` now opens with a table of both dependencies and their
      licences, and states that lamejs is unpatched and must stay that way.
- [x] README "Third-party libraries" section. LAME's licence asks for
      acknowledgement and a link, so this is a condition, not a courtesy.
- [x] Loaded by injected `<script>`, resolved with `new URL(..., import.meta.url)`
      -- a script `src` is document-relative, which would have broken the dev
      harness at a different depth.

### 4B. Encoder module (`static/js/mp3.js`)

- [x] `encodeMp3(buffer, {kbps, onProgress})` -> `Blob`.
- [x] Lazy-loaded and cached; a failed load clears the cache so a later export
      can retry.
- [x] Channels: `Math.min(2, buffer.numberOfChannels)`.
- [x] 1152-sample frames, Float32 -> Int16 per chunk, clamped. One reused
      scratch array, so no full-length second copy; a short final chunk gets its
      own array rather than carrying stale samples.
- [x] `FRAMES_PER_TURN = 48`, **set from measurement, not guessed**. An initial
      200 blocked the main thread for a median of 169 ms per turn (max 268 ms).
      48 gives a median of 44 ms (max 114 ms) and costs 12% throughput:
      26.5x -> 23.6x realtime on an M-series Mac.
- [x] `setTimeout`, not a microtask -- a resolved promise does not let the
      browser paint.
- [x] `onProgress(0..1)` per batch, plus a final 1.
- [x] One `Blob` of `audio/mpeg` from the chunks plus `flush()`.
- [x] Levels untouched. Verified by test E6: a 0.99-amplitude source rendered at
      1.25x comes back at peak 0.9702 with the render's makeup gain intact.

### 4C. Rewire `export.js`

- [x] `runAndExport()`: guards, `getTimeline()`, `encodeMp3()`, `downloadBlob()`.
- [x] Banner reads `rendering...` then `encoding mp3...`; the bar belongs to the
      encode, which is the phase that can report progress.
- [x] Report download unchanged, stagger and fallback link included.
- [x] Errors reported verbatim; the `all-skipped` tag replaces the separate
      pre-check, so "nothing to export" has one definition.
- [x] `setBusy(false)` on every exit.
- [x] Filename `{base}_{YYYYMMDD_HHMM}.mp3`. `exportBaseName()` and
      `reportStamps()` are now exported from `report.js` so the mp3 and its
      report are named from one definition.

### 4D. Volume-only parity (from 2.1)

- [x] (a) applied. `stretch.js` now exports `fadeCurve` and `curvePoints`, so
      `applyGainSchedule` builds the same curve the render bakes in -- the whole
      curve is shared, not just `shapeGain`, so point density matches too.
- [x] `rampHalf()` in `player.js` mirrors `clampedHalf()`, so adjacent ramps
      cannot overlap on one `AudioParam`.
- [x] A ramp already straddling the playhead is truncated rather than skipped.
      Safe because the curve opens at the value currently scheduled, so there is
      no step at the join.

### 4E. Dead client code

- [x] `submitJob`, `pollStatus`, `fetchWithRetry` deleted.
- [x] `networkErrorMessage` **also** deleted. The plan assumed video extraction
      used it; it does not -- `extractAudioOnServer` throws its own message. That
      assumption was checked rather than trusted.
- [x] `CONFIG.POLLING_INTERVAL_MS` and all of `ERROR_MESSAGES` deleted: every key
      described a server failure mode that no longer exists.
- [x] Server endpoints untouched, as Step 4's job.

## 5. Verification

Seven tests added to `static/dev/stretch-test.html` as `runMp3Tests`, following
the existing pattern where each section carries a **different tone**: duration
alone cannot prove a render is right, because a wrong render is still the length
we asked for. Measured values, not just PASS:

| Test | Measured |
|---|---|
| E1 440 Hz tone survives encoding | 440.0 Hz, rms 0.343, 72576 bytes (3 s @ 192 kbps = 72000 expected) |
| E2 duration within 50 ms of source | +24 ms (encoder priming plus frame padding) |
| E3 three sections keep three tones | 330 / 550 / 881 |
| E4 mono encodes as 1 channel | 1 ch, rms 0.343 |
| E5 progress monotonic, reaches 1 | monotonic, last value 1 |
| E6 hot source not clipped | peak 0.9702, render peak 1.0000 -- makeup gain intact |
| E7 export encodes what playback played | same buffer object |

- [x] All seven pass. Full suite is now **37 browser tests** (5 single-rate, 11
      timeline, 14 data model, 7 mp3) and **68 pytest**.
- [x] `TestLocalExport` in `tests/test_player_ui.py`: export references no
      `/upload-audio/`, `submitJob` or `pollStatus`; it uses `getTimeline()` and
      not its own `renderTimeline`; **no module outside `mp3.js` names lamejs**
      (which is what keeps the encoder swappable); the licence files exist.

### 5.1 End to end through the real UI

Module tests passing while a feature is unreachable is a mistake this project has
already made, so the export was also driven through the actual product: a 12 s
three-tone WAV fed to the real file input via CDP, split into three sections with
the middle one at 0.5x, then the real `[ Export ]` button clicked.

| Check | Expected | Got |
|---|---|---|
| Output duration (4 + 8 + 4) | 16 s | **16.04 s** |
| Tone per section | 330 / 550 / 880 | **330 / 552 / 882** |
| Size (16 s @ 192 kbps) | ~384000 | 384940 |
| Filename | report convention | `e2e-input_20260818_2250.mp3` |
| Page errors | none | none |

The pitches staying at 330/550/880 rather than dropping with the speed is what
proves this is time stretching and not resampling.

### 5.2 Measurements

Encode throughput on an M-series Mac, 60 s stereo 48 kHz at 192 kbps:

| `FRAMES_PER_TURN` | throughput | median block | max block |
|---|---|---|---|
| 200 (first attempt) | 26.5x realtime | 169 ms | 268 ms |
| **48 (shipped)** | **23.6x realtime** | **44 ms** | **114 ms** |

The batch size was set from this, not guessed -- the original code comment
claimed "tens of milliseconds" and was wrong by 4x. Trading 12% throughput for a
main thread that keeps painting is the right side of that deal.

Extrapolated, a 3-minute export is roughly 7.6 s of encoding on desktop, on top
of 2.4-3.2 s of rendering measured on the phone in `handoff.md` section 5b.

Measured on a device 2026-08-19, at the export:

```
mp3 11.4 MB in 13.7s · 252 MB live (source 70 + render 182) + 11.4 MB mp3
```

- [x] Encode time off the dev machine: 497 s of audio in 13.7 s, 36x realtime.
- [x] **Peak memory.** 263 MB including the mp3, and it completed -- above the
      ~227 MB projected for the 5-minute worst case. Detail and the caveats in
      `design/handoff.md` section 5c. The load-bearing finding: the render is
      sized by *output* duration, so **slowing down costs memory, not length**.
      A 3:11 source at 0.38x produced an 8:17 render.

## 6. Out of scope

- WAV export in the UI. The encoder exists in `wav.js`, but the product exports
  MP3 and nothing has asked for more. One line of UI if it is ever wanted.
- Any format beyond MP3 -- that reopens ADR 0006.
- A Web Worker for encoding, unless 4B's measurement says the UI stutters.
- Step 4's deletions.
