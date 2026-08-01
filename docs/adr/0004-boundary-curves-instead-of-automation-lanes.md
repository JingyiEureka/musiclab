# 0004. Per-section volume with boundary curves, not automation lanes

Date: 2026-08-01
Status: Accepted. Refined by [0007](0007-cut-fades-stay-engine-internal.md) --
only volume seams ended up user-configurable; cut fades stay engine-internal.

## Context

The brief asked for a freeform volume automation lane: an overlay on the track
where the user clicks to create breakpoints and drags them vertically (volume)
and horizontally (time), mapped to `GainNode.linearRampToValueAtTime()`.

The app already has per-section volume: 0-400%, edited in the section table,
scheduled during playback by `applyGainSchedule()` (`player.js:16`). A freeform
lane would have created a second, competing volume model, requiring a defined
combination order in the export, plus schema changes in `session.js` and
`report.js`.

There is also a time-domain problem. A breakpoint at t=10 s is ambiguous when
its section plays at 0.84x: the waveform canvas shows **source** time, but the
export timeline is **stretched**. Authoring in the wrong domain produces
automation that drifts against the audio, and it cannot be retrofitted once
sessions are saved.

## Decision

Keep per-section volume as the macro control. Add a user-configurable
**transition at section boundaries** -- duration plus curve shape -- rather than
freeform breakpoints. Stated by the user as: per-section volume combined with a
boundary volume curve, "without introducing complex freeform automation lanes."

Stored as `seg.seam = { ms, curve }`, describing the boundary at that section's
end.

## Consequences

Positive:

- One volume model, not two. No combination-order question.
- The time-domain ambiguity disappears: a seam is anchored to a boundary, and its
  duration is in output time, local to that boundary.
- Serves the actual goal -- eliminating clicks and shaping transitions between
  slices -- with far less UI surface.
- Storing the seam on the section reuses the existing splice logic in
  `addSegment()` / `mergeWithNext()` instead of a parallel array that must be
  kept index-aligned.

Negative:

- No arbitrary volume shapes within a section (swells, ducks mid-phrase). If
  wanted later, it is a genuine automation lane and should be its own decision,
  with the source-vs-output time question settled first.

## Notes

Curves are applied with `setValueCurveAtTime` so linear, equal-power, and smooth
share one code path; `GainNode` has no native sqrt or cosine ramp. Note that
`exponentialRampToValueAtTime` cannot be used here because the volume range
includes 0.

Default is 20 ms equal-power, matching the old `fade_sec=0.02`, so existing
projects sound unchanged.
