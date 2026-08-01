# 0008. Preview warms a cache instead of auto-playing on release

Date: 2026-08-02
Status: **Superseded by [0010](0010-one-playback-path.md)** -- the preview button
and `static/js/preview.js` were removed in favour of a single playback path. Kept
for the reasoning about why auto-playing on every committed edit was wrong, which
still applies to any future re-introduction.

## Context

The refactor brief specified the buffered-preview behaviour as: when the user
adjusts a speed parameter and releases the mouse, asynchronously render that
region in the background, store the result in a temporary `AudioBuffer`, and
**play that buffer** for preview. The stated purpose was avoiding realtime WASM
DSP during UI scrubbing, which causes CPU throttling and audio stuttering on
mobile.

Taken literally, every committed edit would start playing audio. MusicLab's
section controls are number inputs with stepper buttons, so a user nudging speed
from 84% to 85% to 86% would trigger three playbacks. Tabbing between fields
would trigger more.

The performance goal and the auto-play behaviour are separable: what prevents
stuttering is *not doing DSP while a control moves*, not *playing the result
immediately*.

## Decision

- An edit drops the cached preview and schedules a background render after 400 ms
  of idle (`warmPreview`).
- Pressing **Preview** plays from cache instantly, or renders on demand if the
  cache is cold or stale.
- Nothing plays without an explicit press.

Confirmed with the user: "pressing Preview plays from cache instantly."

## Consequences

Positive:

- Delivers the brief's actual purpose. No DSP runs during scrubbing, so no CPU
  thrash and no stutter on mobile.
- Preview is effectively instant when the cache is warm; a cold render is 383 ms
  for a 16 s window at the `cheaper` preset on desktop.
- No surprise audio. Editing a number field stays silent.
- Removed the need for the planned `playbackRate` + `preservesPitch` stopgap,
  which existed only to fill the gap while a render was in flight.

Negative:

- A background render can be wasted if the user edits again and never presses
  Preview. Bounded by the 400 ms idle delay and by dropping superseded renders.
- One extra press to hear a change, versus the brief's literal reading.

## Notes

Both paths guard against stale results with a token, so the last release wins
rather than whichever render happens to finish last. Cache keys include the
window bounds and the full section state, so any edit invalidates.
