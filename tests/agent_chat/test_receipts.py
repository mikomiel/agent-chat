import time
from concurrent.futures import ThreadPoolExecutor
from http.cookies import SimpleCookie
from uuid import UUID, uuid4

import pytest

from agent_chat import browser
from agent_chat.auth import authenticate
from agent_chat.models import ChatError
from agent_chat.receipts import acknowledge


@pytest.fixture
def public_origin():
    return "https://chat.test"


def test_ack_is_explicit_idempotent_and_survives_restart(process_api, credentials, db, register, send, event):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "question", kind="question", recipients=[binding["session_id"]])
    with process_api.stream(token=token) as response:
        initial = event(response)
        receipt = initial["data"]["message"]["receipts"][0]
        assert receipt["acknowledged_at"] is receipt["handed_at"] is receipt["replying_message_id"] is None
        path = f"/v1/messages/{message['id']}/ack"
        status, acknowledged = process_api.request("POST", path, {}, token)
        assert status == 200 and acknowledged["acknowledged_at"]
        assert acknowledged["handed_at"] is acknowledged["replying_message_id"] is None
        frame = event(response)
        assert frame["event"] == "receipt" and int(frame["id"]) > int(initial["id"])
        assert frame["data"]["receipt"] == acknowledged
        assert process_api.request("POST", path, {}, token) == (200, acknowledged)
    process_api.restart()
    assert process_api.request("POST", path, {}, token) == (200, acknowledged)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"] == 1
    status, history = process_api.request("GET", f"/v1/rooms/{credentials.room}/history", token=token)
    assert status == 200 and history["messages"][0]["receipts"] == [acknowledged]


def test_reply_endpoint_and_publication_record_first_reply_only(process_api, credentials, db, register, send):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "question", kind="question", recipients=[binding["session_id"]])
    headers = {"Idempotency-Key": str(uuid4())}
    path = f"/v1/messages/{message['id']}/replies"
    status, first = process_api.request("POST", path, {"body": "first reply"}, token, headers)
    assert status == 200 and first["reply_to"] == message["id"] and first["thread_id"] == message["thread_id"]
    assert first["sender"]["session_id"] == binding["session_id"]
    assert process_api.request("POST", path, {"body": "first reply"}, token, headers) == (200, first)
    assert process_api.request("POST", path, {"body": "different"}, token, headers)[0] == 409
    send(process_api, credentials, "another reply", token, kind="reply", reply_to=message["id"])
    receipt = db.execute("SELECT * FROM agent_chat.recipients WHERE message_id = %s", (message["id"],)).fetchone()
    assert str(receipt["replying_message_id"]) == first["id"]
    assert receipt["acknowledged_at"] is receipt["handed_at"] is None
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"] == 1
    status, state = process_api.request("GET", "/v1/instance/status", token=token)
    assert status == 200 and state["pending"] == 0


def test_unaddressed_reply_does_not_fabricate_recipient_receipt(process_api, credentials, db, register, send):
    token, _ = register(process_api, credentials, "bystander")
    message = send(process_api, credentials, "room message")
    status, _ = process_api.request(
        "POST",
        f"/v1/messages/{message['id']}/replies",
        {"body": "room reply"},
        token,
        {"Idempotency-Key": str(uuid4())},
    )
    assert status == 200
    assert db.execute("SELECT count(*) AS n FROM agent_chat.recipients").fetchone()["n"] == 0


@pytest.mark.parametrize("caller", ["host", "operator", "other", "stale", "revoked", "foreign_room", "expired"])
def test_ack_refuses_wrong_purpose_scope_instance_and_expiry(process_api, credentials, db, caller, register, send):
    token, binding = register(process_api, credentials, "recipient")
    other, _ = register(process_api, credentials, "other")
    message = send(process_api, credentials, "question", kind="question", recipients=[binding["session_id"]])
    expected = 403
    if caller == "host":
        token, expected = credentials.agent, 401
    elif caller == "operator":
        token = credentials.operator
    elif caller == "other":
        token = other
    elif caller == "stale":
        process_api.request("POST", "/v1/instance/end", {}, token)
        expected = 409
    elif caller == "revoked":
        db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (credentials.principal,))
        expected = 401
    elif caller == "foreign_room":
        db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (binding["session_id"],))
        expected = 404
    else:
        db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second'")
        expected = 410
    status, _ = process_api.request("POST", f"/v1/messages/{message['id']}/ack", {}, token)
    assert status == expected
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients").fetchone()["acknowledged_at"] is None
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"] == 0


