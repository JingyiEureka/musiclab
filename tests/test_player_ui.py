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


class TestSecureContextGuard:
    """Rendering an edit needs an AudioWorklet, which the spec exposes only in a
    secure context. localhost counts as secure, so this never fails on the dev
    machine -- it failed on a phone loading the LAN IP over plain http, and the
    error it produced blamed the browser instead of the origin."""

    def read_js(self, name):
        with open(os.path.join(STATIC, "js", name), "r") as f:
            return f.read()

    def test_startup_warns_when_not_secure(self):
        assert "isSecureContext" in self.read_js("main.js"), (
            "warn at load, not after the user has uploaded and split a file"
        )

    def test_render_error_names_the_origin(self):
        """A missing audioWorklet has two causes; the message must tell them
        apart, or an http origin reads as an unsupported browser."""
        stretch = self.read_js("stretch.js")
        assert "isSecureContext" in stretch
        assert "https" in stretch

    def test_render_failures_are_not_all_reported_as_skipped(self):
        """The bug that hid this: one catch reported every render failure as
        'all sections are skipped'."""
        player = self.read_js("player.js")
        assert "all-skipped" in player, (
            "the genuine empty-timeline case has to be matched explicitly"
        )


class TestLocalExport:
    """Export encodes in the browser and never uploads (step 3).

    A module test can pass while the product still takes the old path, which is
    the mistake TestSinglePlaybackPath exists to catch. These assert the wiring,
    not the encoder."""

    def read_js(self, name):
        with open(os.path.join(STATIC, "js", name), "r") as f:
            return f.read()

    def test_export_does_not_upload(self):
        export_js = self.read_js("export.js")
        for gone in ("/upload-audio/", "check-status", "pollStatus", "submitJob"):
            assert gone not in export_js, f"{gone} should be gone from the export path"

    def test_export_uses_the_playback_render(self):
        """Parity rests on export encoding the buffer getTimeline() cached for
        the transport, rather than rendering its own."""
        export_js = self.read_js("export.js")
        assert "getTimeline" in export_js
        assert "renderTimeline" not in export_js

    def test_only_mp3_module_knows_the_encoder(self):
        """The encoder is swappable if lamejs's LGPL is ever ruled out, which
        only holds while nothing else names it (ADR 0006 amendment)."""
        for name in os.listdir(os.path.join(STATIC, "js")):
            if not name.endswith(".js") or name == "mp3.js":
                continue
            with open(os.path.join(STATIC, "js", name), "r") as f:
                assert "lamejs" not in f.read(), f"{name} references lamejs directly"

    def test_vendored_encoder_ships_its_licence(self):
        vendor = os.path.join(os.path.dirname(STATIC), "static", "vendor")
        for required in ("lamejs.js", "lamejs-LICENSE.txt", "LGPL-3.0.txt"):
            assert os.path.exists(os.path.join(vendor, required)), (
                f"{required} missing; LGPL requires shipping the licence"
            )


class TestUploadZone:
    """The zone is a <div> whose click handler forwards to the hidden file
    input. It was briefly a <label for>, which needs no JS -- reverted, because
    the reason for the change turned out to be a misdiagnosis: the upload was
    dead because a stray character stopped static/js/stretch.js from parsing,
    which took every module with it, not because of anything about the markup.

    The <div> form depends on JS, so the handler is what these guard. A label is
    also inline where a div is block, and .upload-zone declares no display, so
    the tag and the stylesheet are coupled -- swapping it shrank the box from
    780px to 302px."""

    html = read_html()

    def test_zone_is_a_div(self):
        assert '<div class="upload-zone" id="upload-zone">' in self.html, (
            "the stylesheet has no `display` rule, so it relies on the element "
            "defaulting to block; a <label> here silently shrink-wraps the box"
        )

    def test_click_handler_forwards_to_the_file_input(self):
        """Without it the zone does nothing at all: the input is display:none,
        so there is no other way to reach the picker."""
        with open(os.path.join(STATIC, "js", "main.js"), "r") as f:
            main_js = f.read()
        assert "audio-file-input').click()" in main_js


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
