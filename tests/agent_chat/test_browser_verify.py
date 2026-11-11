"""Verifier boundaries over disposable synthetic HTTPS, never deployed credentials/services."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import multiprocessing
import os
import re
import socket
import struct
import subprocess
import sys
import time
import zlib
from contextlib import ExitStack
from dataclasses import dataclass, field
from importlib.resources import files
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from typing import Any

import psycopg
import pytest
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from playwright.sync_api import sync_playwright

from agent_chat import browser_verify as verify
from agent_chat.browser_verify_artifacts import Artifacts, capture
from agent_chat.browser_verify_run import Fence, cleanup_step, run

from .test_ui import tls_cert as tls_cert

ROOM = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
MESSAGE = "33333333-3333-4333-8333-333333333333"
PEER = "44444444-4444-4444-8444-444444444444"
OTHER = "55555555-5555-4555-8555-555555555555"
ONLINE = "88888888-8888-4888-8888-888888888888"
TOKEN = "a7" * 32
CSRF = "b8" * 32
SECRET_TEXT = "PRIVATE-CONVERSATION-SENTINEL-<img src=/exfil>"
TITLE = "Independent exact title <script>not code</script>"
WEB = files("agent_chat").joinpath("web")
CSS = ("@font-face{font-family:Fixture;src:url('/ui/Manrope-Variable.ttf')}"
       "body{font-family:Fixture;margin:8px}li{overflow-wrap:anywhere}#messages{min-height:20px}")


def binding_file(tmp_path: Path, **updates: Any) -> Path:
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / "viewer.json"
    path.write_text(json.dumps({"version": 1, "origin": "https://chat.example", "room_ids": [ROOM],
                                "viewer_token": TOKEN, **updates}))
    path.chmod(0o600)
    return path


def argv(path: Path, scenario: str = "snapshot") -> list[str]:
    args = ["--binding", str(path), "--scenario", scenario, "--room", ROOM]
    if scenario in ("session-title", "layout"):
        expected = path.parent / "expected-title.txt"
        expected.write_text(TITLE)
        expected.chmod(0o600)
        args += ["--session", SESSION, "--expected-title-file", str(expected)]
    if scenario == "layout":
        args += ["--min-participants", "20"]
    if scenario == "history-receipt":
        args += ["--message", MESSAGE, "--receipt-session", PEER, "--receipt-state", "stored"]
    return args


def invoke(fixture: tuple[str, Path, str] | None, arguments: list[str]) -> subprocess.CompletedProcess[str]:
    # A CLI process owns no pre-existing child tree. The pytest worker may already
    # own the session-scoped PostgreSQL fixture; never relax the production guard.
    if fixture is None:
        setup, call = "", "main(sys.argv[1:])"
        inputs = arguments
    else:
        origin, certificate, pin = fixture
        setup = ("from pathlib import Path; from agent_chat.browser_verify import FixtureTrust; "
                 "trust=FixtureTrust(sys.argv[1], Path(sys.argv[2]), sys.argv[3])")
        call = "main(sys.argv[4:], _test_trust=trust)"
        inputs = [origin, str(certificate), pin, *arguments]
    code = f"""import os, sys, time
from agent_chat.browser_verify import main, _children, _reap_owned
{setup}
try:
    status = {call}
    assert not _children(os.getpid()), "verifier child survived cleanup"
finally:
    assert _reap_owned({{}}, time.monotonic() + 1), "test cleanup failed"
raise SystemExit(status)
"""
    env = {name: os.environ[name] for name in ("PATH", "HOME", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR")
           if name in os.environ}
    return subprocess.run([sys.executable, "-I", "-c", code, *inputs], env=env,
                          text=True, capture_output=True, timeout=140)


def _supervisor_child(send: Any, function: Any, arguments: tuple[Any, ...]) -> None:
    try:
        data = function(*arguments)
        assert not verify._children(os.getpid()), "verifier child survived cleanup"
        send.send(data)
    finally:
        try:
            # Assertion comes first: this test safety net must not hide a leak.
            assert verify._reap_owned({}, time.monotonic() + 1), "test cleanup failed"
        finally:
            send.close()


def isolated_supervise(function: Any, *arguments: Any) -> dict[str, Any]:
    # Fresh interpreter: no pytest-owned PostgreSQL children or live threads.
    # Faults are installed inside this process; the real supervisor stays active.
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    child = context.Process(target=_supervisor_child, args=(send, function, arguments))
    child.start()
    send.close()
    try:
        assert receive.poll(15), "isolated supervisor did not finish"
        data = receive.recv()
        child.join(timeout=2)
        assert child.exitcode == 0
        return data
    finally:
        receive.close()
        if child.is_alive():
            child.terminate()
            child.join(timeout=2)
        if child.is_alive():
            child.kill()
            child.join(timeout=2)
        child.close()


def result(capsys: Any) -> dict[str, Any]:
    captured = capsys.readouterr()
    assert captured.err == ""
    assert TOKEN not in captured.out and CSRF not in captured.out
    assert TITLE not in captured.out and SECRET_TEXT not in captured.out
    assert len(captured.out) < 32768
    data = json.loads(captured.out)
    assert data["source_ref"] == "unknown"
    assert set(data["served_hashes"]) == {"index.html", "chat.js", "chat.css", "Manrope-Variable.ttf"}
    assert all(value == "unknown" or re.fullmatch(r"[0-9a-f]{64}", value) for value in data["served_hashes"].values())
    assert len(data["artifacts"]) <= 4 and data["expiry"] == "NOT_RUN"
    if data["artifacts"]:
        assert data["retention"] == "PASS" and 1 <= data["retention_seconds"] <= 86400
    return data


def codes(data: dict[str, Any]) -> set[str]:
    return {entry["code"] for entry in data["assertions"]}


def why(data: dict[str, Any]) -> str:
    """The failing codes, logout steps and resource closes, ahead of pytest's abbreviated evidence dictionary."""
    failures = [f"{entry['code']}:{entry['result']}" for entry in data.get("assertions", [])
                if entry["result"] != "PASS"]
    failures += [f"cleanup.{name}:{status}" for name, status in data.get("cleanup", {}).items()
                 if status != "PASS"]
    steps = [f"step.{step['step']}:{step['outcome']}:{step['http_status']}:{step['elapsed_ms']}ms"
             f":idle{step['idle_ms']}ms" for step in data.get("cleanup_steps", [])]
    closes = [f"close.{step['step']}:{step['outcome']}:{step['elapsed_ms']}ms" for step in data.get("close_steps", [])]
    prefix = f"{data.get('result')} requests={data.get('requests')}: "
    body = "; ".join(steps + closes + failures)
    # Cap the whole message, prefix included, and cut on a `; ` boundary so no token shows partially.
    return prefix + (body if len(prefix + body) <= 512 else body[:512 - len(prefix)].rpartition("; ")[0])


@pytest.mark.parametrize("arguments", [[], ["--url", TOKEN], ["--token", TOKEN], ["--help"],
                                       ["--remote-debugging-port", "9222"], ["--ignore-tls-errors"],
                                       ["--expected-title", TITLE]])
def test_cli_invalid_arguments_are_one_secret_free_json(arguments: list[str], capsys: Any) -> None:
    assert verify.main(arguments) == 1
    data = result(capsys)
    assert data["result"] == "FAIL" and codes(data) == {"INVALID_INPUT"}


@pytest.mark.parametrize("scenario,extra", [
    ("session-title", []), ("layout", ["--session", SESSION]),
    ("snapshot", ["--session", SESSION]), ("history-receipt", ["--message", MESSAGE]),
    ("snapshot", ["--room", "not-a-uuid"]),
])
def test_named_scenario_preconditions_stop_before_open(
    tmp_path: Path, scenario: str, extra: list[str], monkeypatch: Any, capsys: Any,
) -> None:
    def forbidden(_: Path) -> None:
        pytest.fail("invalid request read credential")
    monkeypatch.setattr(verify, "read_binding", forbidden)
    args = ["--binding", str(tmp_path / "absent"), "--scenario", scenario, "--room", ROOM, *extra]
    assert verify.main(args) == 1
    assert result(capsys)["result"] == "FAIL"


@pytest.mark.parametrize("title", ["", TITLE, "🧪" * 128])
def test_expected_title_is_a_private_file_not_a_process_argument(tmp_path: Path, title: str) -> None:
    path = binding_file(tmp_path)
    expected = path.parent / "expected.txt"
    expected.write_text(title)
    expected.chmod(0o600)
    arguments = argv(path) + ["--scenario", "session-title", "--session", SESSION,
                              "--expected-title-file", str(expected)]
    request = verify.parse(arguments)
    assert request.expected_title == title and request.expected_title_file == expected
    if title:
        assert title not in repr(request) and title not in " ".join(arguments)
    expected.chmod(0o644)
    with pytest.raises(verify.Stop, match="EXPECTED_TITLE_UNSAFE"):
        verify.parse(arguments)


def test_managed_binding_exact_shape_private_and_secret_repr(tmp_path: Path) -> None:
    value = verify.read_binding(binding_file(tmp_path))
    assert value.origin == "https://chat.example" and value.room_ids == (ROOM,)
    assert value.viewer_token == TOKEN and TOKEN not in repr(value)


@pytest.mark.parametrize("fault", ["file-mode", "directory-mode", "symlink", "ancestor-symlink", "hardlink",
                                  "fifo", "oversize", "foreign-owner"])
