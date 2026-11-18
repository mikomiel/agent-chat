#!/usr/bin/python3 -I
"""Validate an existing release using filesystem metadata and the system interpreter."""

import os
import re
import stat
import sys
from pathlib import Path


def check_release(root: Path, owner: int = 0) -> None:
    """Refuse unexpected links, special files and entries controlled by another user."""
    def check(entry: Path) -> None:
        info = entry.lstat()
        if info.st_uid != owner:
            raise ValueError(f"unexpected owner on {str(entry)!r}")
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(entry)
            if entry == root / "lib64" and target == "lib":
                return
            python = r"python(?:3(?:\.[0-9]+)?)?"
            if (entry.parent == root / "bin" and re.fullmatch(python, entry.name)
                    and re.fullmatch(r"(?:/usr/bin/)?" + python, target)):
                # A relative interpreter alias must terminate in a regular interpreter.
                # Only these aliases can escape the checked tree, into the system's bin.
                if entry.resolve(strict=True).is_file():
                    return
            raise ValueError(f"unexpected link at {str(entry)!r}")
        if info.st_mode & 0o022 or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError(f"unexpected mode on {str(entry)!r}")
        if stat.S_ISDIR(info.st_mode):
            for child in entry.iterdir():
                check(child)

    check(root)


if __name__ == "__main__":
    try:
        check_release(Path(sys.argv[1]))
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
