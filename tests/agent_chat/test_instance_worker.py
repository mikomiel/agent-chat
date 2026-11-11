"""Real private HTTP/PG and Python pipe boundaries; no production credentials."""

from __future__ import annotations

import io
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest

from agent_chat import instance_client, instance_worker
from agent_chat.instance_file import InstanceSecret, prepare_instance, read_instance
from agent_chat.models import ChatError

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def join_frame(process_api, credentials, tmp_path):
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    return {
        "id": 0,
        "op": "join",
        "enabled": True,
        "directory": str(directory),
        "native_session_id": "worker-native",
        "boot_id": str(uuid4()),
        "server_origin": process_api.origin,
        "host_token": credentials.agent,
        "harness": "pi",
    }


def worker(*frames):
    return subprocess.run(
        [sys.executable, "-m", "agent_chat.instance_worker"],
        input="".join(json.dumps(frame) + "\n" for frame in frames),
        text=True,
        capture_output=True,
        timeout=30,
        cwd=ROOT,
        env={},
    )


@pytest.mark.parametrize("enabled", [False, 1, "true"])
def test_disabled_worker_has_no_files_or_registration(join_frame, db, enabled):
    join_frame["enabled"] = enabled
    result = worker(join_frame)
    assert result.returncode == 1 and result.stderr == ""
    assert json.loads(result.stdout)["error"]["code"] == "INTEGRATION_DISABLED"
    assert not list(Path(join_frame["directory"]).iterdir())
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 0


def test_worker_real_protocol_and_explicit_end(join_frame, db):
    result = worker(
        join_frame,
        {"id": 1, "op": "heartbeat", "state": {"native_state": "busy", "stopped": True, "plan_mode": True}},
        {"id": 2, "op": "status"},
        {"id": 3, "op": "end"},
    )
    assert result.returncode == 0 and result.stderr == ""
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert [frame["id"] for frame in frames] == [0, 1, 2, 3]
    assert frames[2]["result"]["native_state"] == "busy"
    assert frames[2]["result"]["stopped"] is True and frames[2]["result"]["plan_mode"] is True
    # The record is gone after a clean end, so a leak check cannot read the token back: no instance
    # token (64 hex characters) may appear in any frame at all.
    assert not re.search(r"[0-9a-f]{64}", result.stdout) and join_frame["host_token"] not in result.stdout
    assert not Path(frames[0]["result"]["instance_file"]).exists()
    row = db.execute("SELECT * FROM agent_chat.instances").fetchone()
    assert row["ended_at"] is not None
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


@pytest.mark.parametrize(
    "next_frame", [None, {"id": 1, "op": "arbitrary-http", "path": "/v1/sessions"}, {"id": 8, "op": "status"}]
)
def test_eof_and_protocol_failure_end_only_owned_instance(join_frame, db, next_frame):
    result = worker(join_frame, *([] if next_frame is None else [next_frame]))
    assert result.returncode == (0 if next_frame is None else 1)
    assert result.stderr == ""
    assert db.execute("SELECT ended_at FROM agent_chat.instances").fetchone()["ended_at"] is not None
    if next_frame:
        assert json.loads(result.stdout.splitlines()[-1])["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize("closing", [[], [{"id": 1, "op": "end"}], [{"id": 1, "op": "unknown"}]])
def test_clean_end_eof_and_failure_cleanup_remove_only_the_own_record(join_frame, db, closing):
    sibling = prepare_instance(
        Path(join_frame["directory"]), "peer-native", uuid4(), server_origin=join_frame["server_origin"]
    )
    result = worker(join_frame, *closing)
    assert json.loads(result.stdout.splitlines()[0])["result"]["instance_file"]
    assert db.execute("SELECT ended_at FROM agent_chat.instances").fetchone()["ended_at"] is not None
    # A young peer record is outside the sweep's age gate: only the own file disappears.
    assert [path.name for path in Path(join_frame["directory"]).iterdir()] == [f"{sibling.boot_id}.json"]


def test_failed_end_keeps_the_record_for_the_server_lease_fallback(join_frame, db):
    directory = Path(join_frame["directory"])
    with subprocess.Popen(
        [sys.executable, "-m", "agent_chat.instance_worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=ROOT, env={},
    ) as process:
        try:
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(json.dumps(join_frame) + "\n")
            process.stdin.flush()
            joined = json.loads(process.stdout.readline())["result"]
            # The server now refuses this binding definitively, so both end attempts fail.
            db.execute("UPDATE agent_chat.principals SET revoked = true WHERE kind = 'agent'")
            process.stdin.write(json.dumps({"id": 1, "op": "end"}) + "\n")
            process.stdin.flush()
            assert json.loads(process.stdout.readline())["error"]["code"] == "UNAUTHENTICATED"
            process.wait(timeout=30)
            assert process.returncode == 1 and process.stderr is not None and process.stderr.read() == ""
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
    assert Path(joined["instance_file"]).exists()
    assert read_instance(Path(joined["instance_file"])).native_session_id == join_frame["native_session_id"]
    assert db.execute("SELECT ended_at FROM agent_chat.instances").fetchone()["ended_at"] is None
    assert [path.name for path in directory.iterdir()] == [Path(joined["instance_file"]).name]


def test_worker_start_sweeps_only_long_untouched_records_and_never_uses_the_network(join_frame, db):
    directory = Path(join_frame["directory"])
    with socket.socket() as watched:
        # A stale record whose origin is this socket: any probe of it would show up as a connection.
        watched.bind(("127.0.0.1", 0))
        watched.listen(4)
        watched.setblocking(False)
        origin = f"http://127.0.0.1:{watched.getsockname()[1]}"
        stale = prepare_instance(directory, "crashed-native", uuid4(), server_origin=origin)
        fresh = prepare_instance(directory, "other-native", uuid4(), server_origin=origin)
        os.utime(directory / f"{stale.boot_id}.json", (time.time() - 7200, time.time() - 7200))
        result = worker(join_frame, {"id": 1, "op": "end"})
        assert result.returncode == 0 and result.stderr == ""
        with pytest.raises(BlockingIOError):
            watched.accept()
    assert [path.name for path in directory.iterdir()] == [f"{fresh.boot_id}.json"]


def test_heartbeat_touches_only_the_own_record(join_frame, db):
    directory = Path(join_frame["directory"])
    sibling = prepare_instance(directory, "other-native", uuid4(), server_origin=join_frame["server_origin"])
    sibling_path = directory / f"{sibling.boot_id}.json"
    with subprocess.Popen(
        [sys.executable, "-m", "agent_chat.instance_worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=ROOT, env={},
    ) as process:
        try:
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(json.dumps(join_frame) + "\n")
            process.stdin.flush()
            own = Path(json.loads(process.stdout.readline())["result"]["instance_file"])
            long_ago = time.time() - 1800
            os.utime(own, (long_ago, long_ago))
            os.utime(sibling_path, (long_ago, long_ago))
            state = {"native_state": "idle", "stopped": False, "plan_mode": False}
            process.stdin.write(json.dumps({"id": 1, "op": "heartbeat", "state": state}) + "\n")
            process.stdin.flush()
            assert "result" in json.loads(process.stdout.readline())
            assert own.stat().st_mtime > time.time() - 60
            assert abs(sibling_path.stat().st_mtime - long_ago) < 1
            process.stdin.close()
            process.wait(timeout=30)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)


def test_worker_initial_partial_frame_has_whole_process_deadline(tmp_path):
    started = time.monotonic()
    # Lower the real signal deadline in the child so this exercises the same
    # whole-process alarm without spending the production 20 seconds.
    with subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import agent_chat.instance_worker as worker; "
            "worker.REQUEST_SECONDS = 0.25; "
            "raise SystemExit(worker.main())",
        ],
        cwd=ROOT,
        env={},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ) as process:
        try:
            assert process.stdin is not None
            process.stdin.write(b"{")
            process.stdin.flush()
            process.wait(timeout=10)
            assert process.stdout is not None and process.stderr is not None
            assert json.loads(process.stdout.read())["error"]["code"] == "REQUEST_UNCERTAIN"
            assert process.stderr.read() == b"" and process.returncode == 1
            assert time.monotonic() - started >= 0.2
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)


