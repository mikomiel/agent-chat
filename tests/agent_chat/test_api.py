import json
import logging
import secrets
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from http.client import HTTPConnection
from threading import Thread
from uuid import uuid4

import psycopg
import pytest
import uvicorn

from agent_chat import feed
from agent_chat.api import create_app
from agent_chat.instance_file import prepare_instance
from agent_chat.models import ChatError
from agent_chat.protocol import validate_origin
from agent_chat.storage import connect


def registration(*, native="synthetic-session", token=None, boot=None):
    token = token or secrets.token_hex(32)
    return {
        "native_session_id": native,
        "boot_id": str(boot or uuid4()),
        "instance_token_hash": sha256(token.encode()).hexdigest(),
    }, token


def join(http_api, credentials, *, native="synthetic-session"):
    request, token = registration(native=native)
    status, binding = http_api("POST", "/v1/sessions", request, credentials.agent)
    assert status == 200
    return binding, token, request


def test_api_requires_explicit_opt_in_and_does_not_migrate(database):
    with pytest.raises(ChatError, match="^INTEGRATION_DISABLED$"):
        create_app(database)
    create_app(database, enabled=True)
    with connect(database) as uninitialized:
        row = uninitialized.execute("SELECT to_regnamespace('agent_chat') AS schema").fetchone()
        assert row is not None and row["schema"] is None


def test_registration_retry_is_same_binding_without_credential_echo(http_api, credentials, db):
    binding, token, request = join(http_api, credentials)
    assert set(binding) == {"session_id", "instance_id", "room_id", "host", "harness"}
    assert binding["room_id"] == credentials.room
    assert binding["host"] == "synthetic-host"
    assert binding["harness"] == "pi"
    assert http_api("POST", "/v1/sessions", request, credentials.agent) == (200, binding)
    row = db.execute("SELECT * FROM agent_chat.instances").fetchone()
    assert row["token_hash"] == sha256(token.encode()).hexdigest()
    assert row["native_state"] == "unknown"
    assert row["stopped"] and row["plan_mode"]
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 1
    assert token not in json.dumps(binding)
    assert request["instance_token_hash"] not in json.dumps(binding)
    assert http_api("GET", "/v1/rooms", token=token) == (
        200,
        {"rooms": [{"id": credentials.room, "slug": "homelab", "label": "Homelab"}]},
    )


def test_persisted_token_survives_lost_registration_response(http_api, credentials, tmp_path):
    boot = uuid4()
    secret = prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    payload, _ = registration(native="native", token=secret.token, boot=boot)
    first = http_api("POST", "/v1/sessions", payload, credentials.agent)
    assert first[0] == 200
    recovered = prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    repeated, _ = registration(native="native", token=recovered.token, boot=recovered.boot_id)
    assert http_api("POST", "/v1/sessions", repeated, credentials.agent) == first
    assert http_api("GET", "/v1/rooms", token=recovered.token)[0] == 200


def test_registration_cannot_take_live_session_or_change_boot_secret(http_api, credentials, db):
    binding, _, original = join(http_api, credentials)
    for request in (registration()[0], {**original, "instance_token_hash": sha256(b"synthetic-other").hexdigest()}):
        assert http_api("POST", "/v1/sessions", request, credentials.agent) == (
            409,
            {"error": {"code": "BINDING_CONFLICT", "message": "BINDING_CONFLICT"}},
        )
    assert db.execute("SELECT id FROM agent_chat.instances").fetchone()["id"].hex == binding["instance_id"].replace(
        "-", ""
    )
    assert db.execute("SELECT count(*) AS n FROM agent_chat.sessions").fetchone()["n"] == 1


def test_concurrent_registration_returns_one_binding(http_api, credentials, db):
    payload, _ = registration()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: http_api("POST", "/v1/sessions", payload, credentials.agent), range(2)))
    assert results[0][0] == 200
    assert results[0] == results[1]
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 1


