# Step 2 plan: timeline render with seam handling

## 1. Background

### 1.1 Why this refactor exists

MusicLab slows down and reshapes ballet variation recordings so a dancer can
rehearse against them. All audio processing currently happens on the server:
`POST /upload-audio/` accepts the file, a background task runs `process_audio`
(librosa for time-stretching, ffmpeg for MP3 encoding), and the browser polls
`GET /check-status/{id}` every two seconds until the result is ready.

That design has three costs that compound:

1. **A hard concurrency cap of one job.** `app/main.py` rejects a second export
   while one is active. On the production box (2 vCPU / 1 GB) this is a
   deliberate protection, not a bug -- but it means a second user waits for the
   first, and a stuck task holds the slot for up to 24 hours
   (`ARCHITECTURE.md`, known issue 1).
2. **Every preview is a full server round trip.** `static/js/preview.js` slices
   a 16-second window out of the loaded buffer, encodes it as WAV, uploads it,
   and runs it through the *same* export pipeline just to hear a few seconds.
   Adjusting one section's speed and listening to the result costs an upload, a
   queue wait, a render, and a download.
3. **Server-side state and disk.** In-memory `TASKS_DB` is forgotten on
   container restart, and finished renders accumulate in `outputs/` behind a
   cleanup sweep.

Moving the DSP into the browser removes all three at once. It also means the
audio never leaves the user's device, which is a privacy improvement the
original brief did not claim.

### 1.2 What the current pipeline does

`app/speed_changer.py` is the behaviour Step 2 must replace. Given cut
timestamps, per-section speeds, and per-section volumes, `process_audio`:

1. Loads the file with librosa (`sr=None`, `mono=False`).
2. Slices it at the timestamps into consecutive segments.
3. Drops any segment whose speed is `0` -- the sentinel the UI uses for "skip".
4. Time-stretches each remaining segment **independently** via
   `librosa.effects.time_stretch`, then rescales it so its RMS matches the
   input's (`speed_changer.py:31-33`).
5. Applies per-section gain.
6. Joins segments with a 20 ms equal-power crossfade -- *except* where the audio
   is provably continuous (both sides unstretched, same volume, nothing removed
   between), where it concatenates directly (`speed_changer.py:147`).
7. Clips to +/-1, writes a temporary WAV, encodes MP3 with ffmpeg.

Two details matter for the new design. The **RMS renormalisation** in step 4
exists because librosa's phase vocoder does not preserve loudness. The **20 ms
crossfade** in step 6 exists because each slice is stretched and gain-scaled on
its own, so slices do not line up phase-wise even at equal speeds -- the comment
at `speed_changer.py:148` says exactly this. Both are consequences of processing
slices independently. Neither is an intrinsic requirement.

### 1.3 Where Step 2 sits

The refactor runs in four steps:

| Step | Scope | State |
|---|---|---|
| 1 | Vendor the stretch engine; prove a single-rate offline render | **done, verified** |
| 2 | Render the whole timeline: time map, per-section volume, seam fades | this plan |
| 3 | MP3 encode and local download; export chunking for long files | not started |
| 4 | Delete `process_audio`, trim `requirements.txt`, keep video extraction | not started |

Rewiring `preview.js` off the server is a small follow-on to Step 2, tracked
separately so the engine can be verified before the UI depends on it.

### 1.4 Scope decisions already locked

These were settled with the user and should not be reopened inside this step.

- **No multi-track DAW.** The app stays a single-file model: one audio file cut
  into consecutive, non-overlapping sections (`state.segments`). There are no
  movable clips and no overlapping regions. The "crossfade between overlapping
  regions" idea from the original brief does not apply here.
- **No freeform volume automation lanes.** Volume stays a per-section macro
  control, plus a configurable transition at section boundaries.
- **Signalsmith Stretch (MIT) over RubberBand.** RubberBand is dual-licensed
  GPL / commercial; shipping it as WASM would force copyleft on the whole
  frontend or require a paid licence. Signalsmith is MIT, and at v1.3.2 the
  entire library is a single 111 KB `.mjs` with the WASM base64-inlined -- no
  separate binary, no MIME configuration, no `SharedArrayBuffer`, and therefore
  no COOP/COEP response headers. That matters because this project has **no
  build step**: `static/index.html` loads `static/js/main.js` as a plain ES
  module and everything is served straight off disk.
