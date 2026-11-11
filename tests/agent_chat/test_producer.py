"""The real producer CLI forwards only advisory lease observations, with a private producer token."""

import json
import os
import sys
import time
from typing import Any
from uuid import uuid4

import pytest

from agent_chat import cli, producer
from agent_chat.models import ChatError


def report(mode: str = "classed") -> dict[str, Any]:
    # Callers add heterogeneous fields to exercise projection and redaction.
    classes = ("shared",) if mode == "legacy" else ("leaf", "c1")
    return {
        "schema": "validation-lease-status.v1",
        "mode": mode,
        "slots": [
            {"class": name, "slot": 1, "state": "free", "fields": {}}
            for name in classes
        ],
        "waiters": [],
    }


def script(tmp_path, source):
    path = tmp_path / "validation_lease.py"
    path.write_text(source, encoding="utf-8")
    path.chmod(0o644)
    return path


def write_credential(tmp_path, origin="https://chat.example", token="a" * 64, room=None, **overrides):
    path = tmp_path / "producer.json"
    data = {"server_origin": origin, "token": token, "host": "node-a", "room_id": str(room or uuid4()), **overrides}
    path.write_text(json.dumps(data), encoding="utf-8")
    path.chmod(0o600)
    return path


def test_private_credential_is_explicit_and_token_is_not_in_repr(tmp_path, monkeypatch):
    path = write_credential(tmp_path)
    credential = producer.read_credential(path)
    assert (credential.host, credential.server_origin) == ("node-a", "https://chat.example")
    assert credential.token not in repr(credential)
    with monkeypatch.context() as owner:
        owner.setattr(producer.os, "geteuid", lambda: path.stat().st_uid + 1)
        with pytest.raises(ChatError, match="^PRODUCER_CREDENTIAL_UNSAFE$"):
            producer.read_credential(path)
    for mode in (0o644, 0o640, 0o400):
        path.chmod(mode)
        with pytest.raises(ChatError, match="^PRODUCER_CREDENTIAL_UNSAFE$"):
            producer.read_credential(path)
    path.chmod(0o600)
    alias = tmp_path / "alias.json"
    alias.symlink_to(path)
    with pytest.raises(ChatError, match="^PRODUCER_CREDENTIAL_UNSAFE$"):
        producer.read_credential(alias)
    alias.unlink()
    os.link(path, alias)
    with pytest.raises(ChatError, match="^PRODUCER_CREDENTIAL_UNSAFE$"):
        producer.read_credential(path)


@pytest.mark.parametrize(
    "changes",
    [
        {"host": "Bad_Host"}, {"room_id": "not-a-room"}, {"token": "secret"},
        {"server_origin": "https://chat.example/path"}, {"unexpected": True}, {"token": 1},
    ],
)
def test_bad_credential_data_is_coded_without_echo(tmp_path, changes):
    with pytest.raises(ChatError, match="^PRODUCER_CREDENTIAL_INVALID$"):
        producer.read_credential(write_credential(tmp_path, **changes))


def test_projection_omits_sensitive_fields_and_maps_missing_markers():
    source = report()
    source["slots"][0].update(
        state="held", path="/private/lease", age_seconds=17, command="secret command",
        real_holders=[{"pid": 42, "cmdline": "another secret"}], scan_error="private error",
        fields={
            "owner": "session-1", "lane": "owner/project::abc-123", "branch": "task/chat", "head": "abc",
            "profile": "c2", "effective": "-", "step": "pytest", "pid": "42", "started": "private start",
            "command": "nested secret",
        },
    )
    source["waiters"] = [{
        "class": "leaf", "waiting_since": "2026-10-17T10:00:00Z", "age_seconds": 9,
        "command": "wait secret", "fields": {"owner": "session-2", "lane": "-", "pid": "43"},
    }]
    values = producer._values(source)
    assert values["leaf"] == {
        "schema": "agent-chat.validation-lease.v1", "scan": "known",
        "slots": [{
            "class": "leaf", "slot": 1, "state": "held", "owner": "session-1",
            "lane": "owner/project::abc-123", "branch": "task/chat", "head": "abc", "profile": "c2",
            "effective": None, "step": "pytest",
        }],
        "waiters": [{
            "class": "leaf", "owner": "session-2", "lane": None, "branch": None, "head": None,
            "profile": None, "effective": None, "step": None, "waiting_since": "2026-10-17T10:00:00Z",
        }],
    }
    # Age changes do not cause a new board event through a changed value.
    source["slots"][0]["age_seconds"] += 1
    source["waiters"][0]["age_seconds"] += 1
    assert producer._values(source) == values
    assert set(producer._values(report("legacy"))) == {"shared"}


