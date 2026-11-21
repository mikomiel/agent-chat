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
appears. ``npm pack`` runs on a copy of each directory that also holds the
repository ``LICENSE``, because npm packs only files inside the package
directory. The pack step refuses a link, device or fifo anywhere in a package
directory, a ``<dist-dir>`` that is a link, a link among the files already in
it and a ``*.tgz`` or ``SHA256SUMS`` there that is not a regular file (checked
with ``lstat`` before anything in it is read, so a fifo cannot block it). It
creates the copied ``LICENSE`` exclusively and replaces ``SHA256SUMS`` instead
of writing through it, so no write can reach a file outside the directories it
names.

The checks:

* the sdist holds every path from ``git ls-files integrations`` as a regular
  file, so a later ``include`` or ``exclude`` edit cannot drop a package
  silently;
* the wheel holds no path with an ``integrations`` segment anywhere, because a
  Node package inside the Python import tree is never a harness install
  source;
* there is exactly one ``agent-chat-<harness>-<version>.tgz`` per directory,
  and every artifact is a regular file, not a link;
* ``SHA256SUMS`` has one line per tarball in the GNU text form
  ``<64 lowercase hex digits><two spaces><tarball name>``, with LF line
  endings and a name of letters, digits and ``._+-`` only. A malformed line, a
  binary-mode ``*name`` record or a repeated name fails, and every digest must
  match its tarball;
* each tarball's gzip stream reads to the end, so a bad CRC or length trailer
  or a truncated stream is reported as unreadable;
* each tarball carries ``package.json`` at the product version, every declared
  entry point, the repository ``LICENSE`` byte for byte, every tracked file of
  its directory except ``test/``, and nothing else;
* each tarball member is a regular file or a directory (not a link, device or
  fifo), has a canonical path under ``package/`` (no ``.``, ``..`` or empty
  segment, no backslash, no leading slash, no trailing slash on a file, at most
  one on a directory) and appears once, with duplicates compared on the
  normalized path; a directory member must be an ancestor of an expected file.
  The path is read from the raw archive header, because tarfile strips the
  trailing slashes of a directory name before a check can see them.

``--integrations-only`` skips the sdist and wheel checks, for a directory that
holds only tarballs. The script reads archive member names, the ``package.json``
member and the ``LICENSE`` member of each tarball, and the raw header names. It
never extracts an archive.
Exit status 0 means every check passed.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile
from collections.abc import Iterator, Sequence
from pathlib import Path, PurePosixPath
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[1]
INTEGRATIONS = "integrations"
SUMS = "SHA256SUMS"
LICENSE = "LICENSE"
TARBALL_PREFIX = "package/"
# What reading a damaged or truncated archive, or a bad package.json inside one, raises.
UNREADABLE = (tarfile.TarError, zipfile.BadZipFile, EOFError, OSError, ValueError)
# The only member types a tarball may hold: a regular file or a directory.
REGULAR_OR_DIRECTORY = (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)
# A directory of a package that its tarball leaves out, by the release rule.
UNSHIPPED_DIRECTORY = "test/"
# One SHA256SUMS line in GNU text mode: the digest, two spaces, a plain file name. A binary-mode
# record is `<digest> *<name>`. The install guide in integrations/README.md checks every line of the
# file against this same pattern before it selects one, so change the two together.
SUMS_LINE = re.compile(r"(?P<digest>[0-9a-f]{64})  (?P<name>[A-Za-z0-9._+-]+)")
BLOCK = 512
# Member types after which tarfile reads no data block: link, symlink, device, directory, fifo.
HEADER_ONLY = (b"1", b"2", b"3", b"4", b"5", b"6")


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


def refuse_special_files(directory: Path) -> None:
    """Stop unless ``directory`` holds only regular files and directories.

    A symbolic link, device, fifo or socket anywhere in it stops the pack. ``node_modules`` is
    skipped because the copy never takes it.
    """

    def check(path: Path) -> None:
        mode = os.lstat(path).st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise SystemExit(f"{path} is not a regular file or a directory; a package directory holds only those")

    check(directory)
    for current, names, files in os.walk(directory):
        names[:] = [name for name in names if name != "node_modules"]
        for name in (*names, *files):
            check(Path(current, name))


