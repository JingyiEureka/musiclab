import librosa
import numpy as np
import pytest
import soundfile as sf

from speed_changer import crossfade, process_audio, stretch


def make_sine(duration_sec, sr=22050, freq=440.0):
    """Generate a mono sine wave."""
    t = np.linspace(0, duration_sec, int(sr * duration_sec), endpoint=False)
    return np.sin(2 * np.pi * freq * t).astype(np.float32)


def make_stereo_sine(duration_sec, sr=22050):
    """Generate a stereo sine wave (two channels)."""
    mono = make_sine(duration_sec, sr)
    return np.array([mono, mono * 0.5])


class TestStretch:
    def test_rate_one_returns_same_mono(self):
        audio = make_sine(1.0)
        result = stretch(audio, 1.0, is_stereo=False)
        np.testing.assert_array_equal(result, audio)

    def test_rate_one_returns_same_stereo(self):
        audio = make_stereo_sine(1.0)
        result = stretch(audio, 1.0, is_stereo=True)
        np.testing.assert_array_equal(result, audio)

    def test_double_speed_halves_length_mono(self):
        audio = make_sine(2.0)
        result = stretch(audio, 2.0, is_stereo=False)
        assert len(result) < len(audio)
        assert abs(len(result) - len(audio) / 2) < len(audio) * 0.05

    def test_half_speed_doubles_length_mono(self):
        audio = make_sine(2.0)
        result = stretch(audio, 0.5, is_stereo=False)
        assert len(result) > len(audio)
        assert abs(len(result) - len(audio) * 2) < len(audio) * 0.05

    def test_rms_preserved_after_stretch(self):
        audio = make_sine(2.0)
        result = stretch(audio, 1.5, is_stereo=False)
        rms_in = np.sqrt(np.mean(audio**2))
        rms_out = np.sqrt(np.mean(result**2))
        assert abs(rms_in - rms_out) < 0.01

    def test_stereo_preserves_two_channels(self):
        audio = make_stereo_sine(1.0)
        result = stretch(audio, 1.5, is_stereo=True)
        assert result.ndim == 2
        assert result.shape[0] == 2


class TestCrossfade:
    def test_output_length(self):
        a = make_sine(1.0)
        b = make_sine(0.5)
        sr = 22050
        result = crossfade(a, b, sr, is_stereo=False, fade_sec=0.02)
        expected = len(a) + len(b) - int(0.02 * sr)
        assert len(result) == expected

    def test_no_nan_or_inf(self):
        a = make_sine(1.0)
        b = make_sine(0.5)
        result = crossfade(a, b, 22050, is_stereo=False)
        assert not np.any(np.isnan(result))
        assert not np.any(np.isinf(result))

    def test_stereo_output_shape(self):
        a = make_stereo_sine(1.0)
        b = make_stereo_sine(0.5)
        result = crossfade(a, b, 22050, is_stereo=True)
        assert result.ndim == 2
        assert result.shape[0] == 2

    def test_short_inputs_no_crash(self):
        a = make_sine(0.01)  # shorter than fade
        b = make_sine(0.01)
        result = crossfade(a, b, 22050, is_stereo=False)
        assert len(result) > 0

    def test_zero_fade_concatenates(self):
        a = make_sine(1.0)
        b = make_sine(0.5)
        result = crossfade(a, b, 22050, is_stereo=False, fade_sec=0.0)
        assert len(result) == len(a) + len(b)

    def test_seam_has_no_discontinuity(self):
        a = make_sine(0.5, freq=440.0)
        b = make_sine(0.5, freq=440.0)
        result = crossfade(a, b, 22050, is_stereo=False, fade_sec=0.02)
        seam = len(a) - int(0.02 * 22050) // 2
        diff = abs(result[seam + 1] - result[seam])
        assert diff < 1.0


class TestProcessAudioValidation:
    def test_mismatched_lengths_raises(self):
        with pytest.raises(ValueError, match="length mismatch"):
            process_audio(
                "dummy.mp3",
                "out.mp3",
                timestamps=[10, 20],
                speeds=[1.0],  # should be 3 speeds for 2 timestamps
            )

    def test_correct_lengths_no_raise(self, tmp_path):
        """Validation passes before loading audio (which will fail on dummy file)."""
        with pytest.raises(FileNotFoundError):
            process_audio(
                str(tmp_path / "nonexistent.mp3"),
                str(tmp_path / "out.mp3"),
                timestamps=[10],
                speeds=[1.0, 1.0],
            )

    def test_mismatched_volumes_raises(self):
        with pytest.raises(ValueError, match="length mismatch"):
            process_audio(
                "dummy.mp3",
                "out.mp3",
                timestamps=[10],
                speeds=[1.0, 1.0],
                volumes=[1.0],  # should be 2 volumes for 2 speeds
            )


