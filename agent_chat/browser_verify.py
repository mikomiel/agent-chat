"""One-shot, origin-bound viewer inspection. No credential discovery or profile reuse.

Binding v1 (provisioning-owned, not created here):
{"version": 1, "origin": "https://chat.example", "room_ids": ["<uuid>"],
 "viewer_token": "<64 lowercase hex>",
 "artifact_policy": {"root": "<absolute private provisioned root>", "retention_seconds": 86400}}

artifact_policy is optional. It is a provisioning-owned expiry contract, not proof
that expiry has run. No CLI option can supply or override that policy.
The Python-only test trust injection is not a command-line or environment option.
The managed environment must already contain this package and matching Chromium.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import urlsplit
from uuid import UUID

VIEWPORTS = ((1280, 720), (390, 844))
RUN_SECONDS = 120
CLEANUP_SECONDS = 10
MAX_REQUESTS = 200
MAX_PAGES = 5


class Stop(Exception):
    def __init__(self, code: str, result: str = "FAIL", http_status: int | None = None) -> None:
        self.code, self.result, self.http_status = code, result, http_status
        super().__init__(code)


@dataclass(frozen=True)
class ArtifactPolicy:
    root: Path
    retention_seconds: int


@dataclass(frozen=True)
class Binding:
    origin: str
    room_ids: tuple[str, ...]
    viewer_token: str = field(repr=False)
    artifact_policy: ArtifactPolicy | None = None


@dataclass(frozen=True)
class Request:
    binding: Path
    scenario: str
    room: str
    session: str | None
    message: str | None
    receipt_session: str | None
    expected_title: str | None = field(repr=False)
    min_participants: int | None = None
    receipt_states: tuple[str, ...] = ()
    screenshot: bool = False
    expected_title_file: Path | None = None


@dataclass(frozen=True)
class FixtureTrust:
    """Disposable HTTPS fixture's certificate and exact public-key pin; never CLI inputs."""

    origin: str
    certificate: Path
    spki: str


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # argparse's default diagnostics echo untrusted argv, including mistaken secrets.
        raise Stop("INVALID_INPUT")


def uuid_text(value: str) -> str:
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("noncanonical UUID")
    return value


def parse(argv: list[str] | None) -> Request:
    parser = Parser(add_help=False, allow_abbrev=False)
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--scenario", required=True,
                        choices=("snapshot", "session-title", "layout", "history-receipt"))
    parser.add_argument("--room", type=uuid_text, required=True)
    parser.add_argument("--session", type=uuid_text)
    parser.add_argument("--message", type=uuid_text)
    parser.add_argument("--receipt-session", type=uuid_text)
    parser.add_argument("--expected-title-file", type=Path)
    parser.add_argument("--min-participants", type=int)
    parser.add_argument("--receipt-state", action="append", default=[],
                        choices=("stored", "handed", "acknowledged", "replied", "uncertain"))
    parser.add_argument("--screenshot", action="store_true")
    args = parser.parse_args(argv)
    title_case = args.scenario in ("session-title", "layout")
    receipt_case = args.scenario == "history-receipt"
    if (
        title_case != (args.session is not None)
        or (args.expected_title_file is not None and not title_case)
        or receipt_case != (args.message is not None)
        or receipt_case != (args.receipt_session is not None)
        or receipt_case != bool(args.receipt_state)
        or len(set(args.receipt_state)) != len(args.receipt_state)
        or (args.scenario == "layout") != (args.min_participants is not None)
        or (args.min_participants is not None and not 1 <= args.min_participants <= 250)
    ):
        raise Stop("INVALID_INPUT")
    if args.scenario == "snapshot" and args.screenshot:
        # `#read-only-indicator` is a childless element: an allow-list entry
        # leaves nothing to mask and PREPARE refuses, while the deny-by-default
        # fallback masks that very element and retains a black rectangle.
        raise Stop("SCREENSHOT_SCENARIO_UNAVAILABLE", "UNAVAILABLE")
    expected = None
    if args.expected_title_file is not None:
        try:
            expected = read_private(args.expected_title_file, 512, "EXPECTED_TITLE", allow_empty=True).decode("utf-8")
        except UnicodeError:
            raise Stop("EXPECTED_TITLE_INVALID") from None
    return Request(args.binding, args.scenario, args.room, args.session, args.message,
                   args.receipt_session, expected, args.min_participants,
                   tuple(args.receipt_state), args.screenshot, args.expected_title_file)


