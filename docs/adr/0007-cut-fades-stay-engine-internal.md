# 0007. Cut fades stay engine-internal; only volume seams are user-configurable

Date: 2026-08-02
Status: Accepted. Refines 0004.

## Context

0004 decided that section boundaries get a user-configurable transition --
duration plus curve shape -- covering both the gain ramp where two section
volumes differ and the fade through a cut left by skipped sections. The stated
justification for the cut fade was the original brief's "eliminate clicks/pops".

Two pieces of evidence now contradict that justification.

**Measured.** Test 5.6 finds no sample-level discontinuity at a cut whether or
not a dip is applied: max sample-to-sample step 0.091 in both cases, against a
normal slope of 0.086 for the test tone. Because the whole timeline runs through
one continuous overlap-add stream (0005), the stretcher's own windowing already
blends the input jump. There is no click to eliminate.

**Heard.** An A/B of the same cut rendered at 0 ms and 60 ms on a real ballet
recording was indistinguishable to the user.

Volume seams are a different matter. A 100% -> 50% change over the 20 ms default
is perceptually a step, and shaping that transition over 100-1000 ms is audibly
useful -- it is the part of the original request that still has force.

## Decision

- **Volume seams** keep a per-boundary user control: duration and curve.
- **Cut fades** stay in the engine at the default 20 ms equal-power, with no
  per-boundary UI.

The dip machinery (`dipCurve`, `applySeamDips`) remains in `stretch.js`. It costs
one `setValueCurveAtTime` per cut and shares its shaping code with volume
curves, so keeping it preserves the option cheaply.

## Consequences

Positive:

- Removes roughly half of the planned boundary UI: no waveform "X" overlay, no
  cut-versus-volume visual distinction, no curve picker for cuts.
- Avoids a control whose only observable effect the user cannot hear, which
  would have been UI surface with no payoff.
- 20 ms equal-power matches what the old Python pipeline did at every seam, so
  output stays closest to previously exported files.

Negative:

- A user who *can* hear a cut on some other material -- a splice mid-phrase on a
  sustained note, say -- has no control over it. Re-exposing it is a UI change
  only; the engine parameter and its tests already exist.
- The original brief's request for draggable crossfade handles on the waveform is
  not delivered as described. What survives is the volume-seam control, which is
  what the reshaped requirement in 0004 actually asked for.

## Notes

If cut fades are ever re-exposed, `seg.seam` already carries `{ms, curve}` per
boundary and `buildTimeMap` already resolves the correct seam at a cut (the last
non-skipped section before it, verified by test M5). Only the UI is missing.
