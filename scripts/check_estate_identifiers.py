#!/usr/bin/env python3
"""Reject private estate identifiers before they reach a public repository.

A public project that grew inside a private estate leaks by accident: a host
name in a fixture, a home directory in a docstring, a container number in a
comment. This check fails on the *classes* of identifier such a leak produces,
so the rules themselves carry no private names.

Estate-specific names (client names, internal domains that look public, host
aliases) must not be committed here either. Put them, one regular expression
per line, in `.estate-identifiers` at the repository root, or name that file
with `ESTATE_IDENTIFIERS`. The file is git-ignored on purpose.

Matching text is never printed: the report names the file, the line and the
rule, so a CI log cannot become the leak it is trying to prevent.

Exit status: 0 clean, 1 findings, 2 usage or environment failure.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".mypy_cache"}
SKIP_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
    ".whl", ".so", ".woff", ".woff2", ".ttf", ".pyc",
}

RULES: list[tuple[str, re.Pattern[str]]] = [
    ("private-ipv4", re.compile(r"\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b")),
    ("estate-absolute-path", re.compile(r"/(?:opt|srv|home)/[A-Za-z0-9._-]+/")),
    ("container-number", re.compile(r"\bCT\d{2,4}\b")),
    ("internal-hostname", re.compile(r"\b[a-z0-9][a-z0-9-]*\.(?:internal|intranet|lan)\b")),
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
]


def extra_rules() -> list[tuple[str, re.Pattern[str]]]:
    name = os.environ.get("ESTATE_IDENTIFIERS", ".estate-identifiers")
    path = Path(name)
    if not path.is_file():
        return []
    rules: list[tuple[str, re.Pattern[str]]] = []
    for index, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            rules.append((f"private-rule-{index}", re.compile(line)))
        except re.error as exc:
            print(f"{path}: {index}: unusable regular expression: {exc}", file=sys.stderr)
            raise SystemExit(2) from exc
    return rules


def tracked_files() -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"],
            capture_output=True,
            check=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return [
            p
            for p in Path(".").rglob("*")
            if p.is_file() and not (set(p.parts) & SKIP_DIRS)
        ]
    files = [Path(p) for p in out.split("\0") if p]
    if files:
        return files
    return [
        p
        for p in Path(".").rglob("*")
        if p.is_file() and not (set(p.parts) & SKIP_DIRS)
    ]


def main() -> int:
    rules = RULES + extra_rules()
    findings = 0
    for path in tracked_files():
        if path.suffix.lower() in SKIP_SUFFIXES or set(path.parts) & SKIP_DIRS:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for name, pattern in rules:
                if pattern.search(line):
                    print(f"{path}:{number}: {name}")
                    findings += 1
    if findings:
        print(f"{findings} finding(s); this content must not be public", file=sys.stderr)
        return 1
    print("no estate identifiers found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
