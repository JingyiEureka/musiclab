import numpy as np
import pytest

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