def test_status_exec_is_isolated_and_uses_only_the_lease_environment(tmp_path):
    status = report()
    path = script(tmp_path, "\n".join((
        "import json, os, sys",
        "assert sys.flags.isolated == 1",
        "assert sys.argv[1:] == ['status', '--json', '--fast']",
        "assert os.environ['CI_PROFILE_LOCK_FILE'].endswith('/selected.lock')",
        "assert os.environ['CI_PROFILE_LEAF_SLOTS'] == '2'",
        "assert 'SYNTHETIC_SECRET' not in os.environ and 'PYTHONPATH' not in os.environ",
        f"print({json.dumps(json.dumps(status))})",
    )))
    values = producer._collect(path, tmp_path / "selected.lock", {
        "CI_PROFILE_LEAF_SLOTS": "2", "SYNTHETIC_SECRET": "do not inherit", "PYTHONPATH": "/not/trusted",
        "PATH": "/not/trusted",
    })
    assert values["leaf"]["slots"][0]["state"] == "free"
    path.chmod(0o666)
    with pytest.raises(producer._Unknown, match="^script_unsafe$"):
        producer._collect(path, None, {})
    path.chmod(0o644)
    alias = tmp_path / "alias.py"
    alias.symlink_to(path)
    with pytest.raises(producer._Unknown, match="^script_unsafe$"):
        producer._collect(alias, None, {})


def invoke(monkeypatch, capsys, credential, lease_script, *arguments):
    monkeypatch.setattr(sys, "argv", [
        "agent-chat", "produce", "validation-lease", "--credential-file", str(credential),
        "--lease-script", str(lease_script), *arguments,
    ])
    # This binding must not be consulted by a producer command.
    monkeypatch.setenv("AGENT_CHAT_INSTANCE_FILE", "/nonexistent/session.json")
    result = cli.main()
    captured = capsys.readouterr()
    assert captured.err == ""
    assert "a" * 64 not in captured.out
    return result, json.loads(captured.out)


def test_cli_publishes_real_state_without_a_session_binding(
    tmp_path, monkeypatch, capsys, process_api, make_producer, credentials, db
):
    principal = make_producer()
    credential = write_credential(tmp_path, process_api.origin, principal.token, credentials.room)
    path = script(tmp_path, f"print({json.dumps(json.dumps(report()))})")
    assert invoke(monkeypatch, capsys, credential, path) == (0, {"result": {"entries": [
        {"state_key": "validation-lease:node-a:leaf", "scan": "known"},
        {"state_key": "validation-lease:node-a:c1", "scan": "known"},
        {"state_key": "validation-lease:node-a:shared", "scan": "unknown"},
    ]}})
    rows = db.execute("SELECT state_key, value, ref_key, expires_at - observed_at AS ttl "
                      "FROM agent_chat.room_state ORDER BY state_key").fetchall()
    assert {row["state_key"] for row in rows} == {
        "validation-lease:node-a:leaf", "validation-lease:node-a:c1", "validation-lease:node-a:shared"
    }
    assert all(row["ttl"].total_seconds() == 90 and row["ref_key"] == "resource:node-a:ci-validation" for row in rows)
    assert invoke(monkeypatch, capsys, credential, path)[0] == 0
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'state'").fetchone()["n"] == 3
    path.write_text(f"print({json.dumps(json.dumps(report('legacy')))})", encoding="utf-8")
    assert invoke(monkeypatch, capsys, credential, path)[0] == 0
    values = {
        row["state_key"]: row["value"]
        for row in db.execute("SELECT state_key, value FROM agent_chat.room_state")
    }
    assert values["validation-lease:node-a:shared"]["slots"][0]["state"] == "free"
    for name in ("leaf", "c1"):
        assert values[f"validation-lease:node-a:{name}"] == {
            "schema": "agent-chat.validation-lease.v1", "scan": "unknown", "reason": "inactive"
        }
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


