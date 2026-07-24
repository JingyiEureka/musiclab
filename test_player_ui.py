"""Verify player time labels exist and are positioned correctly."""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def read_html():
    with open(os.path.join(HERE, "index.html"), "r") as f:
        return f.read()


def read_css():
    with open(os.path.join(HERE, "static", "styles.css"), "r") as f:
        return f.read()


def extract_css_rules(css, selector):
    """Extract all CSS blocks matching `selector`. Returns list of rule bodies."""
    pattern = re.compile(
        r"" + re.escape(selector) + r"\s*\{([^}]+)\}",
        re.DOTALL,
    )
    return [m.group(1) for m in pattern.finditer(css)]


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