class TestSeamJoining:
    def test_same_settings_joins_without_crossfade(self, tmp_path):
        sr = 22050
        audio = make_sine(2.0, sr)
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.wav")
        sf.write(input_path, audio, sr)

        process_audio(input_path, output_path, timestamps=[1.0], speeds=[1.0, 1.0])
        result, _ = librosa.load(output_path, sr=None)

        # a continuous seam loses no samples and reproduces the input exactly
        assert len(result) == len(audio)
        np.testing.assert_allclose(result, audio, atol=1e-3)

    def test_equal_stretched_speeds_keep_crossfade(self, tmp_path, monkeypatch):
        import speed_changer

        sr = 22050
        audio = make_sine(2.0, sr)
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.wav")
        sf.write(input_path, audio, sr)

        calls = []
        real_crossfade = speed_changer.crossfade

        def counting_crossfade(*args, **kwargs):
            calls.append(1)
            return real_crossfade(*args, **kwargs)

        monkeypatch.setattr(speed_changer, "crossfade", counting_crossfade)

        # equal speeds, but stretched slices are processed independently,
        # so the seam is not continuous and must still be crossfaded
        process_audio(input_path, output_path, timestamps=[1.0], speeds=[0.8, 0.8])
        assert len(calls) == 1

    def test_different_volume_keeps_crossfade(self, tmp_path):
        sr = 22050
        audio = make_sine(2.0, sr)
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.wav")
        sf.write(input_path, audio, sr)

        process_audio(
            input_path,
            output_path,
            timestamps=[1.0],
            speeds=[1.0, 1.0],
            volumes=[1.0, 0.5],
        )
        result, _ = librosa.load(output_path, sr=None)

        # a volume step is a discontinuity, so the 20ms crossfade stays
        assert len(result) == len(audio) - int(0.02 * sr)


class TestProcessAudioVolume:
    def write_sine_wav(self, path, amplitude=0.5, duration=2.0, sr=22050):
        sf.write(path, make_sine(duration, sr) * amplitude, sr)
        return sr

    def test_volume_scales_output_rms(self, tmp_path):
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.mp3")
        self.write_sine_wav(input_path)

        process_audio(input_path, output_path, timestamps=[], speeds=[1.0])
        full, _ = librosa.load(output_path, sr=None)
        process_audio(
            input_path, output_path, timestamps=[], speeds=[1.0], volumes=[0.5]
        )
        halved, _ = librosa.load(output_path, sr=None)

        rms_full = np.sqrt(np.mean(full**2))
        rms_halved = np.sqrt(np.mean(halved**2))
        assert abs(rms_halved / rms_full - 0.5) < 0.1

    def test_volume_clips_to_valid_range(self, tmp_path):
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.mp3")
        self.write_sine_wav(input_path, amplitude=0.9)

        process_audio(
            input_path, output_path, timestamps=[], speeds=[1.0], volumes=[4.0]
        )
        result, _ = librosa.load(output_path, sr=None)
        assert np.max(np.abs(result)) <= 1.05  # mp3 encoding overshoot tolerance

    def test_progress_callback_monotonic_and_complete(self, tmp_path):
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.mp3")
        self.write_sine_wav(input_path)

        calls = []
        process_audio(
            input_path,
            output_path,
            timestamps=[1.0],
            speeds=[1.0, 0.8],
            progress_cb=lambda frac, stage: calls.append((frac, stage)),
        )
        fracs = [f for f, _ in calls]
        assert fracs == sorted(fracs)
        assert fracs[-1] == 1.0
        assert any("section" in s for _, s in calls)

    def test_stretch_gain_does_not_clip_output(self, tmp_path):
        # RMS compensation after a stretch can push peaks past 1.0 on
        # already-loud input; the output must be clipped back to valid range
        input_path = str(tmp_path / "in.wav")
        output_path = str(tmp_path / "out.mp3")
        self.write_sine_wav(input_path, amplitude=0.99)

        process_audio(input_path, output_path, timestamps=[], speeds=[0.7])
        result, _ = librosa.load(output_path, sr=None)
        assert np.max(np.abs(result)) <= 1.05  # mp3 encoding overshoot tolerance
