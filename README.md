# TempoTailor — Music Speed Changer

Slice audio at arbitrary timestamps, adjust each segment's speed independently, and export as MP3.

```
╔══════════════════════════════════╗
║     T E M P O T A I L O R       ║
╚══════════════════════════════════╝
```

## CLI

```
conda activate librosa
python3 speed_changer.py
```

Edit `cut_timestamps`, `segment_speeds`, and `input_file` in the `__main__` block at the bottom of `speed_changer.py`.

## Web App

```
conda activate librosa
uvicorn main:app --reload --port 8000
```

Open `http://127.0.0.1:8000`, upload an audio file, add segments with timestamps and speeds, then export as MP3.

## Docker

```
docker compose up
```

Or pull the prebuilt image directly:

```
docker run -p 8000:8000 kakakakakaka/music_lab:latest
```

Open `http://127.0.0.1:8000`.

## Dev

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . && conda run -n librosa python -m pytest test_speed_changer.py -v
```