- **Cut seams use option (a), a gain dip**, not a two-node true crossfade. One
  stretcher node, gain dips through the cut. Cheaper on mobile, and cuts are
  rare in practice (see 1.7).

### 1.5 What Step 1 established

Step 1 vendored the library and built `renderStretched(buffer, rate)` on top of
`OfflineAudioContext`. Verified in headless Chrome against a 440 Hz stereo sine
at amplitude 0.5 (RMS 0.354), 2 s, 48 kHz:

| rate | expected | actual | freq | RMS | peak | onset | render |
|---|---|---|---|---|---|---|---|
| 1.00 | 2.000s | 2.000s | 440.5 Hz | 0.353 | 0.585 | 8.3 ms | 94 ms |
| 0.84 | 2.381s | 2.381s | 440.2 Hz | 0.353 | 0.538 | 8.6 ms | 88 ms |
| 0.70 | 2.857s | 2.857s | 440.3 Hz | 0.353 | 0.542 | 11.6 ms | 101 ms |
| 0.50 | 4.000s | 4.000s | 440.8 Hz | 0.351 | 0.603 | 0.5 ms | 135 ms |
| 1.08 | 1.852s | 1.852s | 440.6 Hz | 0.353 | 0.532 | 8.1 ms | 69 ms |

Four findings carry directly into this step:

1. **Loudness is preserved** to within 0.3% at every rate. The RMS
   renormalisation hack from 1.2 has no counterpart here and is not needed.
2. **Peaks overshoot by up to +1.6 dB** (0.500 in, 0.603 out). Normal
   phase-vocoder behaviour, but a source mastered near 0 dBFS will exceed +/-1.
   The old code hard-clipped; this step applies a measured makeup gain instead.
3. **There is a ~8 ms window ramp-in** at the start of a render. Acceptable once
   per export. It would land at *every* boundary if sections were rendered
   separately and concatenated -- which is the main argument for the single-node
   design in 1.6.
4. **Throughput is ~22x realtime** (2 s stereo in ~90 ms on an M-series Mac). A
   3-minute variation should render in roughly 8 s here; even 4-5x slower on a
   mid-range phone leaves export at 30-40 s with a progress bar, and a 16 s
   preview window near 3 s.

### 1.6 The engine's model: a time map, not slices

This is the conceptual shift that shapes the whole step, and the reason most of
1.2's machinery disappears.

Signalsmith's web release is not a "stretch this array" function. It is a sample
player driven by a piecewise **time map**:

```js
node.addBuffers([ch0, ch1])                      // hand it the source audio
node.schedule({ outputTime, output, input, rate }) // at this output time, be at
                                                   // this input position, at this rate
node.configure({ preset: 'cheaper' | 'default' })  // quality vs CPU
```

Each breakpoint says *at output time T, the playhead sits at input position I
and advances at `rate` source-seconds per output-second*. Between breakpoints
the position is interpolated.

MusicLab's edit model is already exactly this: section *i* covers source
`[start, end)` and plays at `speed`. So the whole timeline becomes one
`schedule()` call per section, feeding **one continuous stretcher stream**
rather than a set of independently processed slices.

Three consequences:

- **`rate` is `speed`.** Both are source-seconds per output-second, so
  `speed: 0.84` passes through as `rate: 0.84` with no inversion. (Worth stating
  because a time *ratio* -- output length over input length -- would be the
  reciprocal, and getting this backwards is an easy, quiet bug.)
- **Contiguous rate changes stop needing crossfades.** A 1.0 -> 0.84 boundary
  with nothing removed between is continuous in input, so the stretcher simply
  changes rate mid-stream. The class of artefact that the 20 ms crossfade in 1.2
  existed to hide does not arise. This is why the seam feature in this step is
  narrower than the original brief assumed.
- **Only two boundary conditions still need treatment**: a volume change (a gain
  ramp) and a cut where material was removed (a genuine input discontinuity).

### 1.7 Constraints

- **Mobile is the binding constraint.** The stated goal is no stuttering on
  iOS/Android, so heavy DSP never runs during a drag -- renders happen on
  release, into a buffer that is then played. `preset: 'cheaper'` exists for the
  preview path, `'default'` for export.
