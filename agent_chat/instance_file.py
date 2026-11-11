"""Persist one process's secret and destination; readers never rotate or discover it."""

import json
import os
import secrets
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from .models import ChatError, Registration
from .protocol import token_digest, validate_origin

# Housekeeping bounds: a record untouched this long (far beyond the 90 s lease; a live worker touches it at
# every heartbeat) is an orphan, and a sweep looks at no more than this many directory names.
SWEEP_STALE_SECONDS = 3600
SWEEP_NAMES = 200


@dataclass(frozen=True)
class InstanceSecret:
    native_session_id: str
    boot_id: UUID
    token: str = field(repr=False)
    server_origin: str


def _directory(directory: Path) -> int:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ChatError("BINDING_FILE_UNSAFE")
    return fd


def _read(directory_fd: int, name: str, *, sync: bool = False) -> InstanceSecret:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise ChatError("BINDING_FILE_UNSAFE")
        content = stream.read(4097)
        if sync:
            os.fsync(stream.fileno())
    try:
        data = json.loads(content)
        if (
            len(content) > 4096
            or not isinstance(data, dict)
            or set(data) != {"native_session_id", "boot_id", "token", "server_origin"}
            or not all(isinstance(value, str) for value in data.values())
        ):
            raise ValueError("invalid binding record")
        registration = Registration(
            native_session_id=data["native_session_id"],
            boot_id=data["boot_id"],
            instance_token_hash=token_digest(data["token"]),
        )
        if name != f"{registration.boot_id}.json":
            raise ChatError("BINDING_FILE_CONFLICT")
        validate_origin(data["server_origin"])
        return InstanceSecret(
            registration.native_session_id, registration.boot_id, data["token"], data["server_origin"]
        )
    except (ValueError, UnicodeError):
        raise ChatError("BINDING_FILE_INVALID") from None


def read_instance(path: Path) -> InstanceSecret:
    """An explicit adapter-selected file, never a scan for the newest process."""
    try:
        if path.name != f"{UUID(path.stem)}.json":
            raise ValueError("invalid filename")
    except ValueError:
        raise ChatError("BINDING_FILE_INVALID") from None
    fd = _directory(path.parent)
    try:
        return _read(fd, path.name)
    finally:
        os.close(fd)


def prepare_instance(directory: Path, native_session_id: str, boot_id: UUID, *, server_origin: str) -> InstanceSecret:
    """Adapter supplies a fresh boot UUID and destination before registration.

    A retry must match native identity, boot and destination. Partial/older-format
    files fail closed and are not overwritten. The CLI is only a reader.
    """
    validate_origin(server_origin)
    token = secrets.token_hex(32)
    registration = Registration(
        native_session_id=native_session_id, boot_id=boot_id, instance_token_hash=token_digest(token)
    )
    name = f"{registration.boot_id}.json"
    directory_fd = _directory(directory)
    try:
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        except FileExistsError as exc:
            record = _read(directory_fd, name, sync=True)
            if record.native_session_id != native_session_id or record.server_origin != server_origin:
                raise ChatError("BINDING_FILE_CONFLICT") from exc
            os.fsync(directory_fd)
            return record
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(
                {
                    "native_session_id": native_session_id,
                    "boot_id": str(registration.boot_id),
                    "token": token,
                    "server_origin": server_origin,
                },
                stream,
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(directory_fd)
        return InstanceSecret(native_session_id, registration.boot_id, token, server_origin)
    finally:
        os.close(directory_fd)


def discard_instance(directory: Path, boot_id: UUID) -> None:
    """Best effort: drop one record whose instance is over. A failure leaves the file; never raises."""
    try:
        directory_fd = _directory(directory)
    except (OSError, ChatError):
        return
    try:
        os.unlink(f"{boot_id}.json", dir_fd=directory_fd)
    except OSError:
        pass
    finally:
        os.close(directory_fd)


def touch_instance(directory: Path, boot_id: UUID) -> None:
    """Best effort: mark this process's record as live. Its mtime is the only liveness a sweep reads."""
    try:
        directory_fd = _directory(directory)
    except (OSError, ChatError):
        return
    try:
        os.utime(f"{boot_id}.json", dir_fd=directory_fd, follow_symlinks=False)
    except OSError:
        pass
    finally:
        os.close(directory_fd)


def sweep_stale(directory: Path, own: UUID) -> int:
    """Unlink sibling `<uuid>.json` regular files not touched for SWEEP_STALE_SECONDS; return the count.

    Local only: it reads names and mtimes, never a record's content or token. A live session touches its
    file at every heartbeat, and one silent for an hour has a lapsed lease and rejoins with a new file.
    At most SWEEP_NAMES names are examined; every OSError leaves the file, and a failed listing or close
    ends the sweep with the count so far.
    """
    try:
        directory_fd = _directory(directory)
    except (OSError, ChatError):
        return 0
    removed = 0
    try:
        cutoff = time.time() - SWEEP_STALE_SECONDS
        for name in os.listdir(directory_fd)[:SWEEP_NAMES]:
            try:
                if name == f"{own}.json" or name != f"{UUID(name.removesuffix('.json'))}.json":
                    continue
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
                    os.unlink(name, dir_fd=directory_fd)
                    removed += 1
            except (ValueError, OSError):
                continue
    except OSError:
        pass  # the listing failed: housekeeping stays best effort and returns the count so far
    finally:
        try:
            os.close(directory_fd)
        except OSError:
            pass
    return removed