def test_ack_rechecks_already_resolved_actor_and_rolls_back(db, process_api, credentials, register, send):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "q", kind="question", recipients=[binding["session_id"]])
    actor = authenticate(db, token)

    with pytest.raises(RuntimeError), db.transaction():
        acknowledge(db, actor, UUID(message["id"]))
        raise RuntimeError("synthetic rollback")
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients").fetchone()["acknowledged_at"] is None
    db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp()")
    with pytest.raises(ChatError, match="STALE_INSTANCE"):
        acknowledge(db, actor, UUID(message["id"]))


def test_status_scopes_counts_and_does_not_renew_presence(process_api, credentials, db, register, send):
    token, binding = register(process_api, credentials, "recipient")
    plain = send(process_api, credentials, "ordinary", recipients=[binding["session_id"]])
    uncertain = send(process_api, credentials, "uncertain", kind="question", recipients=[binding["session_id"]])
    db.execute(
        "UPDATE agent_chat.recipients SET uncertainty_reason = 'SEND_UNCERTAIN' WHERE message_id = %s",
        (uncertain["id"],),
    )
    before = db.execute("SELECT heartbeat_at FROM agent_chat.instances").fetchone()["heartbeat_at"]
    status, state = process_api.request("GET", "/v1/instance/status", token=token)
    assert status == 200 and {key: state[key] for key in ("pending", "uncertain")} == {"pending": 1, "uncertain": 1}
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (binding["session_id"],))
    scoped = process_api.request("GET", "/v1/instance/status", token=token)[1]
    assert scoped["pending"] == scoped["uncertain"] == 0
    db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (credentials.room, binding["session_id"]))
    assert state["wake_budget"] is None and state["delivery_supported"] is False
    assert state["stopped"] and state["plan_mode"] and state["native_state"] == "unknown"
    assert db.execute("SELECT heartbeat_at FROM agent_chat.instances").fetchone()["heartbeat_at"] == before
    assert process_api.request("POST", f"/v1/messages/{plain['id']}/ack", {}, token)[0] == 200
    assert process_api.request("POST", f"/v1/messages/{uncertain['id']}/ack", {}, token)[0] == 200
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["uncertain"] == 0
    assert (
        db.execute(
            "SELECT uncertainty_reason FROM agent_chat.recipients WHERE message_id = %s", (uncertain["id"],)
        ).fetchone()["uncertainty_reason"]
        == "SEND_UNCERTAIN"
    )
    db.execute("DELETE FROM agent_chat.memberships")
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["rooms"] == []
    assert process_api.request("GET", "/v1/instance/status", token=credentials.operator)[0] == 403


def test_mute_control_preserves_stop_and_binding_on_resume(process_api, credentials, db, register, event):
    token, binding = register(process_api, credentials, "recipient")
    path = f"/v1/sessions/{binding['session_id']}/mute"
    with process_api.stream(token=token) as response:
        assert process_api.request("POST", path, {"muted": True}, token)[0] == 200
        frame = event(response)
        assert frame["event"] == "control" and frame["data"]["session_id"] == binding["session_id"]
        assert frame["data"]["muted"] is True
        assert process_api.request("POST", path, {"muted": True}, token)[0] == 200
        assert db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"] == 1
    process_api.request("POST", "/v1/instance/end", {}, token)
    replacement, resumed = register(process_api, credentials, "recipient")
    assert resumed["session_id"] == binding["session_id"] and resumed["instance_id"] != binding["instance_id"]
    assert process_api.request("POST", path, {"muted": False}, token)[0] == 409
    assert process_api.request("GET", "/v1/instance/status", token=replacement)[1]["muted"] is True
    assert process_api.request("POST", path, {"muted": False}, credentials.operator)[0] == 200
    state = process_api.request("GET", "/v1/instance/status", token=replacement)[1]
    assert not state["muted"] and state["stopped"] and state["plan_mode"]
    assert state["native_state"] == "unknown"


