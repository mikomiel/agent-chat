"""HTTP/PostgreSQL reservation evidence; no native harness is invoked by this suite."""

import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime
from uuid import uuid4

import pytest

from agent_chat import events
from agent_chat.deliveries import expire_undelivered
from agent_chat.retention import prune


@pytest.fixture
def delivery_enabled(request):
    return getattr(request, "param", True)


def ready(service, token, **changes):
    status, _ = service.request(
        "POST",
        "/v1/instance/heartbeat",
        {"native_state": "idle", "stopped": False, "plan_mode": False, **changes},
        token,
    )
    assert status == 200


@pytest.fixture
def target(process_api, credentials, register):
    token, binding = register(process_api, credentials, "recipient")
    ready(process_api, token)
    return token, binding


def claim(service, token, messages, key=None):
    return service.request(
        "POST",
        "/v1/instance/deliveries/claim",
        {"messages": messages},
        token,
        {"Idempotency-Key": str(key or uuid4())},
    )


def result(service, token, attempt, outcome="handed", reason=None):
    return service.request(
        "POST", f"/v1/instance/deliveries/{attempt['id']}/result", {"outcome": outcome, "reason": reason}, token
    )


@contextmanager
def backoff_held_open(db, attempt_id):
    """Keep a delivery backoff window open for one block, whatever the runner load.

    The window runs on the PostgreSQL clock from completed_at, so a stalled test process can outlast
    its 1 s or 5 s between two requests. Moving completed_at ahead holds it open; it is put back on exit.
    """
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET completed_at = completed_at + interval '1 hour' WHERE id = %s",
        (attempt_id,),
    )
    try:
        yield
    finally:
        db.execute(
            "UPDATE agent_chat.delivery_attempts SET completed_at = completed_at - interval '1 hour' WHERE id = %s",
            (attempt_id,),
        )


def question(service, credentials, send, binding, **changes):
    return send(
        service, credentials, "synthetic coordination", kind="question", recipients=[binding["session_id"]], **changes
    )


def refusal(response, status, code):
    assert response[0] == status, response
    assert response[1]["error"]["code"] == code


def test_batch_handoff_is_not_ack_and_replay_is_not_dispatch(process_api, credentials, target, send, db, event):
    token, binding = target
    first = question(process_api, credentials, send, binding)
    second = question(process_api, credentials, send, binding)
    key = uuid4()
    before = db.execute(
        "SELECT heartbeat_at FROM agent_chat.instances WHERE id = %s", (binding["instance_id"],)
    ).fetchone()
    status, admitted = claim(process_api, token, [second["id"], first["id"]], key)
    assert status == 200 and admitted["dispatch"] is True
    assert [row["id"] for row in admitted["messages"]] == [first["id"], second["id"]]
    attempt = admitted["attempt"]
    assert attempt["ordinal"] == 1 and attempt["outcome"] is None
    duration = datetime.fromisoformat(attempt["expires_at"]) - datetime.fromisoformat(attempt["admitted_at"])
    assert 0 < duration.total_seconds() <= 30.01
    assert (
        db.execute("SELECT heartbeat_at FROM agent_chat.instances WHERE id = %s", (binding["instance_id"],)).fetchone()
        == before
    )
    replay = claim(process_api, token, [first["id"], second["id"], first["id"]], key)
    assert replay == (200, {"dispatch": False, "attempt": attempt, "messages": []})
    refusal(claim(process_api, token, [first["id"]], key), 409, "IDEMPOTENCY_CONFLICT")
    cursor = db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"]
    with process_api.stream(f"/v1/events?after={cursor}", token=token) as response:
        completed = result(process_api, token, attempt)
        assert completed[0] == 200 and completed[1]["outcome"] == "handed"
        frame = event(response)
        receipt = frame["data"]["receipt"]
        assert frame["event"] == "receipt" and receipt["handed_at"]
        assert receipt["acknowledged_at"] is receipt["replying_message_id"] is None
        assert receipt["delivery"] == {"attempt": 1, "outcome": "handed", "reason": None}
    event_count = db.execute("SELECT position FROM agent_chat.event_clock").fetchone()
    assert result(process_api, token, attempt) == completed
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone() == event_count
    refusal(result(process_api, token, attempt, "failed", "native_unavailable"), 409, "DELIVERY_CLOSED")
    refusal(claim(process_api, token, [first["id"], second["id"]]), 409, "DELIVERY_CLOSED")
    process_api.restart()
    assert claim(process_api, token, [first["id"], second["id"]], key)[1]["dispatch"] is False
    status = process_api.request("GET", "/v1/instance/status", token=token)[1]
    assert status["wake_budget"]["used"] == 1 and status["pending"] == 2
    acknowledged = process_api.request("POST", f"/v1/messages/{first['id']}/ack", {}, token)
    assert acknowledged[0] == 200 and acknowledged[1]["handed_at"] and acknowledged[1]["acknowledged_at"]


@pytest.mark.parametrize("state", ["unknown", "muted", "stopped", "plan", "offline"])
def test_native_state_and_mute_fail_closed(process_api, credentials, target, send, db, state):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    expected = "DELIVERY_BLOCKED"
    if state == "unknown":
        ready(process_api, token, native_state="unknown")
    elif state == "muted":
        process_api.request("POST", f"/v1/sessions/{binding['session_id']}/mute", {"muted": True}, token)
    elif state == "stopped":
        ready(process_api, token, stopped=True)
    elif state == "plan":
        ready(process_api, token, plan_mode=True)
    else:
        db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
        expected = "STALE_INSTANCE"
    refusal(claim(process_api, token, [message["id"]]), 409, expected)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