def test_file_guards_run_before_any_credential_read(tmp_path: Path, monkeypatch: Any, fault: str) -> None:
    path = binding_file(tmp_path)
    if fault == "file-mode":
        path.chmod(0o640)
    elif fault == "directory-mode":
        path.parent.chmod(0o750)
    elif fault == "symlink":
        target = path.with_name("target")
        path.rename(target)
        path.symlink_to(target)
    elif fault == "ancestor-symlink":
        link = tmp_path / "linked"
        link.symlink_to(path.parent, target_is_directory=True)
        path = link / path.name
    elif fault == "hardlink":
        os.link(path, path.with_name("linked"))
    elif fault == "fifo":
        path.unlink()
        os.mkfifo(path, 0o600)
    elif fault == "oversize":
        path.write_bytes(b"x" * 8193)
    else:
        monkeypatch.setattr(verify.os, "geteuid", lambda: 987654)

    original = os.fdopen

    class NoRead:
        def __init__(self, fd: int, *args: Any, **kwargs: Any) -> None:
            self.stream = original(fd, *args, **kwargs)

        def __enter__(self) -> NoRead:
            return self

        def __exit__(self, *args: Any) -> None:
            self.stream.close()

        def fileno(self) -> int:
            return self.stream.fileno()

        def read(self, count: int) -> bytes:
            pytest.fail("credential content read before metadata rejection")

    monkeypatch.setattr(verify.os, "fdopen", NoRead)
    with pytest.raises(verify.Stop):
        verify.read_binding(path)


@pytest.mark.parametrize("updates", [
    {"origin": "http://127.0.0.1"}, {"origin": "https://user:pass@chat.example"},
    {"origin": "https://chat.example/?token=" + TOKEN}, {"origin": "https://chat.example:443"},
    {"room_ids": []}, {"room_ids": [ROOM, ROOM]}, {"room_ids": ["not-a-uuid"]},
    {"viewer_token": "producer-or-operator-file"}, {"version": True}, {"token": TOKEN},
])
def test_binding_rejects_overrides_and_unscoped_credentials(tmp_path: Path, updates: dict[str, Any]) -> None:
    with pytest.raises(verify.Stop, match="BINDING_INVALID"):
        verify.read_binding(binding_file(tmp_path, **updates))


def test_binding_duplicate_keys_and_missing_files(tmp_path: Path, capsys: Any) -> None:
    path = binding_file(tmp_path)
    path.write_text('{"version":1,"version":1}')
    assert verify.main(argv(path)) == 1
    assert codes(result(capsys)) == {"BINDING_INVALID"}
    path.unlink()
    assert verify.main(argv(path)) == 1
    assert result(capsys)["result"] == "UNAVAILABLE"


def test_outside_bound_room_never_launches_browser(tmp_path: Path, monkeypatch: Any, capsys: Any) -> None:
    path = binding_file(tmp_path, room_ids=[OTHER])
    monkeypatch.setattr(verify, "supervise", lambda *args, **kwargs: pytest.fail("out-of-scope launch"))
    assert verify.main(argv(path)) == 1
    assert codes(result(capsys)) == {"ROOM_OUTSIDE_BINDING"}


def test_screenshots_require_managed_policy_without_cli_overrides(
    tmp_path: Path, monkeypatch: Any, capsys: Any,
) -> None:
    path = binding_file(tmp_path)
    destination = tmp_path / "capture.png"
    destination.symlink_to(path)
    original = path.read_bytes()
    monkeypatch.setattr(verify.subprocess, "Popen", lambda *a, **kw: pytest.fail("unapproved browser launch"))
    for arguments in (argv(path) + ["--screenshot"], argv(path) + ["--artifact-root", str(tmp_path)],
                      argv(path) + ["--screenshot", "--retention-hours", "24"]):
        assert verify.main(arguments) == 1
        data = result(capsys)
        assert data["result"] in ("FAIL", "UNAVAILABLE") and data["artifacts"] == []
    assert destination.is_symlink() and path.read_bytes() == original
    assert set(tmp_path.rglob("*.png")) == {destination}


def test_unexpected_exception_is_failure_without_exception_text(tmp_path: Path, monkeypatch: Any, capsys: Any) -> None:
    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError(TOKEN + SECRET_TEXT)
    monkeypatch.setattr(verify, "supervise", broken)
    assert verify.main(argv(binding_file(tmp_path))) == 1
    assert result(capsys)["result"] == "FAIL"


@pytest.mark.parametrize("url,method,api", [
    ("https://elsewhere.example/v1/login", "POST", True),
    ("https://chat.example/v1/rooms/" + OTHER + "/history", "GET", False),
    ("https://chat.example/v1/rooms/" + ROOM + "/messages", "POST", False),
    ("https://chat.example/v1/instance/status", "GET", True),
    ("https://chat.example/v1/login", "POST", False),
    ("https://chat.example/v1/events?after=0", "GET", False),
    ("https://chat.example/ui/chat.js?token=" + TOKEN, "GET", True),
])
def test_browser_and_request_api_have_independent_fences(url: str, method: str, api: bool) -> None:
    fence = Fence(verify.Binding("https://chat.example", (ROOM,), TOKEN), verify.evidence())
    fence.viewer = True
    with pytest.raises(verify.Stop):
        fence.target(url, method, api=api)
    assert fence.result["requests"] == 0


def test_static_routes_match_the_production_font_and_reject_nonexistent_assets() -> None:
    fence = Fence(verify.Binding("https://chat.example", (ROOM,), TOKEN), verify.evidence())
    assert fence.target("https://chat.example/ui/Manrope-Variable.ttf", "GET") == "font"
    with pytest.raises(verify.Stop, match="ROUTE_BLOCKED"):
        fence.target("https://chat.example/ui/deepseek-mark.svg", "GET")


def test_request_budget_and_pagination_have_independent_negative_controls() -> None:
    fence = Fence(verify.Binding("https://chat.example", (ROOM,), TOKEN), verify.evidence())
    fence.viewer = True
    for _ in range(197):
        fence.target("https://chat.example/healthz", "GET", api=True)
    with pytest.raises(verify.Stop, match="REQUEST_LIMIT"):
        fence.target("https://chat.example/healthz", "GET", api=True)
    for path in ("/v1/logout", "/v1/browser/session", "/v1/browser/session"):
        fence.target("https://chat.example" + path, "GET", api=True, cleanup=True)
    assert fence.result["requests"] == 200
    with pytest.raises(verify.Stop, match="REQUEST_LIMIT"):
        fence.target("https://chat.example/v1/logout", "POST", api=True, cleanup=True)
    second = Fence(fence.binding, verify.evidence())
    second.viewer = True
    for cursor in ("900", "800", "700", "600", "500"):
        second.target(f"https://chat.example/v1/rooms/{ROOM}/history?before={cursor}", "GET")
    with pytest.raises(verify.Stop, match="PAGE_LIMIT"):
        second.target(f"https://chat.example/v1/rooms/{ROOM}/history?before=400", "GET")


def test_no_assertions_and_incomplete_cleanup_cannot_pass() -> None:
    data = verify.evidence()
    verify.verdict(data)
    assert data["result"] == "UNAVAILABLE"
    verify.record(data, "EXAMPLE")
    data["cleanup"]["logout"] = "UNAVAILABLE"
    verify.verdict(data)
    assert data["result"] == "UNAVAILABLE"
    verify.record(data, "MISMATCH", "FAIL")
    verify.verdict(data)
    assert data["result"] == "FAIL"


@pytest.fixture(scope="module")
def browser_capability() -> None:
    # Missing capability is red UNAVAILABLE evidence, not a skipped green suite.
    with sync_playwright() as driver:
        try:
            browser = driver.chromium.launch()
        except Exception:
            pytest.fail("UNAVAILABLE: matching pinned Chromium required (no runtime installation)")
        browser.close()


@dataclass
class Synthetic:
    origin: str
    trust: verify.FixtureTrust
    fault: str = ""
    calls: list[tuple[str, str, bytes]] = field(default_factory=list)
    logout_count: int = 0
    target_calls: list[bytes] = field(default_factory=list)
    production_assets: bool = False
    mixed_presence: bool = False
    asset_overrides: dict[str, bytes] = field(default_factory=dict)
    asset_reads: dict[str, int] = field(default_factory=dict)


# Intentionally independent fixture markup/expected title, not the production renderer.
HTML = """<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>
<link rel=stylesheet href=/ui/chat.css><script defer src=/ui/chat.js></script>
<section id=viewer data-access=viewer><p id=read-only-indicator>Read only</p>
<select id=room><option value='11111111-1111-4111-8111-111111111111'>Synthetic</option></select>
<button id=refresh>Refresh</button><details id=participants-details open><summary>Participants</summary>
<ul id=participants></ul><button id=more-participants hidden>More</button></details>
<form id=thread-filter><input aria-label=Thread></form><ol id=messages></ol>
<button id=more-messages hidden>More history</button></section>"""