def _timed_worker(
    monkeypatch: pytest.MonkeyPatch,
    script: list[tuple[float, dict[str, Any]]],
    pending_results: list[dict[str, Any] | ChatError | OSError],
    *,
    failures: dict[str, list[Any]] | None = None,
    handlers: dict[int, Any] | None = None,
    feed: list[dict[str, Any]] | None = None,
    muted: Any = None,
) -> tuple[int, list[dict[str, Any]], list[tuple[float, str]]]:
    now = 0.0
    instance = instance_client.JoinedInstance(
        InstanceSecret("timed-native", uuid4(), "1" * 64, "http://127.0.0.1:1"),
        uuid4(), uuid4(), uuid4(), "synthetic-host", "pi",
    )
    attempt = str(uuid4())
    frames = iter(
        [(0.0, {"id": 0, "op": "join", "directory": "/synthetic", "host_token": "synthetic-host-secret"})]
        + [(at, {"id": index, **frame}) for index, (at, frame) in enumerate(script, 1)]
    )
    results = iter(pending_results)
    # `feed` is the receipt rows the server lists; `muted` is the status answer's flag, omitted while it is None.
    # Per-operation outcomes keyed by the last path segment: None succeeds; an error or a callable's raise fails.
    injected = {name: iter(items) for name, items in (failures or {}).items()}
    output = io.BytesIO()
    calls: list[tuple[float, str]] = []

    def readline(_size: int) -> bytes:
        nonlocal now
        item = next(frames, None)
        if item is None:
            return b""
        now, frame = item
        return (json.dumps(frame) + "\n").encode()

    def request(
        _client: Any, method: str, path: str, payload: Any = None, key: Any = None, *, invalid: Any = None
    ) -> dict[str, Any]:
        calls.append((now, path))
        binding = {"instance_id": str(instance.instance_id), "session_id": str(instance.session_id)}
        outcome = next(injected.get(path.rsplit("/", 1)[-1], iter(())), None)
        if callable(outcome):
            outcome = outcome()
        if outcome is not None:
            raise outcome
        if path == "/v1/instance/deliveries/pending":
            result = next(results)
            if callable(result):
                result = result()
            if isinstance(result, (ChatError, OSError)):
                raise result
            assert isinstance(result, dict)
            return binding | result
        if path == "/v1/instance/deliveries/claim":
            return {
                "attempt": {
                    "id": attempt, "instance_id": str(instance.instance_id),
                    "admitted_at": "2026-10-19T00:00:00+00:00",
                    "expires_at": "2026-10-19T00:00:30+00:00", "outcome": None,
                },
                "dispatch": False, "messages": [],
            }
        if path.endswith("/result"):
            return binding | {"id": path.split("/")[-2], **payload}
        if path == "/v1/instance/receipts":
            return binding | {"receipts": feed or []}
        if path == "/v1/instance/receipts/delivered":
            return binding | {"delivered": payload["receipts"]}
        if path == "/v1/instance/status":
            return binding if muted is None else binding | {"muted": muted}
        assert (method, path) in {("POST", "/v1/instance/heartbeat"), ("POST", "/v1/instance/end")}
        return binding

    with monkeypatch.context() as patch:
        patch.setattr(instance_worker, "_join", lambda _request: instance)
        patch.setattr(instance_worker, "monotonic", lambda: now, raising=False)
        patch.setattr(
            instance_worker, "sys",
            SimpleNamespace(stdin=SimpleNamespace(buffer=SimpleNamespace(readline=readline)),
                            stdout=SimpleNamespace(buffer=output)),
        )
        patch.setattr(
            instance_worker, "signal",
            SimpleNamespace(SIGALRM=14, SIGTERM=15, ITIMER_REAL=0,
                            signal=(lambda number, handler: None) if handlers is None
                            else handlers.__setitem__, setitimer=lambda *_args: None),
        )
        patch.setattr(instance_client.Client, "request", request)
        patch.setattr(time, "sleep", lambda *_args: pytest.fail("worker must not sleep between frames"))
        code = instance_worker.main()
    return code, [json.loads(line) for line in output.getvalue().splitlines()], calls


