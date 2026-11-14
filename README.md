# MusicLab — Music Speed Changer

Slice audio at arbitrary timestamps, adjust each section's speed and volume independently, and export as MP3.

```
╔══════════════════════════════════╗
║        M U S I C L A B          ║
╚══════════════════════════════════╝
```

Architecture diagrams and known trade-offs: see [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout

```
app/        the offline CLI script (speed_changer.py)
static/     the whole site: index.html, styles.css, js/ (ES modules, entry point main.js)
tests/      pytest suite
```

`assets/` (sample media) and `archive/` (old prototypes) are local-only folders and are not tracked in git.

## CLI (offline)

The web app does all processing in the browser. `app/speed_changer.py` does the
same kind of edit from the command line, with no server or network, as a
fallback. It needs ffmpeg and its own dependencies:

```
pip install -r requirements-cli.txt
python3 app/speed_changer.py
```

Edit `cut_timestamps`, `segment_speeds`, and `input_file` in the `__main__` block at the bottom of `app/speed_changer.py`.

`input_file` defaults to `assets/Esmeralda.mp3`. The `assets/` folder holds local sample media and is not tracked in git, so point `input_file` at a file of your own after cloning.

## Web App

Live at https://musiclab.jyylab.cc. To run it locally:

```
python3 -m http.server 8000 -d static
```

Open `http://127.0.0.1:8000`, upload an audio file, split it into sections and set each section's speed and volume, then export as MP3. Optionally tick "also download a report" to get a text summary of the edit alongside the MP3.

Video files load where the browser can decode their audio track (Chrome, Android), not in iPhone Safari.

The edit is saved in the browser (IndexedDB), so a refresh or crash offers to restore your last session for a week. Everything runs in the browser; no file is uploaded.

## Deploy

Push to `main`. `.github/workflows/pages.yml` publishes `static/` to GitHub Pages, usually within a minute. Pages caches files for 10 minutes, so visitors may see the old version for that long.

When `static/styles.css` changes, bump the `?v=` query string on its tag in `static/index.html`.

## Dev

The test suite covers the CLI script too, so install `requirements-cli.txt`
plus `pytest` and `ruff` (the `librosa` conda env has them).

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . && conda run -n librosa python -m pytest -v
```

## Third-party libraries

Audio is stretched and encoded in the browser by two vendored libraries in
`static/vendor/`, both loaded lazily and used unbundled:

- **[Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)**
  — time stretching. MIT. Patched; see `static/vendor/PATCHES.md`.
- **[lamejs](https://github.com/zhuker/lamejs)** — MP3 encoding, a JavaScript
  port of **[LAME](https://lame.sourceforge.net)**. LGPL-3.0, vendored
  unmodified. Licence texts accompany the code as `lamejs-LICENSE.txt`,
  `LGPL-3.0.txt`, and `GPL-3.0.txt`.

LAME's licence asks for acknowledgement and a link, so the credit above is a
condition of use rather than a courtesy. Neither library's licence reaches
MusicLab's own code; see the amendment to
[ADR 0006](docs/adr/0006-lamejs-instead-of-ffmpeg-wasm.md) for the reasoning.
