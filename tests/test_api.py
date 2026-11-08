import os
import time

from fastapi.testclient import TestClient

from app import main


def test_index_served_no_cache():
    client = TestClient(main.app)
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-cache"


def test_extract_too_large_413(monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 10)
    client = TestClient(main.app)
    before = set(os.listdir(main.TEMP_DIR))
    resp = client.post(
        "/extract-audio/", files={"file": ("clip.mp4", b"x" * 100, "video/mp4")}
    )
    assert resp.status_code == 413
    assert set(os.listdir(main.TEMP_DIR)) == before


def test_extract_bad_file_400():
    client = TestClient(main.app)
    before = set(os.listdir(main.TEMP_DIR))
    resp = client.post(
        "/extract-audio/", files={"file": ("clip.mp4", b"not a video", "video/mp4")}
    )
    assert resp.status_code == 400
    assert set(os.listdir(main.TEMP_DIR)) == before


def test_cleanup_removes_only_stale_temp_files():
    old = main.TEMP_DIR / "old.bin"
    new = main.TEMP_DIR / "new.bin"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    stale = time.time() - main.CLEANUP_MAX_AGE_SECONDS - 3600
    os.utime(old, (stale, stale))
    main.cleanup_stale_files()
    assert not old.exists()
    assert new.exists()
    new.unlink()


def test_server_processing_endpoints_removed():
    client = TestClient(main.app)
    assert client.post("/upload-audio/").status_code == 404
    assert client.get("/check-status/x").status_code == 404
    assert client.get("/download/x").status_code == 404