def _pending_times(calls: list[tuple[float, str]]) -> list[float]:
    return [at for at, path in calls if path == "/v1/instance/deliveries/pending"]


def test_empty_pending_backoff_uses_monotonic_two_four_eight_second_deadlines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    times = [0, 1.99, 2, 3.99, 5.99, 6, 7, 13.99, 14, 15.99, 21.99, 22]
    code, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in times], [{"messages": []}] * len(times)
    )
    assert code == 0
    assert _pending_times(calls) == [0, 2, 6, 14, 22]
    assert [frame["result"] for frame in frames[1:]] == [{"messages": []}] * len(times)
    assert calls[-1] == (22, "/v1/instance/end")


def test_nonempty_pending_resets_backoff_and_is_never_replayed(monkeypatch: pytest.MonkeyPatch) -> None:
    message = str(uuid4())
    times = [0, 2, 6, 7, 8, 9, 12, 13]
    code, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in times],
        [{"messages": []}, {"messages": []}, {"messages": [message]}] + [{"messages": []}] * len(times),
    )
    assert code == 0
    assert _pending_times(calls) == [0, 2, 6, 7, 9, 13]
    assert frames[3]["result"] == {"messages": [message]}
    assert [frame["result"] for frame in frames[4:]] == [{"messages": []}] * 5


@pytest.mark.parametrize(
    "changed", [{"native_state": "busy"}, {"stopped": True}, {"plan_mode": True}]
)
def test_only_a_changed_heartbeat_resets_empty_backoff(
    monkeypatch: pytest.MonkeyPatch, changed: dict[str, Any],
) -> None:
    state = {"native_state": "idle", "stopped": False, "plan_mode": False}
    code, _frames, calls = _timed_worker(
        monkeypatch,
        [
            (0, {"op": "heartbeat", "state": state}),
            (1, {"op": "pending"}), (3, {"op": "pending"}),
            (6, {"op": "heartbeat", "state": state}), (6, {"op": "pending"}),
            (7, {"op": "pending"}),
            (8, {"op": "heartbeat", "state": state | changed}), (8, {"op": "pending"}),
            (9, {"op": "pending"}), (10, {"op": "pending"}),
        ],
        [{"messages": []}] * 7,
    )
    assert code == 0
    assert _pending_times(calls) == [1, 3, 7, 8, 10]
    assert [at for at, path in calls if path.endswith("/heartbeat")] == [0, 6, 8]


def test_empty_backoff_never_suppresses_other_lifecycle_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    state = {"native_state": "idle", "stopped": False, "plan_mode": False}
    code, frames, calls = _timed_worker(
        monkeypatch,
        [
            (0, {"op": "pending"}),
            (1, {"op": "status"}),
            (1, {"op": "claim", "key": str(uuid4()), "messages": [str(uuid4())]}),
            (1, {"op": "settle", "attempt": str(uuid4()),
                 "result": {"outcome": "deferred", "reason": "busy"}}),
            (1, {"op": "heartbeat", "state": state}), (2, {"op": "pending"}),
            (3, {"op": "heartbeat", "state": state}), (3, {"op": "end"}),
        ],
        [{"messages": []}] * 2,
    )
    assert code == 0 and len(frames) == 9
    assert _pending_times(calls) == [0, 2]
    assert [path.rsplit("/", 1)[-1] for _at, path in calls] == [
        "pending", "status", "claim", "result", "heartbeat", "pending", "heartbeat", "end"
    ]


@pytest.mark.parametrize("invalid", [{"unexpected": True}, {"id": 99}])
def test_pending_frame_validation_precedes_the_empty_cache(
    monkeypatch: pytest.MonkeyPatch, invalid: dict[str, Any],
) -> None:
    code, frames, calls = _timed_worker(
        monkeypatch, [(0, {"op": "pending"}), (1, {"op": "pending", **invalid})], [{"messages": []}] * 2
    )
    assert code == 1 and frames[-1] == {"id": 2, "error": {"code": "INVALID_REQUEST"}}
    assert _pending_times(calls) == [0]
    assert calls[-1] == (1, "/v1/instance/end")


def test_definite_pending_refusal_is_not_cached_as_an_empty_success(monkeypatch: pytest.MonkeyPatch) -> None:
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(at, {"op": "pending"}) for at in [0, 2, 3, 4, 7]],
        [{"messages": []}, ChatError("DELIVERY_BLOCKED"), {"messages": []}, {"messages": []},
         {"messages": []}],
    )
    assert code == 0
    assert _pending_times(calls) == [0, 2, 3, 7]
    assert frames[2] == {"id": 2, "result": {"refused": "DELIVERY_BLOCKED"}}
    assert frames[3] == {"id": 3, "result": {"messages": []}}


@pytest.mark.parametrize(
    ("bad_result", "error_code"),
    [
        ({}, "INVALID_RESPONSE"),
        ({"messages": "malformed"}, "INVALID_RESPONSE"),
        ({"messages": [str(uuid4()), "not-a-uuid"]}, "INVALID_RESPONSE"),
        # A malformed or foreign binding in the envelope is a protocol violation, not an outage.
        ({"instance_id": "not-a-uuid", "messages": []}, "INVALID_RESPONSE"),
        ({"instance_id": str(uuid4()), "messages": []}, "INVALID_RESPONSE"),
        ({"session_id": str(uuid4()), "messages": []}, "INVALID_RESPONSE"),
        (OSError("synthetic network failure"), "REQUEST_UNCERTAIN"),
    ],
)
def test_pending_failure_still_ends_the_worker_without_replaying_empty_metadata(
    monkeypatch: pytest.MonkeyPatch, bad_result: dict[str, Any] | ChatError | OSError, error_code: str,
) -> None:
    code, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in [0, 2, 3]], [{"messages": []}, bad_result]
    )
    assert code == 1 and frames[-1] == {"id": 2, "error": {"code": error_code}}
    assert _pending_times(calls) == [0, 2]
    assert calls[-1] == (2, "/v1/instance/end")


