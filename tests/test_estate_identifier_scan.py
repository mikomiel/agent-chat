"""The public-content scan catches lowercase and history-only values.

The scanner's file mode inspects the current tree. A value introduced in one
commit and replaced in a later one is clean there, so CI also scans the patch
stream; these tests pin both behaviors. The private-looking values are built
from pieces so this test file does not itself contain one.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_estate_identifiers.py"


def _scan_stdin(text: str) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "ESTATE_IDENTIFIERS": str(ROOT / ".absent-estate-identifiers")}
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--stdin"],
        input=text,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        cwd=ROOT,
        env=environment,
    )


def test_a_lowercase_container_number_is_flagged() -> None:
    value = "ct" + "130"
    result = _scan_stdin(f"+host = '{value}'\n")
    assert result.returncode == 1
    assert "container-number" in result.stdout


def test_a_replaced_value_is_visible_in_the_patch_stream() -> None:
    value = "CT" + "1300"
    patch = f"-host = '{value}'\n+host = 'node-a'\n"
    result = _scan_stdin(patch)
    assert result.returncode == 1
    assert "container-number" in result.stdout


def test_clean_text_passes() -> None:
    result = _scan_stdin("+host = 'node-a'\n")
    assert result.returncode == 0
    assert "no estate identifiers found" in result.stdout
