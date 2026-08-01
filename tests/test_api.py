import os
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.speed_changer import AudioDecodeError


def fake_process_audio(
    input_path,
    output_path,
    timestamps,
    speeds,
    overall_factor=1.0,
    volumes=None,
    progress_cb=None,
):
    with open(output_path, "wb") as f:
        f.write(b"mp3")


@pytest.fixture(autouse=True)
def clean_tasks(monkeypatch):
    main.TASKS_DB.clear()
    monkeypatch.setattr(main, "process_audio", fake_process_audio)
    yield
    for task_id in main.TASKS_DB:
        path = main.OUTPUT_DIR / f"{task_id}.mp3"
        if os.path.exists(path):
            os.remove(path)
    main.TASKS_DB.clear()


def upload(client, filename="song.mp3", content=b"fake audio", extra_data=None):
    data = {"timestamps_str": "[]", "speeds_str": "[1.0]"}
    if extra_data:
        data.update(extra_data)
    return client.post(
        "/upload-audio/",
        files={"file": (filename, content, "audio/mpeg")},
        data=data,
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
    before = set(os.listdir(main.TEMP_DIR))
    resp = upload(client, content=b"x" * 100)
    assert resp.status_code == 413
    assert set(os.listdir(main.TEMP_DIR)) == before
    # the pre-registered task record must be released again
    assert main.TASKS_DB == {}


def test_client_ref_returns_same_task_on_retry():
    client = TestClient(main.app)
    r1 = upload(client, extra_data={"client_ref": "retry-123"})
    r2 = upload(client, extra_data={"client_ref": "retry-123"})
    assert r1.json()["task_id"] == r2.json()["task_id"]


def test_client_ref_not_shared_across_sessions():
    client_a = TestClient(main.app)
    client_b = TestClient(main.app)
    r1 = upload(client_a, extra_data={"client_ref": "retry-123"})
    r2 = upload(client_b, extra_data={"client_ref": "retry-123"})
    assert r1.json()["task_id"] != r2.json()["task_id"]


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
    old_created = time.time() - main.CLEANUP_MAX_AGE_SECONDS - 3600
    main.TASKS_DB["old"] = {"status": "processing", "created": old_created}
    main.TASKS_DB["new"] = {"status": "processing", "created": time.time()}
    main.cleanup_stale_files()
    assert "old" not in main.TASKS_DB
    assert "new" in main.TASKS_DB


def test_upload_with_volumes_completes():
    client = TestClient(main.app)
    resp = upload(client, extra_data={"volumes_str": "[0.5]"})
    assert resp.status_code == 200
    task_id = resp.json()["task_id"]
    assert client.get(f"/check-status/{task_id}").json()["status"] == "done"


def test_volumes_wrong_length_400():
    client = TestClient(main.app)
    resp = upload(client, extra_data={"volumes_str": "[1.0, 0.5]"})
    assert resp.status_code == 400


def test_volumes_bad_format_400():
    client = TestClient(main.app)
    resp = upload(client, extra_data={"volumes_str": "not json"})
    assert resp.status_code == 400


def test_volumes_out_of_range_400():
    client = TestClient(main.app)
    resp = upload(client, extra_data={"volumes_str": "[5.0]"})
    assert resp.status_code == 400


def test_volumes_nan_400():
    client = TestClient(main.app)
    resp = upload(client, extra_data={"volumes_str": "[NaN]"})
    assert resp.status_code == 400


def test_volumes_bool_400():
    client = TestClient(main.app)
    resp = upload(client, extra_data={"volumes_str": "[true]"})
    assert resp.status_code == 400


def test_speeds_out_of_range_400():
    client = TestClient(main.app)
    for bad in ("[-1.0]", "[9.0]", "[NaN]", "[0.1]"):
        resp = upload(client, extra_data={"speeds_str": bad})
        assert resp.status_code == 400


def test_overall_factor_out_of_range_400():
    client = TestClient(main.app)
    for bad in ("0", "0.1", "9", "-1"):
        resp = upload(client, extra_data={"overall_factor": bad})
        assert resp.status_code == 400


def test_timestamps_invalid_400():
    client = TestClient(main.app)
    cases = [
        ("[-1.0]", "[1.0, 1.0]"),  # negative
        ("[0]", "[1.0, 1.0]"),  # zero
        ("[30, 10]", "[1.0, 1.0, 1.0]"),  # not ascending
        ("[10, 10]", "[1.0, 1.0, 1.0]"),  # duplicate
        ("[NaN]", "[1.0, 1.0]"),  # NaN
        ("[1e999]", "[1.0, 1.0]"),  # Infinity
        ('["a"]', "[1.0, 1.0]"),  # string
        ("[true]", "[1.0, 1.0]"),  # bool
    ]
    for ts, sp in cases:
        resp = upload(client, extra_data={"timestamps_str": ts, "speeds_str": sp})
        assert resp.status_code == 400, f"timestamps {ts} should be rejected"


def test_weird_filename_extension_still_works():
    client = TestClient(main.app)
    resp = upload(client, filename="song.mp3/../oops")
    assert resp.status_code == 200


def test_speed_zero_skip_marker_allowed():
    client = TestClient(main.app)
    resp = upload(
        client, extra_data={"timestamps_str": "[1.0]", "speeds_str": "[0, 1.0]"}
    )
    assert resp.status_code == 200


def test_volumes_passed_to_process_audio(monkeypatch):
    received = {}

    def recording_fake(
        input_path,
        output_path,
        timestamps,
        speeds,
        overall_factor=1.0,
        volumes=None,
        progress_cb=None,
    ):
        received["volumes"] = volumes
        with open(output_path, "wb") as f:
            f.write(b"mp3")

    monkeypatch.setattr(main, "process_audio", recording_fake)
    client = TestClient(main.app)
    upload(client, extra_data={"volumes_str": "[0.8]"})
    assert received["volumes"] == [0.8]


def test_volumes_default_all_ones(monkeypatch):
    received = {}

    def recording_fake(
        input_path,
        output_path,
        timestamps,
        speeds,
        overall_factor=1.0,
        volumes=None,
        progress_cb=None,
    ):
        received["volumes"] = volumes
        with open(output_path, "wb") as f:
            f.write(b"mp3")

    monkeypatch.setattr(main, "process_audio", recording_fake)
    client = TestClient(main.app)
    upload(client)
    assert received["volumes"] == [1.0]


def test_check_status_includes_progress():
    client = TestClient(main.app)
    task_id = upload(client).json()["task_id"]
    status = client.get(f"/check-status/{task_id}")
    assert "progress" in status.json()


def test_failed_task_reports_error_code(monkeypatch):
    def broken(*args, **kwargs):
        raise AudioDecodeError("bad file")

    monkeypatch.setattr(main, "process_audio", broken)
    client = TestClient(main.app)
    task_id = upload(client).json()["task_id"]
    status = client.get(f"/check-status/{task_id}")
    assert status.json()["status"] == "failed"
    assert status.json()["error"] == "decode_failed"
