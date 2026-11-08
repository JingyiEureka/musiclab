# 0009. The transport plays the rendered timeline, not the original file

Date: 2026-08-02
Status: Accepted. Refined by [0010](0010-one-playback-path.md) -- playback now
renders at the export preset, and the separate Preview button is gone.

## Context

`play()` fed the playback graph `state.audioBuffer` -- the raw decoded upload. Per
section volume was applied live through a `GainNode` schedule
(`applyGainSchedule`), but speed and skip were not, because they needed DSP that
only the server could do. So the transport reflected some edits and not others:

| Edit | transport | Preview | Export |
|---|---|---|---|
| Volume | audible | yes | yes |
| Speed | **silent** | yes | yes |
| Skip | **plays through** | yes | yes |

A user split a file into three sections, changed section B's speed, pressed
"play from beginning", and heard the original music. That is the documented
behaviour working as designed, and it is still wrong: the transport looked like
it was showing the edit and was not.

The constraint that forced it is gone. After 0001 and 0005 a full timeline
renders locally -- a 16 s window in under 300 ms, roughly 22x realtime.

## Decision

The transport plays the rendered timeline.

- Pressing play renders the timeline (cached), then plays the result. The button
  reads `[ Rendering... ]` while it works.
- **Only when a render is actually needed**, i.e. any section has a non-1.0 speed
  or is skipped. If the only difference is volume, playback stays on the raw
  buffer with the existing live gain schedule -- instant and already accurate.
- The render is cached and invalidated on any edit, so play/pause/seek cycles do
  not re-render.
- Playback uses the `cheaper` preset, matching Preview. Export uses `default`.
  **Changed by 0010:** playback now uses the export preset, so the two agree.

### Time domains

The transport's `playOffset`, the waveform, the section lane, and every section
boundary are in **source** time. A rendered timeline is in **output** time. Two
mappings bridge them, derived from the same breakpoints the render used:

- `outputToSource(map, t)` -- keeps the playhead aligned with the waveform while
  rendered audio plays.
- `sourceToOutput(map, t)` -- converts the seek position into a start offset in
  the rendered buffer. Source time inside a skipped region maps to the cut, so
  seeking into removed material lands where playback resumes.

Getting this wrong would put the playhead somewhere other than the audio, which
is worse than the bug being fixed.

## Consequences

Positive:

- The transport, Preview, and Export now agree about what the edit sounds like.
- Skipped sections are actually skipped on playback, and the playhead jumps the
  cut, which makes removal legible in a way the section table cannot convey.
- No cost for the common case: before any speed or skip edit, playback is the
  raw buffer exactly as before, with no render and no delay.

Negative:

- First play after an edit waits on a render. Roughly a few seconds for a
  3-minute file on desktop, longer on mobile. Cached afterwards.
- Volume no longer previews live *while rendered audio is playing*. The playing
  buffer has volume baked in, so `applyGainSchedule` is suppressed to avoid
  applying it twice. The edit is heard on the next play. Volume-only edits are
  unaffected, since those never enter the rendered path.
- ~~Playback quality is `cheaper`, not the `default` used for export.~~ Closed by
  0010: both now use the export preset.
- Memory: the rendered timeline is a second full-length `AudioBuffer` alongside
  the source. A 5-minute stereo 48 kHz render is ~115 MB of Float32, which is a
  real concern on mobile and is the same ceiling 0001 flagged for export. Not
  addressed here.

## Alternatives considered

- **Progressive rendering** -- start at the playhead and render ahead in chunks
  while playing. Feels instant, but needs chunk stitching and seek handling
  across chunk boundaries. Deferred; render-on-play can be upgraded to it later
  without changing what the transport means.
- **Leave it and relabel** -- keep raw-audio scrubbing and rename the control so
  the asymmetry is at least honest. Cheapest, but leaves the product unable to
  audition its own edit.