@pytest.mark.parametrize("condition", ["message", "status", "unaddressed", "ack", "reply", "scope", "expired"])
def test_only_retained_addressed_unprocessed_wake_kinds_are_admitted(
    process_api, credentials, target, send, db, condition
):
    token, binding = target
    kind = condition if condition in ("message", "status") else "question"
    message = send(
        process_api,
        credentials,
        "synthetic",
        kind=kind,
        recipients=[] if condition == "unaddressed" else [binding["session_id"]],
    )
    code, status = "DELIVERY_INELIGIBLE", 409
    if condition == "unaddressed":
        code, status = "NOT_FOUND", 404
    elif condition == "ack":
        assert process_api.request("POST", f"/v1/messages/{message['id']}/ack", {}, token)[0] == 200
    elif condition == "reply":
        send(process_api, credentials, "answer", token, kind="reply", reply_to=message["id"])
    elif condition == "scope":
        db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (binding["session_id"],))
        code, status = "NOT_FOUND", 404
    elif condition == "expired":
        db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second'")
        code, status = "MESSAGE_EXPIRED", 410
    refusal(claim(process_api, token, [message["id"]]), status, code)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


@pytest.mark.parametrize("caller", ["host", "operator", "other", "revoked"])
def test_claim_and_result_bind_to_instance_not_payload(process_api, credentials, target, register, send, db, caller):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    admitted = claim(process_api, token, [message["id"]])[1]
    status, code = 401, "UNAUTHENTICATED"
    if caller == "host":
        token = credentials.agent
    elif caller == "operator":
        token, status, code = credentials.operator, 403, "SESSION_FORBIDDEN"
    elif caller == "other":
        token, _ = register(process_api, credentials, "other")
        ready(process_api, token)
        status, code = 404, "NOT_FOUND"
    else:
        db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (credentials.principal,))
    refusal(result(process_api, token, admitted["attempt"]), status, code)
    refusal(claim(process_api, token, [message["id"]]), status, code)
    assert db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"] is None


@pytest.mark.parametrize("outcome,reason", [("failed", "native_unavailable"), ("deferred", "busy")])
def test_exact_batch_has_three_attempts_with_one_and_five_second_backoff(
    process_api, credentials, target, send, db, outcome, reason
):
    token, binding = target
    messages = [question(process_api, credentials, send, binding)["id"] for _ in range(2)]
    unrelated = question(process_api, credentials, send, binding)["id"]
    for ordinal in range(1, 4):
        status, response = claim(process_api, token, list(reversed(messages)))
        assert status == 200 and response["attempt"]["ordinal"] == ordinal
        assert result(process_api, token, response["attempt"], outcome, reason)[0] == 200
        refusal(claim(process_api, token, [messages[0]]), 409, "DELIVERY_BATCH_CONFLICT")
        refusal(claim(process_api, token, [*messages, unrelated]), 409, "DELIVERY_BATCH_CONFLICT")
        if ordinal == 3:
            refusal(claim(process_api, token, messages), 409, "DELIVERY_EXHAUSTED")
        else:
            # The requests above can outlast the 1 s window on a loaded runner, so hold it open.
            with backoff_held_open(db, response["attempt"]["id"]):
                refusal(claim(process_api, token, messages), 409, "DELIVERY_BACKOFF")
            # PostgreSQL remains the clock. Wait through the actual contract delay,
            # not a mock timestamp or a configurable shorter production interval.
            seconds = 1 if ordinal == 1 else 5
            row = db.execute(
                "SELECT completed_at + %s * interval '1 second' AS due "
                "FROM agent_chat.delivery_attempts WHERE id = %s",
                (seconds, response["attempt"]["id"]),
            ).fetchone()
            deadline = time.monotonic() + seconds + 1
            while not db.execute("SELECT clock_timestamp() >= %s AS due", (row["due"],)).fetchone()["due"]:
                assert time.monotonic() < deadline
                time.sleep(0.02)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 3
    history = process_api.request("GET", f"/v1/rooms/{credentials.room}/history", token=token)[1]
    assert history["messages"][0]["receipts"][0]["delivery"] == {"attempt": 3, "outcome": outcome, "reason": reason}


