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

## 6. Open items, roughly in priority order

1. **Measure on a real phone.** Every number is desktop Chrome. First play on a
   3-minute file is **8.2 s cold / ~4-6 s warm**; extrapolating 4-5x puts mobile at
   30-40 s cold, likely past tolerable. This single measurement decides items 2
   and 3.
2. **Pre-warm the WASM module** on file open, so the first play does not pay WASM
   compile + worklet registration. Small change, recovers most of the cold-start
   gap. Agreed as worthwhile, not implemented.
3. **Mobile fallback if 1 is bad**: switch playback to `PRESET_PREVIEW` (one
   constant, parity lost), or revive progressive playback -- the plan for it is in
   this session's git history, deleted after being rejected.
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
