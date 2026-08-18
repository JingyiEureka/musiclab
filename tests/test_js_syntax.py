"""Parse every frontend module, so a JS syntax error cannot be committed.

This exists because one was. A stray U+00B7 landed at the start of a line in
static/js/stretch.js and shipped in 476abb6, under a commit message that said
"No code change". Nothing caught it: ruff and pytest only read Python, and the
browser suite that would have failed is not part of the pre-commit command.

A broken module is not a small bug. ES modules fail as a graph, so one bad file
means main.js never runs and the whole page is inert -- the upload button, the
transport, everything -- with no visible error.
"""

import os
import shutil
import subprocess
import tempfile

import pytest

STATIC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
)
JS_DIR = os.path.join(STATIC, "js")

node = shutil.which("node")
pytestmark = pytest.mark.skipif(node is None, reason="node is not installed")


def js_modules():
    return sorted(f for f in os.listdir(JS_DIR) if f.endswith(".js"))


@pytest.mark.parametrize("name", js_modules())
def test_module_parses(name):
    """`node --check` treats .js as CommonJS and rejects `import`, so the file
    is copied to a .mjs name to be parsed as a module."""
    src = os.path.join(JS_DIR, name)
    with tempfile.TemporaryDirectory() as tmp:
        dst = os.path.join(tmp, name[:-3] + ".mjs")
        shutil.copyfile(src, dst)
        result = subprocess.run(
            [node, "--check", dst], capture_output=True, text=True, timeout=30
        )
    assert result.returncode == 0, f"{name} does not parse:\n{result.stderr}"


INVISIBLE = {
    "\u00a0": "no-break space",
    "\u200b": "zero-width space",
    "\u200c": "zero-width non-joiner",
    "\u200d": "zero-width joiner",
    "\ufeff": "byte-order mark",
    "\u2028": "line separator",
    "\u2029": "paragraph separator",
}


@pytest.mark.parametrize("name", js_modules())
def test_no_invisible_characters(name):
    """Characters never typed on purpose and invisible in an editor. Unlike a
    blanket non-ASCII ban this has no false positives: the ASCII art in
    report.js and the note glyph in ui.js are deliberate and visible."""
    with open(os.path.join(JS_DIR, name), encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            found = [(c, INVISIBLE[c]) for c in line if c in INVISIBLE]
            assert not found, (
                f"{name}:{lineno} contains a {found[0][1]} (U+{ord(found[0][0]):04X})"
            )
