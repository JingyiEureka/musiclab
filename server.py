"""
Gamzatti 本地服务后端
运行: python3 server.py  (或 conda run -n librosa python server.py)
访问: http://localhost:5001
"""
import os
import uuid
import json
from flask import Flask, request, send_file, jsonify, send_from_directory
from speed_changer import process_audio

app = Flask(__name__, static_folder=".", static_url_path="")

@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

@app.route("/process", methods=["OPTIONS"])
def process_options():
    return "", 204, {"Access-Control-Allow-Origin": "*",
                     "Access-Control-Allow-Headers": "Content-Type",
                     "Access-Control-Allow-Methods": "POST, OPTIONS"}

# 临时输出目录
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "_output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 简单任务状态缓存 (内存)
tasks = {}


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/process", methods=["POST"])
def process():
    """
    接受 JSON 参数，运行 process_audio，以 MP3 流返回。
    Body JSON:
    {
      "timestamps": [25, 45, 62],
      "speeds":     [0.98, 0.96, 0.91, 0.98],
      "overall_factor": 1.0,
      "filename": "gamsatti.mp3"   // 可选，默认使用本地 gamsatti.mp3
    }
    如果携带了上传文件 (multipart/form-data)，则使用上传的文件。
    """
    # ---- 解析参数 ----
    if request.content_type and "multipart/form-data" in request.content_type:
        data = json.loads(request.form.get("params", "{}"))
        uploaded = request.files.get("audio")
    else:
        data = request.get_json(force=True)
        uploaded = None

    timestamps = data.get("timestamps", [])
    speeds = data.get("speeds", [])
    overall_factor = float(data.get("overall_factor", 1.0))
    filename = data.get("filename", "gamsatti.mp3")

    # ---- 确定输入文件路径 ----
    if uploaded:
        tmp_in = os.path.join(OUTPUT_DIR, f"input_{uuid.uuid4().hex}_{uploaded.filename}")
        uploaded.save(tmp_in)
        file_path = tmp_in
    else:
        file_path = os.path.join(os.path.dirname(__file__), filename)
        if not os.path.exists(file_path):
            return jsonify({"error": f"找不到文件 '{filename}'，请先上传音频。"}), 404
        tmp_in = None

    # ---- 运行变速处理 ----
    # 临时切换工作目录到 OUTPUT_DIR，让 process_audio 把结果写在那里
    orig_cwd = os.getcwd()
    try:
        os.chdir(OUTPUT_DIR)
        process_audio(file_path, timestamps, speeds, overall_factor)
    except Exception as e:
        os.chdir(orig_cwd)
        if tmp_in and os.path.exists(tmp_in):
            os.remove(tmp_in)
        return jsonify({"error": str(e)}), 500
    finally:
        os.chdir(orig_cwd)

    # 清理上传的临时文件
    if tmp_in and os.path.exists(tmp_in):
        os.remove(tmp_in)

    # ---- 找到输出文件 ----
    # process_audio 生成的文件名格式: gamsatti_{speeds}.mp3
    speed_strs = [str(int(s * overall_factor * 100)) for s in speeds]
    output_name = f"gamsatti_{'_'.join(speed_strs)}.mp3"
    output_path = os.path.join(OUTPUT_DIR, output_name)

    if not os.path.exists(output_path):
        # fallback: 取最新生成的 mp3
        mp3s = sorted(
            [f for f in os.listdir(OUTPUT_DIR) if f.endswith(".mp3")],
            key=lambda f: os.path.getmtime(os.path.join(OUTPUT_DIR, f)),
            reverse=True
        )
        if not mp3s:
            return jsonify({"error": "处理完成但找不到输出文件。"}), 500
        output_path = os.path.join(OUTPUT_DIR, mp3s[0])
        output_name = mp3s[0]

    return send_file(
        output_path,
        mimetype="audio/mpeg",
        as_attachment=True,
        download_name=output_name,
    )


if __name__ == "__main__":
    print("=" * 50)
    print("🎵 Gamzatti 本地服务已启动")
    print("   访问: http://localhost:5001")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5001, debug=False)