JS = """
(async () => {
  const get = async path => (await fetch(path)).json();
  const cfg = await get('/readyz');
  await get('/v1/browser/session');
  const rooms = await get('/v1/rooms');
  const select = document.querySelector('#room'); select.replaceChildren();
  for (const room of rooms.rooms) {
    const option = document.createElement('option'); option.value=room.id; option.textContent=room.label;
    select.append(option);
  }
  const add = (parent, tag, cls, value) => {
    const node = document.createElement(tag); node.className = cls; node.textContent = value; parent.append(node);
    return node;
  };
  const render = async () => {
    const prefix = '/v1/rooms/' + select.value;
    const rows = await get(prefix + '/participants?limit=50');
    const history = await get(prefix + '/history?limit=50&before=9223372036854775807');
    document.querySelector('#participants').replaceChildren(); document.querySelector('#messages').replaceChildren();
    // The page lists online sessions first and keeps the API order inside each group; `api-order` is the
    // contrary fixture, and the two row faults keep that order and damage the set of rows only.
    const shown = cfg.fault === 'api-order' ? [...rows.participants]
      : [...rows.participants.filter(row => row.online), ...rows.participants.filter(row => !row.online)];
    if (cfg.fault === 'dropped-participant') shown.pop();
    if (cfg.fault === 'duplicated-participant') shown.push(shown[0]);
    for (const row of shown) {
      const item = add(document.querySelector('#participants'), 'li', '', '');
      item.dataset.sessionId = cfg.fault === 'retargeted-uuid'
        ? '55555555-5555-4555-8555-555555555555' : row.session_id;
      add(item, 'bdi', 'session-title', cfg.fault === 'dom-title' ? 'Wrong DOM title' : row.title);
      add(item, 'div', 'participant-id', row.session_id);
      add(item, 'div', 'participant-label', row.label);
      add(item, 'div', 'participant-identity', 'pi · synthetic · ' + row.session_id.slice(0, 8));
      add(item, 'div', 'private-note', cfg.sentinel);
      if (cfg.fault === 'mask-failure') item.append(document.createTextNode(cfg.sentinel));
    }
    for (const m of history.messages) {
      const item = add(document.querySelector('#messages'), 'li', '', ''); item.dataset.messageId = m.id;
      // An untitled sender is named by its identity alone; only the repeating fixture prints it a second time.
      const untitled = cfg.fault === 'untitled-sender' || cfg.fault === 'untitled-sender-repeated';
      add(item, 'bdi', 'sender-name', untitled ? 'claude · synthetic · 55555555' : 'Off-page synthetic sender');
      if (!untitled || cfg.fault === 'untitled-sender-repeated')
        add(item, 'bdi', 'sender-identity', 'claude · synthetic · 55555555');
      add(item, 'p', 'body', cfg.fault === 'dom-body' ? 'Contrary body' : m.body);
      const ul = add(item, 'ul', 'receipt-summary', ''); const li = add(ul, 'li', '', '');
      for (const state of ['zapis: tak', 'przekazanie: —', 'ACK: —', 'odpowiedź: —', 'niepewność: —', 'próba: —'])
        add(li, 'span', 'receipt-state', cfg.fault === 'dom-receipt' ? 'Wrong state' : state);
      const details = add(item, 'details', 'message-evidence', ''); add(details, 'summary', '', 'Evidence');
      const full = add(details, 'ul', 'evidence-receipts', '');
      add(full, 'li', '', '44444444-4444-4444-8444-444444444444 · zapis: 2026-01-01T00:00:00Z · ' +
        'przekazanie: — · ACK: — · odpowiedź: — · niepewność: — · próba: —');
    }
    if (cfg.fault === 'pagination') {
      const button = document.querySelector('#more-participants'); button.hidden=false;
      let cursor = rows.next_session_id;
      button.onclick = async () => {
        const next = await get(prefix + '/participants?limit=50&after_session=' + cursor);
        cursor = next.next_session_id;
      };
    }
  };
  select.onchange = render; await render();
  if (cfg.fault === 'browser-page-limit') {
    for (let i=1; i<=6; i++) await fetch('/v1/rooms/' + select.value + '/participants?limit=50&after_session=' +
      '77777777-7777-4777-8777-' + String(i).padStart(12,'0')).catch(() => {});
  }
  if (cfg.fault === 'browser-request-limit') {
    // Exhaust the request budget without serial round trips racing the navigation deadline.
    // Keep the same fixed 200 requests, with at most eight in flight.
    for (let i=0; i<25; i++) {
      await Promise.all(Array.from({length:8}, () => fetch('/healthz').catch(() => {})));
    }
  }
  if (cfg.fault === 'overflow') document.body.style.width = '2000px';
  if (cfg.fault === 'write-control') {
    const button = document.createElement('button'); button.className = 'reply'; document.body.append(button);
  }
  if (cfg.fault === 'js') throw Error(cfg.sentinel);
  if (cfg.fault === 'console') console.error(cfg.sentinel);
  if (cfg.fault === 'external') await fetch(cfg.external + '/sink');
  if (cfg.fault === 'redirect') await fetch('/ui/Manrope-Variable.ttf');
  if (cfg.fault === 'write') await fetch('/v1/rooms/' + select.value + '/messages',
                                       {method:'POST', body:cfg.sentinel});
  if (cfg.fault === 'popup') window.open(cfg.external + '/sink');
  if (cfg.fault === 'worker') new Worker('/ui/chat.js');
  if (cfg.fault === 'service-worker') await navigator.serviceWorker.register('/ui/chat.js');
  if (cfg.fault === 'websocket') new WebSocket(cfg.external.replace('https:', 'wss:') + '/sink');
  if (cfg.fault === 'download') {
    const a = document.createElement('a'); a.href='/ui/Manrope-Variable.ttf'; a.download='private.txt'; a.click();
  }
})();
"""


@pytest.fixture
def synthetic(tls_cert: tuple[Path, Path], browser_capability: None) -> Any:
    certificate, key = tls_cert
    public = subprocess.run(["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"],
                            check=True, capture_output=True, timeout=10).stdout
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "der"], input=public,
                         check=True, capture_output=True, timeout=10).stdout
    pin = base64.b64encode(hashlib.sha256(der).digest()).decode()
    app = FastAPI()
    with socket.socket() as listener, socket.socket() as external:
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        external.bind(("127.0.0.1", 0))
        external.listen(16)
        origin = f"https://127.0.0.1:{listener.getsockname()[1]}"
        target_origin = f"https://127.0.0.1:{external.getsockname()[1]}"
        fixture = Synthetic(origin, verify.FixtureTrust(origin, certificate, pin))

        @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
        async def handle(path: str, request: Request) -> Response:
            body = await request.body()
            fixture.calls.append((request.method, "/" + path, body))
            if path == "v1/login":
                if request.method == "GET":
                    response = JSONResponse({"csrf_token": CSRF})
                    response.set_cookie("__Host-agent-chat-login", "challenge", secure=True, httponly=True,
                                        samesite="strict")
                    return response
                assert request.headers["origin"] == origin and request.headers["x-csrf-token"] == CSRF
                assert request.cookies.get("__Host-agent-chat-login") == "challenge"
                assert json.loads(body) == {"token": TOKEN}
                if fixture.fault == "login-redirect":
                    return RedirectResponse(target_origin + "/sink", status_code=307)
                if fixture.fault == "credential-purpose":
                    return JSONResponse({"error": TOKEN}, status_code=401)
                response = JSONResponse({"csrf_token": CSRF, "expires_in": 600,
                                         "access": "operator" if fixture.fault == "operator" else "viewer"})
                response.set_cookie("__Host-agent-chat-session", "synthetic-cookie", secure=True,
                                    httponly=True, samesite="strict")
                return response
            if path == "v1/browser/session":
                if not request.cookies.get("__Host-agent-chat-session"):
                    return JSONResponse({"error": "UNAUTHENTICATED"}, status_code=401)
                return JSONResponse({"csrf_token": CSRF, "principal_id": OTHER,
                                     "access": "operator" if fixture.fault == "operator" else "viewer"})
            if path == "v1/logout":
                fixture.logout_count += 1
                if fixture.fault == "logout-network":
                    await asyncio.sleep(2)
                if fixture.fault in ("logout-error", "dom-title-logout-error"):
                    return JSONResponse({"private": TOKEN}, status_code=503)
                response = JSONResponse({"status": "logged_out"})
                response.delete_cookie("__Host-agent-chat-session", secure=True, httponly=True, samesite="strict")
                return response
            if path == "healthz":
                return JSONResponse({"status": "ok"})
            if path == "readyz":
                fault = "dom-title" if fixture.fault == "dom-title-logout-error" else fixture.fault
                if fixture.fault == "second-view-error":
                    fault = "js" if fixture.asset_reads.get("index.html", 0) > 1 else ""
                return JSONResponse({"status": "ready", "fault": fault,
                                     "sentinel": SECRET_TEXT, "external": target_origin})
            if path == "v1/rooms":
                rooms = [{"id": ROOM, "slug": "synthetic", "label": "Synthetic"}]
                if fixture.fault == "multi-room":
                    rooms.insert(0, {"id": OTHER, "slug": "default", "label": "Default, not requested"})
                return JSONResponse({"rooms": rooms})
            if path.endswith("/state"):
                return JSONResponse({"entries": [], "next_key": None})
            if path.endswith("/participants"):
                if fixture.fault == "required-http":
                    return JSONResponse({"private": SECRET_TEXT}, status_code=500)
                rows = [{"session_id": SESSION, "title": TITLE, "label": "pi@synthetic/native",
                         "harness": "pi", "host": "synthetic", "native_session_id": "native",
                         "online": False, "native_state": "unknown", "muted": False, "stopped": True,
                         "plan_mode": True, "lane": None}]
                if fixture.fault == "api-title":
                    rows[0]["title"] = "Contrary independently specified title"
                if fixture.fault == "missing-session":
                    rows = []
                if fixture.fault in ("twenty", "overflow", "multi-room"):
                    rows += [{**rows[0], "session_id": f"66666666-6666-4666-8666-{i:012d}"} for i in range(19)]
                if fixture.fault == "multi-room" and path == f"v1/rooms/{OTHER}/participants":
                    rows = [{**rows[0], "session_id": PEER, "title": "Default-room private title"}]
                if fixture.mixed_presence:
                    # The API lists the offline target first and online sessions after it; the page lists the
                    # online ones first, so the page order differs from the API order.
                    online = {"online": True, "native_state": "idle", "stopped": False}
                    rows = [rows[0], *({**row, **online} for row in rows[1:]),
                            {**rows[0], **online, "session_id": ONLINE, "title": "Online synthetic peer"}]
                next_session = None
                if fixture.fault == "pagination":
                    last = request.query_params.get("after_session", "00000000-0000-0000-0000-000000000000")
                    next_session = f"77777777-7777-4777-8777-{int(last[-12:]) + 1:012d}"
                return JSONResponse({"participants": rows, "next_session_id": next_session})
            if path.endswith("/history"):
                receipt = {"session_id": PEER, "stored_at": "2026-01-01T00:00:00Z", "handed_at": None,
                           "acknowledged_at": None, "replying_message_id": None, "uncertainty_reason": None,
                           "delivery": None}
                messages = [{"id": MESSAGE, "room_id": path.split("/")[2], "thread_id": OTHER, "body": SECRET_TEXT,
                             "created_at": "2026-01-01T00:00:00Z", "kind": "message", "reply_to": None,
                             "recipients": [PEER], "thread_ref_key": None, "thread_resolved_at": None,
                             "sender": {"session_id": OTHER, "principal_id": OTHER,
                                        "title": (None if fixture.fault.startswith("untitled-sender")
                                                  else "Off-page synthetic sender"),
                                        "harness": "claude", "host": "synthetic"},
                             "receipts": [] if fixture.fault == "missing-receipt" else [receipt]}]
                return JSONResponse({"messages": [] if fixture.fault == "missing-message" else messages,
                                     "next_cursor": "1", "has_more": False, "position": "1", "retained_floor": "0"})
            assets = {"": ("index.html", HTML.encode(), "text/html"),
                      "ui/chat.js": ("chat.js", JS.encode(), "text/javascript"),
                      "ui/chat.css": ("chat.css", CSS.encode(), "text/css"),
                      "ui/Manrope-Variable.ttf": ("Manrope-Variable.ttf", b"", "font/ttf")}
            if path in assets:
                name, content, media = assets[path]
                fixture.asset_reads[name] = fixture.asset_reads.get(name, 0) + 1
                if fixture.production_assets or name == "Manrope-Variable.ttf":
                    content = WEB.joinpath(name).read_bytes()
                content = fixture.asset_overrides.get(name, content)
                if fixture.fault == "asset-drift" and name == "chat.js" and fixture.asset_reads[name] > 1:
                    content += b"\n// contrary served bytes\n"
                if name == "Manrope-Variable.ttf":
                    if fixture.fault == "download":
                        return Response(SECRET_TEXT, headers={
                            "Content-Disposition": 'attachment; filename="private.txt"'})
                    if fixture.fault == "redirect":
                        return RedirectResponse(target_origin + "/sink", status_code=302)
                return Response(content, media_type=media)
            return JSONResponse({"error": "UNEXPECTED_REQUEST"}, status_code=404)

        target = FastAPI()

        @target.api_route("/{path:path}", methods=["GET", "POST"])
        async def sink(request: Request) -> Response:
            fixture.target_calls.append(await request.body())
            return Response("unintended receiver")

        servers, threads = [], []
        try:
            for application, sock in ((app, listener), (target, external)):
                server = uvicorn.Server(uvicorn.Config(
                    application, ssl_certfile=str(certificate), ssl_keyfile=str(key), log_config=None,
                    access_log=False, lifespan="off", ws="none", proxy_headers=False, timeout_graceful_shutdown=2,
                ))
                thread = Thread(target=server.run, kwargs={"sockets": [sock]})
                servers.append(server)
                threads.append(thread)
                thread.start()
                deadline = time.monotonic() + 10
                while not server.started:
                    assert thread.is_alive() and time.monotonic() < deadline, "synthetic HTTPS startup failed"
                    time.sleep(0.01)
            yield fixture
        finally:
            for server in servers:
                server.should_exit = True
            for thread in threads:
                thread.join(timeout=5)
                assert not thread.is_alive(), "synthetic HTTPS server survived cleanup"


