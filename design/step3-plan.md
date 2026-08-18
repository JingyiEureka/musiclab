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
- **Memory is the open risk.** A 5-minute stereo 48 kHz render is ~115 MB of
  Float32, and the source buffer sits alongside it, so ~230 MB before encoding
  starts. Untested above the 3-minute mark. The encoder must not add a third
  full-length copy.
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
- [ ] Vendor the **unminified** build as `static/vendor/lamejs.js`, unmodified.
      Not the minified one: LGPL wants the form preferred for making
      modifications (1.5.1). It is lazy-loaded only during an export, so the size
      is not on any page-load path.
- [ ] `static/vendor/lamejs-LICENSE.txt` -- the LGPL-3.0 text, plus the GPL-3.0
      text it incorporates by reference.
- [ ] Record in `static/vendor/PATCHES.md` that lamejs is vendored **unpatched**,
      alongside its licence. That file becomes the one place stating both
      dependencies and their terms: Signalsmith MIT, lamejs LGPL-3.0.
- [ ] An OSS notices line in the UI or README crediting both libraries. Required
      for lamejs, courteous for Signalsmith.
- [ ] It is UMD, not an ES module, so `import` will not work directly. Load it
      lazily the way `stretch.js` loads its engine -- a cached dynamic
      `<script>` injection resolving to `window.lamejs` -- rather than adding a
      blocking tag to `index.html` that every page load pays for.

### 4B. Encoder module (`static/js/mp3.js`)

- [ ] `encodeMp3(buffer, {kbps, onProgress})` -> `Blob`.
- [ ] Lazy-load the vendored encoder on first call; cache the handle.
- [ ] Channels: `Math.min(2, buffer.numberOfChannels)`, matching
      `renderTimeline` and `audioBufferToWav`.
- [ ] Walk the buffer in 1152-sample frames (lamejs's granule size), converting
      Float32 to Int16 per chunk, clamping to +/-1 first.
- [ ] Process many frames per turn, then `await` a macrotask, so the UI paints.
      Tune the batch so a turn is a few tens of milliseconds.
- [ ] `onProgress(0..1)` per batch.
- [ ] Collect `encodeBuffer()` output plus the final `flush()` into one `Blob`
      of type `audio/mpeg`.
- [ ] Do **not** touch levels: `applyPeakSafety` already ran inside the render.

### 4C. Rewire `export.js`

- [ ] `runAndExport()`: keep the guards, then `getTimeline()`, then
      `encodeMp3()`, then `downloadBlob()`.
- [ ] Show the render phase and the encode phase distinctly in the banner, since
      the render has no progress and the encode does.
- [ ] Report download unchanged, including the 800 ms stagger and the manual
      fallback link.
- [ ] Failure path: report the real error the way `player.js` now does, rather
      than a fixed string -- and reuse the `all-skipped` tag from `stretch.js`
      instead of the separate pre-check, so there is one definition of "nothing
      to export".
- [ ] `setBusy(false)` on every exit, including the error paths.

### 4D. Volume-only parity (from 2.1)

- [ ] Apply whichever of (a)/(b) the user picks.
- [ ] If (a): export `shapeGain` from `stretch.js` and build the ramp in
      `applyGainSchedule` from it, so the curve shapes have one definition.
- [ ] The ramp must be clamped the way `clampedHalf` clamps, or two close
      boundaries will produce overlapping automation on one `AudioParam` --
      the failure mode the two-gain-node split exists to avoid.

### 4E. Dead client code

- [ ] `submitJob`, `pollStatus`, `fetchWithRetry` lose their only callers. Delete
      them in this step; leaving them implies a server path that no longer runs.
- [ ] `networkErrorMessage` is still used by `/extract-audio/` for video, so it
      stays. Confirm before deleting anything.
- [ ] `CONFIG.POLLING_INTERVAL_MS` and the `ERROR_MESSAGES` keys that only
      described server failures (`encode_failed`, `invalid_params`,
      `server_error`) become unused. Remove the unused ones.
- [ ] Leave the server endpoints alone. `/upload-audio/`, `/check-status/`,
      `/download/` are Step 4's job; `/extract-audio/` is kept permanently
      (ADR 0001).

## 5. Verification

Add an MP3 suite to `static/dev/stretch-test.html`, following the existing
pattern where each section carries a **different tone**, so a passing test proves
each section survived encoding rather than only that the duration is right.

- [ ] Encode a known tone; decode the result with `decodeAudioData` and confirm
      frequency and RMS survive within MP3's tolerance.
- [ ] Duration within one frame of the render's, allowing for the encoder's
      priming samples.
- [ ] A three-section timeline at three different tones: each tone present at the
      expected output time.
- [ ] Mono source encodes as 1 channel and stays audible.
- [ ] Progress callback reaches 1.0 and is monotonic.
- [ ] Peak safety survives: a source deliberately near 0 dBFS does not come back
      clipped.
- [ ] **Parity:** encode from `getTimeline()`'s buffer and confirm it is the same
      object the transport played, not a re-render. This is the claim ADR 0010
      rests on, so it should be a test and not a comment.
- [ ] A UI-level guard in `tests/test_player_ui.py`, in the spirit of
      `TestSinglePlaybackPath`: assert the export path no longer references
      `/upload-audio/`. Module tests passing while a feature is unreachable is a
      mistake this project has already made once.

Also measure, and record in `handoff.md`:

- [ ] Encode time for a 3-minute file, desktop and phone.
- [ ] Peak memory for the longest variation available, since **the memory
      ceiling is the last untested risk** and export is where it peaks: source
      plus render plus encoder output all live at once.

## 6. Out of scope

- WAV export in the UI. The encoder exists in `wav.js`, but the product exports
  MP3 and nothing has asked for more. One line of UI if it is ever wanted.
- Any format beyond MP3 -- that reopens ADR 0006.
- A Web Worker for encoding, unless 4B's measurement says the UI stutters.
- Step 4's deletions.
