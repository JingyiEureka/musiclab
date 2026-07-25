import asyncio
import json
import logging
import math
import os
import re
import subprocess
import time
import uuid
from datetime import datetime

from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from speed_changer import AudioDecodeError, process_audio

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="音频变速处理 API")

# 前端由本服务自己托管（同源），无需跨域配置。曾经支持双击打开 index.html
# 的 file:// 模式，但会话 cookie 在跨域下无法工作，该模式已移除。

# 挂载前端静态资源和主页
if os.path.exists("assets"):
    app.mount("/assets", StaticFiles(directory="assets"), name="assets")
if os.path.exists("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def serve_index(request: Request):
    if os.path.exists("index.html"):
        response = FileResponse("index.html")
        get_session(request, response)
        return response
    return {"message": "index.html not found"}


# Ensure temp and output directories exist
os.makedirs("temp_uploads", exist_ok=True)
os.makedirs("outputs", exist_ok=True)

# 模拟一个极简的数据库，用来存储任务状态
# 格式: {"task_id": {"status": "pending" | "processing" | "done" | "failed", "file_url": "..."}}
TASKS_DB = {}

CLEANUP_MAX_AGE_SECONDS = 24 * 60 * 60
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
# One export at a time: the production box has 2 slow vCPUs and 1 GB RAM, so
# concurrent jobs thrash CPU and swap and make every export slower.
MAX_ACTIVE_TASKS = 1
SESSION_COOKIE = "session"
MAX_SPEED = 8.0  # matches the frontend clamp (800%); 0 marks a skipped section
MIN_SPEED = 0.25  # matches the frontend clamp (25%); slower = huge CPU cost
MAX_VOLUME = 4.0  # matches the frontend clamp (400%)


def parse_float_list(raw):
    # 清除用户在 Swagger UI 测试时可能手滑多加的外层单引号或双引号
    clean = raw.strip().strip("'").strip('"')
    # 兼容情况 1：正常的 JSON，例如 "[2]" 或 "[1, 0.8]"
    if clean.startswith("[") and clean.endswith("]"):
        return json.loads(clean)
    # 兼容情况 2：前端没用 JSON.stringify 而是直接 toString()，例如 "2" 或 "1,0.8"
    return [float(x.strip()) for x in clean.split(",") if x.strip()]


def check_range(values, name, max_value, min_nonzero=0.0):
    # bool 是 int 的子类，json 的 true/false 也要拒绝；NaN 与任何比较都是 False
    for v in values:
        if (
            not isinstance(v, (int, float))
            or isinstance(v, bool)
            or math.isnan(v)
            or v < 0
            or v > max_value
            or (0 < v < min_nonzero)
        ):
            raise HTTPException(
                status_code=400,
                detail=f"{name}超出范围！每个值应在 0 到 {max_value:g} 之间。",
            )


def check_timestamps(values):
    # 时间点必须是严格递增的正数，否则切片会静默产生重复或空白的音频
    prev = 0.0
    for t in values:
        if (
            not isinstance(t, (int, float))
            or isinstance(t, bool)
            or math.isnan(t)
            or t <= prev
        ):
            raise HTTPException(
                status_code=400,
                detail="时间点必须是严格递增的正数。",
            )
        prev = t


def safe_ext(filename):
    # 扩展名只保留字母数字，防止文件名里带 / 之类的字符引发路径错误
    return re.sub(r"[^a-zA-Z0-9]", "", filename.split(".")[-1]) or "bin"


def get_session(request: Request, response: Response) -> str:
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        sid = uuid.uuid4().hex
        response.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="lax")
    return sid


def get_owned_task(task_id: str, request: Request) -> dict:
    task = TASKS_DB.get(task_id)
    if not task or task["session"] != request.cookies.get(SESSION_COOKIE):
        raise HTTPException(status_code=404, detail="Task not found")
    return task


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
    """Delete files and task records older than CLEANUP_MAX_AGE_SECONDS."""
    cutoff = time.time() - CLEANUP_MAX_AGE_SECONDS
    candidates = [
        os.path.join(folder, name)
        for folder in ("outputs", "temp_uploads")
        for name in os.listdir(folder)
    ]
    candidates += [
        name
        for name in os.listdir(".")
        if name.startswith("temp_output_") and name.endswith(".wav")
    ]
    for path in candidates:
        if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
            os.remove(path)
            logger.info("Cleanup: deleted stale file %s", path)
    # Prune old task records so wedged tasks free their cap slot and memory
    for task_id in list(TASKS_DB):
        if TASKS_DB[task_id].get("created", 0) < cutoff:
            del TASKS_DB[task_id]
            logger.info("Cleanup: removed stale task %s", task_id)


cleanup_stale_files()


# Wrapper for background task execution with status tracking
def background_audio_task(
    task_id: str,
    input_path: str,
    output_path: str,
    timestamps: list,
    speeds: list,
    overall_factor: float,
    volumes: list,
):
    TASKS_DB[task_id]["status"] = "processing"
    try:
        logger.info(
            "Background task started: timestamps=%s, speeds=%s, overall=%s, volumes=%s",
            timestamps,
            speeds,
            overall_factor,
            volumes,
        )
        process_audio(
            input_path, output_path, timestamps, speeds, overall_factor, volumes
        )

        # 处理成功，更新状态
        TASKS_DB[task_id]["status"] = "done"
        TASKS_DB[task_id]["file_url"] = f"/download/{task_id}"
        logger.info("Task %s processed: %s", task_id, output_path)

    except Exception as e:
        logger.exception("Task %s failed", task_id)
        if isinstance(e, AudioDecodeError):
            code = "decode_failed"
        elif isinstance(e, subprocess.CalledProcessError):
            code = "encode_failed"
        elif isinstance(e, ValueError):
            code = "invalid_params"
        else:
            code = "server_error"
        TASKS_DB[task_id]["status"] = "failed"
        TASKS_DB[task_id]["error"] = code
    finally:
        # 清理用户上传的原始文件，节省空间
        if os.path.exists(input_path):
            os.remove(input_path)