def stage_package(directory: Path, scratch: Path, license_file: Path) -> Path:
    """Copy one package directory into ``scratch`` and add the repository ``LICENSE`` to the copy.

    Nothing is followed or preserved: a link anywhere in the directory stops the pack before the
    copy, and the ``LICENSE`` is created exclusively (``O_CREAT | O_EXCL`` never opens an existing
    path or link), so a ``LICENSE`` that the directory already holds stops it too.
    """
    refuse_special_files(directory)
    staged = scratch / directory.name
    shutil.copytree(directory, staged, ignore=shutil.ignore_patterns("node_modules"))
    try:
        with (staged / LICENSE).open("xb") as handle:
            handle.write(license_file.read_bytes())
    except FileExistsError:
        raise SystemExit(f"{directory / LICENSE} exists; a package directory holds no LICENSE of its own") from None
    return staged


def require_regular(path: Path) -> None:
    """Stop unless ``path`` is a regular file. ``lstat`` never opens it, so a fifo cannot block this."""
    if not stat.S_ISREG(os.lstat(path).st_mode):
        raise SystemExit(f"{path} is not a regular file")


def refuse_unsafe_artifacts(dist: Path) -> None:
    """Stop unless ``dist`` holds no link and every ``*.tgz`` and ``SHA256SUMS`` is a regular file."""
    for child in dist.iterdir():
        if child.is_symlink():
            raise SystemExit(f"{child} is a link; npm pack and the sums file would write through it")
        if child.name.endswith(".tgz") or child.name == SUMS:
            require_regular(child)


def write_sums(dist: Path) -> None:
    """Write ``SHA256SUMS`` over the tarballs by replacing it, never by writing through a link."""
    tarballs = sorted(dist.glob("*.tgz"))
    for path in tarballs:
        require_regular(path)  # before any of them is opened and hashed
    lines = [f"{sha256(path)}  {path.name}\n" for path in tarballs]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=dist, prefix=f"{SUMS}.", delete=False) as handle:
        handle.write("".join(lines))
    os.chmod(handle.name, 0o644)
    os.replace(handle.name, dist / SUMS)


def pack(root: Path, dist: Path) -> None:
    """Run ``npm pack`` on every package directory, then write ``SHA256SUMS`` over the tarballs.

    npm packs only files inside the package directory, and the one ``LICENSE`` lives at the
    repository root. Each directory is therefore packed from a scratch copy that also holds that
    file, so the source tree is never written and a failed pack leaves nothing behind.
    """
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm is not on PATH; it is needed to pack the integrations")
    license_file = root / LICENSE
    if not license_file.is_file():
        raise SystemExit(f"{license_file} is missing; every tarball ships it")
    # The output directory itself may not be a link either: checked before it is created or listed.
    if dist.is_symlink():
        raise SystemExit(f"{dist} is a link; npm pack and the sums file would write through it")
    dist.mkdir(parents=True, exist_ok=True)
    refuse_unsafe_artifacts(dist)
    with tempfile.TemporaryDirectory(prefix="agent-chat-pack-") as scratch:
        for directory in package_directories(root):
            staged = stage_package(directory, Path(scratch), license_file)
            subprocess.run(
                [npm, "pack", str(staged), "--pack-destination", str(dist), "--silent"],
                check=True,
                timeout=120,
            )
    write_sums(dist)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path) -> bool:
    """A regular file and not a link: a link in the artifact directory can point anywhere."""
    return path.is_file() and not path.is_symlink()


def only_one(dist: Path, pattern: str, errors: list[str]) -> Path | None:
    found = sorted(dist.glob(pattern))
    if len(found) != 1:
        errors.append(f"{dist}: expected exactly one {pattern}, found {[path.name for path in found]}")
        return None
    if not regular_file(found[0]):
        errors.append(f"{dist}: {found[0].name} is not a regular file")
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
            # The first component is the sdist's own top directory, `<name>-<version>/`. Only a
            # regular file counts: a directory or a link named like a tracked file holds nothing.
            names = {
                member.name.split("/", 1)[1]
                for member in archive.getmembers()
                if member.isfile() and "/" in member.name
            }
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
    # Any segment, with a backslash read as a separator: `agent_chat/integrations/pi/package.json`
    # is as wrong as a top-level path.
    errors.extend(
        f"{wheel.name}: holds {name}" for name in names if INTEGRATIONS in name.replace("\\", "/").split("/")
    )
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

    pi = package.get("pi")
    declared = [
        package.get("main"),
        package.get("exports"),
        package.get("bin"),
        pi.get("extensions") if isinstance(pi, dict) else None,
    ]
    for value in declared:
        for text in strings(value):
            yield str(PurePosixPath(text))


class Contents(NamedTuple):
    """What one tarball holds, relative to ``package/``."""

    files: set[str]
    directories: set[str]
    package: dict
    license: bytes | None


def is_canonical(name: str) -> bool:
    """A member path with no ``.``, ``..`` or empty segment (so no leading or trailing slash) and no backslash."""
    return "\\" not in name and all(segment not in ("", ".", "..") for segment in name.split("/"))