@pytest.mark.parametrize("lost", ["explicit", "expiry", "ended"])
def test_uncertainty_is_terminal_across_process_restart_and_resume(
    process_api, credentials, target, register, send, db, lost
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    _, response = claim(process_api, token, [message["id"]])
    attempt = response["attempt"]
    if lost == "explicit":
        assert result(process_api, token, attempt, "uncertain", "transport_ambiguous")[0] == 200
    elif lost == "expiry":
        db.execute(
            "UPDATE agent_chat.delivery_attempts SET admitted_at = clock_timestamp() - interval '31 seconds', "
            "expires_at = clock_timestamp() - interval '1 second'"
        )
    else:
        assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200
        old = token
        token, resumed = register(process_api, credentials, "recipient")
        assert resumed["session_id"] == binding["session_id"] and resumed["instance_id"] != binding["instance_id"]
        ready(process_api, token)
        refusal(result(process_api, old, attempt), 409, "STALE_INSTANCE")
        refusal(result(process_api, token, attempt), 404, "NOT_FOUND")
    process_api.restart()
    refusal(claim(process_api, token, [message["id"]]), 409, "DELIVERY_CLOSED")
    row = db.execute("SELECT * FROM agent_chat.delivery_attempts").fetchone()
    assert row["outcome"] == "uncertain"
    receipt = db.execute("SELECT * FROM agent_chat.recipients").fetchone()
    assert receipt["handed_at"] is receipt["acknowledged_at"] is None
    assert receipt["uncertainty_reason"] == ("transport_ambiguous" if lost == "explicit" else "claim_expired")
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["uncertain"] == 1
    assert process_api.request("POST", f"/v1/messages/{message['id']}/ack", {}, token)[0] == 200
    state = process_api.request("GET", "/v1/instance/status", token=token)[1]
    assert state["uncertain"] == 0 and state["wake_budget"]["used"] == 1
    assert db.execute("SELECT uncertainty_reason FROM agent_chat.recipients").fetchone()["uncertainty_reason"]


@pytest.mark.parametrize("lapse", ["expiry", "ended"])
def test_lapsed_claim_is_projected_uncertain_before_any_reconcile(process_api, credentials, target, send, db, lapse):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    assert claim(process_api, token, [message["id"]])[0] == 200
    path = f"/v1/rooms/{credentials.room}/history"

    def delivery():
        status, history = process_api.request("GET", path, token=credentials.operator)
        assert status == 200
        return history["messages"][0]["receipts"][0]["delivery"]

    assert delivery() == {"attempt": 1, "outcome": "claimed", "reason": None}
    if lapse == "expiry":
        db.execute(
            "UPDATE agent_chat.delivery_attempts SET admitted_at = clock_timestamp() - interval '31 seconds', "
            "expires_at = clock_timestamp() - interval '1 second'"
        )
    else:
        db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp()")
    assert delivery() == {"attempt": 1, "outcome": "uncertain", "reason": "claim_expired"}
    # The read only projects. The persistent writer remains reconcile.
    assert db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"] is None
    assert db.execute("SELECT uncertainty_reason FROM agent_chat.recipients").fetchone()["uncertainty_reason"] is None


def test_same_key_race_returns_one_dispatch_and_different_keys_cannot_overlap(
    process_api, credentials, target, send, db
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    key = uuid4()
    with ThreadPoolExecutor(max_workers=2) as pool:
        rows = list(pool.map(lambda _: claim(process_api, token, [message["id"]], key), range(2)))
    assert all(row[0] == 200 for row in rows)
    assert sorted(row[1]["dispatch"] for row in rows) == [False, True]
    other = question(process_api, credentials, send, binding)
    refusal(claim(process_api, token, [other["id"]]), 409, "DELIVERY_IN_FLIGHT")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 1


def test_twenty_attempts_persist_across_resume_but_not_other_sessions(
    process_api, credentials, target, register, send, db
):
    token, binding = target
    for _ in range(20):
        message = question(process_api, credentials, send, binding)
        status, claimed = claim(process_api, token, [message["id"]])
        assert status == 200
        assert result(process_api, token, claimed["attempt"])[0] == 200
    another = question(process_api, credentials, send, binding)
    assert process_api.request("GET", "/v1/instance/deliveries/pending", token=token)[1]["messages"] == []
    refusal(claim(process_api, token, [another["id"]]), 429, "WAKE_LIMIT")
    assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200
    token, resumed = register(process_api, credentials, "recipient")
    assert resumed["session_id"] == binding["session_id"]
    ready(process_api, token)
    refusal(claim(process_api, token, [another["id"]]), 429, "WAKE_LIMIT")
    second, second_binding = register(process_api, credentials, "independent")
    ready(process_api, second, native_state="busy")
    other = question(process_api, credentials, send, second_binding)
    assert claim(process_api, second, [other["id"]])[0] == 200
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET admitted_at = admitted_at - interval '3601 seconds' "
        "WHERE session_id = %s",
        (binding["session_id"],),
    )
    assert claim(process_api, token, [another["id"]])[0] == 200


def test_consultation_six_reply_limit_rechecked_at_claim_and_operator_resets(process_api, credentials, target, send):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    # Replies to this sibling count in the same thread but do not confirm the target question.
    sibling = send(process_api, credentials, "sibling", thread_id=message["thread_id"])
    for _ in range(6):
        send(process_api, credentials, "agent continuation", token, kind="reply", reply_to=sibling["id"])
    refusal(claim(process_api, token, [message["id"]]), 409, "CONSULTATION_LIMIT")
    send(process_api, credentials, "agent status does not reset", token, kind="status", thread_id=message["thread_id"])
    refusal(claim(process_api, token, [message["id"]]), 409, "CONSULTATION_LIMIT")
    send(process_api, credentials, "operator participation", thread_id=message["thread_id"])
    assert claim(process_api, token, [message["id"]])[0] == 200


@pytest.mark.parametrize("delivery_enabled", [False], indirect=True)
def test_delivery_admission_defaults_off(process_api, credentials, target, send, db):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    refusal(claim(process_api, token, [message["id"]]), 403, "DELIVERY_DISABLED")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["delivery_supported"] is False
    refusal(process_api.request("GET", "/v1/instance/deliveries/pending", token=token), 403, "DELIVERY_DISABLED")


def test_disable_admission_keeps_settlement_and_database_for_rollback(process_api, credentials, target, send, db):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    status, claimed = claim(process_api, token, [message["id"]])
    assert status == 200
    process_api.restart(enable_delivery=False)
    refusal(claim(process_api, token, [message["id"]]), 403, "DELIVERY_DISABLED")
    assert result(process_api, token, claimed["attempt"])[0] == 200
    assert db.execute("SELECT body FROM agent_chat.messages").fetchone()["body"] == "synthetic coordination"
    process_api.restart()
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["wake_budget"]["used"] == 1


def test_receipt_event_failure_rolls_back_admission_and_completion(process_api, credentials, target, send, db):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    db.execute("ALTER TABLE agent_chat.events ADD CONSTRAINT synthetic_delivery_failure CHECK (kind <> 'receipt')")
    refusal(claim(process_api, token, [message["id"]]), 503, "DATABASE_UNAVAILABLE")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0
    assert db.execute("SELECT delivery_batch_id FROM agent_chat.recipients").fetchone()["delivery_batch_id"] is None
    db.execute("ALTER TABLE agent_chat.events DROP CONSTRAINT synthetic_delivery_failure")
    claimed = claim(process_api, token, [message["id"]])[1]
    db.execute(
        "ALTER TABLE agent_chat.events ADD CONSTRAINT synthetic_delivery_failure CHECK (kind <> 'receipt') NOT VALID"
    )
    refusal(result(process_api, token, claimed["attempt"]), 503, "DATABASE_UNAVAILABLE")
    assert db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"] is None
    assert db.execute("SELECT handed_at FROM agent_chat.recipients").fetchone()["handed_at"] is None


def test_prune_retains_hourly_admission_after_message_expiry_then_collects_ledger(
    process_api, credentials, target, send, db
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    claimed = claim(process_api, token, [message["id"]])[1]
    assert result(process_api, token, claimed["attempt"])[0] == 200
    db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second'")
    prune(db)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.recipients").fetchone()["n"] == 0
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["wake_budget"]["used"] == 1
    assert db.execute("SELECT body FROM agent_chat.messages").fetchone()["body"] is None
    db.execute("UPDATE agent_chat.delivery_attempts SET admitted_at = admitted_at - interval '3601 seconds'")
    prune(db)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_batches").fetchone()["n"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        {"outcome": "failed", "reason": "transport_ambiguous"},
        {"outcome": "handed", "reason": "busy"},
        {"outcome": "uncertain"},
        {"outcome": "handed", "session_id": "caller-selected"},
    ],
)
def test_result_vocabulary_is_strict(process_api, target, payload):
    token, _ = target
    response = process_api.request("POST", f"/v1/instance/deliveries/{uuid4()}/result", payload, token)
    refusal(response, 422, "INVALID_REQUEST")


