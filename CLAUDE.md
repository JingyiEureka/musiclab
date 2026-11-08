# MusicLab Project Instructions

## Before committing

Run the linter and tests. Commit only if both pass.

Remove draft wireframes (`wireframe.html`) before committing -- those are throwaway.

**Keep** `design/` and `docs/adr/`. Plans record what is still outstanding and why
a step was scoped the way it was; ADRs record decisions that are costly to reverse.
Both are committed alongside the code.

- `design/` -- working plans and handoff notes. `design/handoff.md` is the entry
  point for picking up in-flight work.
- `docs/adr/` -- architecture decision records. Immutable once accepted; to change
  a decision, add a new record that supersedes the old one and update its status.

```
conda run -n librosa ruff check . && conda run -n librosa ruff format --check . && conda run -n librosa python -m pytest -v
```

To auto-fix lint issues:

```
conda run -n librosa ruff check --fix . && conda run -n librosa ruff format .
```
