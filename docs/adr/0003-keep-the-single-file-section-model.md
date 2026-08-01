# 0003. Keep the single-file section model, not a multi-track timeline

Date: 2026-08-01
Status: Accepted.

## Context

The refactor brief asked for crossfades between "overlapping audio regions on
the timeline," with draggable handles to set the overlap duration.

MusicLab has no such regions. `state.segments` is a flat list of **consecutive,
non-overlapping sections of one audio file**, each `{endTime, speed, volume,
skip}`, with boundaries clamped 0.5 s apart (`segments.js:210`). One track, no
movable clips, so overlap cannot occur.

The `crossfade()` in `speed_changer.py` was never a user-facing crossfade
either: it was a hard-coded 20 ms seam smoother applied only where a section was
stretched or skipped, to hide the discontinuity that per-slice processing
created. Users never saw or set it.

So the request was really one of two things:

- **(a)** Expose the existing seam fade as an adjustable, visualised parameter
  per boundary.
- **(b)** Build a multi-region timeline with movable, trimmable, overlappable
  clips -- a DAW.

## Decision

Option (a). The app remains a single-file, consecutive, non-overlapping section
model. Confirmed explicitly by the user: "We are not building a multi-track DAW."

## Consequences

Positive:

- The DSP migration can ship without waiting on a timeline rewrite. Option (b)
  would have changed the data model, the session schema, the waveform renderer,
  and the export path all at once.
- Sessions already in IndexedDB stay loadable.
- Seam handling stays simple, because there is never more than one source
  position in play at a time.

Negative:

- No overlapping-clip crossfades, arrangement, or layering. If those are wanted
  later they are separate work, not an extension of this refactor.

## Notes

This bounds the seam feature: with consecutive sections fed through one
continuous stretcher (0005), most boundaries need no fade at all. Only volume
changes and cuts do.