@pytest.mark.parametrize(
    "payload", [{"messages": []}, {"messages": [str(uuid4())] * 17}, {"messages": [str(uuid4())], "source": "ci"}]
)
def test_claim_bounds_and_provenance_are_not_caller_overrides(process_api, target, payload):
    token, _ = target
    response = process_api.request(
        "POST", "/v1/instance/deliveries/claim", payload, token, {"Idempotency-Key": str(uuid4())}
    )
    refusal(response, 422, "INVALID_REQUEST")


def wait_until(db, query, *, timeout=2):
    deadline = time.monotonic() + timeout
    while True:
        db.execute("SELECT pg_stat_clear_snapshot()")
        if db.execute(query).fetchone()["ready"]:
            return
        assert time.monotonic() < deadline, "database did not reach the expected boundary"
        time.sleep(0.01)


@pytest.mark.parametrize("boundary", ["result", "message", "instance"])
def test_expiry_is_checked_after_room_lock_wait_and_uncertainty_commits_on_refusal(
    process_api, credentials, target, send, db, expiry_margin, boundary
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    attempt = claim(process_api, token, [message["id"]])[1]["attempt"] if boundary == "result" else None
    if boundary == "result":
        db.execute(
            "UPDATE agent_chat.delivery_attempts SET expires_at = clock_timestamp() + make_interval(secs => %s)",
            (expiry_margin,),
        )
        expired = "SELECT expires_at <= clock_timestamp() AS ready FROM agent_chat.delivery_attempts"
    elif boundary == "message":
        db.execute(
            "UPDATE agent_chat.messages SET expires_at = clock_timestamp() + make_interval(secs => %s)",
            (expiry_margin,),
        )
        expired = "SELECT expires_at <= clock_timestamp() AS ready FROM agent_chat.messages"
    else:
        db.execute(
            "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s)",
            (90 - expiry_margin,),
        )
        expired = "SELECT heartbeat_at <= clock_timestamp() - interval '90 seconds' AS ready FROM agent_chat.instances"
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (credentials.principal,)
            )
            pending = (
                pool.submit(result, process_api, token, attempt)
                if attempt
                else pool.submit(claim, process_api, token, [message["id"]])
            )
            wait_until(
                db,
                """SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                AND query LIKE '%SELECT 1 FROM agent_chat.principal_rooms%') AS ready""",
                timeout=expiry_margin,
            )
            wait_until(db, expired, timeout=expiry_margin + 1)
        response = pending.result()
    refusal(
        response,
        410 if boundary == "message" else 409,
        {"result": "DELIVERY_CLOSED", "message": "MESSAGE_EXPIRED", "instance": "STALE_INSTANCE"}[boundary],
    )
    if attempt:
        assert db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"] == "uncertain"
        receipt = db.execute("SELECT handed_at, uncertainty_reason FROM agent_chat.recipients").fetchone()
        assert receipt == {"handed_at": None, "uncertainty_reason": "claim_expired"}
    else:
        assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