def test_empty_pending_backoff_is_owned_by_each_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    first = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in [0, 2, 6]], [{"messages": []}] * 3
    )
    second = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in [0, 1, 2]], [{"messages": []}] * 3
    )
    assert first[0] == second[0] == 0
    assert _pending_times(first[2]) == [0, 2, 6]
    assert _pending_times(second[2]) == [0, 2]


def test_the_first_pending_request_has_no_monotonic_epoch_assumption(monkeypatch: pytest.MonkeyPatch) -> None:
    code, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in [-100, -99, -98]], [{"messages": []}] * 3
    )
    assert code == 0 and len(frames) == 4
    assert _pending_times(calls) == [-100, -98]


# Short transport outages: a bounded outage must not end the session.
HEARTBEAT_STATE = {"native_state": "idle", "stopped": False, "plan_mode": False}
LEASE = instance_worker.LEASE_SECONDS


def _ends(calls: list[tuple[float, str]]) -> int:
    return sum(1 for _at, path in calls if path == "/v1/instance/end")


def _sigterm(handlers: dict[int, Any], code: str = "TRANSPORT_UNAVAILABLE") -> Any:
    """A request that fails the way the HTTP client does when SIGTERM interrupts it."""

    def interrupted() -> ChatError:
        with pytest.raises(TimeoutError):
            handlers[15](15, None)
        return ChatError(code)

    return interrupted


def test_the_lease_bound_is_the_server_lease() -> None:
    assert LEASE == 90


@pytest.mark.parametrize("code", ["TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE"])
def test_pending_outage_inside_the_bound_is_a_soft_refusal_and_is_not_cached(
    monkeypatch: pytest.MonkeyPatch, code: str,
) -> None:
    times = [1, 2, 1 + LEASE - 0.1, 1 + LEASE - 0.05]
    code_, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in times],
        [ChatError(code), ChatError(code), ChatError(code), {"messages": []}],
    )
    assert code_ == 0
    assert [frame["result"] for frame in frames[1:]] == [{"refused": code}] * 3 + [{"messages": []}]
    # A refusal never arms the empty backoff, so every poll reaches HTTP; the worker itself does not retry.
    assert _pending_times(calls) == times
    assert _ends(calls) == 1 and calls[-1][1] == "/v1/instance/end"


@pytest.mark.parametrize("code", ["TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE"])
def test_pending_outage_at_the_bound_ends_the_worker(monkeypatch: pytest.MonkeyPatch, code: str) -> None:
    # The streak starts at its first failure, not at the join.
    code_, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "pending"}) for at in (5, 5 + LEASE, 5 + LEASE + 1)], [ChatError(code)] * 3
    )
    assert code_ == 1 and frames[-1] == {"id": 2, "error": {"code": code}}
    assert _pending_times(calls) == [5, 5 + LEASE]
    assert calls[-1] == (5 + LEASE, "/v1/instance/end")


@pytest.mark.parametrize("code", ["TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_UNCERTAIN"])
def test_heartbeat_outage_inside_the_bound_is_a_soft_refusal_that_publishes_nothing(
    monkeypatch: pytest.MonkeyPatch, code: str,
) -> None:
    touched: list[Path] = []
    monkeypatch.setattr(instance_worker.instance_file, "touch_instance", lambda *args: touched.append(args[0]))
    beat = {"op": "heartbeat", "state": HEARTBEAT_STATE}
    code_, frames, calls = _timed_worker(
        monkeypatch,
        [(30, beat), (60, beat), (61, beat)],
        [],
        failures={"heartbeat": [ChatError(code), ChatError(code), None]},
    )
    assert code_ == 0
    assert [frame["result"].get("refused") for frame in frames[1:]] == [code, code, None]
    assert [at for at, path in calls if path.endswith("/heartbeat")] == [30, 60, 61]
    assert len(touched) == 1  # only the successful heartbeat touches the record


@pytest.mark.parametrize("code", ["TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_UNCERTAIN"])
def test_heartbeat_outage_at_the_bound_ends_the_worker(monkeypatch: pytest.MonkeyPatch, code: str) -> None:
    beat = {"op": "heartbeat", "state": HEARTBEAT_STATE}
    code_, frames, calls = _timed_worker(
        monkeypatch, [(30, beat), (30 + LEASE - 0.1, beat), (30 + LEASE, beat)], [],
        failures={"heartbeat": [ChatError(code)] * 3},
    )
    assert code_ == 1 and frames[-1] == {"id": 3, "error": {"code": code}}
    assert [frame["result"] for frame in frames[1:3]] == [{"refused": code}] * 2
    assert calls[-1] == (30 + LEASE, "/v1/instance/end")


def test_a_pending_outage_ends_the_worker_while_heartbeats_keep_succeeding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The silent-deafness case: the lease is renewed, yet the poll has failed for the whole bound.
    beat = {"op": "heartbeat", "state": HEARTBEAT_STATE}
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(1, {"op": "pending"}), (30, beat), (45, {"op": "pending"}), (60, beat), (89, beat),
         (1 + LEASE - 0.1, {"op": "pending"}), (1 + LEASE, {"op": "pending"})],
        [ChatError("TRANSPORT_UNAVAILABLE")] * 4,
    )
    assert code == 1 and frames[-1] == {"id": 7, "error": {"code": "TRANSPORT_UNAVAILABLE"}}
    assert [frame["result"].get("refused") for frame in frames[1:7]] == [
        "TRANSPORT_UNAVAILABLE", None, "TRANSPORT_UNAVAILABLE", None, None, "TRANSPORT_UNAVAILABLE"
    ]
    assert calls[-1] == (1 + LEASE, "/v1/instance/end")


def test_a_pending_success_does_not_clear_a_heartbeat_streak(monkeypatch: pytest.MonkeyPatch) -> None:
    beat = {"op": "heartbeat", "state": HEARTBEAT_STATE}
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(1, beat), (30, {"op": "pending"}), (60, {"op": "pending"}), (1 + LEASE, beat)],
        [{"messages": []}] * 2,
        failures={"heartbeat": [ChatError("REQUEST_UNCERTAIN")] * 2},
    )
    assert code == 1 and frames[-1] == {"id": 4, "error": {"code": "REQUEST_UNCERTAIN"}}
    assert calls[-1] == (1 + LEASE, "/v1/instance/end")