def private_directory(path: Path, unsafe_code: str) -> int:
    # Descriptor walking closes the resolve()+open() symlink race. Only root or
    # this identity may own ancestors; the final directory must be private.
    if not path.is_absolute() or ".." in path.parts or len(path.parts) < 2:
        raise Stop(unsafe_code)
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(path.parts[1:], 1):
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
            info = os.fstat(directory)
            mode = stat.S_IMODE(info.st_mode)
            if info.st_uid not in (0, os.geteuid()) or (mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise Stop(unsafe_code)
            if index == len(path.parts) - 1 and (info.st_uid != os.geteuid() or mode != 0o700):
                raise Stop(unsafe_code)
        return directory
    except (OSError, Stop):
        os.close(directory)
        raise


def read_private(path: Path, maximum: int, code: str, *, allow_empty: bool = False) -> bytes:
    if not path.is_absolute() or ".." in path.parts or len(path.parts) < 3:
        raise Stop(code + "_UNSAFE")
    try:
        directory = private_directory(path.parent, code + "_UNSAFE")
    except OSError:
        raise Stop(code + "_UNAVAILABLE", "UNAVAILABLE") from None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                    or not (0 if allow_empty else 1) <= info.st_size <= maximum):
                raise Stop(code + "_UNSAFE")
            content = stream.read(maximum + 1)
            if len(content) > maximum:
                raise Stop(code + "_UNSAFE")
            return content
    except OSError:
        raise Stop(code + "_UNAVAILABLE", "UNAVAILABLE") from None
    finally:
        os.close(directory)


def read_binding(path: Path) -> Binding:
    content = read_private(path, 8192, "BINDING")
    try:
        data = json.loads(content, object_pairs_hook=_unique_keys)
        required = {"version", "origin", "room_ids", "viewer_token"}
        if (len(content) > 8192 or not required <= set(data) or set(data) - required - {"artifact_policy"}
                or type(data["version"]) is not int or data["version"] != 1):
            raise ValueError("schema")
        origin = data["origin"]
        parts = urlsplit(origin)
        if (not isinstance(origin, str) or len(origin) > 256 or not origin.isascii()
                or re.fullmatch(r"https://[a-z0-9.\[\]:-]+", origin) is None
                or not parts.hostname or parts.username is not None or parts.password is not None
                or parts.path or parts.query or parts.fragment or parts.port in (0, 443)):
            raise ValueError("origin")
        rooms = data["room_ids"]
        if not isinstance(rooms, list) or not 1 <= len(rooms) <= 32:
            raise ValueError("scope")
        rooms = tuple(uuid_text(room) for room in rooms)
        if (len(set(rooms)) != len(rooms) or re.fullmatch(r"[0-9a-f]{64}", data["viewer_token"]) is None
                or data["viewer_token"] in origin):
            raise ValueError("credential")
        policy = None
        if "artifact_policy" in data:
            artifact = data["artifact_policy"]
            if (not isinstance(artifact, dict) or set(artifact) != {"root", "retention_seconds"}
                    or not isinstance(artifact["root"], str) or not 1 <= len(artifact["root"]) <= 512
                    or type(artifact["retention_seconds"]) is not int
                    or not 1 <= artifact["retention_seconds"] <= 86400):
                raise ValueError("artifact policy")
            root = Path(artifact["root"])
            if (not root.is_absolute() or ".." in root.parts or str(root) != artifact["root"]
                    or any(ord(char) < 32 or ord(char) == 127 for char in str(root))
                    or data["viewer_token"] in str(root) or root in path.parents):
                raise ValueError("artifact root")
            policy = ArtifactPolicy(root, artifact["retention_seconds"])
        return Binding(origin, rooms, data["viewer_token"], policy)
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise Stop("BINDING_INVALID") from None


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def evidence(request: Request | None = None, binding: Binding | None = None) -> dict[str, Any]:
    return {
        "version": 1, "scenario": request.scenario if request else "unknown", "mode": "inspection",
        "timestamp": datetime.now(timezone.utc).isoformat(), "origin": binding.origin if binding else "unknown",
        "room": request.room if request else None, "session": request.session if request else None,
        "message": request.message if request else None,
        "receipt_session": request.receipt_session if request else None,
        "viewports": [{"width": width, "height": height} for width, height in VIEWPORTS],
        "source_ref": "unknown",
        "served_hashes": {
            name: "unknown"
            for name in ("index.html", "chat.js", "i18n.js", "chat.css", "Manrope-Variable.ttf")
        },
        "assertions": [], "artifacts": [], "retention": "NOT_RUN", "retention_seconds": None, "expiry": "NOT_RUN",
        "cleanup": {key: "NOT_RUN" for key in ("logout", "context", "browser", "children", "temporary")}
                   | ({"artifacts": "NOT_RUN"} if request is not None and request.screenshot else {}),
        "cleanup_steps": [], "close_steps": [], "cookie_max_lifetime_seconds": "unknown", "requests": 0,
        "result": "NOT_RUN",
    }