@pytest.mark.parametrize("ended", [False, True])
def test_resume_fences_old_instance_and_preserves_logical_state(http_api, credentials, db, ended):
    first, old_token, old_request = join(http_api, credentials)
    db.execute("UPDATE agent_chat.sessions SET muted = true WHERE id = %s", (first["session_id"],))
    if ended:
        status, closed = http_api("POST", "/v1/instance/end", {}, old_token)
        assert status == 200
        assert http_api("POST", "/v1/instance/end", {}, old_token) == (200, closed)
    else:
        db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
    new_request, new_token = registration()
    status, second = http_api("POST", "/v1/sessions", new_request, credentials.agent)
    assert status == 200
    assert first["session_id"] == second["session_id"]
    assert first["instance_id"] != second["instance_id"]
    heartbeat = {"native_state": "idle", "stopped": False, "plan_mode": False}
    assert http_api("POST", "/v1/instance/heartbeat", heartbeat, old_token)[0] == 409
    assert http_api("POST", "/v1/sessions", old_request, credentials.agent)[0] == 409
    assert http_api("POST", "/v1/instance/end", {}, old_token)[0] == 200
    assert http_api("POST", "/v1/instance/heartbeat", heartbeat, new_token)[0] == 200
    assert db.execute("SELECT muted FROM agent_chat.sessions").fetchone()["muted"] is True
    assert db.execute("SELECT id FROM agent_chat.instances WHERE ended_at IS NULL").fetchone()["id"].hex == second[
        "instance_id"
    ].replace("-", "")


def test_two_native_sessions_and_principal_revocation_are_isolated(http_api, credentials, db):
    first, first_token, _ = join(http_api, credentials, native="first")
    second, second_token, _ = join(http_api, credentials, native="second")
    assert first["session_id"] != second["session_id"]
    assert http_api("POST", "/v1/instance/end", {}, first_token)[0] == 200
    assert http_api("GET", "/v1/rooms", token=first_token)[0] == 409
    assert http_api("GET", "/v1/rooms", token=second_token)[0] == 200
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (credentials.principal,))
    assert http_api("GET", "/v1/rooms", token=second_token)[0] == 401
    assert http_api("POST", "/v1/sessions", registration()[0], credentials.agent)[0] == 401
    assert http_api("GET", "/v1/rooms", token=credentials.operator)[0] == 200


def test_revoking_one_host_harness_keeps_another_independent(http_api, credentials, db):
    _, first_token, _ = join(http_api, credentials)
    other_host_token = secrets.token_hex(32)
    principal = uuid4()
    db.execute(
        """
        INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness)
        VALUES (%s, 'agent', %s, 'synthetic-other', 'codex')
    """,
        (principal, sha256(other_host_token.encode()).hexdigest()),
    )
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, credentials.room))
    payload, other_token = registration()
    status, other = http_api("POST", "/v1/sessions", payload, other_host_token)
    assert status == 200
    assert other["host"] == "synthetic-other" and other["harness"] == "codex"
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (credentials.principal,))
    assert http_api("GET", "/v1/rooms", token=first_token)[0] == 401
    assert http_api("GET", "/v1/rooms", token=other_token)[0] == 200


def test_instance_endpoints_reject_foreign_targets_and_operator_tokens(http_api, credentials, db):
    first, token, request = join(http_api, credentials)
    other, _, _ = join(http_api, credentials, native="other")
    body = {"native_state": "idle", "stopped": False, "plan_mode": False}
    assert http_api("POST", "/v1/instance/heartbeat", {**body, "instance_id": other["instance_id"]}, token)[0] == 422
    assert http_api("POST", "/v1/instance/end", {"session_id": other["session_id"]}, token)[0] == 422
    assert http_api("POST", "/v1/instance/heartbeat", body, credentials.operator)[0] == 403
    assert http_api("POST", "/v1/instance/heartbeat", {**body, "stopped": "false"}, token)[0] == 422
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances WHERE ended_at IS NULL").fetchone()["n"] == 2


