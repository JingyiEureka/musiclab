# TempoTailor — Music Speed Changer

Slice audio at arbitrary timestamps, adjust each segment's speed independently, and export as MP3. Two pathways share one core algorithm (`speed_changer.py`).

```mermaid
flowchart LR
    A[Edit params in code] --> B[pythoon3 speed_changer.py]
    B --> C[process_audio in speed_changer.py]
    C --> D[MP3 output]

    E[Browser upload + sliders] --> F[index.html + static/]
    F --> G[main.py FastAPI]
    G --> C
    C --> H[MP3 download]
```

## CLI

```
conda activate librosa
python3 speed_changer.py
```

Edit `cut_timestamps`, `segment_speeds`, and `input_file` in the `__main__` block at the bottom of `speed_changer.py`.

## Web App

```
uvicorn main:app --reload --port 8000
```

Open `http://127.0.0.1:8000`, upload an audio file, add split markers, adjust per-segment speeds, and export.