def record(result: dict[str, Any], code: str, status: str = "PASS", viewport: int | None = None) -> None:
    entry = {"code": code, "result": status}
    if viewport is not None:
        entry["viewport"] = viewport
    if entry not in result["assertions"] and len(result["assertions"]) < 96:
        result["assertions"].append(entry)


def verdict(result: dict[str, Any]) -> None:
    statuses = [entry["result"] for entry in result["assertions"]]
    statuses += list(result["cleanup"].values())
    result["result"] = ("FAIL" if "FAIL" in statuses else "PASS"
                        if statuses and result["assertions"] and all(s == "PASS" for s in statuses)
                        else "UNAVAILABLE")


def _children(pid: int) -> dict[int, str]:
    found: dict[int, str] = {}
    pending = [pid]
    while pending:
        parent = pending.pop()
        try:
            children = Path(f"/proc/{parent}/task/{parent}/children").read_text().split()
        except FileNotFoundError:
            continue
        for value in children:
            child = int(value)
            try:
                start = Path(f"/proc/{child}/stat").read_text().rsplit(")", 1)[1].split()[19]
            except FileNotFoundError:
                continue
            if child not in found:
                found[child] = start
                pending.append(child)
    return found


def _reap_owned(baseline: dict[int, str], deadline: float) -> bool:
    # Linux subreaper adoption retains ownership even if a Chromium process starts
    # its own session, or the Playwright driver dies before closing its browser.
    while time.monotonic() < deadline:
        owned = {pid: start for pid, start in _children(os.getpid()).items() if pid not in baseline}
        if not owned:
            return True
        for pid, start in owned.items():
            try:
                current = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
                if current == start:
                    os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, os.WNOHANG)
            except (FileNotFoundError, ProcessLookupError, ChildProcessError):
                pass
        time.sleep(0.01)
    return not {pid for pid in _children(os.getpid()) if pid not in baseline}


