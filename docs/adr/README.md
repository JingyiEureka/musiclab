# Architecture decision records

Why the architecture is the way it is. `ARCHITECTURE.md` at the repo root
describes what the system currently **is**; these records describe the decisions
that got it there, so the reasoning survives after the plan files in `design/`
are deleted.

Format is Nygard-style and deliberately short: Context, Decision, Consequences.
Records are immutable once accepted -- to change a decision, add a new record
that supersedes the old one and update the old one's Status line.

Not development artifacts. Unlike `design/` plans and `wireframe.html`, these are
committed and kept.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-move-audio-processing-to-the-browser.md) | Move audio processing from the server to the browser | Accepted, implemented; see 0011 |
| [0002](0002-signalsmith-stretch-instead-of-rubber-band.md) | Use Signalsmith Stretch instead of Rubber Band | Accepted, implemented |
| [0003](0003-keep-the-single-file-section-model.md) | Keep the single-file section model, not a multi-track timeline | Accepted |
| [0004](0004-boundary-curves-instead-of-automation-lanes.md) | Per-section volume with boundary curves, not automation lanes | Accepted, refined by 0007 |
| [0005](0005-render-the-timeline-as-one-time-map.md) | Render the timeline as one time map through a single stretcher node | Accepted, implemented |
| [0006](0006-lamejs-instead-of-ffmpeg-wasm.md) | Encode MP3 with lamejs instead of ffmpeg.wasm | Accepted, implemented |
| [0007](0007-cut-fades-stay-engine-internal.md) | Cut fades stay engine-internal; only volume seams are user-configurable | Accepted |
| [0008](0008-preview-warms-a-cache-instead-of-auto-playing.md) | Preview warms a cache instead of auto-playing on release | **Superseded by 0010** |
| [0009](0009-transport-plays-the-rendered-timeline.md) | The transport plays the rendered timeline, not the original file | Accepted, refined by 0010 |
| [0010](0010-one-playback-path.md) | One playback path: retire Preview, transport renders at export quality | Accepted, implemented |
| [0011](0011-keep-the-python-path-as-an-offline-script.md) | Keep the Python path as an offline script, not a server path | Accepted, implemented |

## Adding one

Number sequentially, name the file `NNNN-short-title.md`, add a row above. Worth
a record when the decision is costly to reverse, or when a future reader would
otherwise reasonably ask "why on earth did they do that?"
