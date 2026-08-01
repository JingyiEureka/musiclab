# 0010. One playback path: retire Preview, transport renders at export quality

Date: 2026-08-02
Status: Accepted. Supersedes 0008. Refines 0009.

## Context

After 0009 the app had two ways to hear an edit:

| | `[ Play ]` | `[ Preview ]` |
|---|---|---|
| Renders | whole timeline | 16 s window at the playhead |
| Desktop, 3-minute file | 3498 ms (51x realtime) | 286 ms |
| Pre-warmed after an edit | no | yes, so usually 0 ms felt |
| Preset | `cheaper` | `cheaper` |

Preview existed because a full render was 12.2x more expensive, which mattered
for the tweak -> listen -> tweak loop, especially on mobile where the full render
extrapolates to 15-18 s.

Two options were on the table: build progressive playback (start from a window,
hand off to the full render mid-playback) so Preview became redundant, or drop
Preview and accept the wait. Progressive was planned in detail, then rejected by
the user: the delay is acceptable, and a single path is worth more than a fast
start.

The measurements also exposed something the two-button design had quietly
introduced: **playback and export used different presets**. Playback rendered at
`cheaper`, export at `default`. Close, but not the same audio.

## Decision

- **One playback path.** `[ Play ]` and `[ |< ]` render the full timeline and play
  it. The `[ Preview ]` button, `preview.js`, and the separate preview source node
  in `player.js` are removed.
- **Playback renders at `PRESET_EXPORT`**, the same preset the export uses, so
  what you hear is the file you get.
- The first play after an edit shows `[ Rendering... ]`. Measured on an M-series
  Mac for a 3-minute file at the export preset:

  | situation | render |
  |---|---|
  | First render of a page session (cold WASM + worklet module) | **8.2 s** (22x realtime) |
  | Later renders, module warm | ~4.3-6.4 s (28-51x realtime) |

  Cached until the next edit. Note this is above the ~3.5 s figure the decision
  was originally taken against: that number was the *cheaper* preset with an
  already-warm module.
- Volume-only edits still bypass rendering entirely and use the live gain
  schedule, unchanged from 0009.
- No background pre-warming. Warming a full render on every edit would burn CPU
  on renders the user may never hear, which is worse on the mobile devices the
  cheaper preset was there to protect.

## Consequences

Positive:

- Playback and export are the same render at the same quality. Parity is now
  structural rather than a claim -- there is one code path and one preset.
- No UI ambiguity. Two buttons that both meant "hear my edit" was the mirror image
  of the bug 0009 fixed, where one control silently ignored half the edits.
- Meaningfully less code: `preview.js` deleted, and with it the window snapping,
  the warm-cache tokens, the second source node, and `state.previewSource`.
- `sliceBuffer()` and `PRESET_PREVIEW` survive for the dev harness, and the
  cheaper preset remains available if mobile forces the question again.

Negative:

- First play after any speed or skip edit waits on a full render: 8.2 s cold /
  ~4-6 s warm for 3 minutes on desktop. Extrapolating 4-5x for a mid-range phone
  puts the cold case near 30-40 s, which is likely past tolerable. **Untested on a
  real phone** -- every number here is desktop Chrome.
- Cold-start cost is avoidable: pre-loading the vendored module (and optionally a
  throwaway short render) when a file is opened would move the WASM compile and
  worklet registration off the first play. Not done here.
- Iterating on a speed value is slower than it was with a warm 286 ms window. This
  is the cost the user explicitly accepted.
- Switching playback to `default` costs roughly 18% more render time than
  `cheaper` (343 ms vs 289 ms measured on a 16 s window), which is why the
  3-minute figure is ~4 s rather than 3.5 s.

## Alternatives considered

- **Progressive playback** (planned, rejected): render a window at the playhead,
  start playing, hand off to the full render with a short crossfade. Would have
  given a fast start *and* one button. Rejected as unnecessary complexity for an
  acceptable wait -- and it carried a real risk, since the two renders are
  phase-incoherent and the join needed a crossfade to hide a comb-filter artefact.
- **N-chunk streaming**: rejected before that, because independently stretched
  chunks reintroduce exactly what 0005 avoids -- the stretcher's window ramp-in and
  a phase discontinuity at every chunk boundary instead of one per render.
- **Keep Preview at the cheaper preset**: rejected because it perpetuates the
  parity gap this record closes.

## Notes

If mobile render times turn out to be intolerable, the ordered fallbacks are:
switch playback back to `PRESET_PREVIEW` (one constant, parity lost), or revive
the progressive plan from git history.
