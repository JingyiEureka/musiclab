import json
import os
import re
import uuid
from datetime import datetime

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from speed_changer import process_audio

app = FastAPI(title="音频变速处理 API")

# 配置允许跨域请求 (CORS)，这样你直接双击打开 index.html 也能连上本地服务器了！
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有域名跨域，本地测试最方便
    allow_credentials=True,
    allow_methods=["*"],  # 允许所有请求方法 (GET, POST等)
    allow_headers=["*"],
)

# 挂载前端静态资源和主页
if os.path.exists("assets"):
    app.mount("/assets", StaticFiles(directory="assets"), name="assets")
if os.path.exists("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def serve_index():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"message": "index.html not found"}


# Ensure temp and output directories exist
os.makedirs("temp_uploads", exist_ok=True)
os.makedirs("outputs", exist_ok=True)

# 模拟一个极简的数据库，用来存储任务状态
# 格式: {"task_id": {"status": "pending" | "processing" | "done" | "failed", "file_url": "..."}}
TASKS_DB = {}


# Wrapper for background task execution with status tracking
def background_audio_task(
    task_id: str,
    input_path: str,
    output_path: str,
    timestamps: list,
    speeds: list,
    overall_factor: float,
):
    TASKS_DB[task_id]["status"] = "processing"
    try:
        print(
            f"Background task started: timestamps={timestamps}, speeds={speeds}, overall={overall_factor}"
        )
        process_audio(input_path, output_path, timestamps, speeds, overall_factor)

        # 处理成功，更新状态
        TASKS_DB[task_id]["status"] = "done"
        TASKS_DB[task_id]["file_url"] = f"/download/{task_id}"
        print(f"Task {task_id} processed: {output_path}")

    except Exception as e:
        TASKS_DB[task_id]["status"] = "failed"
        print(f"❌ 任务 {task_id} 失败: {str(e)}")
    finally:
        # 清理用户上传的原始文件，节省空间
        if os.path.exists(input_path):
            os.remove(input_path)


# ==========================================
# 接口 1：前端用来上传文件的 API
# ==========================================
@app.post("/upload-audio/")
async def upload_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    timestamps_str: str = Form(..., description="JSON格式的时间点，如 '[25.8, 46]'"),
    speeds_str: str = Form(..., description="JSON格式的速度，如 '[1, 0.96, 0.91]'"),
    overall_factor: float = Form(1.0, description="全局速度系数"),
):
    # 解析 JSON 字符串为 Python 列表
    try:
        # 清除用户在 Swagger UI 测试时可能手滑多加的外层单引号或双引号
        clean_timestamps = timestamps_str.strip().strip("'").strip('"')
        clean_speeds = speeds_str.strip().strip("'").strip('"')

        # 兼容情况 1：如果接收到的是正常的 JSON，例如 "[2]" 或 "[1, 0.8]"
        if clean_timestamps.startswith("[") and clean_timestamps.endswith("]"):
            timestamps = json.loads(clean_timestamps)
        else:
            # 兼容情况 2：如果前端没用 JSON.stringify 而是直接 toString() 导致传过来的是 "2" 或 "1,0.8"
            timestamps = [
                float(x.strip()) for x in clean_timestamps.split(",") if x.strip()
            ]

        if clean_speeds.startswith("[") and clean_speeds.endswith("]"):
            speeds = json.loads(clean_speeds)
        else:
            speeds = [float(x.strip()) for x in clean_speeds.split(",") if x.strip()]

        if not isinstance(timestamps, list) or not isinstance(speeds, list):
            raise ValueError("解析后不是列表")

    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"参数格式错误！你输入的 timestamps_str 是: {timestamps_str}，speeds_str 是: {speeds_str}。报错原因: {str(e)}。建议输入 JSON 数组，如 [25.8, 46]",
        )
    # 简单校验一下你核心算法需要的数据关系
    if len(speeds) != len(timestamps) + 1:
        raise HTTPException(
            status_code=400,
            detail=f"数组长度不匹配！{len(timestamps)} 个时间点应该对应 {len(timestamps) + 1} 个速度值。",
        )

    # 1. 生成唯一的任务 ID
    task_id = str(uuid.uuid4())

    # 2. 设定文件的保存路径
    input_ext = file.filename.split(".")[-1]
    input_filename = file.filename.rsplit(".", 1)[0]
    input_path = f"temp_uploads/{task_id}.{input_ext}"
    output_path = f"outputs/{task_id}.mp3"

    # 3. 把前端传来的文件保存到硬盘
    with open(input_path, "wb") as buffer:
        buffer.write(await file.read())

    # 4. 在"数据库"中注册这个任务
    TASKS_DB[task_id] = {
        "status": "pending",
        "file_url": None,
        "original_filename": input_filename,
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
    )

    # 6. 秒回前端，告诉它拿这个 ID 去轮询进度
    return {"message": "音频已接收，正在后台处理", "task_id": task_id}


# ==========================================
# 接口 2：前端每隔 2 秒来问一次“处理完了吗？”的 API
# ==========================================
@app.get("/check-status/{task_id}")
async def check_status(task_id: str):
    if task_id not in TASKS_DB:
        raise HTTPException(status_code=404, detail="任务不存在")
    return TASKS_DB[task_id]


# ==========================================
# 接口 3：前端用来下载最终 MP3 的 API
# ==========================================
@app.get("/download/{task_id}")
async def download_audio(task_id: str):
    file_path = f"outputs/{task_id}.mp3"
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="文件尚未生成或已丢失")

    # 从数据库获取原文件名，如果没有就兜底叫 processed
    original_name = TASKS_DB.get(task_id, {}).get("original_filename", "processed")
    safe_name = re.sub(r"[^a-z0-9_]+", "_", original_name.lower()).strip("_")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    download_name = f"{safe_name}_{ts}.mp3"

    def delete_after_send():
        os.remove(file_path)
        print(f"Task {task_id} downloaded, deleted: {file_path}")

    return FileResponse(
        file_path,
        media_type="audio/mpeg",
        filename=download_name,
        background=BackgroundTask(delete_after_send),
    )
