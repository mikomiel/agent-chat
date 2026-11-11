"""Where the Agent Chat suite finds PostgreSQL server binaries on a Debian host.

Debian's `postgresql-<N>` package keeps `initdb` and `postgres` in
`/usr/lib/postgresql/<N>/bin`, which is not on PATH. `postgres_cluster` falls
back to it after PG_TEST_BIN_DIR and PATH. The suite's pre-run probe applies the
same rule, so the probe and the fixture agree.

`PG_TEST_DISTRO_ROOT` replaces the root so a test can use a synthetic tree. It
selects only where to look, as PG_TEST_BIN_DIR does.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

DISTRO_ROOT_ENV = "PG_TEST_DISTRO_ROOT"
DEFAULT_DISTRO_ROOT = "/usr/lib/postgresql"
REQUIRED_BINARIES = ("initdb", "postgres")


def distro_bin_dir(root: str | Path | None = None) -> Path | None:
    """The `<root>/<N>/bin` with the highest numeric N holding both binaries, else None."""
    base = Path(root if root is not None else os.environ.get(DISTRO_ROOT_ENV) or DEFAULT_DISTRO_ROOT)
    try:
        entries = list(base.iterdir())
    except OSError:
        return None
    best: tuple[int, Path] | None = None
    for entry in entries:
        if not re.fullmatch(r"[0-9]+", entry.name):
            continue
        bin_dir = entry / "bin"
        if not all(os.access(bin_dir / name, os.X_OK) and (bin_dir / name).is_file() for name in REQUIRED_BINARIES):
            continue
        if best is None or int(entry.name) > best[0]:
            best = (int(entry.name), bin_dir)
    return None if best is None else best[1]
