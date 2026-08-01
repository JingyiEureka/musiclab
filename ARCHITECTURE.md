# Architecture

## 1. Overview

Three layers: a vanilla-JS frontend served same-origin, a FastAPI layer that
validates requests and tracks jobs in memory, and a pure processing core
around librosa and ffmpeg.

```mermaid
flowchart LR
    subgraph Browser["Browser (static/js/)"]
        UP[Upload zone<br/>drag and drop]
        WF[Waveform player<br/>canvas + zoom + section lane]
        SEG[Section editor<br/>speed / volume / split / merge]
        EXP[Export + progress banner]
        IDB[(IndexedDB<br/>session restore)]
    end

    subgraph Server["FastAPI (app/main.py)"]
        IDX["GET /<br/>static/index.html, no-cache"]
        UPL["POST /upload-audio/<br/>validate, cap = 1 job"]
        EXT["POST /extract-audio/<br/>video to mp3"]
        ST["GET /check-status/:id"]
        DL["GET /download/:id"]
        DB[(TASKS_DB<br/>in-memory, session-scoped)]
        BG[background_audio_task]
    end

    subgraph Core["app/speed_changer.py"]
        PA["process_audio<br/>load, slice, stretch,<br/>crossfade, encode"]
    end

    FF[ffmpeg]
    LB[librosa / soundfile]
    OUT[(outputs/*.mp3)]

    UP -->|video file| EXT
    UP --> WF --> SEG --> EXP
    SEG <--> IDB
    EXP --> UPL --> DB
    UPL --> BG --> PA
    PA --> LB
    PA -->|mp3 encode| FF
    EXT --> FF
    PA --> OUT
    EXP -->|poll every 2s| ST --> DB
    EXP --> DL --> OUT
```

## 2. Export flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as static/js/
    participant API as app/main.py
    participant W as background task
    participant SC as process_audio

    U->>FE: click Export
    FE->>API: POST /upload-audio/ (file, timestamps, speeds, volumes, client_ref)
    API->>API: validate params, check cap (max 1 active)
    API->>API: register task in TASKS_DB, save upload
    API-->>FE: task_id
    API->>W: queue background_audio_task
    W->>SC: process_audio(...)
    SC->>SC: load, slice, stretch + volume, crossfade
    SC->>SC: write WAV, ffmpeg encode MP3
    SC-->>W: progress callbacks update TASKS_DB
    loop every 2s
        FE->>API: GET /check-status/task_id
        API-->>FE: status + progress (renders pet + bar)
    end
    FE->>API: GET /download/task_id
    API-->>U: mp3 (original-name_timestamp.mp3)
    W->>W: delete uploaded input file
```

## 3. Known issues and trade-offs

Findings from a code review on 2026-07-26. All are minor at the current
scale; listed so they are not rediscovered from scratch.

1. **Task-slot leak on unexpected upload failure** (`app/main.py`, upload step 2).
   If `save_upload` raises anything other than `HTTPException` (for example a
   disk error), the `except HTTPException` block does not fire, so the
   pending task record stays in `TASKS_DB` and occupies the single job slot
   for up to 24 hours, blocking all exports until cleanup. Catching
   `Exception` there would be safer.

2. **No concurrency cap on `/extract-audio/`** (`app/main.py`). Unlike
   `/upload-audio/`, video extraction is not limited, so several
   simultaneous ffmpeg processes could run on the 2-vCPU / 1 GB production
   box.

3. **In-memory task state** (`TASKS_DB` in `app/main.py`). A container restart
   forgets in-flight jobs; clients polling an old task get 404. Accepted
   trade-off for a single-worker deployment.

4. **Mixed logging styles**. `app/speed_changer.py` uses `print` while
   `app/main.py` uses `logging`, so container logs are inconsistent in format.

5. **Shared mutable frontend state**. The ES modules under `static/js/` pass
   state through one exported `state` object (`state.js`) rather than through
   arguments. It keeps the module graph acyclic and the split small, but any
   module can write any field, so the data flow is not enforced by the
   structure.