@pytest.mark.parametrize("operation", ["pending", "heartbeat"])
def test_a_success_of_the_same_op_resets_its_streak(monkeypatch: pytest.MonkeyPatch, operation: str) -> None:
    # The streak started at 1 would end the worker at 91. The success at 50 starts a new one at 60.
    outcomes: list[ChatError | None] = [
        ChatError("TRANSPORT_UNAVAILABLE"), None, ChatError("SERVICE_UNAVAILABLE"),
        ChatError("SERVICE_UNAVAILABLE"), ChatError("SERVICE_UNAVAILABLE"),
    ]
    op_frame = {"op": "pending"} if operation == "pending" else {"op": "heartbeat", "state": HEARTBEAT_STATE}
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(at, op_frame) for at in (1, 50, 60, 100, 60 + LEASE)],
        [{"messages": []} if outcome is None else outcome for outcome in outcomes] if operation == "pending" else [],
        failures={"heartbeat": list(outcomes)} if operation == "heartbeat" else None,
    )
    assert code == 1 and frames[-1] == {"id": 5, "error": {"code": "SERVICE_UNAVAILABLE"}}
    assert [frame["result"].get("refused") for frame in frames[1:5]] == [
        "TRANSPORT_UNAVAILABLE", None, "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE",
    ]
    assert calls[-1] == (60 + LEASE, "/v1/instance/end")


def test_an_admission_refusal_proves_the_server_answered_and_resets_the_pending_streak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    code, frames, _calls = _timed_worker(
        monkeypatch,
        [(at, {"op": "pending"}) for at in (1, 2, 1 + LEASE)],
        [ChatError("TRANSPORT_UNAVAILABLE"), ChatError("DELIVERY_BLOCKED"), ChatError("TRANSPORT_UNAVAILABLE")],
    )
    assert code == 0
    assert [frame["result"] for frame in frames[1:]] == [
        {"refused": "TRANSPORT_UNAVAILABLE"}, {"refused": "DELIVERY_BLOCKED"}, {"refused": "TRANSPORT_UNAVAILABLE"},
    ]


def test_a_failed_heartbeat_does_not_count_as_published_state(monkeypatch: pytest.MonkeyPatch) -> None:
    busy = HEARTBEAT_STATE | {"native_state": "busy"}
    code, _frames, calls = _timed_worker(
        monkeypatch,
        [
            (0, {"op": "heartbeat", "state": HEARTBEAT_STATE}),
            (1, {"op": "pending"}),
            (1.5, {"op": "heartbeat", "state": busy}),
            (1.6, {"op": "pending"}),
            (2, {"op": "heartbeat", "state": busy}),
            (2.1, {"op": "pending"}),
        ],
        [{"messages": []}] * 2,
        failures={"heartbeat": [None, ChatError("REQUEST_UNCERTAIN"), None]},
    )
    assert code == 0
    # The empty backoff set at 1 still holds at 1.6; the retried change at 2 is the first publication.
    assert _pending_times(calls) == [1, 2.1]


@pytest.mark.parametrize("operation", ["pending", "heartbeat"])
@pytest.mark.parametrize(
    "code",
    ["STALE_INSTANCE", "UNAUTHENTICATED", "INVALID_REQUEST", "INVALID_RESPONSE", "HTTP_REFUSED", "REDIRECT_REFUSED"],
)
def test_other_pending_and_heartbeat_failures_stay_fatal_inside_the_lease(
    monkeypatch: pytest.MonkeyPatch, operation: str, code: str,
) -> None:
    frame = {"op": "pending"} if operation == "pending" else {"op": "heartbeat", "state": HEARTBEAT_STATE}
    code_, frames, calls = _timed_worker(
        monkeypatch, [(1, frame)], [ChatError(code)],
        failures={"heartbeat": [ChatError(code)]},
    )
    assert code_ == 1 and frames[-1] == {"id": 1, "error": {"code": code}}
    assert calls[-1] == (1, "/v1/instance/end")


def test_pending_request_uncertain_stays_fatal(monkeypatch: pytest.MonkeyPatch) -> None:
    code, frames, calls = _timed_worker(
        monkeypatch, [(1, {"op": "pending"})], [ChatError("REQUEST_UNCERTAIN")]
    )
    assert code == 1 and frames[-1] == {"id": 1, "error": {"code": "REQUEST_UNCERTAIN"}}
    assert calls[-1] == (1, "/v1/instance/end")


@pytest.mark.parametrize("code", ["TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_UNCERTAIN"])
@pytest.mark.parametrize("operation", ["claim", "settle", "status", "end"])
def test_claim_settle_status_and_end_outages_stay_fatal(
    monkeypatch: pytest.MonkeyPatch, operation: str, code: str,
) -> None:
    frames_in = {
        "claim": {"op": "claim", "key": str(uuid4()), "messages": [str(uuid4())]},
        "settle": {"op": "settle", "attempt": str(uuid4()), "result": {"outcome": "deferred", "reason": "busy"}},
        "status": {"op": "status"},
        "end": {"op": "end"},
    }
    key = {"claim": "claim", "settle": "result", "status": "status", "end": "end"}[operation]
    code_, frames, calls = _timed_worker(
        monkeypatch, [(1, frames_in[operation])], [], failures={key: [ChatError(code)] * 2}
    )
    assert code_ == 1 and frames[-1] == {"id": 1, "error": {"code": code}}
    # The failed request, then the failure path's own end attempt.
    assert calls[-2][0] == 1 and calls[-2][1].endswith(key) and calls[-1] == (1, "/v1/instance/end")
    assert len(frames) == 2  # the join reply and the one error frame


@pytest.mark.parametrize(
    "code", ["DELIVERY_CLOSED", "DELIVERY_EXHAUSTED", "DELIVERY_INELIGIBLE", "MESSAGE_EXPIRED", "NOT_FOUND"],
)
def test_a_definite_settlement_refusal_is_soft_and_the_worker_keeps_serving(
    monkeypatch: pytest.MonkeyPatch, code: str,
) -> None:
    """A reservation that lapsed while the native send ran answers DELIVERY_CLOSED. That is the ledger's
    decision, not a failed transport, so the session must not end over it."""
    settle = {"op": "settle", "attempt": str(uuid4()), "result": {"outcome": "handed", "reason": None}}
    code_, frames, calls = _timed_worker(
        monkeypatch, [(1, settle), (2, {"op": "status"})], [], failures={"result": [ChatError(code)]},
    )
    assert code_ == 0
    assert frames[1]["result"] == {"refused": code}
    assert frames[2]["result"]["instance_id"]
    assert calls[-1] == (2, "/v1/instance/end")