def _leaking_probe(marker: Path) -> dict[str, Any]:
    child = subprocess.Popen([sys.executable, "-c", "import signal; signal.pause()"],
                             env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    marker.write_text(str(child.pid))
    return {"cleanup": {"children": "PASS"}}


def test_isolated_cleanup_guard_rejects_and_reaps_a_real_owned_survivor(tmp_path: Path) -> None:
    marker = tmp_path / "owned-child"
    with pytest.raises(EOFError):
        isolated_supervise(_leaking_probe, marker)
    with pytest.raises(ProcessLookupError):
        os.kill(int(marker.read_text()), 0)


def execute(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, scenario: str = "snapshot",
    *, screenshot: bool = False, policy: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    updates: dict[str, Any] = {"origin": synthetic.origin}
    if synthetic.fault == "multi-room":
        updates["room_ids"] = [OTHER, ROOM]
    if policy is not None:
        updates["artifact_policy"] = policy
    path = binding_file(tmp_path, **updates)
    completed = invoke((synthetic.origin, synthetic.trust.certificate, synthetic.trust.spki),
                       argv(path, scenario) + (["--screenshot"] if screenshot else []))
    assert completed.stderr == ""
    print(completed.stdout, end="")
    status, data = completed.returncode, result(capsys)
    assert synthetic.target_calls == []
    assert not any(TOKEN.encode() in body for method, path, body in synthetic.calls if path != "/v1/login")
    assert sum(method == "POST" and path == "/v1/login" for method, path, body in synthetic.calls) == 1
    assert all(path in ("/v1/login", "/v1/logout") for method, path, body in synthetic.calls if method == "POST")
    return status, data


@pytest.mark.parametrize("scenario", ["snapshot", "session-title", "layout", "history-receipt"])
def test_real_chromium_named_scenarios_assert_content_and_cleanup(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, scenario: str,
) -> None:
    if scenario == "layout":
        synthetic.fault = "twenty"
    status, data = execute(synthetic, tmp_path, capsys, scenario)
    assert status == 0 and data["result"] == "PASS", why(data)
    assert data["cleanup"] == {name: "PASS" for name in ("logout", "context", "browser", "children", "temporary")}
    assert synthetic.logout_count == 1
    assert [(step["step"], step["outcome"], step["http_status"]) for step in data["cleanup_steps"]] == [
        ("logout", "ok", 200), ("confirm", "ok", 401)]
    assert [(step["step"], step["outcome"]) for step in data["close_steps"]] == [
        ("context", "ok"), ("browser", "ok"), ("driver", "ok")]
    assert all(type(step["elapsed_ms"]) is int and step["elapsed_ms"] >= 0 for step in data["close_steps"])
    assert {entry.get("viewport") for entry in data["assertions"] if "viewport" in entry} == {0, 1}
    assert data["viewports"] == [{"width": 1280, "height": 720}, {"width": 390, "height": 844}]


def test_an_untitled_sender_is_asserted_by_its_identity_alone(
    synthetic: Synthetic, tmp_path: Path, capsys: Any,
) -> None:
    synthetic.fault = "untitled-sender"
    status, data = execute(synthetic, tmp_path, capsys, "history-receipt")
    assert status == 0 and data["result"] == "PASS", why(data)


@pytest.mark.parametrize("scenario,production", [
    ("snapshot", False), ("snapshot", True), ("session-title", True), ("layout", True),
])
def test_the_roster_is_expected_online_first_not_in_the_api_order(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, scenario: str, production: bool,
) -> None:
    # The API page is [offline target, online ...] and the page lists online sessions first. The fixture rows are
    # otherwise all offline, so only a mixed page can show whether the verifier agrees with that presentation;
    # the actual UI assets show that it agrees with the real renderer and not only with the fixture's own markup.
    synthetic.mixed_presence = True
    synthetic.production_assets = production
    if scenario == "layout":
        synthetic.fault = "twenty"
    status, data = execute(synthetic, tmp_path, capsys, scenario)
    assert status == 0 and data["result"] == "PASS", why(data)
    assert synthetic.logout_count == 1


@pytest.mark.parametrize("fault", ["api-order", "retargeted-uuid", "dropped-participant", "duplicated-participant"])
def test_a_roster_other_than_the_online_first_page_still_fails_the_participant_ids_check(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, fault: str,
) -> None:
    # The API order is no longer what the page must show, but the exact row set still is: a missing, duplicated or
    # retargeted row fails, and so does a page that ignores the presentation order.
    synthetic.mixed_presence = True
    synthetic.fault = fault
    status, data = execute(synthetic, tmp_path, capsys, "snapshot")
    assert status == 1 and data["result"] == "FAIL" and "PARTICIPANT_IDS_MISMATCH" in codes(data), why(data)
    assert synthetic.logout_count == 1


@pytest.mark.parametrize("fault,scenario,expected,code", [
    ("dom-title", "session-title", "FAIL", "TITLE_DOM_MISMATCH"),
    ("retargeted-uuid", "snapshot", "FAIL", "PARTICIPANT_IDS_MISMATCH"),
    ("dom-body", "history-receipt", "FAIL", "MESSAGE_BODY_MISMATCH"),
    ("untitled-sender-repeated", "history-receipt", "FAIL", "SENDER_IDENTITY_MISMATCH"),
    ("pagination", "snapshot", "UNAVAILABLE", "PAGE_LIMIT"),
    ("browser-page-limit", "snapshot", "UNAVAILABLE", "PAGE_LIMIT"),
    ("browser-request-limit", "snapshot", "UNAVAILABLE", "REQUEST_LIMIT"),
    ("asset-drift", "snapshot", "FAIL", "ASSET_CHANGED"),
    ("", "layout", "UNAVAILABLE", "LAYOUT_DATA_UNAVAILABLE"),
    ("api-title", "session-title", "FAIL", "EXPECTED_TITLE_MISMATCH"),
    ("dom-receipt", "history-receipt", "FAIL", "RECEIPT_STATE_DOM_MISMATCH"),
    ("overflow", "layout", "FAIL", "DOCUMENT_OVERFLOW"),
    ("missing-session", "session-title", "UNAVAILABLE", "SESSION_UNAVAILABLE"),
    ("missing-message", "history-receipt", "UNAVAILABLE", "MESSAGE_UNAVAILABLE"),
    ("missing-receipt", "history-receipt", "UNAVAILABLE", "RECEIPT_UNAVAILABLE"),
    ("required-http", "snapshot", "FAIL", "REQUIRED_HTTP_ERROR"),
    ("js", "snapshot", "FAIL", "JAVASCRIPT_ERROR"),
    ("console", "snapshot", "FAIL", "CONSOLE_ERROR"),
    ("write-control", "snapshot", "FAIL", "MUTATION_CONTROL_ENABLED"),
    ("external", "snapshot", "FAIL", "ORIGIN_BLOCKED"),
    ("redirect", "snapshot", "FAIL", "REDIRECT_BLOCKED"),
    ("write", "snapshot", "FAIL", "ROUTE_BLOCKED"),
    ("popup", "snapshot", "FAIL", "JAVASCRIPT_ERROR"),
    ("worker", "snapshot", "FAIL", "JAVASCRIPT_ERROR"),
    ("service-worker", "snapshot", "FAIL", "JAVASCRIPT_ERROR"),
    ("websocket", "snapshot", "FAIL", "WEBSOCKET_BLOCKED"),
    ("download", "snapshot", "FAIL", "DOWNLOAD_BLOCKED"),
])
def test_real_chromium_contrary_states_are_red_capable_and_secret_free(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, fault: str, scenario: str, expected: str, code: str,
) -> None:
    synthetic.fault = fault
    status, data = execute(synthetic, tmp_path, capsys, scenario)
    assert status == 1 and data["result"] == expected and code in codes(data), (
        data["result"], sorted(codes(data)), data["requests"],
    )
    assert synthetic.logout_count == 1 and data["cleanup"]["logout"] == "PASS"
    assert data["cleanup"]["children"] == "PASS" and data["cleanup"]["temporary"] == "PASS"


@pytest.mark.parametrize("fault,expected", [("operator", "FAIL"), ("credential-purpose", "UNAVAILABLE"),
                                          ("login-redirect", "FAIL")])
def test_access_kind_and_login_redirect_stop_before_any_protected_read(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, fault: str, expected: str,
) -> None:
    synthetic.fault = fault
    status, data = execute(synthetic, tmp_path, capsys)
    assert status == 1 and data["result"] == expected, why(data)
    assert not any(path.startswith("/v1/rooms") for _, path, _ in synthetic.calls)
    assert synthetic.logout_count == 1
    if fault == "login-redirect":
        assert "REDIRECT_BLOCKED" in codes(data) and synthetic.target_calls == []


@pytest.mark.parametrize("fault,scenario,expected,logout", [
    ("logout-error", "snapshot", "UNAVAILABLE", ("http_status", 503)),
    ("logout-network", "snapshot", "UNAVAILABLE", ("timeout", None)),
    ("dom-title-logout-error", "session-title", "FAIL", ("http_status", 503)),
])
def test_uncertain_logout_never_upgrades_original_failure(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, fault: str, scenario: str, expected: str,
    logout: tuple[str, int | None],
) -> None:
    synthetic.fault = fault
    status, data = execute(synthetic, tmp_path, capsys, scenario)
    assert status == 1 and data["result"] == expected
    assert data["cleanup"]["logout"] == "UNAVAILABLE" and synthetic.logout_count == 1
    assert data["cleanup"]["context"] == "PASS" and data["cleanup"]["children"] == "PASS"
    # The uncertain exchange is named and classified; the confirmation is still attempted.
    steps = data["cleanup_steps"]
    assert [(step["step"], step["outcome"], step["http_status"]) for step in steps] == [
        ("logout", *logout), ("confirm", "ok", 200)]
    # Diagnostics are a closed vocabulary plus integers: no URL, cookie, CSRF, token or body text.
    text = json.dumps(steps)
    for secret in (TOKEN, CSRF, SECRET_TEXT, synthetic.origin, "127.0.0.1", "/v1/", "synthetic-cookie",
                   "Timeout", "https:"):
        assert secret not in text
    for step in steps:
        assert set(step) == {"step", "outcome", "http_status", "elapsed_ms", "idle_ms"}
        assert step["outcome"] in ("ok", "timeout", "http_status", "reset", "transport", "other", "deadline")
        assert step["http_status"] is None or type(step["http_status"]) is int
        assert type(step["elapsed_ms"]) is int and 0 <= step["elapsed_ms"] < verify.CLEANUP_SECONDS * 1000
        assert type(step["idle_ms"]) is int and step["idle_ms"] >= 0


def test_cleanup_step_classifies_errors_without_exception_or_url_text() -> None:
    from playwright.async_api import Error
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    url = f"https://127.0.0.1:8443/v1/logout?csrf={CSRF}"
    faults: list[tuple[BaseException | None, str, int | None]] = [
        (None, "ok", 401),
        (PlaywrightTimeout(f"Timeout 1000ms exceeded. {url} {TOKEN}"), "timeout", None),
        (Error(f"read ECONNRESET {url} cookie=synthetic-cookie"), "reset", None),
        (Error(f"socket hang up {url}"), "reset", None),
        (Error(f"connect ECONNREFUSED {url} {SECRET_TEXT}"), "transport", None),
        (verify.Stop("REQUIRED_HTTP_ERROR", http_status=503), "http_status", 503),
        (verify.Stop("REQUEST_LIMIT", "UNAVAILABLE"), "REQUEST_LIMIT", None),
        (RuntimeError(TOKEN), "other", None),
    ]

    async def observe() -> dict[str, Any]:
        fence = Fence(verify.Binding("https://chat.example", (ROOM,), TOKEN), verify.evidence())
        for fault, _, _ in faults:
            async def call(fault: BaseException | None = fault) -> dict[str, Any]:
                if fault is not None:
                    raise fault
                return {"_status": 401, "csrf_token": CSRF}
            await cleanup_step(fence, "logout", call)

        async def stalled() -> dict[str, Any]:
            await asyncio.sleep(5)
            return {}
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(cleanup_step(fence, "confirm", stalled), timeout=0.05)
        return fence.result

    data = asyncio.run(observe())
    steps = data["cleanup_steps"]
    assert [(step["outcome"], step["http_status"]) for step in steps] == [
        *((outcome, status) for _, outcome, status in faults), ("deadline", None)]
    text = json.dumps(steps)
    for secret in (TOKEN, CSRF, SECRET_TEXT, "127.0.0.1", "/v1/", "synthetic-cookie", "ECONN", "hang up"):
        assert secret not in text
    assert all(type(step["elapsed_ms"]) is int and type(step["idle_ms"]) is int for step in steps)
    assert data["assertions"] == [] and data["cleanup"]["logout"] == "NOT_RUN"


def test_untrusted_fixture_tls_never_enables_a_production_tls_bypass(
    synthetic: Synthetic, tmp_path: Path, capsys: Any,
) -> None:
    path = binding_file(tmp_path, origin=synthetic.origin)
    completed = invoke(None, argv(path))
    assert completed.returncode == 1 and completed.stderr == ""
    print(completed.stdout, end="")
    data = result(capsys)
    assert data["result"] == "UNAVAILABLE" and "AUTH_TRANSPORT_UNAVAILABLE" in codes(data)
    assert not any(method == "POST" for method, _, _ in synthetic.calls)
    assert synthetic.target_calls == []


def test_partial_browser_start_still_closes_every_acquired_resource(tmp_path: Path, monkeypatch: Any) -> None:
    closed = []

    async def close_browser() -> None:
        closed.append("browser")

    async def stop_driver() -> None:
        closed.append("driver")

    _partial_start(monkeypatch, close=close_browser, stop=stop_driver)
    request = verify.parse(argv(binding_file(tmp_path)))
    data = asyncio.run(run(request, verify.read_binding(request.binding)))
    assert data["result"] == "FAIL" and data["cleanup"]["browser"] == "PASS"
    assert closed == ["browser", "driver"]
    assert TOKEN not in json.dumps(data)


async def _hang() -> None:
    await asyncio.sleep(5)


async def _refuse() -> None:
    raise RuntimeError(TOKEN)


async def _quit() -> None:
    return None


async def _slow() -> None:
    await asyncio.sleep(1.5)


async def _stubborn() -> None:
    """A close that ignores its own timeout: cancelling it starts more work."""
    try:
        await asyncio.sleep(5)
    finally:
        await asyncio.sleep(5)


def _partial_start(monkeypatch: Any, close: Any, stop: Any) -> None:
    """A fake Playwright whose context creation fails, so only the browser and driver closes run."""
    import playwright.async_api

    class Browser:
        async def new_context(self, **kwargs: Any) -> None:
            raise RuntimeError(TOKEN)

        def close(self) -> Any:
            return close()

    class Driver:
        chromium: Any

        def __init__(self) -> None:
            self.chromium = self

        async def launch(self, **kwargs: Any) -> Browser:
            return Browser()

        async def start(self) -> Driver:
            return self

        def stop(self) -> Any:
            return stop()

    monkeypatch.setattr(playwright.async_api, "async_playwright", Driver)


def test_a_close_slower_than_one_second_completes_within_its_share(tmp_path: Path, monkeypatch: Any) -> None:
    _partial_start(monkeypatch, close=_slow, stop=_quit)
    request = verify.parse(argv(binding_file(tmp_path)))
    data = asyncio.run(run(request, verify.read_binding(request.binding)))
    steps = data["close_steps"]
    # The browser needs 1.5 s; its share of the closing time is about 3 s, so the close is neither cut nor failed.
    assert [(step["step"], step["outcome"]) for step in steps] == [("browser", "ok"), ("driver", "ok")]
    assert steps[0]["elapsed_ms"] >= 1500
    assert data["cleanup"]["browser"] == "PASS" and data["result"] == "FAIL"
    assert TOKEN not in json.dumps(data)


def test_close_steps_name_the_slow_browser_and_the_failed_driver(tmp_path: Path, monkeypatch: Any) -> None:
    _partial_start(monkeypatch, close=_hang, stop=_refuse)
    # The cleanup budget is CLEANUP_SECONDS - 2 = 2 s, 1.5 s of it for the closes: 0.75 s for each of the two.
    monkeypatch.setattr("agent_chat.browser_verify_run.CLEANUP_SECONDS", 4.0)
    request = verify.parse(argv(binding_file(tmp_path)))
    data = asyncio.run(run(request, verify.read_binding(request.binding)))
    steps = data["close_steps"]
    assert [(step["step"], step["outcome"]) for step in steps] == [("browser", "timeout"), ("driver", "other")]
    # A hung close is cut at its share and the driver still gets its attempt; a failed driver stop is reported as
    # the browser's cleanup.
    assert all(type(step["elapsed_ms"]) is int for step in steps)
    assert 700 <= steps[0]["elapsed_ms"] < 2000 and steps[1]["elapsed_ms"] < 700
    assert data["cleanup"]["browser"] == "UNAVAILABLE" and data["result"] == "FAIL"
    assert TOKEN not in json.dumps(data)


def test_close_steps_record_a_close_that_the_cleanup_budget_cancels(tmp_path: Path, monkeypatch: Any) -> None:
    _partial_start(monkeypatch, close=_stubborn, stop=_quit)
    # The cleanup budget is CLEANUP_SECONDS - 2 = 2 s and the browser's share of it 0.75 s. The close outlasts both
    # because cancelling it starts more work, so it is the budget that cancels it.
    monkeypatch.setattr("agent_chat.browser_verify_run.CLEANUP_SECONDS", 4.0)
    request = verify.parse(argv(binding_file(tmp_path)))
    data = asyncio.run(run(request, verify.read_binding(request.binding)))
    steps = data["close_steps"]
    assert [(step["step"], step["outcome"]) for step in steps] == [("browser", "deadline")]
    assert type(steps[0]["elapsed_ms"]) is int and 1500 <= steps[0]["elapsed_ms"] < 4000
    assert data["cleanup"]["browser"] == "UNAVAILABLE"


def test_why_names_the_logout_steps_and_the_resource_closes() -> None:
    data = verify.evidence()
    data["cleanup_steps"].append(
        {"step": "logout", "outcome": "ok", "http_status": 200, "elapsed_ms": 45, "idle_ms": 7})
    data["close_steps"].append({"step": "browser", "outcome": "timeout", "elapsed_ms": 1001})
    data["cleanup"]["browser"] = "UNAVAILABLE"
    message = why(data)
    assert "step.logout:ok:200:45ms:idle7ms" in message
    assert "close.browser:timeout:1001ms" in message and "cleanup.browser:UNAVAILABLE" in message
    assert why({}) == "None requests=None: "


def test_why_caps_the_whole_message_on_a_token_boundary() -> None:
    data = verify.evidence()
    data["cleanup_steps"] = [
        {"step": f"logout{index}", "outcome": "ok", "http_status": 200, "elapsed_ms": 45, "idle_ms": 7}
        for index in range(3)]
    data["assertions"] = [{"code": f"CODE_{index}_LONGNAME", "result": "FAIL"} for index in range(40)]
    message = why(data)
    assert len(message) <= 512 and message.startswith(f"{data['result']} requests={data['requests']}: ")
    tokens = message.split(": ", 1)[1].split("; ")
    assert tokens[0].startswith("step.logout0:") and all(
        token.startswith("step.") or re.fullmatch(r"CODE_\d+_LONGNAME:FAIL", token) for token in tokens)


def _crash_probe(request: verify.Request, binding: verify.Binding, marker: Path, hang: bool) -> dict[str, Any]:
    original = subprocess.Popen
    baseline = verify._children(os.getpid())
    code = (
        "import json, os, pathlib, signal, subprocess, sys; "
        "child=subprocess.Popen([sys.executable, '-c', 'import signal; signal.pause()'], "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True); "
        f"pathlib.Path({str(marker)!r}).write_text(str(child.pid)); "
        "payload=json.load(sys.stdin); target=payload['artifact_target']; "
        "fd=os.open('capture-0.png', os.O_WRONLY|os.O_CREAT|os.O_EXCL, "
        "0o600, dir_fd=target['fd']) if target else None; "
        f"os.write(fd, {png_pixel()!r}) if fd is not None else None; "
        "os.close(fd) if fd is not None else None; "
        + ("signal.pause()" if hang else "sys.exit(3)")
    )

    ready_at = 0.0

    def worker(argv: list[str], **kwargs: Any) -> Any:
        nonlocal ready_at
        assert argv == [sys.executable, "-I", "-m", "agent_chat.browser_verify_run"]
        child = original([sys.executable, "-I", "-c", code], **kwargs)
        # Establish startup before applying the short deadline: elapsed timeout is
        # the subject of this test, not interpreter startup performance.
        deadline = time.monotonic() + 60
        try:
            while not marker.exists():
                assert child.poll() is None and time.monotonic() < deadline
                time.sleep(0.01)
            ready_at = time.monotonic()
            return child
        finally:
            if not ready_at:
                child.kill()
                child.wait(timeout=5)
                verify._reap_owned(baseline, time.monotonic() + 1)

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(verify.subprocess, "Popen", worker)
        monkeypatch.setattr(verify, "RUN_SECONDS", 0.2)
        return verify.supervise(request, binding)


@pytest.mark.parametrize("hang", [False, True])
@pytest.mark.parametrize("screenshots", [False, True])
def test_supervisor_reaps_owned_detached_children_after_crash_or_deadline(
    tmp_path: Path, hang: bool, screenshots: bool,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    path = binding_file(tmp_path, **({"artifact_policy": {"root": str(root), "retention_seconds": 3600}}
                                   if screenshots else {}))
    request = verify.parse(argv(path, "session-title") + (["--screenshot"] if screenshots else []))
    binding = verify.read_binding(path)
    marker = tmp_path / "owned-child"
    started = time.monotonic()
    data = isolated_supervise(_crash_probe, request, binding, marker, hang)
    assert marker.exists() and time.monotonic() - started < 10
    assert data["result"] == ("UNAVAILABLE" if hang else "FAIL")
    assert data["cleanup"]["children"] == "PASS" and data["cleanup"]["temporary"] == "PASS"
    assert list(root.iterdir()) == [] and data["artifacts"] == []
    if screenshots:
        assert data["cleanup"]["artifacts"] == "PASS"
    with pytest.raises(ProcessLookupError):
        os.kill(int(marker.read_text()), 0)


@pytest.mark.parametrize("boundary", ["isolated_supervise", "invoke"])
def test_verifier_cleanup_does_not_claim_new_postgres_fixture_children(
    tmp_path: Path, postgres_cluster: str, synthetic: Synthetic, capsys: Any,
    monkeypatch: pytest.MonkeyPatch, boundary: str,
) -> None:
    original = globals()[boundary]
    with ExitStack() as clients:
        def with_fixture_backend(*args: Any, **kwargs: Any) -> Any:
            # Start a real fixture backend after the caller's baseline snapshot.
            # Keep it alive through every assertion, not for a fixed lifetime.
            connection = clients.enter_context(psycopg.connect(postgres_cluster))
            assert connection.info.backend_pid in verify._children(os.getpid())
            return original(*args, **kwargs)

        monkeypatch.setitem(globals(), boundary, with_fixture_backend)
        if boundary == "isolated_supervise":
            test_supervisor_reaps_owned_detached_children_after_crash_or_deadline(tmp_path, False, False)
        else:
            status, data = execute(synthetic, tmp_path, capsys)
            assert status == 0 and data["result"] == "PASS", why(data)


def _cleanup_probe(request: verify.Request, binding: verify.Binding, artifact_close: bool = False) -> dict[str, Any]:
    data = verify.evidence(request, binding)
    verify.record(data, "ORIGINAL_ASSERTION", "PASS" if artifact_close else "FAIL")
    if artifact_close:
        data["cleanup"] = dict.fromkeys(data["cleanup"], "PASS")
    temporary = verify.tempfile.TemporaryDirectory

    class FailingCleanup:
        def __init__(self, **kwargs: Any) -> None:
            self.directory = temporary(**kwargs)

        def __enter__(self) -> str:
            return self.directory.__enter__()

        def __exit__(self, *args: Any) -> None:
            self.directory.__exit__(*args)
            raise OSError(TOKEN)

    class Worker:
        returncode = 0

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def communicate(self, *args: Any, **kwargs: Any) -> tuple[bytes, None]:
            if artifact_close:
                target = json.loads(args[0])["artifact_target"]
                for number in range(2):
                    fd = os.open(f"capture-{number}.png", os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                 0o600, dir_fd=target["fd"])
                    try:
                        os.write(fd, png_pixel())
                    finally:
                        os.close(fd)
            return json.dumps(data).encode(), None

        def poll(self) -> int:
            return 0

        def wait(self, **kwargs: Any) -> int:
            return 0

    def refuse_close(self: Artifacts) -> None:
        raise OSError(TOKEN)

    with pytest.MonkeyPatch.context() as monkeypatch:
        if artifact_close:
            monkeypatch.setattr(Artifacts, "close", refuse_close)
        else:
            monkeypatch.setattr(verify.tempfile, "TemporaryDirectory", FailingCleanup)
        monkeypatch.setattr(verify.subprocess, "Popen", Worker)
        return verify.supervise(request, binding)


def test_parent_cleanup_error_keeps_original_worker_assertion(tmp_path: Path) -> None:
    path = binding_file(tmp_path)
    request, binding = verify.parse(argv(path)), verify.read_binding(path)
    observed = isolated_supervise(_cleanup_probe, request, binding)
    assert observed["result"] == "FAIL" and "ORIGINAL_ASSERTION" in codes(observed)
    assert observed["cleanup"]["temporary"] == "UNAVAILABLE" and TOKEN not in json.dumps(observed)


def test_artifact_close_failure_attempts_discard_and_withholds_paths(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    path = binding_file(tmp_path, artifact_policy={"root": str(root), "retention_seconds": 3600})
    request = verify.parse(argv(path, "session-title") + ["--screenshot"])
    observed = isolated_supervise(_cleanup_probe, request, verify.read_binding(path), True)
    assert observed["result"] == "UNAVAILABLE"
    assert observed["artifacts"] == [] and list(root.iterdir()) == []
    assert observed["cleanup"]["artifacts"] == "UNAVAILABLE" and observed["retention"] == "UNAVAILABLE"
    assert "ARTIFACT_CLEANUP_UNAVAILABLE" in codes(observed) and TOKEN not in json.dumps(observed)


def test_actual_production_assets_load_through_https_fence_without_static_copies(
    synthetic: Synthetic, monkeypatch: Any,
) -> None:
    # This is an asset/renderer boundary, not a claim that this baseline's operator
    # UI already implements the separately-owned viewer presentation contract.
    synthetic.production_assets = True
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(synthetic.trust.certificate))

    async def inspect_assets() -> dict[str, Any]:
        from playwright.async_api import async_playwright

        data = verify.evidence()
        fence = Fence(verify.Binding(synthetic.origin, (ROOM,), TOKEN), data)
        async with async_playwright() as driver:
            browser = await driver.chromium.launch(
                args=["--ignore-certificate-errors-spki-list=" + synthetic.trust.spki], timeout=15000,
            )
            context = None
            authenticated = False
            try:
                context = await browser.new_context(service_workers="block", accept_downloads=False)
                await context.route("**/*", fence.route)
                challenge = await fence.api(context, "/v1/login")
                await fence.api(context, "/v1/login", method="POST", body={"token": TOKEN},
                                csrf=challenge["csrf_token"])
                authenticated = True
                bootstrap = await fence.api(context, "/v1/browser/session")
                assert bootstrap["access"] == "viewer"
                fence.viewer = True
                page = await context.new_page()
                page.on("requestfailed", fence.request_failed)
                page.on("console", fence.console)
                page.on("pageerror", lambda _: verify.record(data, "JAVASCRIPT_ERROR", "FAIL"))
                await fence.navigate(page)
                await page.evaluate("document.fonts.ready")
                assert await page.locator("#messages .body").text_content() == SECRET_TEXT
                assert not any(item["result"] != "PASS" for item in data["assertions"]), why(data)
                return data
            finally:
                try:
                    if context is not None and authenticated:
                        await fence.api(context, "/v1/logout", method="POST", body={}, csrf=CSRF, cleanup=True)
                finally:
                    try:
                        if context is not None:
                            await context.close()
                    finally:
                        await browser.close()

    observed = asyncio.run(inspect_assets())
    assert observed["served_hashes"] == {
        name: hashlib.sha256(WEB.joinpath(name).read_bytes()).hexdigest()
        for name in ("index.html", "chat.js", "chat.css", "Manrope-Variable.ttf")
    }
    assert synthetic.target_calls == [] and synthetic.logout_count == 1


@pytest.mark.parametrize("name,base,contrary", [
    ("index.html", HTML.encode(), (HTML + "<!-- contrary document -->").encode()),
    ("chat.js", JS.encode(), (JS + "\n// contrary script\n").encode()),
    ("chat.css", CSS.encode(), (CSS + "\n/* contrary style */\n").encode()),
])
def test_served_hashes_follow_actual_bytes_not_local_or_placeholder_hashes(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, name: str, base: bytes, contrary: bytes,
) -> None:
    synthetic.asset_overrides[name] = contrary
    status, data = execute(synthetic, tmp_path, capsys)
    assert status == 0 and data["result"] == "PASS", why(data)
    assert data["served_hashes"][name] == hashlib.sha256(contrary).hexdigest()
    assert data["served_hashes"][name] != hashlib.sha256(base).hexdigest()
    assert data["source_ref"] == "unknown"


def test_layout_restores_requested_room_after_each_reload(
    synthetic: Synthetic, tmp_path: Path, capsys: Any,
) -> None:
    synthetic.fault = "multi-room"
    status, data = execute(synthetic, tmp_path, capsys, "layout")
    assert status == 0 and data["result"] == "PASS", json.dumps(data)
    assert {entry["viewport"] for entry in data["assertions"] if entry["code"] == "LAYOUT_GEOMETRY"} == {0, 1}
    # Different participants in the default room make a missed post-reload
    # selection fail the actual UUID comparison, not just a mocked select call.
    assert any(path == f"/v1/rooms/{OTHER}/participants" for _, path, _ in synthetic.calls)
    assert sum(path == f"/v1/rooms/{ROOM}/participants" for _, path, _ in synthetic.calls) >= 8


@pytest.mark.parametrize("limit", ["PAGE_LIMIT", "REQUEST_LIMIT"])
def test_intentional_limit_abort_preserves_unavailable_but_other_network_errors_fail(limit: str) -> None:
    data = verify.evidence()
    fence = Fence(verify.Binding("https://chat.example", (ROOM,), TOKEN), data)
    fence.viewer = True
    url = f"https://chat.example/v1/rooms/{ROOM}/participants?limit=50&after_session=" + SESSION
    if limit == "REQUEST_LIMIT":
        data["requests"] = 197
    else:
        fence.pages[(ROOM, "participants")] = {ROOM, OTHER, PEER, MESSAGE, "initial"}
    request = SimpleNamespace(url=url, method="GET", resource_type="fetch", redirected_from=None)

    class NetworkRequest:
        url = request.url
        method = request.method
        resource_type = request.resource_type
        redirected_from = None

    original = NetworkRequest()

    class Route:
        request = original

        async def abort(self) -> None:
            fence.request_failed(self.request)
            fence.console(SimpleNamespace(type="error", location={"url": url},
                                          text="Failed to load resource: net::ERR_FAILED"))

        async def fetch(self, **kwargs: Any) -> None:
            pytest.fail("bounded request reached transport")

    asyncio.run(fence.route(Route()))
    verify.verdict(data)
    assert data["result"] == "UNAVAILABLE" and codes(data) == {limit}, why(data)
    assert not fence.intentional_aborts
    # Even the same URL must not turn a different, genuinely failed request into
    # an intentional abort. Arbitrary console diagnostics must still fail too.
    fence.request_failed(NetworkRequest())
    fence.console(SimpleNamespace(type="error", location={"url": url}, text=SECRET_TEXT))
    verify.verdict(data)
    assert data["result"] == "FAIL" and {"REQUEST_FAILED", "CONSOLE_ERROR"} <= codes(data)


def png_pixel() -> bytes:
    def chunk(kind: bytes, value: bytes) -> bytes:
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00")) + chunk(b"IEND", b""))


@pytest.mark.parametrize("policy", [
    {"root": "relative", "retention_seconds": 24}, {"root": "/tmp/a", "retention_seconds": 86401},
    {"root": "/tmp/a", "retention_seconds": 0}, {"root": "/tmp/a", "retention_seconds": True},
    {"root": "/tmp/a", "retention_seconds": "3600"},
    {"root": "/tmp/a", "retention_seconds": 3600, "registered": True},
])
def test_artifact_policy_is_closed_private_binding_input_only(tmp_path: Path, policy: dict[str, Any]) -> None:
    with pytest.raises(verify.Stop, match="BINDING_INVALID"):
        verify.read_binding(binding_file(tmp_path, artifact_policy=policy))


@pytest.mark.parametrize("fault", ["root-mode", "root-symlink", "ancestor-symlink", "missing-root"])
def test_artifact_root_is_never_provisioned_or_symlink_traversed(tmp_path: Path, fault: str) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    if fault == "root-mode":
        root.chmod(0o750)
    elif fault == "root-symlink":
        target = root.with_name("real")
        root.rename(target)
        root.symlink_to(target, target_is_directory=True)
    elif fault == "ancestor-symlink":
        link = tmp_path / "link"
        link.symlink_to(tmp_path, target_is_directory=True)
        root = link / "artifacts"
    else:
        root.rmdir()
    with pytest.raises((verify.Stop, OSError)):
        Artifacts.create(verify.ArtifactPolicy(root, 3600))
    assert not list(tmp_path.rglob("*.png"))


def test_artifact_descriptors_enforce_private_no_overwrite_count_and_byte_limits(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    artifacts = Artifacts.create(verify.ArtifactPolicy(root, 3600))
    try:
        for number in range(4):
            artifacts.save(number, png_pixel())
        paths = artifacts.paths(expected=4)
        assert len(paths) == 4
        for path in paths:
            info = Path(path).stat()
            assert info.st_mode & 0o777 == 0o600 and info.st_uid == os.geteuid() and info.st_nlink == 1
            assert Path(path).read_bytes() == png_pixel()
        with pytest.raises(FileExistsError):
            artifacts.save(0, png_pixel())
        with pytest.raises(verify.Stop, match="ARTIFACT_LIMIT"):
            artifacts.save(4, png_pixel())
        with pytest.raises(verify.Stop, match="ARTIFACT_LIMIT"):
            artifacts.save(0, b"\x89PNG\r\n\x1a\n" + b"x" * 5242881)
        assert Path(paths[0]).read_bytes() == png_pixel()
    finally:
        try:
            artifacts.discard()
        finally:
            artifacts.close()
    assert list(root.iterdir()) == []


def test_artifact_symlink_collision_and_swapped_root_cannot_overwrite_files(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    outside = tmp_path / "untouched"
    outside.write_bytes(b"independent outside sentinel")
    artifacts = Artifacts.create(verify.ArtifactPolicy(root, 3600))
    try:
        link = root / artifacts.name / "capture-0.png"
        link.symlink_to(outside)
        with pytest.raises(FileExistsError):
            artifacts.save(0, png_pixel())
        assert outside.read_bytes() == b"independent outside sentinel" and link.is_symlink()
        root.rename(tmp_path / "moved")
        root.mkdir(mode=0o700)
        with pytest.raises(verify.Stop, match="ARTIFACT_UNSAFE"):
            artifacts.save(1, png_pixel())
        assert list(root.iterdir()) == []
    finally:
        try:
            artifacts.discard()
        finally:
            artifacts.close()


@pytest.mark.parametrize("scenario", ["session-title", "layout", "history-receipt"])
def test_opt_in_https_screenshots_are_private_bounded_and_policy_owned(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, scenario: str,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    if scenario == "layout":
        synthetic.fault = "twenty"
    status, data = execute(synthetic, tmp_path, capsys, scenario, screenshot=True,
                           policy={"root": str(root), "retention_seconds": 3600})
    assert status == 0 and data["result"] == "PASS", why(data)
    assert len(data["artifacts"]) == 2 and data["retention_seconds"] == 3600 and data["expiry"] == "NOT_RUN"
    assert data["cleanup"]["artifacts"] == "PASS"
    for name in data["artifacts"]:
        path = Path(name)
        assert root in path.parents and not path.is_symlink() and path.stat().st_mode & 0o777 == 0o600
        assert path.parent.stat().st_mode & 0o777 == 0o700 and path.stat().st_size <= 5242880
        content = path.read_bytes()
        assert content.startswith(b"\x89PNG\r\n\x1a\n")
        assert all(value.encode() not in content for value in (TOKEN, CSRF, SECRET_TEXT, TITLE))


def test_snapshot_scenario_refuses_screenshot_before_any_browser_launch(
    tmp_path: Path, monkeypatch: Any, capsys: Any,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    path = binding_file(tmp_path, artifact_policy={"root": str(root), "retention_seconds": 3600})
    monkeypatch.setattr(verify.subprocess, "Popen", lambda *a, **kw: pytest.fail("unapproved browser launch"))
    assert verify.main(argv(path, "snapshot") + ["--screenshot"]) == 1
    data = result(capsys)
    assert data["result"] == "UNAVAILABLE" and "SCREENSHOT_SCENARIO_UNAVAILABLE" in codes(data)
    assert data["artifacts"] == [] and data["expiry"] == "NOT_RUN" and list(root.iterdir()) == []


def test_mask_failure_has_no_unmasked_fallback_or_retained_images(
    synthetic: Synthetic, tmp_path: Path, capsys: Any,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    synthetic.fault = "mask-failure"
    status, data = execute(synthetic, tmp_path, capsys, "session-title", screenshot=True,
                           policy={"root": str(root), "retention_seconds": 86400})
    assert status == 1 and data["result"] == "FAIL" and "CAPTURE_MASK_FAILED" in codes(data), why(data)
    assert data["artifacts"] == [] and list(root.iterdir()) == [] and synthetic.logout_count == 1


@pytest.mark.parametrize("fault,expected", [("second-view-error", "FAIL"), ("logout-network", "UNAVAILABLE")])
def test_failed_second_view_or_cleanup_discards_already_captured_private_images(
    synthetic: Synthetic, tmp_path: Path, capsys: Any, fault: str, expected: str,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    synthetic.fault = fault
    status, data = execute(synthetic, tmp_path, capsys, "session-title", screenshot=True,
                           policy={"root": str(root), "retention_seconds": 3600})
    assert status == 1 and data["result"] == expected, why(data)
    assert "SCREENSHOT_CAPTURE" in codes(data) and data["artifacts"] == [] and list(root.iterdir()) == []
    assert data["cleanup"]["artifacts"] == "PASS"


@pytest.mark.parametrize("fault,code", [("mask", "CAPTURE_MASK_FAILED"), ("mutation", "CAPTURE_MASK_FAILED"),
                                       ("capture", "CAPTURE_FAILED"), ("size", "ARTIFACT_LIMIT"),
                                       ("mask-cleanup", "CAPTURE_MASK_FAILED")])
def test_capture_faults_never_write_or_retry_an_unmasked_frame(
    tmp_path: Path, fault: str, code: str,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    artifacts = Artifacts.create(verify.ArtifactPolicy(root, 3600))
    request = verify.parse(argv(binding_file(tmp_path), "session-title") + ["--screenshot"])
    captured = []

    class Component:
        async def count(self) -> int:
            return 1

        async def is_visible(self) -> bool:
            return True

        async def bounding_box(self) -> dict[str, int]:
            return {"width": 100, "height": 100}

        async def evaluate(self, script: str, value: Any) -> Any:
            if "masked.length" in script:
                return {"safe": fault != "mask", "count": 1}
            return fault != "mutation"

        async def screenshot(self, **kwargs: Any) -> bytes:
            assert fault != "mask", "missing mask invoked screenshot"
            assert kwargs["mask_color"] == "#000000" and "path" not in kwargs
            captured.append(kwargs)
            if fault == "capture":
                raise RuntimeError(TOKEN + SECRET_TEXT)
            return png_pixel() if fault != "size" else b"\x89PNG\r\n\x1a\n" + b"x" * 5242881

    class Page:
        def locator(self, selector: str) -> Component:
            return Component()

        async def evaluate(self, script: str) -> None:
            if fault == "mask-cleanup":
                raise RuntimeError(CSRF)

    try:
        with pytest.raises(verify.Stop, match=code):
            asyncio.run(capture(request, Page(), artifacts, 0, viewer=True))
        assert len(captured) <= 1
        assert list((root / artifacts.name).iterdir()) == []
    finally:
        try:
            artifacts.discard()
        finally:
            artifacts.close()


def png_colors(content: bytes) -> set[tuple[int, int, int]]:
    # Independent PNG pixel decoding makes this a red-capable privacy assertion,
    # not a vacuous search for plaintext inside compressed screenshot bytes.
    offset, compressed = 8, bytearray()
    width = height = channels = 0
    while offset < len(content):
        size = int.from_bytes(content[offset:offset + 4], "big")
        kind = content[offset + 4:offset + 8]
        value = content[offset + 8:offset + 8 + size]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", value)
            assert depth == 8 and color in (2, 6) and interlace == 0
            channels = 3 if color == 2 else 4
        elif kind == b"IDAT":
            compressed.extend(value)
        offset += 12 + size
    raw = zlib.decompress(compressed)
    stride = width * channels
    previous = bytearray(stride)
    colors = set()
    for line in range(height):
        start = line * (stride + 1)
        filtering, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for index in range(stride):
            left = row[index - channels] if index >= channels else 0
            up = previous[index]
            corner = previous[index - channels] if index >= channels else 0
            if filtering == 1:
                predict = left
            elif filtering == 2:
                predict = up
            elif filtering == 3:
                predict = (left + up) // 2
            elif filtering == 4:
                p = left + up - corner
                predict = min((left, up, corner), key=lambda candidate: abs(p - candidate))
            else:
                assert filtering == 0
                predict = 0
            row[index] = (row[index] + predict) & 255
        colors.update((row[i], row[i + 1], row[i + 2]) for i in range(0, stride, channels))
        previous = row
    return colors


def test_real_screenshot_masks_unknown_private_text_and_unrelated_details_in_pixels(
    tmp_path: Path, browser_capability: None,
) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o700)
    artifacts = Artifacts.create(verify.ArtifactPolicy(root, 3600))
    request = verify.parse(argv(binding_file(tmp_path), "session-title") + ["--screenshot"])

    async def inspect_mask() -> tuple[bytes, bytes]:
        from playwright.async_api import async_playwright

        async with async_playwright() as driver:
            browser = await driver.chromium.launch(timeout=15000)
            context = None
            try:
                context = await browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
                page = await context.new_page()
                await page.set_content(f"""<section id=viewer data-access=viewer>
                  <p id=read-only-indicator>Read only</p><ul id=participants>
                  <li data-session-id='{SESSION}' style='width:300px;background:white'>
                    <bdi class=session-title style='display:block;background:rgb(0,255,0)'></bdi>
                    <div class=participant-id style='background:rgb(255,0,255)'>{TOKEN}</div>
                    <div class=participant-label style='background:rgb(255,0,255)'>{CSRF}</div>
                    <div class=unknown-private-detail style='background:rgb(255,0,255)'></div>
                  </li><li style='background:rgb(0,0,255)'>Unrelated session private title</li></ul>
                  <p class=body style='position:fixed;top:0;background:rgb(0,0,255)'>Unrelated body</p></section>""")
                await page.locator(".session-title").evaluate("(node, title) => node.textContent = title", TITLE)
                await page.locator(".unknown-private-detail").evaluate(
                    "(node, text) => node.textContent = text", SECRET_TEXT)
                component = page.locator(f"li[data-session-id='{SESSION}']")
                unmasked = await component.screenshot(type="png")
                await capture(request, page, artifacts, 0, viewer=True)
                return unmasked, Path(artifacts.paths(expected=1)[0]).read_bytes()
            finally:
                try:
                    if context is not None:
                        await context.close()
                finally:
                    await browser.close()

    try:
        unmasked, masked = asyncio.run(inspect_mask())
        assert (255, 0, 255) in png_colors(unmasked), "negative control did not expose private fixture pixels"
        colors = png_colors(masked)
        assert (255, 0, 255) not in colors and (0, 0, 255) not in colors
        assert (0, 255, 0) in colors and (0, 0, 0) in colors
        assert all(value.encode() not in masked for value in (TOKEN, CSRF, SECRET_TEXT, TITLE))
    finally:
        try:
            artifacts.discard()
        finally:
            artifacts.close()


def test_module_cli_isolated_python_has_no_raw_parse_traceback(tmp_path: Path) -> None:
    completed = subprocess.run(
        [sys.executable, "-I", "-m", "agent_chat.browser_verify", "--token", TOKEN],
        capture_output=True, timeout=60, check=False,
    )
    assert completed.returncode == 1 and completed.stderr == b""
    assert TOKEN.encode() not in completed.stdout
    assert json.loads(completed.stdout)["result"] == "FAIL"
