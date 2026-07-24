import os
import subprocess
import uuid
import warnings

import librosa
import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")


class AudioDecodeError(Exception):
    pass


def stretch(audio_seg, rate, is_stereo=False):
    """Time-stretch an audio segment with RMS volume compensation."""
    if rate == 1.0:
        return audio_seg
    rms_original = np.sqrt(np.mean(audio_seg**2))
    if is_stereo:
        stretched = np.array(
            [
                librosa.effects.time_stretch(audio_seg[0], rate=rate),
                librosa.effects.time_stretch(audio_seg[1], rate=rate),
            ]
        )
    else:
        stretched = librosa.effects.time_stretch(audio_seg, rate=rate)
    rms_stretched = np.sqrt(np.mean(stretched**2))
    if rms_stretched > 0:
        stretched = stretched * (rms_original / rms_stretched)
    return stretched


def crossfade(a, b, sr, is_stereo=False, fade_sec=0.02):
    """Equal-power crossfade between two audio arrays."""
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
        return np.concatenate((a[:-fade_samples], blended, b[fade_samples:]), axis=-1)


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
    try:
        y, sr = librosa.load(input_path, sr=None, mono=False)
    except FileNotFoundError:
        raise
    except Exception as e:
        raise AudioDecodeError(str(e)) from e
    is_stereo = y.ndim > 1

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

        # speed 0 marks a section the user skipped in the UI
        if speed == 0 or audio_slice.shape[-1] == 0:
            print(f"Removing segment {i + 1} ({start_time}s - {end_time}s)")
            continue

        print(
            f"Processing segment {i + 1} ({start_time}s - {end_time}s), "
            f"speed: {speed * 100:.1f}%"
        )
        stretched_slices.append(stretch(audio_slice, speed, is_stereo))

    if not stretched_slices:
        raise ValueError("All segments removed, nothing to export.")

    print("Crossfading and concatenating...")
    final_audio = stretched_slices[0]
    for next_slice in stretched_slices[1:]:
        final_audio = crossfade(final_audio, next_slice, sr, is_stereo)

    print("Writing output...")
    temp_wav = f"temp_output_{uuid.uuid4().hex}.wav"
    sf.write(temp_wav, final_audio.T if is_stereo else final_audio, sr)

    print(f"Encoding to MP3: {output_path} ...")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", temp_wav, "-q:a", "2", output_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
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

    process_audio(
        input_file, output_file, cut_timestamps, segment_speeds, global_slowdown
    )