def read_exactly(stream: gzip.GzipFile, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise ValueError("the archive ends inside a member")
    return data


def skip(stream: gzip.GzipFile, size: int) -> None:
    while size > 0:
        chunk = stream.read(min(size, 1 << 20))
        if not chunk:
            raise ValueError("the archive ends inside a member")
        size -= len(chunk)


def header_text(field: bytes) -> str:
    return field.split(b"\0", 1)[0].decode("utf-8", "surrogateescape")


def header_size(block: bytes) -> int:
    field = block[124:136]
    if field[0] == 0o200:
        return int.from_bytes(field[1:], "big")
    return int(field.split(b"\0", 1)[0].strip() or b"0", 8)


def pax_path(data: bytes) -> str | None:
    """The ``path`` record of a pax extended header, as the header spells it."""
    found = None
    position = 0
    while position < len(data):
        space = data.index(b" ", position)
        length = int(data[position:space])
        if length <= space - position + 1:
            raise ValueError("a pax record has an impossible length")
        key, _, value = data[space + 1 : position + length].removesuffix(b"\n").partition(b"=")
        if key == b"path":
            found = value.decode("utf-8", "surrogateescape")
        position += length
    return found


def read_to_the_end(path: Path) -> None:
    """Read the whole gzip stream: a bad CRC or length trailer, or a truncated stream, raises."""
    with gzip.open(path, "rb") as stream:
        while stream.read(1 << 20):
            pass


def header_names(path: Path) -> list[str]:
    """Every member name, spelled as its archive header spells it.

    tarfile strips the trailing slashes of a directory name before it returns the member, so a
    check on ``member.name`` cannot see ``package/lib//``. This reads the header blocks itself:
    the ustar name and prefix, a GNU long name or a pax ``path`` record. The caller compares the
    result with tarfile's members and stops on any disagreement, so a misread cannot pass.
    """
    names: list[str] = []
    override: str | None = None
    with gzip.open(path, "rb") as stream:
        while block := stream.read(BLOCK):
            if len(block) < BLOCK:
                raise ValueError("the archive ends inside a header")
            if block == bytes(BLOCK):
                break
            kind, size = block[156:157], header_size(block)
            if kind in (b"x", b"g", b"L", b"K"):
                data = read_exactly(stream, size)
                skip(stream, -size % BLOCK)
                if kind == b"x":
                    override = pax_path(data) or override
                elif kind == b"L":
                    override = header_text(data)
                elif kind == b"g" and pax_path(data) is not None:
                    raise ValueError("a global pax header that sets a path is not supported")
                continue
            prefix, name = header_text(block[345:500]), header_text(block[0:100])
            names.append(override if override is not None else f"{prefix}/{name}" if prefix else name)
            override = None
            if kind not in HEADER_ONLY:
                skip(stream, size + -size % BLOCK)
    return names


def read_tarball(path: Path, errors: list[str]) -> Contents:
    """The members under ``package/``, the parsed ``package.json`` and the ``LICENSE`` bytes of one tarball."""
    files: set[str] = set()
    directories: set[str] = set()
    seen: set[str] = set()
    wanted: dict[str, tarfile.TarInfo] = {}
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        raw_names = header_names(path)
        # Both walks stop at the end-of-archive blocks, before the gzip trailer.
        read_to_the_end(path)
        if len(raw_names) != len(members):
            raise ValueError(f"the headers hold {len(raw_names)} members and tarfile reads {len(members)}")
        for member, raw in zip(members, raw_names, strict=True):
            if raw.rstrip("/") != member.name.rstrip("/"):
                raise ValueError(f"member {member.name!r} has the header name {raw!r}")
            # A directory header may end in one slash, as GNU tar writes it. Nothing else may.
            spelled = raw.removesuffix("/") if member.isdir() else raw
            # Two spellings of one path (`package/lib`, `package/./lib`) are one member twice.
            normalized = posixpath.normpath(spelled)
            if normalized in seen:
                errors.append(f"{path.name}: duplicate member {spelled} (path {normalized})")
            seen.add(normalized)
            # A link, device or fifo never belongs in a package that a user extracts.
            if member.type not in REGULAR_OR_DIRECTORY:
                errors.append(f"{path.name}: member {member.name} is not a regular file or directory")
            elif not is_canonical(spelled):
                errors.append(f"{path.name}: member {raw!r} has a non-canonical path")
            elif member.isdir() and spelled == TARBALL_PREFIX.rstrip("/"):
                continue
            elif not spelled.startswith(TARBALL_PREFIX):
                errors.append(f"{path.name}: member {spelled} is outside {TARBALL_PREFIX}")
            else:
                relative = spelled[len(TARBALL_PREFIX) :]
                (directories if member.isdir() else files).add(relative)
                if member.isfile():
                    wanted.setdefault(relative, member)

        def read(name: str) -> bytes | None:
            handle = archive.extractfile(wanted[name]) if name in wanted else None
            return handle.read() if handle is not None else None

        manifest, license_text = read("package.json"), read(LICENSE)
    if manifest is None:
        errors.append(f"{path.name}: no package.json at the package root")
        return Contents(files, directories, {}, license_text)
    package = json.loads(manifest.decode("utf-8"))
    if not isinstance(package, dict):
        raise ValueError("package.json is not a JSON object")
    return Contents(files, directories, package, license_text)


def check_tarball(path: Path, harness: str, version: str, tracked: Sequence[str], license_text: bytes) -> list[str]:
    errors: list[str] = []
    try:
        files, directories, package, shipped_license = read_tarball(path, errors)
    except UNREADABLE as error:
        return [f"{path.name}: cannot read the archive: {error}"]
    if package.get("name") != f"agent-chat-{harness}":
        errors.append(f"{path.name}: package name is {package.get('name')!r}, not agent-chat-{harness}")
    if package.get("version") != version:
        errors.append(f"{path.name}: package version is {package.get('version')!r}, not {version}")
    prefix = f"{INTEGRATIONS}/{harness}/"
    # The tracked files, minus the tests, plus the repository LICENSE that the pack step adds.
    expected = {
        name[len(prefix) :]
        for name in tracked
        if name.startswith(prefix) and not name[len(prefix) :].startswith(UNSHIPPED_DIRECTORY)
    }
    if not expected:
        errors.append(f"{path.name}: git tracks no file under {prefix}")
    expected.add(LICENSE)
    errors.extend(f"{path.name}: missing {name}" for name in sorted(expected - files))
    errors.extend(f"{path.name}: unexpected {name}" for name in sorted(files - expected))
    # A directory member is only the parent of a file that belongs here; one named like a file does not count.
    parents = {str(parent) for name in expected for parent in PurePosixPath(name).parents} - {"."}
    errors.extend(f"{path.name}: unexpected directory {name}" for name in sorted(directories - parents))
    if shipped_license is not None and shipped_license != license_text:
        errors.append(f"{path.name}: {LICENSE} differs from the repository {LICENSE}")
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
    found: dict[str, Path] = {}
    for path in sorted(dist.glob("*.tgz")):
        if regular_file(path):
            found[path.name] = path
        else:
            errors.append(f"{dist}: {path.name} is not a regular file")
    errors.extend(f"{dist}: no tarball {name}" for name in sorted(expected.keys() - found.keys()))
    errors.extend(f"{dist}: unexpected tarball {name}" for name in sorted(found.keys() - expected.keys()))
    license_file = root / LICENSE
    if not license_file.is_file():
        errors.append(f"{license_file} is missing, so the tarball {LICENSE} check would prove nothing")
    else:
        license_text = license_file.read_bytes()
        for name in sorted(expected.keys() & found.keys()):
            errors.extend(check_tarball(found[name], expected[name], version, tracked, license_text))
    errors.extend(check_sums(dist, found))
    return errors


def check_sums(dist: Path, found: dict[str, Path]) -> list[str]:
    """``SHA256SUMS`` in GNU text mode, one line per tarball, each digest right."""
    sums = dist / SUMS
    if not sums.is_file():
        return [f"{dist}: no {SUMS}"]
    if sums.is_symlink():
        return [f"{dist}: {SUMS} is a link, not a regular file"]
    try:
        # Bytes, not read_text: universal newlines would turn a CRLF file into a clean one.
        text = sums.read_bytes().decode("utf-8")
    except UNREADABLE as error:
        return [f"{SUMS}: cannot read the file: {error}"]
    errors: list[str] = []
    listed: dict[str, str] = {}
    # Split on newlines only: a carriage return stays in the line and fails the match.
    for number, line in enumerate(text.removesuffix("\n").split("\n"), start=1):
        match = SUMS_LINE.fullmatch(line)
        if match is None:
            errors.append(f"{SUMS}: line {number} is not '<64 lowercase hex digits>  <file name>': {line!r}")
        elif match["name"] in listed:
            errors.append(f"{SUMS}: line {number} repeats {match['name']}")
        else:
            listed[match["name"]] = match["digest"]
    errors.extend(f"{SUMS}: no line for {name}" for name in sorted(found.keys() - listed.keys()))
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