- **Existing data model must survive.** Sections are
  `{endTime, speed, volume, skip}` with boundaries clamped 0.5 s apart
  (`segments.js:210`), persisted to IndexedDB via `session.js` with a one-week
  TTL. Sessions saved before this step must still open.
- **Real-world speed range is narrow.** From `archive/outputs/`, actual usage is
  speed 0.70-1.08, overwhelmingly 0.80-1.00, with a single 0.50 outlier:

  ```
  speed:  50  70  75  80  84  85  87  91  92  93  95  96  98 100 103 105 108
  count:   1   2   1   7   1   2   1   2   3   1   4   3   2  24   1   1   1
  ```

  In output-length ratio that is 0.93x-1.43x, comfortably inside Signalsmith's
  recommended 0.75x-1.5x band. The UI's 25%-800% range is theoretical. Cuts are
  rare -- one removal across all recorded sessions -- which is what makes the
  cheaper seam-dip choice safe.
- **No build step, vanilla ES modules**, 4-space indent, comments only where the
  reasoning is not obvious from the code.

### 1.8 Terminology

Loose use of these terms caused two errors in Step 1, so they are fixed here.

| Term | Meaning in this document |
|---|---|
| **speed** / **rate** | Source seconds per output second. `0.84` = slower, longer output. Interchangeable. |
| **ratio** | Output length over input length -- the *reciprocal* of speed. Only used when quoting Signalsmith's quality band. |
| **skip** | A section removed from the output. The output gets **shorter**. |
| **cut** | The boundary left behind by one or more skipped sections. The input position jumps. |
| **seam** | Any boundary between two rendered sections. |
| **dip** | Gain falling to 0 and back across a cut, to hide the discontinuity. |

### 1.9 Requirements traceability

The original brief listed four features. Two were reshaped by the user's own
follow-up; this table records where each one now lives so nothing is quietly
dropped.

| # | As originally requested | Status | Where |
|---|---|---|---|
| 1 | High-quality time stretching | **done** (Step 1) | `renderStretched()`, verified in 1.5 |
| 1 | Buffered preview: render on `onMouseUp`, play the rendered buffer | **this step** | 4D |
| 2 | Crossfade between *overlapping regions*, draggable handles | **superseded** -- no overlapping regions exist in this model | 1.4 |
| 2 | Adjustable, visualised seam fade per boundary (option a) | **this step** | 3, 4A, 4B, 4C |
| 3 | Volume Automation Curve: freeform lane, click-to-add breakpoints, drag in x/y | **superseded** by the user's revision -- explicitly "without complex freeform automation lanes" | -- |
| 3 | Per-section volume macro + boundary volume curve / seam crossfade | **this step** | 3, 4A, 4B, 4C |
| 4 | Zero-server export via `OfflineAudioContext` | **this step** (render half) | 4A |
| 4 | MP3 encode + local download | Step 3 | 1.3 |
| 4 | `ffmpeg.wasm` as the encoder | **superseded** -- ~25-30 MB and wants `SharedArrayBuffer` + COOP/COEP; `lamejs` is ~50 KB for MP3-only | Step 3 |

Requirement 3 is the one the brief marked "(New Feature)". It is not dropped --
the freeform lane was replaced by the boundary curve at the user's direction, and
that curve is a first-class part of this step.

## 2. Two corrections carried in from Step 1

**2.1 `active: false` is not skip.** I said earlier that skip maps natively onto
`schedule({active: false})`. It does not. `active: false` outputs *silence while
output time keeps advancing* -- a mute, not a cut. MusicLab's skip **removes**
the section, so the output gets shorter (`segments.js:36`, and the `continue` at
`speed_changer.py:132`).

The right encoding is an **input jump**: at the output time where the skipped
material would have started, schedule the next kept section with an explicit
`input` pointing past it. Output time stays continuous, input position jumps.
`active` is not used at all in this step.

**2.2 `schedule()` cannot pre-load a time map at all.** An earlier draft of this
plan said to pass an explicit `outputTime` on every breakpoint. **That does not
work.** The worklet prunes in two places:

```js
while (timeMap.length && timeMap[timeMap.length - 1].output >= outputTime) pop()
...
while (timeMap.length > 1 && timeMap[1].output <= outputTime) shift()
```