@pytest.mark.parametrize("boundary", ["lease", "retention", "reservation"])
def test_each_deadline_checked_after_the_sender_receipt_waits_refuses_and_commits_nothing(
    process_api, credentials, target, register, send, db, expiry_margin, boundary
):
    """The handed receipt's insert can block on the sender session row. Lease, message
    retention and reservation are each rechecked after that wait; one crossing per case."""
    token, binding = target
    sender_token, sender = register(process_api, credentials, "sender")
    message = question(process_api, credentials, send, binding, token=sender_token)
    attempt = claim(process_api, token, [message["id"]])[1]["attempt"]
    if boundary == "lease":
        # Only the recipient's lease is shortened, so it is the one that crosses.
        db.execute(
            "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s) "
            "WHERE id = %s",
            (90 - expiry_margin, binding["instance_id"]),
        )
        crossed = (
            "SELECT bool_or(heartbeat_at <= clock_timestamp() - interval '90 seconds') AS ready "
            "FROM agent_chat.instances"
        )
    elif boundary == "retention":
        db.execute(
            "UPDATE agent_chat.messages SET expires_at = clock_timestamp() + make_interval(secs => %s) "
            "WHERE id = %s",
            (expiry_margin, message["id"]),
        )
        crossed = "SELECT bool_or(expires_at <= clock_timestamp()) AS ready FROM agent_chat.messages"
    else:
        db.execute(
            "UPDATE agent_chat.delivery_attempts "
            "SET expires_at = clock_timestamp() + make_interval(secs => %s) WHERE id = %s",
            (expiry_margin, attempt["id"]),
        )
        crossed = "SELECT bool_or(expires_at <= clock_timestamp()) AS ready FROM agent_chat.delivery_attempts"
    events_before = db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"]
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            # The handed receipt's foreign-key check on its sender session waits behind this row lock.
            db.execute("SELECT 1 FROM agent_chat.sessions WHERE id = %s FOR UPDATE", (sender["session_id"],))
            pending = pool.submit(result, process_api, token, attempt)
            wait_until(
                db,
                """SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                AND query LIKE '%INSERT INTO agent_chat.sender_receipts%') AS ready""",
                timeout=expiry_margin,
            )
            wait_until(db, crossed, timeout=expiry_margin + 1)
        response = pending.result()
    refusal(
        response,
        {"lease": 409, "retention": 410, "reservation": 409}[boundary],
        {"lease": "STALE_INSTANCE", "retention": "MESSAGE_EXPIRED", "reservation": "DELIVERY_CLOSED"}[boundary],
    )
    assert db.execute("SELECT count(*) AS n FROM agent_chat.sender_receipts").fetchone()["n"] == 0
    if boundary == "reservation":
        # The refused settlement rolled back; the existing reconciliation then commits the
        # reservation's expiry as uncertainty, which is not a handoff.
        assert db.execute("SELECT outcome, reason FROM agent_chat.delivery_attempts").fetchone() == {
            "outcome": "uncertain", "reason": "claim_expired"}
        assert db.execute("SELECT handed_at, uncertainty_reason FROM agent_chat.recipients").fetchone() == {
            "handed_at": None, "uncertainty_reason": "claim_expired"}
    else:
        assert db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"] is None
        assert db.execute("SELECT handed_at, uncertainty_reason FROM agent_chat.recipients").fetchone() == {
            "handed_at": None, "uncertainty_reason": None}
        assert db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"] == events_before


def test_last_hourly_slot_is_serialized_across_concurrent_batches(process_api, credentials, target, send):
    token, binding = target
    for _ in range(19):
        message = question(process_api, credentials, send, binding)
        claimed = claim(process_api, token, [message["id"]])
        assert claimed[0] == 200
        assert result(process_api, token, claimed[1]["attempt"])[0] == 200
    waiting = [question(process_api, credentials, send, binding)["id"] for _ in range(2)]

    def deliver(message):
        response = claim(process_api, token, [message])
        if response[0] == 200:
            assert result(process_api, token, response[1]["attempt"])[0] == 200
        return response

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(deliver, waiting))
    assert sum(row[0] == 200 for row in responses) == 1
    rejected = next(row for row in responses if row[0] != 200)
    assert (rejected[0], rejected[1]["error"]["code"]) in ((429, "WAKE_LIMIT"), (409, "DELIVERY_IN_FLIGHT"))
    state = process_api.request("GET", "/v1/instance/status", token=token)[1]
    assert state["wake_budget"]["used"] == 20 and state["wake_budget"]["remaining"] == 0


def test_result_revocation_and_bounded_expiry_pruning_do_not_lose_unknown_handoffs(
    process_api, credentials, target, register, send, db
):
    first, binding = target
    second, other = register(process_api, credentials, "other")
    ready(process_api, second)
    for token, receiver in [(first, binding), (second, other)]:
        message = question(process_api, credentials, send, receiver)
        claimed = claim(process_api, token, [message["id"]])[1]
        db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (receiver["session_id"],))
        refusal(result(process_api, token, claimed["attempt"]), 404, "NOT_FOUND")
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET admitted_at = clock_timestamp() - interval '31 seconds', "
        "expires_at = clock_timestamp() - interval '1 second'"
    )
    prune(db, limit=1)
    assert (
        db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts WHERE outcome = 'uncertain'").fetchone()[
            "n"
        ]
        == 1
    )
    prune(db, limit=1)
    assert (
        db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts WHERE outcome = 'uncertain'").fetchone()[
            "n"
        ]
        == 2
    )
    assert (
        db.execute("SELECT count(*) AS n FROM agent_chat.recipients WHERE handed_at IS NOT NULL").fetchone()["n"] == 0
    )


