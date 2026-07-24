import os
import time

import pytest
from fastapi.testclient import TestClient

import main
from speed_changer import AudioDecodeError


def fake_process_audio(input_path, output_path, timestamps, speeds, overall_factor):
    with open(output_path, "wb") as f:
        f.write(b"mp3")


@pytest.fixture(autouse=True)
def clean_tasks(monkeypatch):
    main.TASKS_DB.clear()
    monkeypatch.setattr(main, "process_audio", fake_process_audio)
    yield
    for task_id in main.TASKS_DB:
        path = f"outputs/{task_id}.mp3"
        if os.path.exists(path):
            os.remove(path)
    main.TASKS_DB.clear()


def upload(client, filename="song.mp3", content=b"fake audio"):
    return client.post(
        "/upload-audio/",
        files={"file": (filename, content, "audio/mpeg")},
        data={"timestamps_str": "[]", "speeds_str": "[1.0]"},
    )


def test_upload_sets_cookie_and_completes():
    client = TestClient(main.app)
    resp = upload(client)
    assert resp.status_code == 200
    assert "session" in resp.cookies
    task_id = resp.json()["task_id"]
    status = client.get(f"/check-status/{task_id}")
    assert status.status_code == 200
    assert status.json()["status"] == "done"
    assert "session" not in status.json()


def test_check_status_other_session_404():
    client_a = TestClient(main.app)
    task_id = upload(client_a).json()["task_id"]
    client_b = TestClient(main.app)
    assert client_b.get(f"/check-status/{task_id}").status_code == 404


def test_download_ownership():
    client_a = TestClient(main.app)
    task_id = upload(client_a).json()["task_id"]
    client_b = TestClient(main.app)
    assert client_b.get(f"/download/{task_id}").status_code == 404
    own = client_a.get(f"/download/{task_id}")
    assert own.status_code == 200
    assert own.headers["content-type"] == "audio/mpeg"


def test_download_bad_task_id_404():
    client = TestClient(main.app)
    assert client.get("/download/notauuid").status_code == 404
    assert client.get("/download/%2e%2e%2fmain").status_code == 404


def test_upload_too_large_413(monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 10)
    client = TestClient(main.app)
    before = set(os.listdir("temp_uploads"))
    resp = upload(client, content=b"x" * 100)
    assert resp.status_code == 413
    assert set(os.listdir("temp_uploads")) == before


def test_extract_too_large_413(monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 10)
    client = TestClient(main.app)
    resp = client.post(
        "/extract-audio/", files={"file": ("clip.mp4", b"x" * 100, "video/mp4")}
    )
    assert resp.status_code == 413


def test_bad_params_400_not_echoed():
    client = TestClient(main.app)
    resp = client.post(
        "/upload-audio/",
        files={"file": ("song.mp3", b"fake", "audio/mpeg")},
        data={"timestamps_str": "MARKER123 not json", "speeds_str": "[1.0]"},
    )
    assert resp.status_code == 400
    assert "MARKER123" not in resp.json()["detail"]


def test_busy_returns_429():
    for i in range(3):
        main.TASKS_DB[f"task-{i}"] = {"status": "processing"}
    client = TestClient(main.app)
    resp = upload(client)
    assert resp.status_code == 429


def test_cleanup_prunes_old_tasks():
    main.TASKS_DB["old"] = {"status": "processing", "created": time.time() - 7200}
    main.TASKS_DB["new"] = {"status": "processing", "created": time.time()}
    main.cleanup_stale_files()
    assert "old" not in main.TASKS_DB
    assert "new" in main.TASKS_DB


def test_failed_task_reports_error_code(monkeypatch):
    def broken(*args):
        raise AudioDecodeError("bad file")

    monkeypatch.setattr(main, "process_audio", broken)
    client = TestClient(main.app)
    task_id = upload(client).json()["task_id"]
    status = client.get(f"/check-status/{task_id}")
    assert status.json()["status"] == "failed"
    assert status.json()["error"] == "decode_failed"
