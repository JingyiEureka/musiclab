import librosa
import soundfile as sf
import numpy as np
import warnings
import subprocess
import os

# 忽略 librosa 读取 mp3 时的一些常见警告
warnings.filterwarnings("ignore")

def process_audio(file_path, timestamps, speeds, overall_factor=1.0):
    """
    处理音频：根据时间点数组和速度数组，对音频进行分段变速并平滑拼接。
    """
    
    # 1. 校验输入
    if len(speeds) != len(timestamps) + 1:
        raise ValueError(f"❌ 数组长度不匹配！{len(timestamps)} 个时间点应该对应 {len(timestamps)+1} 个速度值。")

    # 2. 计算出每段最终的实际播放速度
    final_speeds = [s * overall_factor for s in speeds]

    # 3. 自动生成包含所有最终比例的文件名
    speed_strs = [str(int(s * 100)) for s in final_speeds]
    filename_suffix = "_".join(speed_strs)
    output_path = f"esmeralda_{filename_suffix}.mp3"

    print(f"⏳ 正在加载音频 (这可能需要十几秒，请稍候)...")
    y, sr = librosa.load(file_path, sr=None, mono=False)
    is_stereo = y.ndim > 1
    
    # ==========================================
    # 关键修复 1：加入 RMS 音量平衡的变速函数
    # ==========================================
    def stretch(audio_seg, rate):
        if rate == 1.0: return audio_seg
        
        # 计算原始片段的 RMS 能量
        rms_original = np.sqrt(np.mean(audio_seg**2))
        
        # 进行变速处理
        if is_stereo:
            stretched = np.array([
                librosa.effects.time_stretch(audio_seg[0], rate=rate),
                librosa.effects.time_stretch(audio_seg[1], rate=rate)
            ])
        else:
            stretched = librosa.effects.time_stretch(audio_seg, rate=rate)
            
        # 计算变速后的 RMS 能量并补偿音量，防止速度快的段落听起来更响
        rms_stretched = np.sqrt(np.mean(stretched**2))
        if rms_stretched > 0:
            volume_ratio = rms_original / rms_stretched
            stretched = stretched * volume_ratio
            
        return stretched

    # 4. 将时间点数组 (秒) 转换为采样点索引
    sample_indices = [int(t * sr) for t in timestamps]
    
    print(f"✂️ 正在根据时间点 {timestamps} 进行切片...")
    slices = []
    start_idx = 0
    for end_idx in sample_indices:
        segment = y[:, start_idx:end_idx] if is_stereo else y[start_idx:end_idx]
        slices.append(segment)
        start_idx = end_idx
    # 截取最后一段
    last_segment = y[:, start_idx:] if is_stereo else y[start_idx:]
    slices.append(last_segment)

    # 5. 执行变速
    stretched_slices = []
    for i, (audio_slice, final_speed) in enumerate(zip(slices, final_speeds)):
        start_time = 0 if i == 0 else timestamps[i-1]
        end_time = timestamps[i] if i < len(timestamps) else "结尾"
        print(f"🎵 正在处理第{i+1}段 ({start_time}s - {end_time}s)，实际速度: {final_speed*100:.1f}%")
        
        stretched_slices.append(stretch(audio_slice, final_speed))

    # ==========================================
    # 关键修复 2：等功率微缝交叉淡入淡出 (已修复缩进)
    # ==========================================
    def crossfade(a, b, fade_sec=0.02): 
        fade_samples = int(fade_sec * sr)
        if fade_samples <= 0: return np.concatenate((a, b), axis=-1)
        
        fade_samples = min(fade_samples, a.shape[-1], b.shape[-1])
        
        # 使用平方根曲线（等功率）
        fade_in = np.sqrt(np.linspace(0, 1, fade_samples))
        fade_out = np.sqrt(np.linspace(1, 0, fade_samples))

        if is_stereo:
            a_end, b_start = a[:, -fade_samples:], b[:, :fade_samples]
            blended = a_end * fade_out + b_start * fade_in
            return np.concatenate((a[:, :-fade_samples], blended, b[:, fade_samples:]), axis=-1)
        else:
            a_end, b_start = a[-fade_samples:], b[:fade_samples]
            blended = a_end * fade_out + b_start * fade_in
            return np.concatenate((a[:-fade_samples], blended, b[fade_samples:]), axis=-1)

    print("🌊 正在拼接并进行平滑交叉淡入淡出处理...")
    final_audio = stretched_slices[0]
    for next_slice in stretched_slices[1:]:
        final_audio = crossfade(final_audio, next_slice, fade_sec=0.02)
            
    # 7. 保存临时 WAV 并转为 MP3
    print("💾 正在生成音频...")
    temp_wav = "temp_output.wav"
    sf.write(temp_wav, final_audio.T if is_stereo else final_audio, sr)
    
    print(f"💽 正在编码为 MP3 格式: {output_path} ...")
    try:
        subprocess.run(["ffmpeg", "-y", "-i", temp_wav, "-q:a", "2", output_path], 
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(temp_wav)
        print(f"✅ 处理完成！已完美导出为: {output_path}")
    except Exception as e:
        print(f"❌ MP3 转换失败，已保留 WAV 文件: {temp_wav}。错误: {e}")

if __name__ == "__main__":
    
    # cut_timestamps = [25.8, 46, 55, 62.5]  
    # segment_speeds = [1, 0.96, 0.91, 0.95, 1]
    cut_timestamps = []
    segment_speeds = [1]
    global_slowdown = 0.9
    
    process_audio("La Esmerelda Female Variation.mp4", cut_timestamps, segment_speeds, global_slowdown)