@pytest.mark.parametrize("kind", ["consultation", "reply"])
def test_other_addressed_wake_kinds_and_whole_batch_rejection(process_api, credentials, target, send, kind):
    token, binding = target
    parent = send(process_api, credentials, "room context")
    message = send(
        process_api,
        credentials,
        "coordination",
        kind=kind,
        recipients=[binding["session_id"]],
        **({"reply_to": parent["id"]} if kind == "reply" else {}),
    )
    ordinary = send(process_api, credentials, "not a wake", recipients=[binding["session_id"]])
    refusal(claim(process_api, token, [message["id"], ordinary["id"]]), 409, "DELIVERY_INELIGIBLE")
    response = claim(process_api, token, [message["id"]])
    assert response[0] == 200 and response[1]["attempt"]["ordinal"] == 1


def test_ack_projection_expiry_after_recipient_lock_wait_is_not_an_internal_error(
    process_api, credentials, target, send, db, lock_wait, expiry_margin
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() + make_interval(secs => %s)",
        (expiry_margin,),
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute("SELECT 1 FROM agent_chat.recipients FOR UPDATE")
            pending = pool.submit(process_api.request, "POST", f"/v1/messages/{message['id']}/ack", {}, token)
            lock_wait("agent_chat.recipients", timeout=expiry_margin)
            wait_until(
                db,
                "SELECT expires_at <= clock_timestamp() AS ready FROM agent_chat.messages",
                timeout=expiry_margin + 1,
            )
        response = pending.result()
    refusal(response, 410, "MESSAGE_EXPIRED")
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients").fetchone()["acknowledged_at"] is None
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"] == 1


def test_ack_lease_expiry_during_recipient_lock_wait_is_stale_instance(
    process_api, credentials, target, send, db, lock_wait, expiry_margin
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s)",
        (90 - expiry_margin,),
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute("SELECT 1 FROM agent_chat.recipients FOR UPDATE")
            pending = pool.submit(process_api.request, "POST", f"/v1/messages/{message['id']}/ack", {}, token)
            lock_wait("agent_chat.recipients", timeout=expiry_margin)
            wait_until(
                db,
                "SELECT heartbeat_at <= clock_timestamp() - interval '90 seconds' AS ready FROM agent_chat.instances",
                timeout=expiry_margin + 1,
            )
        response = pending.result()
    refusal(response, 409, "STALE_INSTANCE")
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients").fetchone()["acknowledged_at"] is None
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"] == 1


def test_pending_is_bounded_read_only_and_returns_whole_retry_batches(process_api, credentials, target, send, db):
    token, binding = target
    messages = [question(process_api, credentials, send, binding)["id"] for _ in range(18)]

    def pending():
        status, body = process_api.request("GET", "/v1/instance/deliveries/pending", token=token)
        assert status == 200 and body["instance_id"] == binding["instance_id"]
        return body["messages"]

    before = db.execute("SELECT position FROM agent_chat.event_clock").fetchone()
    lease = db.execute("SELECT heartbeat_at FROM agent_chat.instances").fetchone()
    assert pending() == messages[:16]
    assert pending() == messages[:16]
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone() == before
    assert db.execute("SELECT heartbeat_at FROM agent_chat.instances").fetchone() == lease
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0
    admitted = claim(process_api, token, messages[:16])[1]
    assert pending() == []  # even other messages wait for the in-flight reservation
    assert result(process_api, token, admitted["attempt"], "deferred", "busy")[0] == 200
    with backoff_held_open(db, admitted["attempt"]["id"]):
        assert pending() == messages[16:]
    time.sleep(1.05)
    assert set(pending()) == set(messages[:16])
    # Processing one member makes the whole immutable retry batch ineligible.
    assert process_api.request("POST", f"/v1/messages/{messages[0]}/ack", {}, token)[0] == 200
    assert pending() == messages[16:]


@pytest.mark.parametrize(
    "condition",
    [
        "message",
        "status",
        "unaddressed",
        "ack",
        "handed",
        "uncertain",
        "expired",
        "scope",
        "limit",
        "exhausted",
        "muted",
        "stopped",
        "plan",
    ],
)
def test_pending_excludes_ineligible_or_terminal_items(process_api, credentials, target, send, db, condition):
    token, binding = target
    message = send(
        process_api,
        credentials,
        "candidate",
        kind=condition if condition in ("message", "status") else "question",
        recipients=[] if condition == "unaddressed" else [binding["session_id"]],
    )
    if condition == "ack":
        assert process_api.request("POST", f"/v1/messages/{message['id']}/ack", {}, token)[0] == 200
    elif condition in ("handed", "uncertain", "exhausted"):
        attempt = claim(process_api, token, [message["id"]])[1]["attempt"]
        outcome, reason = (
            ("failed", "native_unavailable")
            if condition == "exhausted"
            else (condition, "transport_ambiguous" if condition == "uncertain" else None)
        )
        assert result(process_api, token, attempt, outcome, reason)[0] == 200
        if condition == "exhausted":
            db.execute("UPDATE agent_chat.delivery_attempts SET ordinal = 3 WHERE id = %s", (attempt["id"],))
    elif condition == "expired":
        db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second'")
    elif condition == "scope":
        db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (binding["session_id"],))
    elif condition == "limit":
        db.execute("UPDATE agent_chat.threads SET agent_replies = 6")
    elif condition == "muted":
        assert (
            process_api.request("POST", f"/v1/sessions/{binding['session_id']}/mute", {"muted": True}, token)[0] == 200
        )
    elif condition in ("stopped", "plan"):
        ready(process_api, token, **{"stopped" if condition == "stopped" else "plan_mode": True})
    assert process_api.request("GET", "/v1/instance/deliveries/pending", token=token)[1]["messages"] == []