# Receipts are advisory: a receipt fault of any code is a soft refusal and never ends the worker. The instance's
# liveness is decided by heartbeat, pending and claim, which still fail closed.
RECEIPT_OPERATIONS = {
    "receipts": ({"op": "receipts"}, "receipts"),
    "receipts_delivered": ({"op": "receipts_delivered", "receipts": [str(uuid4())]}, "delivered"),
}
RECEIPT_CODES = [
    "TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_UNCERTAIN",
    "INVALID_RESPONSE", "STALE_INSTANCE", "UNAUTHENTICATED", "HTTP_REFUSED", "SOME_UNKNOWN_CODE",
]


def _receipt_row(state: str = "acked") -> dict[str, str]:
    return {
        "id": str(uuid4()), "message_id": str(uuid4()), "state": state, "recipient_session_id": str(uuid4()),
        "recipient_harness": "codex", "recipient_host": "host-a", "created_at": "2026-10-31T10:00:00+00:00",
    }


@pytest.mark.parametrize("code", RECEIPT_CODES)
@pytest.mark.parametrize("operation", sorted(RECEIPT_OPERATIONS))
def test_a_receipt_failure_of_any_code_is_a_soft_refusal_and_the_worker_keeps_serving(
    monkeypatch: pytest.MonkeyPatch, operation: str, code: str,
) -> None:
    frame, key = RECEIPT_OPERATIONS[operation]
    code_, frames, calls = _timed_worker(
        monkeypatch, [(1, frame), (2, frame), (3, {"op": "status"})], [],
        failures={key: [ChatError(code), None]},
    )
    assert code_ == 0
    assert frames[1] == {"id": 1, "result": {"refused": code}}
    assert "refused" not in frames[2]["result"]  # the next call is a real request, never a cached refusal
    assert set(frames[3]["result"]) == {"instance_id", "session_id"}  # the same worker still serves status
    assert [at for at, path in calls if path.endswith(key)] == [1, 2]
    assert _ends(calls) == 1 and calls[-1][1] == "/v1/instance/end"


@pytest.mark.parametrize("code", ["SERVICE_UNAVAILABLE", "TRANSPORT_UNAVAILABLE", "INVALID_RESPONSE"])
@pytest.mark.parametrize("operation", sorted(RECEIPT_OPERATIONS))
def test_a_receipt_failure_streak_longer_than_the_lease_never_ends_the_worker(
    monkeypatch: pytest.MonkeyPatch, operation: str, code: str,
) -> None:
    frame, key = RECEIPT_OPERATIONS[operation]
    times = [5, 5 + LEASE - 0.1, 5 + LEASE, 5 + 3 * LEASE]
    code_, frames, calls = _timed_worker(
        monkeypatch, [(at, frame) for at in times] + [(5 + 3 * LEASE, {"op": "status"})], [],
        failures={key: [ChatError(code)] * 4},
    )
    assert code_ == 0
    assert [frame_["result"] for frame_ in frames[1:5]] == [{"refused": code}] * 4
    assert set(frames[5]["result"]) == {"instance_id", "session_id"}
    assert [at for at, path in calls if path.endswith(key)] == times
    assert _ends(calls) == 1 and calls[-1][1] == "/v1/instance/end"