To add breakpoint *k* while keeping the earlier ones, the first loop requires
`T[k-1] < outputTime` and the second requires `T[1] > outputTime`. Together that
demands `T[1] > T[k-1]`, impossible for any k >= 2 in ascending order. **The map
retains at most two entries regardless of what `outputTime` is passed.**
`schedule()` is built for realtime, where it correctly discards the past on every
call.

Resolved by patching the vendored library with a `setTimeMap` remote method that
assigns the whole map at once -- see `static/vendor/PATCHES.md`. The library is
MIT, the patch is five lines, and `process()` still prunes as playback advances,
which is the behaviour we want during rendering.

The failure mode is silent: without the patch the render succeeds using only the
last section's rate, back-extrapolated from t=0. Test 5.2 exists to catch it, and
`renderTimeline` additionally checks `setTimeMap`'s returned count.

## 3. Design decisions

- **One stretcher node, one time map.** Not per-section renders. Avoids the
  ~8 ms window ramp-in landing at every boundary (1.5, finding 3).
- **Two gain nodes in series**, `volumeGain -> seamGain -> destination`.
  Per-section volume ramps live on the first, cut dips on the second. Keeping
  them apart avoids overlapping automation on one `AudioParam`, which is where
  `setValueCurveAtTime` and `linearRampToValueAtTime` interact unpredictably.
- **Curves via `setValueCurveAtTime`** so linear / equal-power / smooth share one
  code path. `GainNode` has no native sqrt or cosine ramp.
- **Seam params live on the section**: `seg.seam = { ms, curve }` describes the
  boundary at that section's **end**. The last section's value is unused. This
  piggybacks on the existing splice logic instead of a parallel array that has to
  be kept index-aligned.
- **Default 20 ms, equal-power** -- matches the current `fade_sec=0.02`
  (`speed_changer.py:37`), so existing projects sound the same. Range 0-1000 ms.
- **Dips do not shorten the output.** They are pure gain, unlike the Python
  overlap crossfade which consumed `fade_samples` from both sides. So
  `getFinalTotalDuration()` becomes *more* accurate and needs no change.

Which treatment a boundary gets is derived, not configured:

| Boundary condition | Treatment |
|---|---|
| Contiguous source, same volume | nothing (stretcher is continuous in input) |
| Volume differs | ramp on `volumeGain` over `ms` |
| Material removed before it (cut) | dip to 0 and back on `seamGain`, centred on the cut |
| Both | both, independently |

## 4. Build checklist

### 4A. Engine (`static/js/stretch.js`)

- [x] Patch the vendored library with `setTimeMap` (see 2.2 and
      `static/vendor/PATCHES.md`).
- [x] `buildTimeMap(segments, totalDuration)` -> breakpoints plus
      `outputDuration`, `cuts`, `volumeRamps`. Pure function, no audio.
- [x] Drop skipped sections; emit an input jump at each resulting cut.
- [x] Collapse runs of consecutive skipped sections into one cut.
- [x] Handle skipped **first** and **last** sections as plain trims (no cut seam
      at the start or end of the file).
- [x] `renderTimeline(buffer, segments, {preset, peakSafe})` -> `AudioBuffer`.
- [x] Load the whole map via `setTimeMap`, and verify the returned entry count.
- [x] `volumeGain`: `setValueAtTime` per section, replaced by a `ms`-long curve
      at boundaries where volume changes.
- [x] `seamGain`: value curve dipping to 0 and back across each cut, centred on
      it, clamped so it cannot extend past the render or into a neighbouring cut.
- [x] `fadeCurve` / `dipCurve` for `linear`, `equalPower` (sqrt), `smooth`
      (raised cosine).
- [x] Peak safety: measure true peak, apply one makeup gain if > 1.0. Addresses
      the +1.6 dB overshoot from 1.5 without clipping.
- [x] Keep `renderStretched()` as a thin wrapper over `renderTimeline()` so the
      Step 1 tests keep passing.

### 4B. Data model

- [x] Seam constants in `config.js` (`SEAM_DEFAULT`, `SEAM_CURVES`,
      `SEAM_MAX_MS`); `newSegment()` / `newSeam()` factories in `segments.js`, used
      everywhere a section is constructed (`segments.js`, `main.js` fresh upload).