@pytest.mark.parametrize("caller", ["operator", "host", "other", "expired"])
def test_pending_authentication_and_concrete_session_scope(
    process_api, credentials, target, register, send, db, caller
):
    token, binding = target
    question(process_api, credentials, send, binding)
    if caller == "operator":
        refusal(
            process_api.request("GET", "/v1/instance/deliveries/pending", token=credentials.operator),
            403,
            "SESSION_FORBIDDEN",
        )
    elif caller == "host":
        refusal(
            process_api.request("GET", "/v1/instance/deliveries/pending", token=credentials.agent),
            401,
            "UNAUTHENTICATED",
        )
    elif caller == "other":
        other, _ = register(process_api, credentials, "other")
        ready(process_api, other)
        assert process_api.request("GET", "/v1/instance/deliveries/pending", token=other)[1]["messages"] == []
    else:
        db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
        refusal(process_api.request("GET", "/v1/instance/deliveries/pending", token=token), 409, "STALE_INSTANCE")


def test_end_persists_abandoned_uncertainty_but_cannot_settle_replacement(
    process_api, credentials, target, register, send, db
):
    token, binding = target
    message = question(process_api, credentials, send, binding)
    attempt = claim(process_api, token, [message["id"]])[1]["attempt"]
    assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200
    row = db.execute(
        "SELECT outcome, reason FROM agent_chat.delivery_attempts WHERE id = %s", (attempt["id"],)
    ).fetchone()
    assert row == {"outcome": "uncertain", "reason": "claim_expired"}
    replacement, new_binding = register(process_api, credentials, "recipient")
    ready(process_api, replacement)
    next_message = question(process_api, credentials, send, new_binding)
    next_attempt = claim(process_api, replacement, [next_message["id"]])[1]["attempt"]
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET admitted_at = clock_timestamp() - interval '30 seconds', "
        "expires_at = clock_timestamp() - interval '1 second' WHERE id = %s",
        (next_attempt["id"],),
    )
    assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200
    assert (
        db.execute("SELECT outcome FROM agent_chat.delivery_attempts WHERE id = %s", (next_attempt["id"],)).fetchone()[
            "outcome"
        ]
        is None
    )


def age_recipient(db, message_id, interval):
    db.execute(
        "UPDATE agent_chat.recipients SET stored_at = clock_timestamp() - %s::interval WHERE message_id = %s",
        (interval, message_id),
    )


def test_pending_offers_only_items_younger_than_the_age_limit(process_api, credentials, target, send, db):
    token, binding = target
    old = question(process_api, credentials, send, binding)["id"]
    young = question(process_api, credentials, send, binding)["id"]
    age_recipient(db, old, "24 hours 1 minute")
    age_recipient(db, young, "23 hours 59 minutes")
    assert process_api.request("GET", "/v1/instance/deliveries/pending", token=token)[1]["messages"] == [young]


def test_deferred_batch_past_the_age_limit_is_not_reoffered_or_claimable(process_api, credentials, target, send, db):
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]

    def pending():
        return process_api.request("GET", "/v1/instance/deliveries/pending", token=token)[1]["messages"]

    for _ in range(2):
        attempt = claim(process_api, token, [message])[1]["attempt"]
        assert result(process_api, token, attempt, "deferred", "busy")[0] == 200
        # Move the backoff window into the past instead of sleeping through it.
        db.execute(
            "UPDATE agent_chat.delivery_attempts SET completed_at = completed_at - interval '1 hour' WHERE id = %s",
            (attempt["id"],),
        )
    assert db.execute("SELECT max(ordinal) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 2
    assert pending() == [message]  # the third attempt is otherwise due
    age_recipient(db, message, "24 hours 1 minute")
    assert pending() == []
    refusal(claim(process_api, token, [message]), 409, "DELIVERY_INELIGIBLE")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 2
    # The refusal still committed the settlement of the requesting session's old row.
    row = db.execute("SELECT uncertainty_reason FROM agent_chat.recipients").fetchone()
    assert row["uncertainty_reason"] == "expired_undelivered"


@pytest.mark.parametrize("boundary", ["claim", "pending"])
def test_age_limit_is_judged_after_the_room_lock_wait(
    process_api, credentials, target, send, db, expiry_margin, boundary
):
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    age_recipient(db, message, f"24 hours - {expiry_margin} seconds")
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (credentials.principal,)
            )
            waiting = (
                pool.submit(claim, process_api, token, [message])
                if boundary == "claim"
                else pool.submit(process_api.request, "GET", "/v1/instance/deliveries/pending", token=token)
            )
            wait_until(
                db,
                """SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                AND query LIKE '%SELECT 1 FROM agent_chat.principal_rooms%') AS ready""",
                timeout=expiry_margin,
            )
            wait_until(
                db,
                "SELECT stored_at <= clock_timestamp() - interval '24 hours' AS ready FROM agent_chat.recipients",
                timeout=expiry_margin + 1,
            )
        response = waiting.result()
    if boundary == "claim":
        refusal(response, 409, "DELIVERY_INELIGIBLE")
        row = db.execute("SELECT uncertainty_reason FROM agent_chat.recipients").fetchone()
        assert row["uncertainty_reason"] == "expired_undelivered"
    else:
        assert response[0] == 200
        assert response[1]["messages"] == []
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


