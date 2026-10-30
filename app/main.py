import asyncio
import logging
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# All paths are anchored to the repo root rather than the working directory,
# so the server behaves the same however it is launched.
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
ASSETS_DIR = BASE_DIR / "assets"
TEMP_DIR = BASE_DIR / "temp_uploads"
INDEX_HTML = STATIC_DIR / "index.html"

app = FastAPI(title="音频变速处理 API")

# 前端由本服务自己托管（同源），无需跨域配置

# 挂载前端静态资源和主页
if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def serve_index():
    if INDEX_HTML.exists():
        # always revalidate the page itself, otherwise a cached copy keeps
        # pointing at old ?v= asset versions after a deploy
        return FileResponse(INDEX_HTML, headers={"Cache-Control": "no-cache"})
    return {"message": "index.html not found"}


os.makedirs(TEMP_DIR, exist_ok=True)

CLEANUP_MAX_AGE_SECONDS = 24 * 60 * 60
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def safe_ext(filename):
    # 扩展名只保留字母数字，防止文件名里带 / 之类的字符引发路径错误
    return re.sub(r"[^a-zA-Z0-9]", "", filename.split(".")[-1]) or "bin"


# The frontend is a set of ES modules importing each other by URL, so a ?v=
# query string on the entry point cannot bust the rest. Make them revalidate
# instead: cheap 304s, and no version bump to remember on deploy.
@app.middleware("http")
async def revalidate_js_modules(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/static/js/", "/static/vendor/")):
        response.headers["Cache-Control"] = "no-cache"
    return response


# Starlette parses the whole multipart body before the handler runs, so
# save_upload alone cannot stop an oversized request; reject by header first.
@app.middleware("http")
async def reject_oversized_requests(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_UPLOAD_BYTES + 1024 * 1024:
        return JSONResponse(
            status_code=413, content={"detail": "File too large (max 50 MB)"}
        )
    return await call_next(request)


async def save_upload(file: UploadFile, path: str):
    size = 0
    with open(path, "wb") as buffer:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                break
            buffer.write(chunk)
    if size > MAX_UPLOAD_BYTES:
        os.remove(path)
        raise HTTPException(status_code=413, detail="File too large (max 50 MB)")


def cleanup_stale_files():
    """Delete temp files older than CLEANUP_MAX_AGE_SECONDS, left by a crash mid-extract."""
    cutoff = time.time() - CLEANUP_MAX_AGE_SECONDS
    for name in os.listdir(TEMP_DIR):
        path = TEMP_DIR / name
        if path.is_file() and path.stat().st_mtime < cutoff:
            path.unlink()
            logger.info("Cleanup: deleted stale file %s", path)


cleanup_stale_files()


# ==========================================
# 接口：从视频中提取音轨（iPhone Safari 无法在浏览器内解码视频）
# ==========================================
@app.post("/extract-audio/")
async def extract_audio(file: UploadFile = File(...)):
    temp_id = str(uuid.uuid4())
    input_ext = safe_ext(file.filename)
    input_path = str(TEMP_DIR / f"{temp_id}.{input_ext}")
    output_path = str(TEMP_DIR / f"{temp_id}.mp3")

    await save_upload(file, input_path)

    try:
        # ffmpeg 可能要跑几十秒，放到线程池里，避免阻塞整个事件循环
        await asyncio.to_thread(
            subprocess.run,
            ["ffmpeg", "-y", "-i", input_path, "-vn", "-q:a", "2", output_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=400, detail="无法从该文件提取音频")
    finally:
        if os.path.exists(input_path):
            os.remove(input_path)

    logger.info("Extracted audio track: %s", output_path)
    return FileResponse(
        output_path,
        media_type="audio/mpeg",
        background=BackgroundTask(os.remove, output_path),
    )