def test_mute_requires_self_or_operator_with_full_target_room_scope(process_api, credentials, db, register):
    token, binding = register(process_api, credentials, "recipient")
    other, _ = register(process_api, credentials, "other")
    path = f"/v1/sessions/{binding['session_id']}/mute"
    assert process_api.request("POST", path, {"muted": True}, other)[0] == 403
    hidden = uuid4()
    db.execute("INSERT INTO agent_chat.rooms(id, slug, label) VALUES (%s, 'hidden', 'Hidden')", (hidden,))
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (credentials.principal, hidden))
    db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (hidden, binding["session_id"]))
    assert process_api.request("POST", path, {"muted": True}, credentials.operator)[0] == 404
    assert process_api.request("POST", path, {"muted": True}, token)[0] == 200
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"] == 2


def test_browser_mute_and_reply_require_csrf_and_cannot_ack(process_api, credentials, register, send):
    token, binding = register(process_api, credentials, "recipient")
    _, nonce, headers = process_api.request("GET", "/v1/login", include_headers=True)
    jar = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            jar.load(value)
    login_headers = {
        "Origin": "https://chat.test",
        "X-CSRF-Token": nonce["csrf_token"],
        "Cookie": f"{browser.LOGIN_COOKIE}={jar[browser.LOGIN_COOKIE].value}",
    }
    status, session, headers = process_api.request(
        "POST", "/v1/login", {"token": credentials.operator}, headers=login_headers, include_headers=True
    )
    assert status == 200
    for name, value in headers:
        if name.lower() == "set-cookie":
            jar.load(value)
    headers = {
        "Origin": "https://chat.test",
        "Cookie": f"{browser.SESSION_COOKIE}={jar[browser.SESSION_COOKIE].value}",
    }
    mute = f"/v1/sessions/{binding['session_id']}/mute"
    assert process_api.request("POST", mute, {"muted": True}, headers=headers)[0] == 403
    headers["X-CSRF-Token"] = session["csrf_token"]
    assert process_api.request("POST", mute, {"muted": True}, headers=headers)[0] == 200
    message = send(process_api, credentials, "question", token, kind="question")
    headers["Idempotency-Key"] = str(uuid4())
    status, reply = process_api.request(
        "POST", f"/v1/messages/{message['id']}/replies", {"body": "operator"}, headers=headers
    )
    assert status == 200 and reply["recipients"] == [binding["session_id"]]
    assert process_api.request("POST", f"/v1/messages/{reply['id']}/ack", {}, headers=headers)[0] == 401


def test_ack_and_mute_wait_for_the_clock_without_holding_actor_locks(
    process_api, credentials, db, register, send, lock_wait
):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "q", kind="question", recipients=[binding["session_id"]])
    ack = ("POST", f"/v1/messages/{message['id']}/ack", {}, token)
    with ThreadPoolExecutor(max_workers=4) as pool:
        with db.transaction():
            db.execute("SELECT 1 FROM agent_chat.event_clock FOR UPDATE")
            acks = [pool.submit(process_api.request, *ack) for _ in range(2)]
            mute = pool.submit(
                process_api.request, "POST", f"/v1/sessions/{binding['session_id']}/mute", {"muted": True}, token
            )
            lock_wait("agent_chat.event_clock", count=3)
            # A heartbeat takes no clock, so it completes only if every waiter above holds no actor lock yet.
            beat = pool.submit(
                process_api.request,
                "POST",
                "/v1/instance/heartbeat",
                {"native_state": "idle", "stopped": False, "plan_mode": False},
                token,
            )
            assert beat.result(timeout=2)[0] == 200
        first, second = (call.result(timeout=5) for call in acks)
        assert first == second and first[0] == 200
        assert mute.result(timeout=5)[0] == 200
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"] == 1