@pytest.mark.parametrize("operation", sorted(RECEIPT_OPERATIONS))
def test_sigterm_during_a_receipt_call_still_ends_the_worker(
    monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    frame, key = RECEIPT_OPERATIONS[operation]
    handlers: dict[int, Any] = {}
    code, frames, calls = _timed_worker(
        monkeypatch, [(1, frame), (2, {"op": "status"})], [],
        failures={key: [_sigterm(handlers)]}, handlers=handlers,
    )
    assert code == 1
    assert frames[-1]["error"]["code"] == "TRANSPORT_UNAVAILABLE"
    assert len(frames) == 2  # no soft refusal was written, and the second frame was never read
    assert calls[-1] == (1, "/v1/instance/end") and _ends(calls) == 1


# The `receipts` answer carries the mute flag, so a parent never needs the fatal `status` request to decide whether to
# show a receipt. A failed mute read must not end the session over an advisory receipt.
@pytest.mark.parametrize("muted", [False, True])
def test_a_receipts_answer_with_rows_carries_the_mute_flag_read_after_the_feed(
    monkeypatch: pytest.MonkeyPatch, muted: bool,
) -> None:
    rows = [_receipt_row("handed"), _receipt_row()]
    code, frames, calls = _timed_worker(monkeypatch, [(1, {"op": "receipts"})], [], feed=rows, muted=muted)
    assert code == 0
    assert frames[1] == {"id": 1, "result": {"receipts": rows, "muted": muted}}
    assert [path.rsplit("/", 1)[-1] for _at, path in calls] == ["receipts", "status", "end"]


def test_an_empty_feed_has_nothing_to_hold_so_it_reads_no_mute_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    code, frames, calls = _timed_worker(monkeypatch, [(1, {"op": "receipts"})], [], feed=[], muted=True)
    assert code == 0 and frames[1] == {"id": 1, "result": {"receipts": []}}
    assert [path.rsplit("/", 1)[-1] for _at, path in calls] == ["receipts", "end"]


@pytest.mark.parametrize("code", RECEIPT_CODES)
def test_a_failed_mute_read_refuses_the_receipts_answer_and_the_worker_keeps_serving(
    monkeypatch: pytest.MonkeyPatch, code: str,
) -> None:
    rows = [_receipt_row()]
    code_, frames, calls = _timed_worker(
        monkeypatch,
        [
            (1, {"op": "receipts"}),
            (2, {"op": "receipts"}),
            (3, {"op": "heartbeat", "state": HEARTBEAT_STATE}),
            (4, {"op": "pending"}),
        ],
        [{"messages": []}],
        failures={"status": [ChatError(code), None]},
        feed=rows,
        muted=False,
    )
    assert code_ == 0
    assert frames[1] == {"id": 1, "result": {"refused": code}}  # the feed was read, the flag was not: show nothing
    assert frames[2] == {"id": 2, "result": {"receipts": rows, "muted": False}}  # never a cached refusal
    assert "refused" not in frames[3]["result"] and frames[4] == {"id": 4, "result": {"messages": []}}
    assert [path.rsplit("/", 1)[-1] for _at, path in calls] == [
        "receipts", "status", "receipts", "status", "heartbeat", "pending", "end",
    ]
    assert _ends(calls) == 1 and calls[-1][1] == "/v1/instance/end"


@pytest.mark.parametrize("muted", [None, "yes", "false", 1, 0, [], {}])
def test_a_missing_or_non_boolean_mute_flag_refuses_the_receipts_answer(
    monkeypatch: pytest.MonkeyPatch, muted: Any,
) -> None:
    code, frames, _calls = _timed_worker(
        monkeypatch, [(1, {"op": "receipts"}), (2, {"op": "pending"})], [{"messages": []}],
        feed=[_receipt_row()], muted=muted,
    )
    assert code == 0
    assert frames[1] == {"id": 1, "result": {"refused": "INVALID_RESPONSE"}}
    assert frames[2] == {"id": 2, "result": {"messages": []}}


def test_a_mute_read_that_fails_for_longer_than_the_lease_never_ends_the_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    times = [5, 5 + LEASE - 0.1, 5 + LEASE, 5 + 3 * LEASE]
    code, frames, calls = _timed_worker(
        monkeypatch, [(at, {"op": "receipts"}) for at in times] + [(5 + 3 * LEASE, {"op": "pending"})],
        [{"messages": []}],
        failures={"status": [ChatError("SERVICE_UNAVAILABLE")] * 4}, feed=[_receipt_row()], muted=False,
    )
    assert code == 0
    assert [frame["result"] for frame in frames[1:5]] == [{"refused": "SERVICE_UNAVAILABLE"}] * 4
    assert frames[5] == {"id": 5, "result": {"messages": []}}
    assert _ends(calls) == 1 and calls[-1][1] == "/v1/instance/end"


def test_sigterm_during_the_mute_read_still_ends_the_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    handlers: dict[int, Any] = {}
    code, frames, calls = _timed_worker(
        monkeypatch, [(1, {"op": "receipts"}), (2, {"op": "pending"})], [],
        failures={"status": [_sigterm(handlers)]}, handlers=handlers, feed=[_receipt_row()], muted=False,
    )
    assert code == 1
    assert frames[-1]["error"]["code"] == "TRANSPORT_UNAVAILABLE"
    assert len(frames) == 2  # no soft refusal was written, and the second frame was never read
    assert calls[-1] == (1, "/v1/instance/end") and _ends(calls) == 1


@pytest.mark.parametrize("operation", ["pending", "heartbeat"])
def test_sigterm_during_a_tolerated_outage_still_ends_the_worker(
    monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    handlers: dict[int, Any] = {}
    interrupted = _sigterm(handlers, "TRANSPORT_UNAVAILABLE" if operation == "pending" else "REQUEST_UNCERTAIN")
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(1, {"op": "pending"} if operation == "pending" else {"op": "heartbeat", "state": HEARTBEAT_STATE}),
         (2, {"op": "pending"})],
        [interrupted],
        failures={"heartbeat": [interrupted]},
        handlers=handlers,
    )
    assert code == 1
    assert frames[-1]["error"]["code"] in {"TRANSPORT_UNAVAILABLE", "REQUEST_UNCERTAIN"}
    assert len(frames) == 2  # no soft refusal was written, and the second frame was never read
    assert calls[-1] == (1, "/v1/instance/end")
    assert _ends(calls) == 1


def test_the_same_outage_without_sigterm_is_tolerated(monkeypatch: pytest.MonkeyPatch) -> None:
    # The control for the SIGTERM test: only the recorded signal differs.
    code, frames, _calls = _timed_worker(
        monkeypatch, [(1, {"op": "pending"})], [ChatError("TRANSPORT_UNAVAILABLE")], handlers={}
    )
    assert code == 0 and frames[1] == {"id": 1, "result": {"refused": "TRANSPORT_UNAVAILABLE"}}


def _frame(process: subprocess.Popen[str], request: dict[str, Any]) -> dict[str, Any]:
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    return json.loads(process.stdout.readline())


def test_live_worker_survives_a_server_restart_and_keeps_its_instance(
    process_api, credentials, send, join_frame, db,
) -> None:
    with subprocess.Popen(
        [sys.executable, "-m", "agent_chat.instance_worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=ROOT, env={},
    ) as process:
        try:
            joined = _frame(process, join_frame)["result"]
            record = Path(joined["instance_file"])
            beat = _frame(process, {"id": 1, "op": "heartbeat", "state": HEARTBEAT_STATE})
            assert beat["result"]["instance_id"] == joined["instance_id"]
            process_api.stop()
            # The listener stays open, so each request waits out the client's 3-second socket timeout.
            assert _frame(process, {"id": 2, "op": "pending"}) == {
                "id": 2, "result": {"refused": "TRANSPORT_UNAVAILABLE"}
            }
            assert _frame(process, {"id": 3, "op": "heartbeat", "state": HEARTBEAT_STATE}) == {
                "id": 3, "result": {"refused": "REQUEST_UNCERTAIN"}
            }
            assert process.poll() is None and record.exists()
            row = db.execute("SELECT id, ended_at FROM agent_chat.instances").fetchone()
            assert str(row["id"]) == joined["instance_id"] and row["ended_at"] is None
            process_api.restart(enable_delivery=True)
            assert _frame(process, {"id": 4, "op": "heartbeat", "state": HEARTBEAT_STATE})["result"][
                "instance_id"
            ] == joined["instance_id"]
            message = send(
                process_api, credentials, "synthetic coordination", kind="question",
                recipients=[joined["session_id"]],
            )
            assert _frame(process, {"id": 5, "op": "pending"}) == {
                "id": 5, "result": {"messages": [message["id"]]}
            }
            assert record.exists()
            assert db.execute("SELECT ended_at FROM agent_chat.instances").fetchone()["ended_at"] is None
            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=30)
            assert process.returncode == 0 and process.stderr is not None and process.stderr.read() == ""
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
    assert db.execute("SELECT ended_at FROM agent_chat.instances").fetchone()["ended_at"] is not None