- [x] `addSegment()`: the inserted section is the *first* half and owns the new
      boundary, so it gets a default seam; the section it split keeps its own.
      Verified by M4.
- [x] **Fixed `mergeWithNext()`**: `segments[i].seam` now moves with
      `segments[i].endTime`, since both describe `i+1`'s old boundary. Verified by
      M3. This was a pre-existing bug, invisible until seams became user-editable.
- [x] At a cut, use the seam of the last **non-skipped** section before it.
      Verified by M5; leading/trailing skips produce no cut at all (M6).
- [x] `normalizeSegments()` backfills `seam` on sessions saved without it and
      rejects unknown curve names; called from `restoreSession()` in `main.js`.
      Verified by M2.
- [x] `report.js`: seam ms/curve column, blank for the last section since it has
      no boundary.

### 4C. UI

**Scope reduced** -- see ADR 0007. Cut dips are inaudible both by measurement
(5.6) and by ear on real material, so they get no UI. What remains is the volume
seam, which is the part of the original request that still has force: a 100% ->
50% change over the default 20 ms is perceptually a step, and shaping it over
100-1000 ms is audibly useful.

Dropped from the original 4C: the waveform "X" overlay, the cut-versus-volume
visual distinction, and the curve picker for cuts. The "X" was a crossfade
metaphor, and there is no user-facing crossfade left to draw.

- [x] Seam controls on the **existing `.seg-merge-divider` row** rather than a new
      table column. A seam is a property of the boundary, not a section, and that
      divider already sits between adjacent sections next to the merge button. Its
      render condition (`!isLast && !skipped && !next.skip`) already matches exactly
      "boundary between two kept sections", which is where a volume ramp can apply.
      Verified by M9.
- [x] Duration input plus steppers reusing the `.stepper` pattern
      (`data-kind="seam"`), and a curve select.
- [x] Dimmed via `.seam-ctl.inactive` when the two volumes match.
      `refreshSeamActivity()` updates it live during volume typing without a table
      rebuild, so focus is never lost. Verified by M10.
- [x] Ramp indicator in the section lane where volumes differ, shaded in the
      direction of the level change (`.rising` / `.falling`). **Non-interactive** --
      the split dragger already occupies that x position. Verified by M11.
- [x] `seam.ms` is output time but the lane is source time, so each half of the
      ramp is scaled by the speed of the section it falls in. A 4 px floor keeps
      short seams visible at default zoom (20 ms is 0.26 px at 13 px/s).
- [x] Styles next to the existing `.lane-handle` rules; `styles.css?v=17`.
- [x] `commitSeamMs()` redraws only the lane, not the table, so the input keeps
      focus while editing. Edits reach audio through the existing
      `saveMeta()` / `warmPreview()` path -- release only, per 1.7.

Verified by M8-M11: seam ms reaches the `buildTimeMap` ramp span, the control
appears only where a ramp is possible, dimming tracks volume equality live, and
the lane ramp renders once with the correct direction.

### 4D. Buffered preview

Requirement 1 from the brief: adjusting a parameter and releasing the mouse
renders that region in the background, and the *rendered* buffer is what plays.
This replaces the current server round trip in `preview.js`, which uploads a
16 s WAV and polls for a full export.

- [x] Render previews with `renderTimeline(..., {preset: PRESET_PREVIEW})` over a
      `sliceBuffer()` of the window, keeping `previewWindow()`'s outward snapping.
- [x] Trigger on release, never on `input` while dragging: `warmPreview()` is
      called from `renderSegments()` (covers split, merge, skip, boundary drag) and
      alongside the existing `saveMeta()` calls in `main.js` for the speed/volume
      commits that do not re-render.
- [x] Cache the rendered buffer, keyed on window + section state; any edit drops
      it immediately.
- [x] Discard superseded renders. A token guards both paths so the last release
      wins rather than whichever render finishes last.
- [ ] **Skipped:** instant `playbackRate` feedback. Made redundant by the
      interpretation below -- a warm cache already makes Preview effectively
      instant (383 ms cold on desktop).
- [x] Dropped the WAV upload path from `preview.js`. `submitJob`/`pollStatus`
      remain in `export.js` until Step 4 removes the server export.
- [x] `setBusy` still owns the button's disabled state; only the label changes.