def test_registration_heartbeat_and_publication_queue_in_lock_order(http_api, credentials, db, lock_wait):
    _, token, registration_request = join(http_api, credentials)
    with ThreadPoolExecutor(max_workers=3) as pool:
        with db.transaction():
            db.execute("SELECT id FROM agent_chat.instances FOR UPDATE")
            # The heartbeat holds the session share lock while it waits for the instance.
            heartbeat = pool.submit(
                http_api,
                "POST",
                "/v1/instance/heartbeat",
                {"native_state": "busy", "stopped": False, "plan_mode": False},
                token,
            )
            lock_wait("SELECT id FROM agent_chat.instances")
            # Registration needs that session exclusively, so it waits there, before reaching the instance.
            registration = pool.submit(http_api, "POST", "/v1/sessions", registration_request, credentials.agent)
            lock_wait("AND native_session_id")
            # Publication takes the clock first, which registration holds, before
            # it could reach the session or the instance.
            publication = pool.submit(
                http_api,
                "POST",
                f"/v1/rooms/{credentials.room}/messages",
                {"kind": "message", "body": "concurrent"},
                token,
                {"Idempotency-Key": str(uuid4())},
            )
            # Registration holds the clock while it waits for the session, so
            # publication queues behind it there: every writer takes the clock
            # first, before the session and the instance.
            lock_wait("SELECT position, retained_floor FROM agent_chat.event_clock")
        assert [call.result(timeout=8)[0] for call in (heartbeat, registration, publication)] == [200, 200, 200]


def test_heartbeat_changes_presence_only_and_cannot_revive_expired_instance(http_api, credentials, db):
    _, token, _ = join(http_api, credentials)
    payload = {"native_state": "busy", "stopped": True, "plan_mode": True}
    status, observed = http_api("POST", "/v1/instance/heartbeat", payload, token)
    assert status == 200
    assert {key: observed[key] for key in payload} == payload
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"] == 0
    db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
    assert http_api("POST", "/v1/instance/heartbeat", payload, token)[0] == 409
    assert db.execute(
        "SELECT heartbeat_at < clock_timestamp() - interval '90 seconds' AS old FROM agent_chat.instances"
    ).fetchone()["old"]


def test_http_publication_sender_scope_and_lost_response_retry(http_api, credentials, db):
    binding, token, _ = join(http_api, credentials)
    path = f"/v1/rooms/{credentials.room}/messages"
    payload = {"kind": "message", "body": "synthetic private content"}
    headers = {"Idempotency-Key": str(uuid4())}
    code, stored = http_api("POST", path, payload, token, headers)
    assert code == 200
    assert stored["sender"] == {"principal_id": credentials.principal, "session_id": binding["session_id"]}
    assert http_api("POST", path, payload, token, headers) == (200, stored)
    assert http_api("POST", path, {**payload, "body": "changed"}, token, headers)[0] == 409
    assert http_api("POST", path, {**payload, "sender": "operator"}, token, headers) == (
        422,
        {"error": {"code": "INVALID_REQUEST", "message": "INVALID_REQUEST"}},
    )
    foreign = uuid4()
    db.execute("INSERT INTO agent_chat.rooms VALUES (%s, 'foreign', 'Foreign')", (foreign,))
    assert http_api("POST", f"/v1/rooms/{foreign}/messages", payload, token, headers)[0] == 403
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 1


@pytest.mark.parametrize("kind", ["missing", "malformed", "unknown", "host", "operator-register", "instance-register"])
def test_credential_purposes_cannot_be_interchanged(http_api, credentials, kind):
    _, instance_token, payload = join(http_api, credentials)
    path, method, body = "/v1/rooms", "GET", None
    token = {
        "missing": None,
        "malformed": "not-a-token",
        "unknown": secrets.token_hex(32),
        "host": credentials.agent,
        "operator-register": credentials.operator,
        "instance-register": instance_token,
    }[kind]
    if kind.endswith("-register"):
        path, method, body = "/v1/sessions", "POST", payload
    assert http_api(method, path, body, token) == (
        401,
        {"error": {"code": "UNAUTHENTICATED", "message": "UNAUTHENTICATED"}},
    )


@pytest.mark.parametrize("extra", [{"host": "forged"}, {"harness": "claude"}, {"principal_id": str(uuid4())}])
def test_registration_rejects_identity_overrides(http_api, credentials, extra):
    payload, _ = registration()
    assert http_api("POST", "/v1/sessions", {**payload, **extra}, credentials.agent)[0] == 422


BIDI_POINTS = (0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069)


@pytest.mark.parametrize("control", [chr(point) for point in BIDI_POINTS])
def test_registration_rejects_bidirectional_controls_in_the_native_identity(http_api, credentials, db, control):
    payload, _ = registration(native=f"plain{control}spoof")
    assert http_api("POST", "/v1/sessions", payload, credentials.agent)[0] == 422
    assert db.execute("SELECT count(*) AS n FROM agent_chat.sessions").fetchone()["n"] == 0
    payload, _ = registration(native="plain-ünïcode-שלום")  # Ordinary right-to-left text stays valid.
    assert http_api("POST", "/v1/sessions", payload, credentials.agent)[0] == 200