def test_age_limit_is_judged_after_reconciliation_settles_an_expired_reservation(
    process_api, credentials, target, send, db, expiry_margin
):
    token, binding = target
    stale = question(process_api, credentials, send, binding)["id"]
    assert claim(process_api, token, [stale])[0] == 200
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET admitted_at = clock_timestamp() - interval '2 seconds', "
        "expires_at = clock_timestamp() - interval '1 second'"
    )
    message = question(process_api, credentials, send, binding)["id"]
    age_recipient(db, message, f"24 hours - {expiry_margin} seconds")
    # Settling the unrelated reservation outlasts the margin, so the item crosses the limit inside reconcile().
    db.execute(
        "CREATE FUNCTION agent_chat.slow_settlement() RETURNS trigger LANGUAGE plpgsql AS "
        f"$$ BEGIN PERFORM pg_sleep({expiry_margin + 1}); RETURN NEW; END $$"
    )
    db.execute(
        "CREATE TRIGGER slow_settlement BEFORE UPDATE ON agent_chat.delivery_attempts "
        "FOR EACH ROW EXECUTE FUNCTION agent_chat.slow_settlement()"
    )
    try:
        refusal(claim(process_api, token, [message]), 409, "DELIVERY_INELIGIBLE")
    finally:
        db.execute("DROP TRIGGER slow_settlement ON agent_chat.delivery_attempts")
        db.execute("DROP FUNCTION agent_chat.slow_settlement()")
    rows = db.execute(
        "SELECT message_id, uncertainty_reason FROM agent_chat.recipients WHERE message_id = ANY(%s::uuid[])",
        ([stale, message],),
    ).fetchall()
    assert {str(row["message_id"]): row["uncertainty_reason"] for row in rows} == {
        stale: "claim_expired",
        message: "expired_undelivered",
    }
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 1


def test_expire_undelivered_settles_only_old_unhanded_items_without_an_open_attempt(
    process_api, credentials, target, send, db
):
    token, binding = target
    ids = {
        name: question(process_api, credentials, send, binding)["id"]
        for name in ("old", "young", "handed", "acked", "replied", "open")
    }
    handed = claim(process_api, token, [ids["handed"]])[1]["attempt"]
    assert result(process_api, token, handed)[0] == 200
    assert process_api.request("POST", f"/v1/messages/{ids['acked']}/ack", {}, token)[0] == 200
    db.execute(
        "UPDATE agent_chat.recipients SET replying_message_id = %s WHERE message_id = %s", (ids["old"], ids["replied"])
    )
    open_attempt = claim(process_api, token, [ids["open"]])[1]["attempt"]
    for name, message in ids.items():
        age_recipient(db, message, "1 hour" if name == "young" else "25 hours")

    def reasons():
        rows = db.execute("SELECT message_id, uncertainty_reason FROM agent_chat.recipients").fetchall()
        return {
            name: next(r["uncertainty_reason"] for r in rows if str(r["message_id"]) == message)
            for name, message in ids.items()
        }

    def receipts(message):
        return db.execute(
            "SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt' AND message_id = %s", (message,)
        ).fetchone()["n"]

    def expire(**kwargs):
        with db.transaction():
            events.lock(db)
            return expire_undelivered(db, **kwargs)

    before = receipts(ids["old"])
    assert expire(session=uuid4()) == 0
    assert expire() == 1
    assert reasons() == dict.fromkeys(ids, None) | {"old": "expired_undelivered"}
    assert receipts(ids["old"]) == before + 1
    assert expire() == 0
    assert receipts(ids["old"]) == before + 1
    # The in-flight attempt still settles through its own result.
    assert result(process_api, token, open_attempt)[0] == 200
    assert expire() == 0
    assert reasons()["open"] is None
    assert db.execute("SELECT handed_at FROM agent_chat.recipients WHERE message_id = %s", (ids["open"],)).fetchone()[
        "handed_at"
    ]


def test_pending_reports_body_sizes_and_the_retry_marker(process_api, credentials, target, send, db):
    token, binding = target
    bodies = ["a", "zażółć gęślą jaźń " * 40, "x" * 5000]
    messages = [
        send(
            process_api,
            credentials,
            body,
            kind="question",
            recipients=[binding["session_id"]],
        )["id"]
        for body in bodies
    ]

    def pending():
        status, body = process_api.request("GET", "/v1/instance/deliveries/pending", token=token)
        assert status == 200
        return body

    fresh = pending()
    assert fresh["messages"] == messages
    assert fresh["retry"] is False
    assert fresh["sizes"] == {mid: len(body.encode()) for mid, body in zip(messages, bodies, strict=True)}
    assert all(type(size) is int and size >= 0 for size in fresh["sizes"].values())

    admitted = claim(process_api, token, messages)[1]
    assert result(process_api, token, admitted["attempt"], "deferred", "busy")[0] == 200
    time.sleep(1.05)
    again = pending()
    assert set(again["messages"]) == set(messages)
    assert again["retry"] is True
    assert again["sizes"] == fresh["sizes"]  # every member of the immutable batch, with its size


def test_an_empty_pending_carries_no_sizes(process_api, target):
    token, binding = target
    status, body = process_api.request("GET", "/v1/instance/deliveries/pending", token=token)
    assert status == 200
    assert body == {"session_id": binding["session_id"], "instance_id": binding["instance_id"], "messages": []}