**Confirmed with the user** and recorded as ADR 0008. The brief said to render on
release *and play that buffer*; auto-playing on every committed number-field edit
would be jarring. Instead an edit schedules a background render after 400 ms of
idle (`warmPreview`), and pressing Preview plays from cache instantly, or renders
on demand if the cache is cold. This delivers the stated purpose -- no DSP during
scrubbing, no CPU thrash on mobile -- without surprise playback.

## 5. Verification (`static/dev/stretch-test.html`)

Extend the harness; the Step 1 sine cases stay green.

Every section carries a **different tone**, so a pass proves that breakpoint
actually took effect. Duration alone cannot: the render length is whatever
`renderTimeline` asked for.

- [x] **5.1** Two sections, rates 1.0 then 0.84: duration 4.381 s, 440 Hz and
      880 Hz in their respective halves.
- [x] **5.2** Multi-breakpoint survival: three sections at distinct rates, all
      three tones present in the right output regions. The 2.2 regression test.
- [x] **5.3** Middle section skipped: duration equals the kept sections, and the
      skipped tone is **absent** from the output.
- [x] **5.4** Volume: two sections at 100% / 50%, RMS ratio 2.001.
- [x] **5.5** Volume ramp: level moves monotonically across the boundary.
- [x] **5.6** Cut has no hard discontinuity, **with or without** a dip. See 6.5 --
      the original click-detection premise was wrong.
- [x] **5.7** Dip attenuates at the cut: 0.066 of surrounding level at 60 ms
      versus 0.715 at `ms: 0`. The `ms: 0` control is what proves the curve does
      the work.
- [x] **5.8** Peak safety: raw peak 1.155, safe peak 1.000.
- [x] **5.9** Runs headless via CDP (`Runtime.evaluate` over a WebSocket, node
      built-ins only -- no new dependencies).
- [x] **5.10** Preview parity: window at `PRESET_PREVIEW` matches the same range
      of the full `PRESET_EXPORT` render -- RMS 0.353/0.353 loud, 0.176/0.177 quiet.
- [x] **5.11** Preview latency for a 16 s window on desktop: **383 ms** cheaper,
      **454 ms** default.

Plus a data-model suite (M1-M7) and a page-load smoke test that fails on any
console error, since 4B and 4D touched imports across six modules.

## 6. Risks

- **6.1 Resolved.** The time-map loading problem in 2.2 is fixed by the
  `setTimeMap` patch and verified by 5.2. The cost is a patched vendor file that
  must be re-applied on upgrade; 5.2 fails loudly if it is missing.
- **6.2 AudioWorklet inside `OfflineAudioContext` on iOS Safari.** Verified on
  desktop Chrome only. The worklet module loads from a `URL.createObjectURL`
  Blob by default, historically a Safari weak point; the escape hatch is that
  `createNode.moduleUrl` is settable, so it can be served as a static file
  instead. Needs a real device before Step 4 deletes the server path.
- **6.3 Long-file memory on mobile.** A 5-minute stereo 48 kHz render is ~115 MB
  of Float32 before encoding. Not addressed here; export chunking is Step 3.
- **6.4 Dip audibility on sustained notes.** The known trade-off of option (a).
  If it is audible in real material, the per-boundary structure here leaves room
  to add two-node true crossfade as an opt-in later without reworking the data
  model.
- **6.5 Cut dips may not be needed at all.** Test 5.6 shows **no sample-level
  discontinuity at a cut even with `ms: 0`** -- max step 0.091 against a normal
  sine slope of 0.086, identical with and without a dip. Because the whole
  timeline is one continuous overlap-add stream (0005), the stretcher's own
  windowing already blends an input jump. So the "eliminate clicks/pops"
  rationale for cut dips is **empirically weak**; what remains is taste, shaping
  how a cut lands.

  Volume seams are unaffected and clearly useful. The engine supports both
  either way. The open question is whether the per-boundary *UI* for cut dips
  earns its keep, which should be decided by ear on real material before 4C is
  built. Deferring it would remove roughly half of 4C.

## 7. Out of scope

- MP3 encoding and download, and export chunking for long files (Step 3).
- Deleting `process_audio` and trimming `requirements.txt` (Step 4). The server
  export route stays reachable through this step as a fallback.
- Pitch shifting. The node supports it; no requirement asks for it.
