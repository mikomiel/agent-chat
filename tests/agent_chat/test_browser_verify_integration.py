"""The isolated command against the real viewer API, schema and production renderer."""
from __future__ import annotations

import base64
import hashlib
import json
import socket
import subprocess
import time
from pathlib import Path
from threading import Thread
from typing import Any
from uuid import uuid4

import pytest
import uvicorn

from agent_chat import receipts, sessions
from agent_chat.api import create_app
from agent_chat.models import Heartbeat, Publication
from agent_chat.publication import publish

from .test_browser_verify import invoke
from .test_ui import tls_cert as tls_cert
from .test_viewer import snapshot


@pytest.fixture
def viewer_https(database: str, db: Any, tls_cert: tuple[Path, Path]) -> Any:
    cert, key = tls_cert
    public = subprocess.run(["openssl", "x509", "-in", str(cert), "-pubkey", "-noout"],
                            check=True, capture_output=True, timeout=10).stdout
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "der"], input=public,
                         check=True, capture_output=True, timeout=10).stdout
    pin = base64.b64encode(hashlib.sha256(der).digest()).decode()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        origin = f"https://127.0.0.1:{listener.getsockname()[1]}"
        server = uvicorn.Server(uvicorn.Config(
            create_app(database, enabled=True, public_origin=origin),
            ssl_certfile=str(cert), ssl_keyfile=str(key), log_config=None, access_log=False,
            lifespan="off", ws="none", proxy_headers=False, timeout_graceful_shutdown=3,
        ))
        thread = Thread(target=server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline
                time.sleep(0.01)
            yield origin, cert, pin
        finally:
            server.should_exit = True
            thread.join(timeout=8)
            assert not thread.is_alive(), "isolated HTTPS server survived teardown"


@pytest.mark.parametrize("scenario,title", [
    ("snapshot", None), ("session-title", None), ("session-title", "duplicate"),
    ("session-title", "<img src=x onerror=alert(1)>"), ("layout", "🧪" * 128),
    ("history-receipt", "Native synthetic sender"),
])
def test_command_observes_real_viewer_service_without_chat_effects(
    viewer_https: Any, db: Any, actors: Any, actor_factory: Any, make_viewer: Any,
    tmp_path: Path, scenario: str, title: str | None,
) -> None:
    room, first, peer, _ = actors
    participants = [first, peer, *(actor_factory(room) for _ in range(18))]
    for actor in participants:
        sessions.heartbeat(db, actor, Heartbeat(native_state="idle", stopped=False, plan_mode=False, title=title))
    message = publish(db, first, room, uuid4(), Publication(
        kind="question", body="PRIVATE-BODY-INTEGRATION-SENTINEL", recipients=(peer.session_id,),
    ))
    receipts.acknowledge(db, peer, message["id"])
    viewer = make_viewer(room)
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    binding = directory / "viewer.json"
    binding.write_text(json.dumps({"version": 1, "origin": viewer_https[0], "room_ids": [str(room)],
                                   "viewer_token": viewer.token}))
    binding.chmod(0o600)
    args = ["--binding", str(binding), "--scenario", scenario, "--room", str(room)]
    if scenario in ("session-title", "layout"):
        expected = directory / "expected.txt"
        expected.write_text(title or "")
        expected.chmod(0o600)
        args += ["--session", str(first.session_id), "--expected-title-file", str(expected)]
    if scenario == "layout":
        args += ["--min-participants", "20"]
    if scenario == "history-receipt":
        args += ["--message", str(message["id"]), "--receipt-session", str(peer.session_id),
                 "--receipt-state", "stored", "--receipt-state", "acknowledged"]
    before = snapshot(db)
    completed = invoke(viewer_https, args)
    assert completed.stderr == ""
    assert viewer.token not in completed.stdout and "PRIVATE-BODY-INTEGRATION-SENTINEL" not in completed.stdout
    if title:
        assert title not in completed.stdout
    evidence = json.loads(completed.stdout)
    # Keep failure codes visible instead of pytest's abbreviated evidence dictionary.
    failures = [f"{entry['code']}:{entry['result']}" for entry in evidence["assertions"]
                if entry["result"] != "PASS"]
    failures += [f"cleanup.{name}:{status}" for name, status in evidence["cleanup"].items()
                 if status != "PASS"]
    # Fixed-vocabulary logout exchanges: step, error class, HTTP status, latency and prior idle time.
    # At most three short entries; put them first so the 512-character cut never drops them.
    steps = [f"step.{step['step']}:{step['outcome']}:{step['http_status']}:{step['elapsed_ms']}ms"
             f":idle{step['idle_ms']}ms" for step in evidence["cleanup_steps"]] if failures else []
    # Then the resource closes (context, browser, driver): fixed outcome and latency against its share of the
    # closing window, which `CLOSE_BUDGET_SHARE` in `agent_chat/browser_verify_run.py` computes.
    closes = [f"close.{step['step']}:{step['outcome']}:{step['elapsed_ms']}ms"
              for step in evidence["close_steps"]] if failures else []
    failure_summary = "; ".join(steps + closes + failures)[:512] or "No failing status recorded"
    assert completed.returncode == 0 and evidence["result"] == "PASS", failure_summary
    assert all(status == "PASS" for status in evidence["cleanup"].values()), failure_summary
    assert {entry.get("viewport") for entry in evidence["assertions"] if "viewport" in entry} == {0, 1}
    web = Path(__file__).parents[2] / "agent_chat/web"
    assert evidence["served_hashes"] == {name: hashlib.sha256((web / name).read_bytes()).hexdigest()
                                         for name in ("index.html", "chat.js", "chat.css", "Manrope-Variable.ttf")}
    assert snapshot(db) == before
    assert db.execute("SELECT count(*) AS count FROM agent_chat.browser_sessions").fetchone()["count"] == 0