@pytest.mark.parametrize("failure", ["failed", "malformed", "schema", "missing_class", "oversized"])
def test_failed_or_invalid_scan_publishes_unknown_for_every_class(
    tmp_path, monkeypatch, capsys, process_api, make_producer, credentials, db, failure
):
    principal = make_producer()
    credential = write_credential(tmp_path, process_api.origin, principal.token, credentials.room)
    source = report()
    if failure == "failed":
        content = "raise SystemExit(1)"
    elif failure == "malformed":
        content = "print('sensitive not-json output')"
    else:
        if failure == "schema":
            source["schema"] = "future.v2"
        elif failure == "missing_class":
            source["slots"] = source["slots"][:1]
        else:
            source["waiters"] = [
                {"class": "leaf", "waiting_since": "2026-10-17T10:00:00Z", "fields": {"owner": "x" * 500}}
                for _ in range(10)
            ]
        content = f"print({json.dumps(json.dumps(source))})"
    code, output = invoke(monkeypatch, capsys, credential, script(tmp_path, content))
    assert code == 0
    rows = db.execute("SELECT state_key, value FROM agent_chat.room_state").fetchall()
    assert {entry["scan"] for entry in output["result"]["entries"]} == {"unknown"}
    assert {entry["state_key"] for entry in output["result"]["entries"]} == {
        "validation-lease:node-a:leaf", "validation-lease:node-a:c1", "validation-lease:node-a:shared"
    }
    assert {row["state_key"] for row in rows} == {
        "validation-lease:node-a:leaf", "validation-lease:node-a:c1", "validation-lease:node-a:shared"
    }
    assert all(row["value"]["scan"] == "unknown" and "slots" not in row["value"] for row in rows)
    assert "sensitive" not in json.dumps(rows)


def test_timeout_has_real_five_second_bound_and_never_reports_free(tmp_path, monkeypatch):
    marker = tmp_path / "started"
    path = script(tmp_path, f"import pathlib, time\npathlib.Path({str(marker)!r}).touch()\ntime.sleep(60)\n")
    calls = []

    def request(_client, method, route, payload):
        calls.append((method, route, payload))
        return {"entries": []}

    monkeypatch.setattr(producer.Client, "request", request)
    credential = producer.read_credential(write_credential(tmp_path))
    started = time.monotonic()
    result = producer.produce(credential, path)
    assert marker.is_file(), "timeout was observed before the child began"
    assert 4.5 <= time.monotonic() - started < 15
    assert all(entry["scan"] == "unknown" for entry in result["entries"])
    assert len(calls) == 1 and calls[0][0] == "POST"
    assert all(entry["value"] == {
        "schema": "agent-chat.validation-lease.v1", "scan": "unknown", "reason": "command_timeout"
    } for entry in calls[0][2]["entries"])


def test_cli_rejects_unsafe_credentials_without_running_script_or_sending(tmp_path, monkeypatch, capsys):
    marker = tmp_path / "should-not-exist"
    credential = write_credential(tmp_path)
    credential.chmod(0o644)
    path = script(tmp_path, f"from pathlib import Path\nPath({str(marker)!r}).touch()")
    code, output = invoke(monkeypatch, capsys, credential, path)
    assert (code, output) == (1, {"error": {"code": "PRODUCER_CREDENTIAL_UNSAFE"}})
    assert not marker.exists()