def test_mute_locks_session_before_waiting_on_instance(process_api, credentials, db, register):
    token, binding = register(process_api, credentials, "recipient")

    def wait_for(query_fragment):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            db.execute("SELECT pg_stat_clear_snapshot()")
            if db.execute(
                """
                SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE %s
            """,
                ("%" + query_fragment + "%",),
            ).fetchone():
                return
            time.sleep(0.01)
        pytest.fail("request did not wait at the required lock boundary: " + query_fragment)

    with ThreadPoolExecutor(max_workers=2) as pool:
        with db.transaction():
            db.execute("SELECT id FROM agent_chat.instances WHERE id = %s FOR UPDATE", (binding["instance_id"],))
            mute = pool.submit(
                process_api.request, "POST", f"/v1/sessions/{binding['session_id']}/mute", {"muted": True}, token
            )
            wait_for("SELECT id FROM agent_chat.instances")
            heartbeat = pool.submit(
                process_api.request,
                "POST",
                "/v1/instance/heartbeat",
                {"native_state": "idle", "stopped": False, "plan_mode": False},
                token,
            )
            wait_for("SELECT id FROM agent_chat.sessions")
        assert mute.result()[0] == heartbeat.result()[0] == 200


def test_ack_checks_message_expiry_after_waiting_for_room_grant(
    process_api, credentials, db, register, send, expiry_margin
):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "q", kind="question", recipients=[binding["session_id"]])
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() + make_interval(secs => %s)",
        (expiry_margin,),
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (credentials.principal,)
            )
            pending = pool.submit(process_api.request, "POST", f"/v1/messages/{message['id']}/ack", {}, token)
            deadline = time.monotonic() + expiry_margin
            while True:
                db.execute("SELECT pg_stat_clear_snapshot()")
                waiting = db.execute("""
                    SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                    AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                    AND query LIKE '%%SELECT 1 FROM agent_chat.principal_rooms%%'
                """).fetchone()
                if waiting:
                    break
                assert time.monotonic() < deadline, "ack did not reach the blocked room grant"
                time.sleep(0.01)
            deadline = time.monotonic() + expiry_margin + 1
            while not db.execute(
                "SELECT expires_at < clock_timestamp() AS expired FROM agent_chat.messages"
            ).fetchone()["expired"]:
                assert time.monotonic() < deadline
                time.sleep(0.01)
        status, error = pending.result()
    assert status == 410 and error["error"]["code"] == "MESSAGE_EXPIRED"
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients").fetchone()["acknowledged_at"] is None


def test_control_snapshot_hides_new_state_after_target_leaves_room(process_api, credentials, db, register, event):
    token, binding = register(process_api, credentials, "recipient")
    path = f"/v1/sessions/{binding['session_id']}/mute"
    assert process_api.request("POST", path, {"muted": True}, token)[0] == 200
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (binding["session_id"],))
    assert process_api.request("POST", path, {"muted": False}, token)[0] == 200
    with process_api.stream(token=credentials.operator) as response:
        frame = event(response)
        assert frame["event"] == "control" and frame["data"]["muted"] is None


def test_reply_and_receipt_rollback_together_on_event_failure(process_api, credentials, db, register, send):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "q", kind="question", recipients=[binding["session_id"]])
    db.execute("ALTER TABLE agent_chat.events ADD CONSTRAINT synthetic_receipt_failure CHECK (kind <> 'receipt')")
    status, result = process_api.request(
        "POST", f"/v1/messages/{message['id']}/replies", {"body": "rollback"}, token, {"Idempotency-Key": str(uuid4())}
    )
    assert status == 503 and result["error"]["code"] == "DATABASE_UNAVAILABLE"
    for table in ("messages", "requests", "events"):
        from psycopg import sql

        assert (
            db.execute(sql.SQL("SELECT count(*) AS n FROM agent_chat.{}").format(sql.Identifier(table))).fetchone()[
                "n"
            ]
            == 1
        )
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"] == 1
    assert (
        db.execute("SELECT replying_message_id FROM agent_chat.recipients").fetchone()["replying_message_id"] is None
    )
    assert db.execute("SELECT agent_replies FROM agent_chat.threads").fetchone()["agent_replies"] == 0