# ==========================================
# 接口 1：前端用来上传文件的 API
# ==========================================
@app.post("/upload-audio/")
async def upload_audio(
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    timestamps_str: str = Form(..., description="JSON格式的时间点，如 '[25.8, 46]'"),
    speeds_str: str = Form(..., description="JSON格式的速度，如 '[1, 0.96, 0.91]'"),
    overall_factor: float = Form(1.0, description="全局速度系数"),
    volumes_str: str = Form(None, description="JSON格式的音量，如 '[1, 0.8, 1.2]'"),
):
    active = sum(
        1 for t in TASKS_DB.values() if t["status"] in ("pending", "processing")
    )
    if active >= MAX_ACTIVE_TASKS:
        logger.warning("Rejected upload: %d tasks already active", active)
        raise HTTPException(
            status_code=429, detail="Server is busy - please try again in a minute."
        )

    sid = get_session(request, response)

    # 解析 JSON 字符串为 Python 列表
    try:
        timestamps = parse_float_list(timestamps_str)
        speeds = parse_float_list(speeds_str)
        clean_volumes = (volumes_str or "").strip().strip("'").strip('"')
        if clean_volumes:
            volumes = parse_float_list(clean_volumes)
        else:
            volumes = [1.0] * len(speeds)

        if (
            not isinstance(timestamps, list)
            or not isinstance(speeds, list)
            or not isinstance(volumes, list)
        ):
            raise ValueError("解析后不是列表")

    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid timestamps/speeds format. Send JSON arrays like [25.8, 46].",
        )
    # 简单校验一下你核心算法需要的数据关系
    if len(speeds) != len(timestamps) + 1:
        raise HTTPException(
            status_code=400,
            detail=f"数组长度不匹配！{len(timestamps)} 个时间点应该对应 {len(timestamps) + 1} 个速度值。",
        )
    if len(volumes) != len(speeds):
        raise HTTPException(
            status_code=400,
            detail=f"数组长度不匹配！{len(speeds)} 个速度值应该对应 {len(speeds)} 个音量值。",
        )
    check_timestamps(timestamps)
    check_range(speeds, "速度", MAX_SPEED, min_nonzero=MIN_SPEED)
    check_range(volumes, "音量", MAX_VOLUME)
    # overall_factor 在校验之后才乘进速度里，所以要单独限制范围
    if math.isnan(overall_factor) or not (MIN_SPEED <= overall_factor <= MAX_SPEED):
        raise HTTPException(
            status_code=400,
            detail=f"全局速度系数应在 {MIN_SPEED:g} 到 {MAX_SPEED:g} 之间。",
        )

    # 1. 生成唯一的任务 ID
    task_id = str(uuid.uuid4())

    # 2. 设定文件的保存路径
    input_ext = safe_ext(file.filename)
    input_filename = file.filename.rsplit(".", 1)[0]
    input_path = f"temp_uploads/{task_id}.{input_ext}"
    output_path = f"outputs/{task_id}.mp3"

    # 3. 把前端传来的文件保存到硬盘
    await save_upload(file, input_path)

    # 4. 在"数据库"中注册这个任务
    TASKS_DB[task_id] = {
        "status": "pending",
        "file_url": None,
        "error": None,
        "original_filename": input_filename,
        "session": sid,
        "created": time.time(),
    }

    # 5. 把真正的处理工作扔给后台，立刻放行
    background_tasks.add_task(
        background_audio_task,
        task_id,
        input_path,
        output_path,
        timestamps,
        speeds,
        overall_factor,
        volumes,
    )
    background_tasks.add_task(cleanup_stale_files)

    # 6. 秒回前端，告诉它拿这个 ID 去轮询进度
    return {"message": "音频已接收，正在后台处理", "task_id": task_id}


# ==========================================
# 接口 1b：从视频中提取音轨（iPhone Safari 无法在浏览器内解码视频）
# ==========================================
@app.post("/extract-audio/")
async def extract_audio(file: UploadFile = File(...)):
    temp_id = str(uuid.uuid4())
    input_ext = safe_ext(file.filename)
    input_path = f"temp_uploads/{temp_id}.{input_ext}"
    output_path = f"temp_uploads/{temp_id}.mp3"

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


# ==========================================
# 接口 2：前端每隔 2 秒来问一次“处理完了吗？”的 API
# ==========================================
@app.get("/check-status/{task_id}")
async def check_status(task_id: str, request: Request):
    task = get_owned_task(task_id, request)
    return {
        "status": task["status"],
        "file_url": task["file_url"],
        "error": task["error"],
    }


# ==========================================
# 接口 3：前端用来下载最终 MP3 的 API
# ==========================================
@app.get("/download/{task_id}")
async def download_audio(task_id: str, request: Request):
    task = get_owned_task(task_id, request)

    file_path = f"outputs/{task_id}.mp3"
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="文件尚未生成或已丢失")

    # 从数据库获取原文件名，如果没有就兜底叫 processed
    original_name = task.get("original_filename", "processed")
    safe_name = re.sub(r"[^a-z0-9_]+", "_", original_name.lower()).strip("_")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    download_name = f"{safe_name}_{ts}.mp3"

    return FileResponse(file_path, media_type="audio/mpeg", filename=download_name)
