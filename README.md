# MusicLab — Music Speed Changer

Slice audio (or video) at arbitrary timestamps, adjust each section's speed and volume independently, and export as MP3.

```
╔══════════════════════════════════╗
║        M U S I C L A B          ║
╚══════════════════════════════════╝
```

Architecture diagrams and known trade-offs: see [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout

```
app/        FastAPI server (main.py) and the processing core (speed_changer.py)
static/     index.html, styles.css, and js/ (ES modules, entry point main.js)
tests/      pytest suite
```

`assets/` (sample media), `archive/` (old prototypes), `outputs/`, and
`temp_uploads/` are runtime or local-only folders and are not tracked in git.

## CLI

```
conda activate librosa
python3 app/speed_changer.py
```

Edit `cut_timestamps`, `segment_speeds`, and `input_file` in the `__main__` block at the bottom of `app/speed_changer.py`.

`input_file` defaults to `assets/kitri.mp3`. The `assets/` folder holds local sample media and is not tracked in git, so point `input_file` at a file of your own after cloning.

## Web App

```
conda activate librosa
uvicorn app.main:app --reload --port 8000
```

Open `http://127.0.0.1:8000`, upload an audio or video file, split it into sections and set each section's speed and volume, then export as MP3. Optionally tick "also download a report" to get a text summary of the edit alongside the MP3.

The edit is saved in the browser (IndexedDB), so a refresh or crash offers to restore your last session for a week. Nothing is stored on the server between exports.

## Docker

```
docker compose up
```

Or pull the prebuilt image directly:

```
docker run -p 8000:8000 kakakakakaka/music_lab:latest
```

Open `http://127.0.0.1:8000`.

## Deploy to production

When `static/styles.css` changes, bump the `?v=` query string on its tag in `static/index.html` so browsers drop their cached copies. The JS modules need no bump: they are served with `Cache-Control: no-cache` and revalidate on every load.

The production server is linux/amd64. On an Apple Silicon Mac a plain `docker build` produces an arm64 image that crashes there with `exec format error`, so always build with buildx:

```
docker buildx build --platform linux/amd64 -t kakakakakaka/music_lab:latest --push .
```

Then on the server:

```
docker compose pull && docker compose up -d
```

## Dev

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . && conda run -n librosa python -m pytest -v
```
