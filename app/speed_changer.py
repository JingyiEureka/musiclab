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


# Lead-in/lead-out handed to the stretcher so the section edge is not also
# the phase vocoder's edge. 1.0s is the shortest value that held every
# section in Esmeralda.mp3 within ~0.6 LU of its source at the boundary.
STRETCH_CONTEXT_SEC = 1.0


def stretch(audio_seg, rate, is_stereo=False, pad=(0, 0)):
    """Time-stretch an audio segment with RMS volume compensation.

    pad is (before, after): samples of surrounding audio carried in
    audio_seg as context. The stretched context is dropped before
    returning. Without it the phase vocoder starts on a hard cut and
    rebuilds that edge as a burst, leaving the first half second of every
    stretched section up to 3 LU too loud.
    """
    pre, post = pad
    core = audio_seg[..., pre : audio_seg.shape[-1] - post]
    if rate == 1.0:
        return core
    rms_original = np.sqrt(np.mean(core**2))
    if is_stereo:
        # Stretching L and R independently gives each channel its own phase
        # advance, which decorrelates them and collapses the phantom centre
        # by ~1.5 dB. Stretching mid/side keeps both output channels built
        # from one mid signal, so the centre stays coherent.
        mid = (audio_seg[0] + audio_seg[1]) / 2
        side = (audio_seg[0] - audio_seg[1]) / 2
        mid_s = librosa.effects.time_stretch(mid, rate=rate)
        side_s = librosa.effects.time_stretch(side, rate=rate)
        n = min(len(mid_s), len(side_s))
        mid_s, side_s = mid_s[:n], side_s[:n]
        stretched = np.array([mid_s + side_s, mid_s - side_s])
    else:
        stretched = librosa.effects.time_stretch(audio_seg, rate=rate)
    stretched = stretched[
        ..., round(pre / rate) : stretched.shape[-1] - round(post / rate)
    ]
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


def process_audio(
    input_path,
    output_path,
    timestamps,
    speeds,
    overall_factor=1.0,
    volumes=None,
    progress_cb=None,
):
    """
    Process audio: slice at timestamps, apply per-segment speed and volume
    changes, crossfade, and export to output_path.

    progress_cb, if given, is called as progress_cb(fraction, stage) where
    fraction goes 0..1 and stage is a short label like "section 2/5".
    """
    if progress_cb is None:

        def progress_cb(frac, stage):
            pass

    if len(speeds) != len(timestamps) + 1:
        raise ValueError(
            f"Array length mismatch: {len(timestamps)} timestamps "
            f"requires {len(timestamps) + 1} speeds."
        )

    if volumes is None:
        volumes = [1.0] * len(speeds)
    if len(volumes) != len(speeds):
        raise ValueError(
            f"Array length mismatch: {len(speeds)} speeds "
            f"requires {len(speeds)} volumes."
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
    progress_cb(0.10, "loading")

    sample_indices = [int(t * sr) for t in timestamps]

    print(f"Slicing at timestamps {timestamps}...")
    # each slice carries STRETCH_CONTEXT_SEC of the neighbouring audio on both
    # sides, which stretch() consumes and discards; pre/post record how much,
    # so the rest of the loop can work in terms of the section itself
    n_samples = y.shape[-1]
    context = int(STRETCH_CONTEXT_SEC * sr)
    slices = []
    start_idx = 0
    for end_idx in list(sample_indices) + [n_samples]:
        lo = max(0, start_idx - context)
        hi = min(n_samples, end_idx + context)
        segment = y[..., lo:hi]
        slices.append((segment, start_idx - lo, hi - end_idx, end_idx - start_idx))
        start_idx = end_idx

    # progress weight per segment ~ output length (what stretch cost scales with)
    weights = [
        0 if speed == 0 else core_len / speed
        for (_, _, _, core_len), speed in zip(slices, final_speeds)
    ]
    total_weight = sum(weights) or 1
    done_weight = 0.0

    final_audio = None
    prev_i = prev_speed = prev_volume = None
    for i, ((audio_slice, pre, post, core_len), speed, volume) in enumerate(
        zip(slices, final_speeds, volumes)
    ):
        start_time = 0 if i == 0 else timestamps[i - 1]
        end_time = timestamps[i] if i < len(timestamps) else "end"

        # speed 0 marks a section the user skipped in the UI
        if speed == 0 or core_len == 0:
            print(f"Removing segment {i + 1} ({start_time}s - {end_time}s)")
            continue

        print(
            f"Processing segment {i + 1} ({start_time}s - {end_time}s), "
            f"speed: {speed * 100:.1f}%, volume: {volume * 100:.1f}%"
        )
        segment = stretch(audio_slice, speed, is_stereo, pad=(pre, post))
        # gain before crossfade so the fade blends the two loudness levels
        if volume != 1.0:
            segment = np.clip(segment * volume, -1.0, 1.0)

        if final_audio is None:
            final_audio = segment
        elif prev_i == i - 1 and speed == prev_speed == 1.0 and volume == prev_volume:
            # unstretched, same volume, nothing removed between: the audio
            # is continuous across this seam, so join it without a crossfade.
            # Stretched slices are not continuous even at equal speeds,
            # because each slice is stretched and gain-compensated on its own.
            final_audio = np.concatenate((final_audio, segment), axis=-1)
        else:
            final_audio = crossfade(final_audio, segment, sr, is_stereo)
        prev_i, prev_speed, prev_volume = i, speed, volume

        done_weight += weights[i]
        progress_cb(
            0.10 + 0.75 * done_weight / total_weight,
            f"section {i + 1}/{len(slices)}",
        )

    if final_audio is None:
        raise ValueError("All segments removed, nothing to export.")

    print("Writing output...")
    progress_cb(0.85, "encoding")
    # RMS compensation in stretch() can push peaks past ±1, which the 16-bit
    # WAV write would hard-clip into distortion; clip explicitly instead
    np.clip(final_audio, -1.0, 1.0, out=final_audio)
    # keep the intermediate next to the final file, so it lands in outputs/ for
    # the server (where cleanup sweeps it) instead of whatever the cwd happens to be
    temp_wav = os.path.join(
        os.path.dirname(os.path.abspath(output_path)),
        f"temp_output_{uuid.uuid4().hex}.wav",
    )
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
        progress_cb(1.0, "done")
        print(f"Done: {output_path}")
    except Exception as e:
        print(f"MP3 conversion failed, WAV kept at: {temp_wav}. Error: {e}")
        raise


if __name__ == "__main__":
    cut_timestamps = [17, 19, 25.0, 27.0, 42, 44, 49.0, 51.0, 73.0, 79.0, 84.0, 93.0]
    segment_speeds = [1, 0.92, 1, 0.90, 1, 0.92, 1, 0.70, 0.95, 1.03, 1.06, 1.09, 1.00]

    global_slowdown = 1.0

    # assets/ is not tracked in git; point this at a file of your own
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    input_file = os.path.join(repo_root, "assets", "Esmeralda.mp3")
    input_name = os.path.basename(input_file).rsplit(".", 1)[0]
    speed_strs = [str(int(s * global_slowdown * 100)) for s in segment_speeds]
    output_file = f"{input_name}_{'_'.join(speed_strs)}.mp3"

    process_audio(
        input_file, output_file, cut_timestamps, segment_speeds, global_slowdown
    )