@pytest.mark.parametrize(
    "operation,payload",
    [
        ("ack", {"session_id": str(uuid4())}),
        ("replies", {"body": "bad", "sender": "operator"}),
        ("replies", {"body": "x" * 16385}),
        ("mute", {"muted": "false"}),
    ],
)
def test_strict_receipt_and_control_inputs(process_api, credentials, operation, payload, register, send):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "q", kind="question", recipients=[binding["session_id"]])
    path = (
        f"/v1/sessions/{binding['session_id']}/mute"
        if operation == "mute"
        else f"/v1/messages/{message['id']}/{operation}"
    )
    assert process_api.request("POST", path, payload, token, {"Idempotency-Key": str(uuid4())})[0] == 422


@pytest.mark.parametrize("route", ["publish", "ack"])
def test_lease_is_rechecked_after_waiting_for_room_grant(
    process_api, credentials, db, register, send, lock_wait, expiry_margin, route
):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "q", kind="question", recipients=[binding["session_id"]])
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s)",
        (90 - expiry_margin,),
    )
    if route == "publish":
        call = (
            "POST",
            f"/v1/rooms/{credentials.room}/messages",
            {"kind": "message", "body": "too late"},
            token,
            {"Idempotency-Key": str(uuid4())},
        )
    else:
        call = ("POST", f"/v1/messages/{message['id']}/ack", {}, token)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (credentials.principal,)
            )
            pending = pool.submit(process_api.request, *call)
            lock_wait("SELECT 1 FROM agent_chat.principal_rooms", timeout=expiry_margin)
            deadline = time.monotonic() + expiry_margin + 1
            while not db.execute(
                "SELECT heartbeat_at <= clock_timestamp() - interval '90 seconds' AS expired FROM agent_chat.instances"
            ).fetchone()["expired"]:
                assert time.monotonic() < deadline, "synthetic lease did not expire"
                time.sleep(0.01)
        status, error = pending.result()
    assert status == 409 and error["error"]["code"] == "STALE_INSTANCE"
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 1
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"] == 0


def test_mute_rechecks_lease_after_waiting_for_room_grant(
    process_api, credentials, db, register, lock_wait, expiry_margin
):
    token, binding = register(process_api, credentials, "recipient")
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s)",
        (90 - expiry_margin,),
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (credentials.principal,)
            )
            pending = pool.submit(
                process_api.request, "POST", f"/v1/sessions/{binding['session_id']}/mute", {"muted": True}, token
            )
            lock_wait("FOR SHARE OF pr", timeout=expiry_margin)
            deadline = time.monotonic() + expiry_margin + 1
            while not db.execute(
                "SELECT heartbeat_at <= clock_timestamp() - interval '90 seconds' AS expired FROM agent_chat.instances"
            ).fetchone()["expired"]:
                assert time.monotonic() < deadline, "synthetic lease did not expire"
                time.sleep(0.01)
        status, error = pending.result()
    assert status == 409 and error["error"]["code"] == "STALE_INSTANCE"
    muted = db.execute("SELECT muted FROM agent_chat.sessions WHERE id = %s", (binding["session_id"],)).fetchone()
    assert muted["muted"] is False
    assert db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'control'").fetchone()["n"] == 0


def test_reply_replay_survives_parent_expiry_on_both_routes(process_api, credentials, db, register, send):
    token, binding = register(process_api, credentials, "recipient")
    message = send(process_api, credentials, "question", kind="question", recipients=[binding["session_id"]])
    path = f"/v1/messages/{message['id']}/replies"
    key = {"Idempotency-Key": str(uuid4())}
    status, first = process_api.request("POST", path, {"body": "answer"}, token, key)
    assert status == 200
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second' WHERE id = %s",
        (message["id"],),
    )
    assert process_api.request("POST", path, {"body": "answer"}, token, key) == (200, first)
    room_route = {"kind": "reply", "body": "answer", "reply_to": message["id"]}
    assert process_api.request("POST", f"/v1/rooms/{credentials.room}/messages", room_route, token, key) == (
        200,
        first,
    )
    # A new reply to the expired parent is still refused.
    status, refused = process_api.request("POST", path, {"body": "answer"}, token, {"Idempotency-Key": str(uuid4())})
    assert status == 410 and refused["error"]["code"] == "MESSAGE_EXPIRED"
