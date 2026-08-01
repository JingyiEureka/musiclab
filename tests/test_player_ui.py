"""Verify player time labels exist and are positioned correctly."""

import os
import re

STATIC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
)


def read_html():
    with open(os.path.join(STATIC, "index.html"), "r") as f:
        return f.read()


def read_css():
    with open(os.path.join(STATIC, "styles.css"), "r") as f:
        return f.read()


def extract_css_rules(css, selector):
    """Extract all CSS blocks matching `selector`. Returns list of rule bodies."""
    pattern = re.compile(
        r"" + re.escape(selector) + r"\s*\{([^}]+)\}",
        re.DOTALL,
    )
    return [m.group(1) for m in pattern.finditer(css)]


class TestSinglePlaybackPath:
    """The separate preview button is gone: the transport renders and plays the
    full timeline, so playback and export are the same render (ADR 0010).

    Replaces an earlier guard that asserted the button was *visible*. That guard
    was written because the button had once been hidden by an inline style while
    its code stayed wired up, making the feature unreachable while its module
    tests passed. Deleting the button means the assertion has to invert, or it
    would pass trivially on an element that no longer exists."""

    html = read_html()

    def test_no_preview_button(self):
        assert "preview-btn" not in self.html, (
            "the preview button was retired; playback goes through the transport"
        )

    def test_transport_controls_present(self):
        for element_id in ("restart-btn", "play-btn", "btn-add-segment"):
            assert f'id="{element_id}"' in self.html

    def test_no_inline_hidden_player_controls(self):
        """The failure mode that made the old guard necessary: a control wired up
        in JS but hidden in the markup."""
        row = re.search(
            r'<div class="player-bar-row player-controls">(.*?)</div>',
            self.html,
            re.DOTALL,
        )
        assert row is not None, "player controls row should exist"
        assert "display: none" not in row.group(1)
        assert "display:none" not in row.group(1)


class TestPlayerTimeLabels:
    html = read_html()
    css = read_css()

    def test_player_total_exists(self):
        assert 'id="player-total"' in self.html

    def test_player_current_exists(self):
        assert 'id="player-current"' in self.html

    def test_playhead_line_exists(self):
        assert 'id="playhead"' in self.html

    def test_waveform_inner_exists(self):
        assert 'id="waveform-inner"' in self.html

    def test_player_total_is_child_of_waveform_wrap(self):
        # player-total should be a direct child of waveform-wrap,
        # outside waveform-inner (so it is not clipped by overflow-x)
        match = re.search(
            r'<div class="waveform-wrap"[^>]*>.*?<span class="waveform-time" id="player-total"',
            self.html,
            re.DOTALL,
        )
        assert match is not None, "player-total should be inside waveform-wrap"

    def test_player_current_is_outside_waveform_inner(self):
        # player-current should be before waveform-inner in the HTML
        # so it sits outside the scroll container
        wrap_match = re.search(
            r'<div class="waveform-wrap"[^>]*>(.*?)<div id="waveform-inner"',
            self.html,
            re.DOTALL,
        )
        assert wrap_match is not None
        wrap_content = wrap_match.group(1)
        assert 'id="player-current"' in wrap_content, (
            "player-current should be between waveform-wrap open "
            "and waveform-inner open"
        )

    def test_waveform_wrap_no_overflow_x(self):
        rules = extract_css_rules(self.css, ".waveform-wrap")
        assert len(rules) >= 1
        body = rules[0]
        assert "overflow-x:" not in body, (
            "waveform-wrap must not set overflow-x — it clips time labels at top:-16px"
        )

    def test_waveform_inner_has_overflow_x_auto(self):
        rules = extract_css_rules(self.css, "#waveform-inner")
        assert len(rules) >= 1
        body = rules[0]
        assert "overflow-x" in body, (
            "waveform-inner must set overflow-x: auto for waveform scrolling"
        )

    def test_playhead_time_has_position_absolute(self):
        rules = extract_css_rules(self.css, ".playhead-time")
        assert len(rules) >= 1
        body = rules[0]
        assert "position: absolute" in body or "position:absolute" in body

    def test_waveform_time_has_position_absolute(self):
        rules = extract_css_rules(self.css, ".waveform-time")
        assert len(rules) >= 1
        body = rules[0]
        assert "position: absolute" in body or "position:absolute" in body
