import librosa
import soundfile as sf
import numpy as np
import warnings
import subprocess
import os
import uuid

warnings.filterwarnings("ignore")


def process_audio(input_path, output_path, timestamps, speeds, overall_factor=1.0):
    """
    Process audio: slice at timestamps, apply per-segment speed changes,
    crossfade, and export to output_path.
    """
    if len(speeds) != len(timestamps) + 1:
        raise ValueError(
            f"Array length mismatch: {len(timestamps)} timestamps "
            f"requires {len(timestamps) + 1} speeds."
        )

    final_speeds = [s * overall_factor for s in speeds]

    print(f"Loading audio: {input_path} (this may take a moment)...")
    y, sr = librosa.load(input_path, sr=None, mono=False)
    is_stereo = y.ndim > 1

    def stretch(audio_seg, rate):
        if rate == 1.0:
            return audio_seg
        rms_original = np.sqrt(np.mean(audio_seg ** 2))
        if is_stereo:
            stretched = np.array([
                librosa.effects.time_stretch(audio_seg[0], rate=rate),
                librosa.effects.time_stretch(audio_seg[1], rate=rate),
            ])
        else:
            stretched = librosa.effects.time_stretch(audio_seg, rate=rate)
        rms_stretched = np.sqrt(np.mean(stretched ** 2))
        if rms_stretched > 0:
            stretched = stretched * (rms_original / rms_stretched)
        return stretched

    sample_indices = [int(t * sr) for t in timestamps]

    print(f"Slicing at timestamps {timestamps}...")
    slices = []
    start_idx = 0
    for end_idx in sample_indices:
        segment = y[:, start_idx:end_idx] if is_stereo else y[start_idx:end_idx]
        slices.append(segment)
        start_idx = end_idx
    slices.append(y[:, start_idx:] if is_stereo else y[start_idx:])

    stretched_slices = []
    for i, (audio_slice, speed) in enumerate(zip(slices, final_speeds)):
        start_time = 0 if i == 0 else timestamps[i - 1]
        end_time = timestamps[i] if i < len(timestamps) else "end"

        if speed == 0:
            print(f"Removing segment {i + 1} ({start_time}s - {end_time}s)")
            continue

        print(
            f"Processing segment {i + 1} ({start_time}s - {end_time}s), "
            f"speed: {speed * 100:.1f}%"
        )
        stretched_slices.append(stretch(audio_slice, speed))

    if not stretched_slices:
        print("All segments removed, nothing to export.")
        return

    def crossfade(a, b, fade_sec=0.02):
        fade_samples = int(fade_sec * sr)
        if fade_samples <= 0:
            return np.concatenate((a, b), axis=-1)
        fade_samples = min(fade_samples, a.shape[-1], b.shape[-1])
        fade_in = np.sqrt(np.linspace(0, 1, fade_samples))
        fade_out = np.sqrt(np.linspace(1, 0, fade_samples))
        if is_stereo:
            a_end, b_start = a[:, -fade_samples:], b[:, :fade_samples]
            blended = a_end * fade_out + b_start * fade_in
            return np.concatenate(
                (a[:, :-fade_samples], blended, b[:, fade_samples:]), axis=-1
            )
        else:
            a_end, b_start = a[-fade_samples:], b[:fade_samples]
            blended = a_end * fade_out + b_start * fade_in
            return np.concatenate(
                (a[:-fade_samples], blended, b[fade_samples:]), axis=-1
            )

    print("Crossfading and concatenating...")
    final_audio = stretched_slices[0]
    for next_slice in stretched_slices[1:]:
        final_audio = crossfade(final_audio, next_slice, fade_sec=0.02)

    print("Writing output...")
    temp_wav = f"temp_output_{uuid.uuid4().hex}.wav"
    sf.write(temp_wav, final_audio.T if is_stereo else final_audio, sr)

    print(f"Encoding to MP3: {output_path} ...")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", temp_wav, "-q:a", "2", output_path],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.remove(temp_wav)
        print(f"Done: {output_path}")
    except Exception as e:
        print(f"MP3 conversion failed, WAV kept at: {temp_wav}. Error: {e}")
        raise


if __name__ == "__main__":
    cut_timestamps = [16, 38]
    segment_speeds = [1, 0.84, 1]
    global_slowdown = 1.0

    input_file = "./assets/kitri.mp3"
    input_name = os.path.basename(input_file).rsplit(".", 1)[0]
    speed_strs = [str(int(s * global_slowdown * 100)) for s in segment_speeds]
    output_file = f"{input_name}_{'_'.join(speed_strs)}.mp3"

    process_audio(input_file, output_file, cut_timestamps, segment_speeds, global_slowdown)
