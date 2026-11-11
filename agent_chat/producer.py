"""One bounded validation-lease observation; no lease acquisition or native delivery."""

import json
import os
import re
import stat
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from .client import Client
from .models import ChatError, StateEntry, StateUpsert
from .protocol import token_digest, validate_origin

STATUS_SCHEMA = "validation-lease-status.v1"
VALUE_SCHEMA = "agent-chat.validation-lease.v1"
CLASSES = ("leaf", "c1", "shared")
FIELDS = ("lane", "branch", "head", "profile", "effective", "owner", "step")
LEASE_ENV = (
    "CI_PROFILE_SLOTS", "CI_PROFILE_LEAF_SLOTS", "CI_PROFILE_C1_SLOTS", "CI_PROFILE_RUN_USER_DIR", "TMPDIR"
)
HOST = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
MAX_CREDENTIAL_BYTES = 16 * 1024
MAX_STATUS_BYTES = 1024 * 1024


@dataclass(frozen=True)
class ProducerCredential:
    server_origin: str
    token: str = field(repr=False)
    host: str
    room_id: UUID


def read_credential(path: Path) -> ProducerCredential:
    """Read the named, private producer file; never discover a credential or accept a symlink."""
    try:
        if not path.is_absolute():
            raise ChatError("PRODUCER_CREDENTIAL_UNSAFE")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1
            ):
                raise ChatError("PRODUCER_CREDENTIAL_UNSAFE")
            raw = handle.read(MAX_CREDENTIAL_BYTES + 1)
    except OSError:
        raise ChatError("PRODUCER_CREDENTIAL_UNSAFE") from None
    try:
        data = json.loads(raw.decode("utf-8"))
        if (
            len(raw) > MAX_CREDENTIAL_BYTES
            or not isinstance(data, dict)
            or set(data) != {"server_origin", "token", "host", "room_id"}
            or not all(isinstance(value, str) for value in data.values())
            or HOST.fullmatch(data["host"]) is None
        ):
            raise ValueError("invalid producer credential")
        validate_origin(data["server_origin"])
        token_digest(data["token"])
        room = UUID(data["room_id"])
        if str(room) != data["room_id"]:
            raise ValueError("noncanonical room")
        return ProducerCredential(data["server_origin"], data["token"], data["host"], room)
    except (ValueError, UnicodeError, ChatError, RecursionError):
        raise ChatError("PRODUCER_CREDENTIAL_INVALID") from None


class _Unknown(Exception):
    """A fixed, secret-free reason for replacing every class observation with unknown."""


def _safe_script(script: Path) -> bool:
    try:
        if not script.is_absolute():
            return False
        descriptor = os.open(script, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            return (
                stat.S_ISREG(info.st_mode)
                and info.st_uid in (0, os.geteuid())
                and not info.st_mode & 0o022
            )
    except OSError:
        return False


def _text(value: Any) -> str | None:
    if value is None or value == "-":
        return None
    if not isinstance(value, str) or len(value.encode("utf-8")) > 512 or "\x00" in value:
        raise _Unknown("invalid_status")
    return value


def _fields(row: dict[str, Any]) -> dict[str, Any]:
    fields = row.get("fields")
    if not isinstance(fields, dict):
        raise _Unknown("invalid_status")
    return {name: _text(fields.get(name)) for name in FIELDS}


def _values(report: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(report, dict) or report.get("schema") != STATUS_SCHEMA:
        raise _Unknown("schema_mismatch")
    classes = {"classed": ("leaf", "c1"), "legacy": ("shared",)}.get(report.get("mode"))
    if classes is None or not isinstance(report.get("slots"), list) or not isinstance(report.get("waiters"), list):
        raise _Unknown("invalid_status")
    values: dict[str, dict[str, Any]] = {
        name: {"schema": VALUE_SCHEMA, "scan": "known", "slots": [], "waiters": []} for name in classes
    }
    seen = set()
    for row in report["slots"]:
        if not isinstance(row, dict):
            raise _Unknown("invalid_status")
        name, number, state = row.get("class"), row.get("slot"), row.get("state")
        if (
            name not in classes
            or type(number) is not int
            or not 1 <= number <= 16
            or state not in ("free", "held", "stuck", "unknown")
            or (name, number) in seen
        ):
            raise _Unknown("invalid_status")
        seen.add((name, number))
        values[name]["slots"].append({"class": name, "slot": number, "state": state, **_fields(row)})
    if any(not value["slots"] for value in values.values()):
        raise _Unknown("invalid_status")
    for row in report["waiters"]:
        if not isinstance(row, dict) or row.get("class") not in classes:
            raise _Unknown("invalid_status")
        name = row["class"]
        values[name]["waiters"].append(
            {"class": name, **_fields(row), "waiting_since": _text(row.get("waiting_since"))}
        )
    for value in values.values():
        value["slots"].sort(key=lambda slot: slot["slot"])
    return values


def _collect(script: Path, lock_file: Path | None, environ: Mapping[str, str]) -> dict[str, dict[str, Any]]:
    if not _safe_script(script):
        raise _Unknown("script_unsafe")
    child_env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    child_env.update({name: environ[name] for name in LEASE_ENV if name in environ})
    if lock_file is not None:
        if not lock_file.is_absolute():
            raise ChatError("INVALID_ARGUMENTS")
        child_env["CI_PROFILE_LOCK_FILE"] = str(lock_file)
    try:
        result = subprocess.run(
            ["python3", "-I", str(script), "status", "--json", "--fast"],
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=True,
        )
    except subprocess.TimeoutExpired:
        raise _Unknown("command_timeout") from None
    except (OSError, subprocess.CalledProcessError):
        raise _Unknown("command_failed") from None
    if len(result.stdout) > MAX_STATUS_BYTES:
        raise _Unknown("invalid_status")
    try:
        return _values(json.loads(result.stdout.decode("utf-8")))
    except (ValueError, UnicodeError, TypeError, RecursionError):
        raise _Unknown("invalid_status") from None


def _entries(host: str, values: dict[str, dict[str, Any]]) -> StateUpsert:
    return StateUpsert(
        entries=tuple(
            StateEntry(
                state_key=f"validation-lease:{host}:{name}",
                ref_key=f"resource:{host}:ci-validation",
                value=values.get(name, {"schema": VALUE_SCHEMA, "scan": "unknown", "reason": "inactive"}),
                ttl_seconds=90,
            )
            for name in CLASSES
        )
    )


def produce(credential: ProducerCredential, script: Path, lock_file: Path | None = None) -> dict[str, Any]:
    """Publish once. Failed scans overwrite every possible class as unknown, never as free."""
    try:
        values = _collect(script, lock_file, os.environ)
        request = _entries(credential.host, values)
    except (_Unknown, ValidationError) as error:
        reason = str(error) if isinstance(error, _Unknown) else "state_too_large"
        values = {name: {"schema": VALUE_SCHEMA, "scan": "unknown", "reason": reason} for name in CLASSES}
        request = _entries(credential.host, values)
    Client(credential.server_origin, credential.token).request(
        "POST", f"/v1/rooms/{credential.room_id}/state", request.model_dump(mode="json")
    )
    return {"entries": [{"state_key": entry.state_key, "scan": entry.value["scan"]} for entry in request.entries]}