@pytest.mark.parametrize("option", ["stream_lifetime", "stream_poll"])
@pytest.mark.parametrize("value", [0, -1])
def test_event_stream_timing_must_be_positive(database, option, value):
    with pytest.raises(ValueError, match="positive"):
        create_app(database, enabled=True, **{option: value})


def test_room_grants_do_not_automatically_expand_membership(http_api, credentials, db):
    foreign = uuid4()
    db.execute("INSERT INTO agent_chat.rooms VALUES (%s, 'allowed-extra', 'Allowed extra')", (foreign,))
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (credentials.principal, foreign))
    binding, token, _ = join(http_api, credentials)
    assert len(http_api("GET", "/v1/rooms", token=token)[1]["rooms"]) == 1
    db.execute(
        "DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s",
        (credentials.principal, credentials.room),
    )
    assert http_api("GET", "/v1/rooms", token=token) == (200, {"rooms": []})
    assert http_api("POST", "/v1/sessions", registration(native="another")[0], credentials.agent)[0] == 403
    assert db.execute("SELECT count(*) AS n FROM agent_chat.sessions").fetchone()["n"] == 1


def test_token_reuse_conflict_rolls_back_replacement(http_api, credentials, db):
    first, token, _ = join(http_api, credentials)
    payload, _ = registration(native="different", token=token)
    assert http_api("POST", "/v1/sessions", payload, credentials.agent)[0] == 409
    assert db.execute("SELECT count(*) AS n FROM agent_chat.sessions").fetchone()["n"] == 1
    payload, _ = registration(native="host-token", token=credentials.agent)
    assert http_api("POST", "/v1/sessions", payload, credentials.agent)[0] == 409
    assert http_api("GET", "/v1/rooms", token=token)[0] == 200


def test_http_boundary_redacts_errors_and_rejects_unadmitted_browser_access(http_api, credentials):
    assert http_api("POST", "/v1/sessions", token=credentials.agent, raw=b'{"private-marker": invalid')[1] == {
        "error": {"code": "INVALID_REQUEST", "message": "INVALID_REQUEST"}
    }
    assert http_api("POST", "/v1/sessions", token=credentials.agent, raw=b"x" * 131073)[0] == 413
    for header in ({"Origin": "https://synthetic.invalid"}, {"Cookie": "session=synthetic"}):
        assert http_api("GET", "/v1/rooms", token=credentials.operator, headers=header)[0] == 403
    assert http_api("GET", "/v1/rooms?token=synthetic", token=credentials.operator)[0] == 422
    assert (
        http_api(
            "GET", "/v1/rooms", token=credentials.operator, headers={"authorization": "Bearer " + credentials.agent}
        )[0]
        == 401
    )
    assert http_api("GET", "/healthz") == (200, {"status": "ok"})
    assert http_api("GET", "/readyz") == (200, {"status": "ready"})


def test_lease_expiring_while_waiting_for_lock_cannot_be_renewed(
    process_api, credentials, db, lock_wait, expiry_margin
):
    _, token, _ = join(process_api.request, credentials)
    # The lease crosses `expiry_margin` seconds after this update, inside the
    # child's 6 s lock budget, so the request is still waiting when the row lock
    # is released and sees the expired lease rather than a lock timeout.
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s)",
        (90 - expiry_margin,),
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute("SELECT id FROM agent_chat.instances FOR UPDATE")
            future = pool.submit(
                process_api.request,
                "POST",
                "/v1/instance/heartbeat",
                {"native_state": "idle", "stopped": False, "plan_mode": False},
                token,
            )
            lock_wait("agent_chat.instances", timeout=expiry_margin)
            deadline = time.monotonic() + expiry_margin + 1
            while not db.execute("""
                SELECT heartbeat_at <= clock_timestamp() - interval '90 seconds' AS expired
                FROM agent_chat.instances
            """).fetchone()["expired"]:
                if time.monotonic() >= deadline:
                    pytest.fail("synthetic lease did not expire")
                time.sleep(0.01)
        assert future.result(timeout=8)[0] == 409