def test_pending_with_bodies_keeps_the_empty_backoff_and_passes_the_sizing_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    message = str(uuid4())
    sized = {"messages": [message], "sizes": {message: 12}, "retry": False}
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(at, {"op": "pending", "bodies": True}) for at in [0, 1, 2, 3, 6]],
        [{"messages": []}, {"messages": []}, sized],
    )
    assert code == 0
    assert _pending_times(calls) == [0, 2, 6]  # the same 2 s then 4 s deadlines as a plain pending
    assert [frame["result"] for frame in frames[1:]] == [{"messages": []}] * 4 + [sized]
    assert frames[-1]["result"] == sized


def test_a_plain_pending_never_returns_the_sizing_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    message = str(uuid4())
    sized = {"messages": [message], "sizes": {message: 12}, "retry": True}
    code, frames, _calls = _timed_worker(monkeypatch, [(0, {"op": "pending"})], [sized])
    assert code == 0 and frames[1] == {"id": 1, "result": {"messages": [message]}}


@pytest.mark.parametrize("flag", ["yes", 1, 0, None, [], "true"])
def test_a_non_boolean_bodies_flag_is_an_invalid_request_before_any_call(
    monkeypatch: pytest.MonkeyPatch, flag: Any
) -> None:
    code, frames, calls = _timed_worker(monkeypatch, [(0, {"op": "pending", "bodies": flag})], [{"messages": []}])
    assert code == 1 and frames[-1] == {"id": 1, "error": {"code": "INVALID_REQUEST"}}
    assert _pending_times(calls) == []
    code, frames, calls = _timed_worker(
        monkeypatch,
        [(0, {"op": "claim", "key": str(uuid4()), "messages": [str(uuid4())], "bodies": flag})],
        [],
    )
    assert code == 1 and frames[-1] == {"id": 1, "error": {"code": "INVALID_REQUEST"}}
    assert "/v1/instance/deliveries/claim" not in [path for _at, path in calls]


@pytest.mark.parametrize("operation", ["pending", "claim"])
def test_any_other_extra_key_is_still_refused_beside_bodies(monkeypatch: pytest.MonkeyPatch, operation: str) -> None:
    frame: dict[str, Any] = {"op": operation, "bodies": True, "unexpected": True}
    if operation == "claim":
        frame |= {"key": str(uuid4()), "messages": [str(uuid4())]}
    code, frames, calls = _timed_worker(monkeypatch, [(0, frame)], [{"messages": []}])
    assert code == 1 and frames[-1] == {"id": 1, "error": {"code": "INVALID_REQUEST"}}
    assert [path for _at, path in calls if "deliveries" in path] == []


def test_a_claim_with_bodies_returns_the_grant_clock_and_a_plain_claim_does_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    message = str(uuid4())
    claim = {"op": "claim", "key": str(uuid4()), "messages": [message]}
    code, frames, _calls = _timed_worker(monkeypatch, [(0, claim | {"bodies": True}), (1, claim)], [])
    assert code == 0
    assert frames[1]["result"]["admitted_at"] == "2026-10-19T00:00:00+00:00"
    assert "admitted_at" not in frames[2]["result"]


def test_worker_reads_and_marks_sender_receipts_over_real_http(join_frame, db):
    foreign = str(uuid4())
    result = worker(
        join_frame,
        {"id": 1, "op": "receipts"},
        {"id": 2, "op": "receipts_delivered", "receipts": [foreign]},
        {"id": 3, "op": "status"},
        {"id": 4, "op": "end"},
    )
    assert result.returncode == 0 and result.stderr == ""
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert frames[1] == {"id": 1, "result": {"receipts": []}}  # an empty feed reads no mute flag
    # An ID the session does not own is ignored, never disclosed.
    assert frames[2] == {"id": 2, "result": {"delivered": []}}
    # The flag a non-empty receipts answer carries comes from this very answer, and the worker accepts only a boolean.
    assert frames[3]["result"]["muted"] is False


def test_receipt_ops_reach_http_inside_the_empty_pending_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    receipt = str(uuid4())
    code, frames, calls = _timed_worker(
        monkeypatch,
        [
            (0, {"op": "pending"}),
            (1, {"op": "receipts"}),
            (1, {"op": "receipts_delivered", "receipts": [receipt, receipt]}),
            (1, {"op": "pending"}),
        ],
        [{"messages": []}],
    )
    assert code == 0
    assert frames[2] == {"id": 2, "result": {"receipts": []}}
    assert frames[3] == {"id": 3, "result": {"delivered": [receipt]}}
    assert _pending_times(calls) == [0]  # the receipt ops neither reset nor consume the pending backoff
    assert [path.rsplit("/", 1)[-1] for _at, path in calls] == ["pending", "receipts", "delivered", "end"]


@pytest.mark.parametrize(
    "frame",
    [
        {"op": "receipts", "unexpected": True},
        {"op": "receipts_delivered"},
        {"op": "receipts_delivered", "receipts": []},
        {"op": "receipts_delivered", "receipts": "not-a-list"},
        {"op": "receipts_delivered", "receipts": ["not-a-uuid"]},
        {"op": "receipts_delivered", "receipts": [str(uuid4()) for _ in range(51)]},
        {"op": "receipts_delivered", "receipts": [str(uuid4())], "unexpected": True},
    ],
)
def test_receipt_frames_are_whitelisted_before_any_call(
    monkeypatch: pytest.MonkeyPatch, frame: dict[str, Any]
) -> None:
    code, frames, calls = _timed_worker(monkeypatch, [(0, frame)], [])
    assert code == 1 and frames[-1] == {"id": 1, "error": {"code": "INVALID_REQUEST"}}
    assert [path for _at, path in calls if "receipts" in path] == []
