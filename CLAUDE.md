# TempoTailor Project Instructions

## Before committing

Run the linter and tests. Commit only if both pass.

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . && conda run -n librosa python -m pytest test_speed_changer.py -v
```

To auto-fix lint issues:

```
conda run -n librosa ruff check --fix . && conda run -n librosa ruff format .
```