def test_database_schema_failure_is_sanitized_and_health_stays_live(http_api, db):
    db.execute("ALTER TABLE agent_chat.event_clock RENAME TO unavailable_clock")
    assert http_api("GET", "/readyz") == (
        503,
        {"error": {"code": "DATABASE_UNAVAILABLE", "message": "DATABASE_UNAVAILABLE"}},
    )
    assert http_api("GET", "/healthz") == (200, {"status": "ok"})


def secured(headers):
    named = {name.lower(): value for name, value in headers}
    assert named["cache-control"] == "no-store"
    assert "default-src 'none'" in named["content-security-policy"]
    return named


def test_unrouted_requests_use_the_error_envelope(http_api):
    status, body, headers = http_api("GET", "/v1/nowhere", include_headers=True)
    assert (status, body) == (404, {"error": {"code": "NOT_FOUND", "message": "NOT_FOUND"}})
    secured(headers)
    status, body, headers = http_api("DELETE", "/healthz", include_headers=True)
    assert (status, body) == (405, {"error": {"code": "METHOD_NOT_ALLOWED", "message": "METHOD_NOT_ALLOWED"}})
    assert secured(headers)["allow"] == "GET"


def test_unhandled_failure_returns_a_sanitized_envelope_with_security_headers(http_api, credentials, monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("synthetic-private-marker")

    monkeypatch.setattr(feed, "history", fail)
    status, body, headers = http_api(
        "GET",
        f"/v1/rooms/{credentials.room}/history",
        headers={"Authorization": "Bearer " + credentials.operator},
        include_headers=True,
    )
    assert (status, body) == (500, {"error": {"code": "INTERNAL_ERROR", "message": "INTERNAL_ERROR"}})
    secured(headers)


@pytest.mark.parametrize("origin", ["https://chat.test:443", "http://127.0.0.1:80", "http://[::1]:80"])
def test_explicit_default_ports_are_not_canonical_origins(origin):
    # Browsers omit a default port from Origin, so every cookie mutation would otherwise fail the exact match.
    with pytest.raises(ChatError, match="^INVALID_ORIGIN$"):
        validate_origin(origin)


@pytest.mark.parametrize("origin", ["https://chat.test", "https://chat.test:8443", "http://127.0.0.1:8080"])
def test_canonical_origins_remain_accepted(origin):
    validate_origin(origin)


SENTINEL = "sentinel-private-7f3a91"


@pytest.mark.parametrize("case", ["refusal", "validation_body", "validation_path", "database"])
def test_each_handled_error_logs_one_fixed_line_and_no_request_data(http_api, credentials, caplog, monkeypatch, case):
    caplog.set_level(logging.INFO, logger="agent_chat.api")
    room = str(uuid4())
    template = "/v1/rooms/{room}/history"
    if case == "refusal":
        request = ("GET", f"/v1/rooms/{room}/history?after={SENTINEL}", None, SENTINEL)
        expected = (401, "UNAUTHENTICATED", logging.WARNING, "ChatError")
    elif case == "validation_body":
        payload = {"body": SENTINEL, "sender": SENTINEL}
        request = ("POST", f"/v1/rooms/{room}/messages", payload, credentials.operator)
        template = "/v1/rooms/{room}/messages"
        expected = (422, "INVALID_REQUEST", logging.WARNING, "RequestValidationError")
    elif case == "validation_path":
        room = SENTINEL
        request = ("GET", f"/v1/rooms/{room}/history?limit=0&after={SENTINEL}", None, credentials.operator)
        expected = (422, "INVALID_REQUEST", logging.WARNING, "RequestValidationError")
    else:

        def fail(*_args, **_kwargs):
            raise psycopg.OperationalError(SENTINEL)

        monkeypatch.setattr(feed, "history", fail)
        request = ("GET", f"/v1/rooms/{room}/history", None, credentials.operator)
        expected = (503, "DATABASE_UNAVAILABLE", logging.ERROR, "OperationalError")
    method, path, payload, token = request
    status, body = http_api(method, path, payload, token)
    assert (status, body["error"]["code"]) == expected[:2]
    records = [record for record in caplog.records if record.name == "agent_chat.api"]
    assert len(records) == 1
    (record,) = records
    assert record.levelno == expected[2]
    assert record.getMessage() == f"code={expected[1]} route={template} status={expected[0]} exc={expected[3]}"
    assert record.exc_info is None
    # Nothing the client sent, and no exception text, reaches any captured output.
    for private in (SENTINEL, room, credentials.operator):
        assert private not in caplog.text


@pytest.mark.parametrize(
    ("method", "path", "kwargs", "status", "code", "exc", "route"),
    [
        ("GET", f"/v1/rooms?token={SENTINEL}", {}, 422, "INVALID_REQUEST", "none", "unmatched"),
        (
            "GET",
            "/v1/rooms",
            {"headers": {"Origin": f"https://{SENTINEL}.invalid"}},
            403,
            "SESSION_FORBIDDEN",
            "none",
            "unmatched",
        ),
        (
            "POST",
            "/v1/sessions",
            {"raw": SENTINEL.encode() + b"x" * 131073},
            413,
            "REQUEST_TOO_LARGE",
            "none",
            "unmatched",
        ),
        ("GET", f"/v1/{SENTINEL}", {}, 404, "NOT_FOUND", "HTTPException", "unmatched"),
        (
            "DELETE",
            "/healthz",
            {"headers": {"X-Marker": SENTINEL}},
            405,
            "METHOD_NOT_ALLOWED",
            "HTTPException",
            "/healthz",
        ),
    ],
    ids=["query_key", "origin", "oversized", "unknown_route", "unsupported_method"],
)
def test_refused_before_routing_logs_one_fixed_line_and_no_request_data(
    http_api, credentials, caplog, method, path, kwargs, status, code, exc, route
):
    caplog.set_level(logging.INFO, logger="agent_chat.api")
    assert http_api(method, path, token=credentials.operator, **kwargs)[0] == status
    records = [record for record in caplog.records if record.name == "agent_chat.api"]
    assert len(records) == 1
    (record,) = records
    assert record.levelno == logging.WARNING
    assert record.getMessage() == f"code={code} route={route} status={status} exc={exc}"
    assert record.exc_info is None
    for private in (SENTINEL, credentials.operator):
        assert private not in caplog.text


@pytest.mark.parametrize(
    ("failure", "code", "level", "exc"),
    [
        (lambda: psycopg.OperationalError(SENTINEL), "DATABASE_UNAVAILABLE", logging.ERROR, "OperationalError"),
        (lambda: ChatError("ROOM_SCOPE_CHANGED"), "ROOM_SCOPE_CHANGED", logging.WARNING, "ChatError"),
    ],
    ids=["database", "chat_error"],
)
def test_failure_after_the_stream_started_logs_one_fixed_line(
    database, credentials, caplog, monkeypatch, failure, code, level, exc
):
    caplog.set_level(logging.INFO, logger="agent_chat.api")
    real = feed.events
    calls = []

    def second_read_fails(*args, **kwargs):
        calls.append(args[2])
        if len(calls) == 1:
            return real(*args, **kwargs)
        raise failure()

    monkeypatch.setattr(feed, "events", second_read_fails)
    app = create_app(database, enabled=True, stream_poll=0.05)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        server = uvicorn.Server(
            uvicorn.Config(app, log_config=None, access_log=False, lifespan="off", ws="none", proxy_headers=False)
        )
        thread = Thread(target=server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline, "isolated HTTP server failed to start"
                time.sleep(0.01)
            connection = HTTPConnection("127.0.0.1", listener.getsockname()[1], timeout=8)
            bearer = {"Authorization": "Bearer " + credentials.operator}
            connection.request("GET", "/v1/events?after=0", headers=bearer)
            response = connection.getresponse()
            body = response.read().decode()
            connection.close()
        finally:
            server.should_exit = True
            thread.join(timeout=8)
    assert len(calls) == 2
    # The stream began with 200 and ends with one coded control event; the log line says so, once.
    assert response.status == 200
    assert body.endswith("event: control\ndata: " + json.dumps({"error": {"code": code}}) + "\n\n")
    records = [record for record in caplog.records if record.name == "agent_chat.api"]
    assert len(records) == 1
    (record,) = records
    assert record.levelno == level
    assert record.getMessage() == f"code={code} route=/v1/events status=200 exc={exc} phase=stream"
    assert record.exc_info is None
    for private in (SENTINEL, credentials.operator):
        assert private not in caplog.text
