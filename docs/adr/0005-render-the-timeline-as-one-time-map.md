# 0005. Render the timeline as one time map through a single stretcher node

Date: 2026-08-01
Status: Accepted. Implementation planned in `design/step2-plan.md` section 4A.

## Context

The old pipeline sliced the file at section boundaries, stretched each slice
**independently**, gain-scaled each one, and joined them with 20 ms crossfades.
Two workarounds existed only because of that independence:

- RMS renormalisation per slice, because librosa's phase vocoder did not preserve
  loudness (`speed_changer.py:31-33`).
- A 20 ms crossfade at every seam, because independently stretched slices do not
  line up phase-wise even at equal speeds -- stated in the comment at
  `speed_changer.py:148`.

The obvious client-side translation would have been the same shape: stretch each
section into its own `AudioBuffer`, then concatenate with crossfades.

Signalsmith's web release, however, is not a "stretch this array" function. It is
a sample player driven by a piecewise **time map**:

```js
node.addBuffers([ch0, ch1])
node.schedule({ outputTime, output, input, rate })
```

Each breakpoint says: at output time T, the playhead sits at input position I and
advances at `rate` source-seconds per output-second. MusicLab's edit model is
already exactly this.

## Decision

Feed the entire timeline to **one** stretcher node as a single time map -- one
`schedule()` call per section -- rather than rendering sections separately and
joining them.

Skip is encoded as an **input jump**: output time stays continuous while input
position jumps past the removed material.

## Consequences

Positive:

- Contiguous rate changes no longer need crossfades. A 1.0 -> 0.84 boundary with
  nothing removed between is continuous in input, so the stretcher simply changes
  rate mid-stream. The artefact the old 20 ms crossfade existed to hide does not
  arise.
- Only two boundary conditions still need treatment: a volume change (gain ramp)
  and a cut (input discontinuity). This is why the seam feature is much narrower
  than originally scoped.
- The measured ~8 ms window ramp-in occurs once per render, at the start, instead
  of at every section boundary.
- Cut fades are pure gain, so unlike the old overlap crossfade they do not consume
  material. Output duration stays exactly `sum((end - start) / speed)`, which makes
  `getFinalTotalDuration()` more accurate, not less.
- RMS renormalisation is unnecessary (see 0002).

- **A cut produces no click.** Measured: max sample-to-sample step at a cut is
  0.091 with a dip and 0.091 without, against a normal sine slope of 0.086. The
  continuous overlap-add stream blends the input jump on its own. This is a
  benefit, but it also undercuts the stated reason for user-configurable cut
  fades (see 0004) -- those are now a taste control, not a click fix.

Negative:

- **Requires a patched vendor file.** `schedule()` cannot pre-load a multi-entry
  time map. It prunes in two loops; keeping breakpoint *k* requires
  `T[k-1] < outputTime` while keeping `T[1]` requires `T[1] > outputTime`, which
  is contradictory for k >= 2. The map holds at most two entries no matter what
  arguments are passed, because `schedule()` is designed for realtime and
  discards the past on every call.

  Resolved with a five-line `setTimeMap` remote method added to
  `static/vendor/signalsmith-stretch.mjs` (MIT, so permitted), documented in
  `static/vendor/PATCHES.md`. The patch must be re-applied on version bumps. The
  failure mode without it is silent -- the render succeeds using only the last
  section's rate, back-extrapolated from t=0 -- so a regression test exists
  specifically to catch its absence.
- `active: false` is **not** skip. It emits silence while output time advances --
  a mute, not a cut. Using it would leave silent gaps instead of shortening the
  output.

## Fallback

If the patch ever becomes untenable, the fallback is one node per section with
explicit crossfades. That reintroduces the 8 ms ramp at every boundary, loses the
phase continuity that removes clicks at rate changes, and costs more CPU -- so it
is a last resort.
