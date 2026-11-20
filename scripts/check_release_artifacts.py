#!/usr/bin/env python3
"""Pack and verify the release artifacts: the Python distribution and one tarball per integration.

    check_release_artifacts.py [--pack] [--integrations-only] <dist-dir>

``<dist-dir>`` holds what a release ships. ``uv build`` puts the sdist and the
wheel there. ``--pack`` first runs ``npm pack`` on every ``integrations/*/``
directory into it and writes ``SHA256SUMS`` over the tarballs. The release
workflow runs this one command before it attaches anything, so the check proves
the packing that the release performs. Run it over a ``uv build`` output
directory to check the sdist and the wheel as well. Directories are enumerated,
never listed: a new harness package is packed, and checked, when its directory
appears.

The checks:

* the sdist holds every path from ``git ls-files integrations``, so a later
  ``include`` or ``exclude`` edit cannot drop a package silently;
* the wheel holds no ``integrations/`` path, because a Node package inside the
  Python import tree is never a harness install source;
* there is exactly one ``agent-chat-<harness>-<version>.tgz`` per directory
  and ``SHA256SUMS`` matches those tarballs;
* each tarball carries ``package.json`` at the product version, every declared
  entry point, every tracked file of its directory except ``test/``, and
  nothing else.

``--integrations-only`` skips the sdist and wheel checks, for a directory that
holds only tarballs. The script reads archive member names and one JSON member.
It never extracts an archive. Exit status 0 means every check passed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from collections.abc import Iterator, Sequence
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
INTEGRATIONS = "integrations"
SUMS = "SHA256SUMS"
TARBALL_PREFIX = "package/"
# What reading a damaged or truncated archive, or a bad package.json inside one, raises.
UNREADABLE = (tarfile.TarError, zipfile.BadZipFile, EOFError, OSError, ValueError)
# A directory of a package that its tarball leaves out, by the release rule.
UNSHIPPED_DIRECTORY = "test/"


def project_version(root: Path) -> str:
    return tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def package_directories(root: Path) -> list[Path]:
    """Every ``integrations/<harness>/`` directory, found by listing, never from a fixed list."""
    base = root / INTEGRATIONS
    return sorted(path for path in base.iterdir() if path.is_dir())


def tracked_integration_files(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", INTEGRATIONS],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return sorted(path for path in result.stdout.split("\0") if path)


def tarball_name(harness: str, version: str) -> str:
    return f"agent-chat-{harness}-{version}.tgz"


def pack(root: Path, dist: Path) -> None:
    """Run ``npm pack`` on every package directory, then write ``SHA256SUMS`` over the tarballs."""
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm is not on PATH; it is needed to pack the integrations")
    dist.mkdir(parents=True, exist_ok=True)
    for directory in package_directories(root):
        subprocess.run(
            [npm, "pack", str(directory), "--pack-destination", str(dist), "--silent"],
            check=True,
            timeout=120,
        )
    lines = [f"{sha256(path)}  {path.name}\n" for path in sorted(dist.glob("*.tgz"))]
    (dist / SUMS).write_text("".join(lines), encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def only_one(dist: Path, pattern: str, errors: list[str]) -> Path | None:
    found = sorted(dist.glob(pattern))
    if len(found) != 1:
        errors.append(f"{dist}: expected exactly one {pattern}, found {[path.name for path in found]}")
        return None
    return found[0]


def check_sdist(dist: Path, tracked: Sequence[str]) -> list[str]:
    errors: list[str] = []
    if not tracked:
        return [f"git ls-files {INTEGRATIONS} lists nothing, so the sdist check would prove nothing"]
    sdist = only_one(dist, "*.tar.gz", errors)
    if sdist is None:
        return errors
    try:
        with tarfile.open(sdist, "r:gz") as archive:
            # The first component is the sdist's own top directory, `<name>-<version>/`.
            names = {name.split("/", 1)[1] for name in archive.getnames() if "/" in name}
    except UNREADABLE as error:
        return [f"{sdist.name}: cannot read the archive: {error}"]
    errors.extend(f"{sdist.name}: missing tracked file {path}" for path in tracked if path not in names)
    return errors


def check_wheel(dist: Path) -> list[str]:
    errors: list[str] = []
    wheel = only_one(dist, "*.whl", errors)
    if wheel is None:
        return errors
    try:
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
    except UNREADABLE as error:
        return [f"{wheel.name}: cannot read the archive: {error}"]
    if not any(name.startswith("agent_chat/") for name in names):
        errors.append(f"{wheel.name}: holds no agent_chat/ path, so the integrations check would prove nothing")
    errors.extend(f"{wheel.name}: holds {name}" for name in names if name.startswith(f"{INTEGRATIONS}/"))
    return errors


def entry_points(package: dict) -> Iterator[str]:
    """The paths that a package.json names as loadable, relative to the package root."""

    def strings(value: object) -> Iterator[str]:
        if isinstance(value, str):
            yield value
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)
        elif isinstance(value, dict):
            for item in value.values():
                yield from strings(item)

    declared = [
        package.get("main"),
        package.get("exports"),
        package.get("bin"),
        (package.get("pi") or {}).get("extensions"),
    ]
    for value in declared:
        for text in strings(value):
            yield str(PurePosixPath(text))


def read_tarball(path: Path, errors: list[str]) -> tuple[set[str], dict]:
    """The file names under ``package/`` and the parsed ``package.json`` of one tarball."""
    files: set[str] = set()
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            if not member.name.startswith(TARBALL_PREFIX):
                errors.append(f"{path.name}: member {member.name} is outside {TARBALL_PREFIX}")
            elif member.isfile():
                files.add(member.name[len(TARBALL_PREFIX) :])
        handle = archive.extractfile(f"{TARBALL_PREFIX}package.json") if "package.json" in files else None
        if handle is None:
            errors.append(f"{path.name}: no package.json at the package root")
            return files, {}
        return files, json.loads(handle.read().decode("utf-8"))


def check_tarball(path: Path, harness: str, version: str, tracked: Sequence[str]) -> list[str]:
    errors: list[str] = []
    try:
        files, package = read_tarball(path, errors)
    except UNREADABLE as error:
        return [f"{path.name}: cannot read the archive: {error}"]
    if package.get("name") != f"agent-chat-{harness}":
        errors.append(f"{path.name}: package name is {package.get('name')!r}, not agent-chat-{harness}")
    if package.get("version") != version:
        errors.append(f"{path.name}: package version is {package.get('version')!r}, not {version}")
    prefix = f"{INTEGRATIONS}/{harness}/"
    expected = {
        name[len(prefix) :]
        for name in tracked
        if name.startswith(prefix) and not name[len(prefix) :].startswith(UNSHIPPED_DIRECTORY)
    }
    if not expected:
        errors.append(f"{path.name}: git tracks no file under {prefix}")
    errors.extend(f"{path.name}: missing {name}" for name in sorted(expected - files))
    errors.extend(f"{path.name}: unexpected {name}" for name in sorted(files - expected))
    for entry in sorted(set(entry_points(package))):
        if entry not in files and not any(name.startswith(f"{entry}/") for name in files):
            errors.append(f"{path.name}: declared entry point {entry} is not in the tarball")
    return errors


def check_tarballs(root: Path, dist: Path, version: str, tracked: Sequence[str]) -> list[str]:
    errors: list[str] = []
    harnesses: list[str] = []
    for directory in package_directories(root):
        if not (directory / "package.json").is_file():
            errors.append(f"{INTEGRATIONS}/{directory.name}: no package.json; every directory is a package")
        else:
            harnesses.append(directory.name)
    expected = {tarball_name(harness, version): harness for harness in harnesses}
    found = {path.name: path for path in dist.glob("*.tgz")}
    errors.extend(f"{dist}: no tarball {name}" for name in sorted(expected.keys() - found.keys()))
    errors.extend(f"{dist}: unexpected tarball {name}" for name in sorted(found.keys() - expected.keys()))
    for name in sorted(expected.keys() & found.keys()):
        errors.extend(check_tarball(found[name], expected[name], version, tracked))
    errors.extend(check_sums(dist, found))
    return errors


def check_sums(dist: Path, found: dict[str, Path]) -> list[str]:
    sums = dist / SUMS
    if not sums.is_file():
        return [f"{dist}: no {SUMS}"]
    listed: dict[str, str] = {}
    for line in sums.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.partition("  ")
        listed[name] = digest
    errors = [f"{SUMS}: no line for {name}" for name in sorted(found.keys() - listed.keys())]
    errors.extend(
        f"{SUMS}: line for {name}, which is not a tarball here" for name in sorted(listed.keys() - found.keys())
    )
    errors.extend(
        f"{SUMS}: wrong digest for {name}"
        for name in sorted(listed.keys() & found.keys())
        if listed[name] != sha256(found[name])
    )
    return errors


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("dist_dir", type=Path, help="directory that holds the release artifacts")
    parser.add_argument(
        "--pack", action="store_true", help="run npm pack on every integrations/*/ into dist_dir first"
    )
    parser.add_argument(
        "--integrations-only",
        action="store_true",
        help="dist_dir holds only the tarballs: skip the sdist and wheel checks",
    )
    args = parser.parse_args(argv)
    dist: Path = args.dist_dir
    if args.pack:
        pack(ROOT, dist)
    if not dist.is_dir():
        print(f"{dist} is not a directory", file=sys.stderr)
        return 1
    version = project_version(ROOT)
    tracked = tracked_integration_files(ROOT)
    errors: list[str] = []
    if not args.integrations_only:
        errors.extend(check_sdist(dist, tracked))
        errors.extend(check_wheel(dist))
    errors.extend(check_tarballs(ROOT, dist, version, tracked))
    for error in errors:
        print(f"FAIL {error}", file=sys.stderr)
    if errors:
        return 1
    count = len(list(dist.glob("*.tgz")))
    print(
        f"OK {count} integration tarballs at {version}"
        + ("" if args.integrations_only else ", the sdist and the wheel")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