def supervise(request: Request, binding: Binding, *, test_trust: FixtureTrust | None = None) -> dict[str, Any]:
    result = evidence(request, binding)
    if request.screenshot and binding.artifact_policy is None:
        raise Stop("ARTIFACT_POLICY_UNAVAILABLE", "UNAVAILABLE")
    if sys.platform != "linux":
        raise Stop("PROCESS_CONTROL_UNAVAILABLE", "UNAVAILABLE")
    # This is a one-shot process, not an embeddable browser service. Refuse an
    # existing process tree rather than risk claiming somebody else's orphan.
    baseline = _children(os.getpid())
    if baseline:
        raise Stop("PROCESS_OWNERSHIP_UNAVAILABLE", "UNAVAILABLE")
    libc = ctypes.CDLL(None, use_errno=True)
    previous = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(previous), 0, 0, 0) != 0 or libc.prctl(36, 1, 0, 0, 0) != 0:
        raise Stop("PROCESS_CONTROL_UNAVAILABLE", "UNAVAILABLE")
    from .browser_verify_artifacts import Artifacts

    artifacts = None
    try:
        if request.screenshot and binding.artifact_policy is not None:
            artifacts = Artifacts.create(binding.artifact_policy)
        with tempfile.TemporaryDirectory(prefix="agent-chat-verify-") as directory:
            root = Path(directory)
            os.chmod(root, 0o700)
            env = {"PATH": os.defpath, "LANG": "C.UTF-8", "HOME": directory, "TMPDIR": directory}
            # This is an installation path, not a browser profile or browser endpoint.
            if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
                env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ["PLAYWRIGHT_BROWSERS_PATH"]
            else:
                env["PLAYWRIGHT_BROWSERS_PATH"] = str(Path.home() / ".cache/ms-playwright")
            trust = None
            if test_trust is not None:
                if (test_trust.origin != binding.origin or urlsplit(binding.origin).hostname != "127.0.0.1"
                        or re.fullmatch(r"[A-Za-z0-9+/]{43}=", test_trust.spki) is None):
                    raise Stop("TEST_TRUST_INVALID")
                certificate = root / "fixture-ca.pem"
                certificate.write_bytes(test_trust.certificate.read_bytes())
                certificate.chmod(0o600)
                env["NODE_EXTRA_CA_CERTS"] = str(certificate)
                trust = test_trust.spki
            arguments = ["--binding", str(request.binding), "--scenario", request.scenario, "--room", request.room]
            for flag, value in (("--session", request.session), ("--message", request.message),
                                ("--receipt-session", request.receipt_session),
                                ("--expected-title-file", request.expected_title_file),
                                ("--min-participants", request.min_participants)):
                if value is not None:
                    arguments.append(flag + "=" + str(value))
            for state in request.receipt_states:
                arguments += ["--receipt-state", state]
            if request.screenshot:
                arguments.append("--screenshot")
            # The worker revalidates the managed file; no alternate stdin token or
            # URL route exists even at this private process boundary.
            policy = binding.artifact_policy
            payload = {"argv": arguments, "origin": binding.origin, "room_ids": binding.room_ids, "test_spki": trust,
                       "artifact_policy": [str(policy.root), policy.retention_seconds] if policy else None,
                       "artifact_target": {"fd": artifacts.directory_fd, "name": artifacts.name}
                       if artifacts else None}
            child = subprocess.Popen(
                [sys.executable, "-I", "-m", "agent_chat.browser_verify_run"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=env, start_new_session=True,
                pass_fds=(artifacts.directory_fd,) if artifacts else (),
            )
            try:
                timed_out = False
                try:
                    output, _ = child.communicate(json.dumps(payload).encode(), timeout=RUN_SECONDS)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    child.send_signal(signal.SIGTERM)
                    try:
                        output, _ = child.communicate(timeout=CLEANUP_SECONDS - 2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        output, _ = child.communicate(timeout=1)
                    record(result, "RUN_LIMIT", "UNAVAILABLE")
                if child.returncode == 0 and len(output) <= 32768:
                    worker = json.loads(output)
                    worker["assertions"] += result["assertions"]
                    result = worker
                else:
                    record(result, "WORKER_INCOMPLETE" if timed_out else "WORKER_FAILED",
                           "UNAVAILABLE" if timed_out else "FAIL")
            finally:
                waited = True
                try:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=0.25)
                except (OSError, subprocess.TimeoutExpired):
                    waited = False
                try:
                    cleaned = _reap_owned(baseline, time.monotonic() + 0.75)
                except OSError:
                    cleaned = False
                result["cleanup"]["children"] = "PASS" if cleaned and waited else "UNAVAILABLE"
        result["cleanup"]["temporary"] = "PASS"
    except Stop as error:
        record(result, error.code, error.result)
    except OSError:
        result["cleanup"]["temporary"] = "UNAVAILABLE"
        record(result, "SUPERVISION_UNAVAILABLE", "UNAVAILABLE")
    except Exception:
        # Preserve worker assertions if the private protocol or parent cleanup
        # fails. Letting this escape would replace the original failure in main.
        result["cleanup"]["temporary"] = "UNAVAILABLE"
        record(result, "SUPERVISION_ERROR", "FAIL")
    finally:
        if libc.prctl(36, previous.value, 0, 0, 0) != 0:
            result["cleanup"]["children"] = "UNAVAILABLE"
        if artifacts is not None:
            try:
                result["cleanup"]["artifacts"] = "PASS"
                verdict(result)
                if result["result"] == "PASS":
                    result["artifacts"] = artifacts.paths(expected=len(VIEWPORTS))
                    result["retention"] = "PASS"
                    result["retention_seconds"] = artifacts.policy.retention_seconds
                else:
                    artifacts.discard()
            except (OSError, Stop) as error:
                result["cleanup"]["artifacts"] = "UNAVAILABLE"
                record(result, error.code if isinstance(error, Stop) else "ARTIFACT_CLEANUP_UNAVAILABLE",
                       error.result if isinstance(error, Stop) else "UNAVAILABLE")
                result["artifacts"] = []
                try:
                    artifacts.discard()
                except (OSError, Stop):
                    pass
            finally:
                try:
                    artifacts.close()
                except OSError:
                    result["artifacts"] = []
                    result["retention"] = "UNAVAILABLE"
                    result["cleanup"]["artifacts"] = "UNAVAILABLE"
                    record(result, "ARTIFACT_CLEANUP_UNAVAILABLE", "UNAVAILABLE")
                    try:
                        artifacts.discard()
                    except (OSError, Stop):
                        pass
    verdict(result)
    return result


def main(argv: list[str] | None = None, *, _test_trust: FixtureTrust | None = None) -> int:
    request = binding = None
    result = evidence()
    try:
        request = parse(argv)
        result = evidence(request)
        binding = read_binding(request.binding)
        result = evidence(request, binding)
        if request.room not in binding.room_ids:
            raise Stop("ROOM_OUTSIDE_BINDING")
        result = supervise(request, binding, test_trust=_test_trust)
    except Stop as error:
        record(result, error.code, error.result)
    except (OSError, ImportError):
        record(result, "PREREQUISITE_UNAVAILABLE", "UNAVAILABLE")
    except KeyboardInterrupt:
        record(result, "INTERRUPTED", "UNAVAILABLE")
    except Exception:
        # Final protocol boundary: private exception messages must never reach stderr.
        record(result, "UNEXPECTED_ERROR", "FAIL")
    verdict(result)
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0 if result["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
