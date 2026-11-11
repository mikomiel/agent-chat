"""The client surfaces install and import without the PostgreSQL driver.

A client-only install must not need psycopg: the CLI talks HTTP, and the
adapter lifecycle client writes a local binding file. The server modules are
the opposite boundary, so the negative control proves the probe can fail.
"""

from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BLOCK_PSYCOPG = "import sys; sys.modules['psycopg'] = None; "


def _import_without_psycopg(tmp_path: Path, modules: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", BLOCK_PSYCOPG + f"import {modules}"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_client_modules_import_with_psycopg_blocked(tmp_path: Path) -> None:
    modules = ", ".join(
        f"agent_chat.{name}" for name in ("cli", "client", "instance_client", "instance_file", "protocol")
    )
    result = _import_without_psycopg(tmp_path, modules)
    assert result.returncode == 0, result.stderr


def test_blocking_psycopg_is_observable_on_server_modules(tmp_path: Path) -> None:
    # Negative control: the client probe can only be meaningful if the block
    # really stops a module that imports the driver.
    result = _import_without_psycopg(tmp_path, "agent_chat.api")
    assert result.returncode != 0
    assert "psycopg" in result.stderr


def test_base_install_does_not_carry_psycopg() -> None:
    manifest = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = manifest["project"]
    assert not [
        dependency for dependency in project["dependencies"] if dependency.lower().startswith("psycopg")
    ]
    server = project["optional-dependencies"]["server"]
    assert [dependency for dependency in server if dependency.startswith("psycopg[binary]==")]


def test_browser_extra_is_isolated_from_the_service_install() -> None:
    manifest = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = manifest["project"]
    base = [dependency.lower() for dependency in project["dependencies"]]
    assert not [dependency for dependency in base if dependency.startswith(("playwright", "psycopg"))]
    browser = project["optional-dependencies"]["browser"]
    assert any(dependency.startswith("playwright==") for dependency in browser)
    server = project["optional-dependencies"]["server"]
    assert not any(dependency.lower().startswith("playwright") for dependency in server)
    dev = [item for item in manifest["dependency-groups"]["dev"] if isinstance(item, str)]
    assert any(item.startswith("playwright==") for item in dev)
