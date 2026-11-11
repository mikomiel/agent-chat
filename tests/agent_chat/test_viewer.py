"""Viewer authority at real HTTP and PostgreSQL boundaries, including already-resolved actors."""

from __future__ import annotations

import secrets
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from http.cookies import SimpleCookie
from typing import Any
from uuid import UUID, uuid4

import pytest
from psycopg import Connection, sql

from agent_chat import auth, browser, deliveries, events, feed, receipts, rooms, sessions, state, threads
from agent_chat.models import (
    Actor,
    ChatError,
    DeliveryClaim,
    DeliveryResult,
    Heartbeat,
    LaneDeclaration,
    ProducerActor,
    Publication,
    Registration,
    RoomCreation,
    StateEntry,
    StateUpsert,
)
from agent_chat.publication import publish
from agent_chat.storage import connect

ORIGIN = "https://chat.test"
TABLES = (
    "principals",
    "principal_rooms",
    "rooms",
    "sessions",
    "instances",
    "memberships",
    "threads",
    "messages",
    "recipients",
    "requests",
    "events",
    "event_clock",
    "delivery_batches",
    "delivery_attempts",
    "room_state",
    "sender_receipts",
)


@pytest.fixture
def public_origin() -> str:
    return ORIGIN


@pytest.fixture
def delivery_enabled() -> bool:
    return True


def login(http_api: Any, token: str) -> tuple[dict[str, str], dict[str, Any]]:
    status, challenge, headers = http_api("GET", "/v1/login", include_headers=True)
    assert status == 200
    cookies = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            cookies.load(value)
    status, session, headers = http_api(
        "POST",
        "/v1/login",
        {"token": token},
        headers={
            "Origin": ORIGIN,
            "Cookie": f"{browser.LOGIN_COOKIE}={cookies[browser.LOGIN_COOKIE].value}",
            "X-CSRF-Token": challenge["csrf_token"],
        },
        include_headers=True,
    )
    assert status == 200
    for name, value in headers:
        if name.lower() == "set-cookie":
            cookies.load(value)
    cookie = cookies[browser.SESSION_COOKIE]
    assert cookie["secure"] and cookie["httponly"] and cookie["samesite"] == "strict"
    assert cookie["path"] == "/" and cookie["domain"] == ""
    assert cookie["max-age"] == str(session["expires_in"])
    return {
        "Origin": ORIGIN,
        "Cookie": f"{browser.SESSION_COOKIE}={cookie.value}",
        "X-CSRF-Token": session["csrf_token"],
    }, session


def snapshot(db: Connection[dict[str, Any]]) -> dict[str, Any]:
    return {
        table: db.execute(
            sql.SQL("SELECT to_jsonb(t) AS row FROM agent_chat.{} t ORDER BY to_jsonb(t)::text").format(
                sql.Identifier(table)
            )
        ).fetchall()
        for table in TABLES
    }


def resolved_actor(db: Connection[dict[str, Any]], headers: dict[str, str]) -> Actor:
    return browser.authenticate_cookie(db, headers["Cookie"].split("=", 1)[1])


def test_granted_reads_use_shared_views_without_presence_or_receipt_effects(
    http_api: Any,
    db: Connection[dict[str, Any]],
    credentials: Any,
    actors: Any,
    make_viewer: Any,
    make_producer: Any,
) -> None:
    room, first, second, operator = actors
    hidden = rooms.create(db, operator, RoomCreation(slug="private", label="Private"))["id"]
    message = publish(
        db,
        first,
        room,
        uuid4(),
        Publication(
            kind="question",
            body="granted content",
            recipients=(second.session_id,),
        ),
    )
    publish(db, operator, hidden, uuid4(), Publication(kind="message", body="private sentinel"))
    producer = make_producer()
    state.upsert(
        db,
        ProducerActor(UUID(producer.principal), producer.host, producer.producer),
        room,
        StateUpsert(
            entries=(StateEntry(state_key="validation-lease:node-a:leaf", value={"synthetic": True}, ttl_seconds=60),),
        ),
    )
    viewer, empty = make_viewer(room), make_viewer()
    headers, session = login(http_api, viewer.token)
    assert session["access"] == "viewer" and session["expires_in"] == 600
    before = snapshot(db)
    status, bootstrap = http_api("GET", "/v1/browser/session", headers=headers)
    assert status == 200
    assert bootstrap == {
        "principal_id": str(viewer.principal),
        "access": "viewer",
        "csrf_token": session["csrf_token"],
    }
    assert http_api("GET", "/v1/rooms", headers=headers) == (
        200,
        {"rooms": [{"id": str(room), "slug": "homelab", "label": "Homelab"}]},
    )
    participants = http_api("GET", f"/v1/rooms/{room}/participants", headers=headers)
    assert participants[0] == 200
    assert {row["session_id"] for row in participants[1]["participants"]} == {
        str(first.session_id),
        str(second.session_id),
    }
    status, history = http_api("GET", f"/v1/rooms/{room}/history", headers=headers)
    assert status == 200 and [row["id"] for row in history["messages"]] == [str(message["id"])]
    assert history["messages"][0]["receipts"][0]["session_id"] == str(second.session_id)
    status, coordination = http_api("GET", f"/v1/rooms/{room}/state", headers=headers)
    assert status == 200 and coordination["entries"][0]["value"] == {"synthetic": True}
    actor = resolved_actor(db, headers)
    batch = feed.events(db, actor, 0)
    assert {frame["data"]["room_id"] for frame in batch["events"]} == {room}
    assert batch["rooms"] == (room,)
    for denied in (hidden, uuid4()):
        for route in ("participants", "history", "state"):
            assert http_api("GET", f"/v1/rooms/{denied}/{route}", headers=headers) == (
                403,
                {"error": {"code": "ROOM_FORBIDDEN", "message": "ROOM_FORBIDDEN"}},
            )
    empty_headers, _ = login(http_api, empty.token)
    assert http_api("GET", "/v1/rooms", headers=empty_headers) == (200, {"rooms": []})
    assert feed.events(db, resolved_actor(db, empty_headers), 0)["events"] == []
    assert snapshot(db) == before


def test_full_http_mutation_and_native_deny_matrix_has_no_chat_effects(
    http_api: Any,
    db: Connection[dict[str, Any]],
    credentials: Any,
    actors: Any,
    make_viewer: Any,
) -> None:
    room, first, _second, operator = actors
    sessions.heartbeat(db, first, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    message = publish(
        db,
        operator,
        room,
        uuid4(),
        Publication(
            kind="question",
            body="retained target",
            recipients=(first.session_id,),
        ),
    )
    attempt = deliveries.claim(db, first, uuid4(), DeliveryClaim(messages=(message["id"],)))["attempt"]["id"]
    viewer = make_viewer(room)
    headers, _ = login(http_api, viewer.token)
    headers["Idempotency-Key"] = str(uuid4())
    matrix = [
        ("POST", f"/v1/rooms/{room}/messages", {"kind": "message", "body": "must not publish"}, 403),
        (
            "POST",
            f"/v1/rooms/{room}/messages",
            {
                "kind": "reply",
                "body": "must not reply",
                "reply_to": str(message["id"]),
            },
            403,
        ),
        ("POST", f"/v1/messages/{message['id']}/replies", {"body": "must not reply"}, 403),
        ("POST", f"/v1/messages/{message['id']}/ack", {}, 401),
        ("POST", f"/v1/sessions/{first.session_id}/mute", {"muted": True}, 403),
        ("POST", f"/v1/threads/{message['thread_id']}/resolution", {"resolved": True}, 403),
        ("POST", "/v1/rooms", {"slug": "forbidden", "label": "Forbidden"}, 403),
        ("POST", f"/v1/rooms/{room}/memberships", {"session_id": str(first.session_id)}, 403),
        (
            "POST",
            "/v1/sessions",
            {
                "native_session_id": "viewer-must-not-register",
                "boot_id": str(uuid4()),
                "instance_token_hash": sha256(secrets.token_bytes(32)).hexdigest(),
            },
            401,
        ),
        (
            "POST",
            "/v1/instance/heartbeat",
            {
                "native_state": "idle",
                "stopped": False,
                "plan_mode": False,
                "title": "must not rename",
            },
            401,
        ),
        ("POST", "/v1/instance/lane", {"lane": "task::viewer"}, 401),
        ("POST", "/v1/instance/end", {}, 401),
        ("GET", "/v1/instance/status", None, 401),
        ("GET", "/v1/instance/deliveries/pending", None, 401),
        ("POST", "/v1/instance/deliveries/claim", {"messages": [str(message["id"])]}, 401),
        ("POST", f"/v1/instance/deliveries/{attempt}/result", {"outcome": "handed"}, 401),
        ("GET", "/v1/instance/receipts", None, 401),
        ("POST", "/v1/instance/receipts/delivered", {"receipts": [str(uuid4())]}, 401),
        (
            "POST",
            f"/v1/rooms/{room}/state",
            {
                "entries": [
                    {
                        "state_key": "validation-lease:node-a:leaf",
                        "value": {"synthetic": True},
                        "ttl_seconds": 60,
                    }
                ]
            },
            401,
        ),
    ]
    before = snapshot(db)
    for method, path, payload, status in matrix:
        code = "SESSION_FORBIDDEN" if status == 403 else "UNAUTHENTICATED"
        assert http_api(method, path, payload, headers=headers) == (
            status,
            {"error": {"code": code, "message": code}},
        ), path
        # A viewer's credential is accepted by login only, never as an operator, host, instance or producer bearer.
        assert http_api(
            method,
            path,
            payload,
            token=viewer.token,
            headers={
                "Idempotency-Key": str(uuid4()),
            },
        ) == (401, {"error": {"code": "UNAUTHENTICATED", "message": "UNAUTHENTICATED"}}), path
        assert snapshot(db) == before, path
    # Client-provided authority is not an authentication result (the closed request models refuse it).
    assert (
        http_api(
            "POST",
            f"/v1/rooms/{room}/messages",
            {
                "kind": "message",
                "body": "forged",
                "access": "operator",
            },
            headers=headers,
        )[0]
        == 422
    )
    assert snapshot(db) == before


@pytest.mark.parametrize(
    "operation",
    [
        "lock",
        "authorize",
        "visible",
        "publish",
        "reply",
        "ack",
        "mute",
        "resolution",
        "create",
        "join",
        "register",
        "heartbeat",
        "lane",
        "end",
        "status",
        "pending",
        "claim",
        "result",
        "producer",
    ],
)
def test_direct_domain_operations_refuse_viewer_before_effects(
    db: Connection[dict[str, Any]],
    actors: Any,
    make_viewer: Any,
    operation: str,
) -> None:
    room, first, _second, operator = actors
    message = publish(
        db,
        operator,
        room,
        uuid4(),
        Publication(
            kind="question",
            body="domain target",
            recipients=(first.session_id,),
        ),
    )
    viewer = make_viewer(room)
    session = browser.login(db, viewer.token)
    actor = browser.authenticate_cookie(db, session.token)
    operations = {
        "lock": lambda: auth.lock_actor(db, actor),
        "authorize": lambda: auth.authorize_room(db, actor, room),
        "visible": lambda: rooms.visible(db, actor),
        "publish": lambda: publish(db, actor, room, uuid4(), Publication(kind="message", body="forbidden")),
        "reply": lambda: publish(
            db,
            actor,
            room,
            uuid4(),
            Publication(
                kind="reply",
                body="forbidden",
                reply_to=message["id"],
            ),
        ),
        "ack": lambda: receipts.acknowledge(db, actor, message["id"]),
        "mute": lambda: sessions.mute(db, actor, first.session_id, True),
        "resolution": lambda: threads.resolve(db, actor, message["thread_id"], True),
        "create": lambda: rooms.create(db, actor, RoomCreation(slug="forbidden", label="Forbidden")),
        "join": lambda: rooms.join(db, actor, room, first.session_id),
        "register": lambda: sessions.register(
            db,
            actor,
            Registration(
                native_session_id="forbidden",
                boot_id=uuid4(),
                instance_token_hash=secrets.token_hex(32),
            ),
        ),
        "heartbeat": lambda: sessions.heartbeat(
            db,
            actor,
            Heartbeat(
                native_state="idle",
                stopped=False,
                plan_mode=False,
                title="forbidden",
            ),
        ),
        "lane": lambda: sessions.declare_lane(db, actor, LaneDeclaration(lane="task::viewer")),
        "end": lambda: sessions.end(db, actor),
        "status": lambda: sessions.status(db, actor, delivery_enabled=True),
        "pending": lambda: deliveries.pending(db, actor),
        "claim": lambda: deliveries.claim(db, actor, uuid4(), DeliveryClaim(messages=(message["id"],))),
        "result": lambda: deliveries.result(db, actor, uuid4(), DeliveryResult(outcome="handed")),
        "producer": lambda: state.upsert(
            db,
            ProducerActor(viewer.principal, "node-a", "validation-lease"),
            room,
            StateUpsert(
                entries=(
                    StateEntry(
                        state_key="validation-lease:node-a:leaf",
                        value={"synthetic": True},
                        ttl_seconds=60,
                    ),
                )
            ),
        ),
    }
    before = snapshot(db)
    with pytest.raises(ChatError) as refused, db.transaction():
        operations[operation]()
    expected = "UNAUTHENTICATED" if operation in ("register", "producer") else "SESSION_FORBIDDEN"
    assert refused.value.code == expected
    assert snapshot(db) == before
    # A caller cannot attach someone else's native identity to the viewer principal.
    with pytest.raises(ChatError, match="^SESSION_FORBIDDEN$"), db.transaction():
        auth.lock_actor(
            db,
            Actor(
                viewer.principal, first.session_id, first.instance_id, browser_session_hash=actor.browser_session_hash
            ),
            read=True,
        )


def test_cookie_lifetime_is_ten_minutes_and_does_not_slide(
    http_api: Any,
    db: Connection[dict[str, Any]],
    credentials: Any,
    make_viewer: Any,
) -> None:
    viewer = make_viewer(UUID(credentials.room))
    headers, _ = login(http_api, viewer.token)
    actor = resolved_actor(db, headers)
    row = db.execute(
        "SELECT * FROM agent_chat.browser_sessions WHERE token_hash = %s", (actor.browser_session_hash,)
    ).fetchone()
    assert row is not None
    assert (row["expires_at"] - row["created_at"]).total_seconds() == 600
    db.execute(
        "UPDATE agent_chat.browser_sessions SET expires_at = expires_at - interval '5 minutes' WHERE token_hash = %s",
        (actor.browser_session_hash,),
    )
    before = db.execute("SELECT * FROM agent_chat.browser_sessions").fetchall()
    assert http_api("GET", "/v1/browser/session", headers=headers)[0] == 200
    assert http_api("GET", "/v1/rooms", headers=headers)[0] == 200
    assert feed.events(db, actor, 0)["rooms"] == (UUID(credentials.room),)
    assert db.execute("SELECT * FROM agent_chat.browser_sessions").fetchall() == before
    for registration in (False, True):
        with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
            auth.authenticate(db, viewer.token, registration=registration)
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        auth.authenticate_producer(db, viewer.token)
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"), db.transaction():
        auth.lock_actor(db, Actor(viewer.principal, None, None), read=True)


def test_cookie_security_logout_and_unrelated_sessions(
    http_api: Any,
    db: Connection[dict[str, Any]],
    credentials: Any,
    make_viewer: Any,
) -> None:
    viewer = make_viewer(UUID(credentials.room))
    headers, _ = login(http_api, viewer.token)
    other_headers, _ = login(http_api, viewer.token)
    operator_headers, operator_session = login(http_api, credentials.operator)
    assert operator_session["access"] == "operator" and operator_session["expires_in"] == 28800
    for altered in (
        {k: v for k, v in headers.items() if k != "Origin"},
        {**headers, "Origin": "https://hostile.test"},
        {k: v for k, v in headers.items() if k != "X-CSRF-Token"},
        {**headers, "X-CSRF-Token": "wrong"},
    ):
        assert http_api("POST", "/v1/logout", {}, headers=altered)[0] == 403
    assert http_api("GET", "/v1/rooms", token=credentials.operator, headers=headers)[0] == 401
    assert http_api("POST", "/v1/logout", {}, headers=headers) == (200, {"status": "logged_out"})
    assert http_api("GET", "/v1/browser/session", headers=headers)[0] == 401
    assert http_api("GET", "/v1/rooms", headers=other_headers)[0] == 200
    assert http_api("GET", "/v1/rooms", headers=operator_headers)[0] == 200


def bounded_read(db: Connection[dict[str, Any]], actor: Actor, room: UUID, surface: str) -> Any:
    if surface == "rooms":
        return rooms.visible(db, actor, read=True)
    if surface == "participants":
        return rooms.participants(db, actor, room)
    if surface == "history":
        return feed.history(db, actor, room)
    if surface == "state":
        return state.read(db, actor, room)
    if surface == "bootstrap":
        with db.transaction():
            return auth.lock_actor(db, actor, read=True)
    return feed.events(db, actor, 0, expected_rooms=(room,))


@pytest.mark.parametrize("surface", ["rooms", "participants", "history", "state", "bootstrap", "events"])
@pytest.mark.parametrize("change", ["revoke", "logout", "expire", "grant"])
def test_waiting_reads_recheck_resolved_actor_after_access_changes(
    db: Connection[dict[str, Any]],
    database: str,
    actors: Any,
    make_viewer: Any,
    lock_wait: Any,
    surface: str,
    change: str,
) -> None:
    room, _first, _second, operator = actors
    publish(db, operator, room, uuid4(), Publication(kind="message", body="protected sentinel"))
    viewer, unrelated = make_viewer(room), make_viewer(room)
    session, other = browser.login(db, viewer.token), browser.login(db, unrelated.token)
    actor = browser.authenticate_cookie(db, session.token)
    assert bounded_read(db, actor, room, surface)  # The same reader has a positive authorization control.
    before = snapshot(db)

    def read() -> Any:
        with connect(database) as reader:
            try:
                return bounded_read(reader, actor, room, surface)
            except ChatError as error:
                return error.code

    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            if change == "revoke":
                db.execute("SELECT id FROM agent_chat.principals WHERE id = %s FOR UPDATE", (viewer.principal,))
                fragment = "principals"
            elif change == "grant":
                db.execute(
                    "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (viewer.principal,)
                )
                fragment = "principal_rooms"
            else:
                db.execute(
                    "SELECT 1 FROM agent_chat.browser_sessions WHERE token_hash = %s FOR UPDATE",
                    (actor.browser_session_hash,),
                )
                fragment = "browser_sessions"
            future = pool.submit(read)
            # Bootstrap has no room grant; it remains valid when only the grant is removed.
            if change != "grant" or surface != "bootstrap":
                lock_wait(fragment)
                assert not future.done()
            if change == "revoke":
                db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (viewer.principal,))
            elif change == "logout":
                db.execute(
                    "DELETE FROM agent_chat.browser_sessions WHERE token_hash = %s", (actor.browser_session_hash,)
                )
            elif change == "expire":
                db.execute(
                    "UPDATE agent_chat.browser_sessions SET expires_at = clock_timestamp() - interval '1 second' "
                    "WHERE token_hash = %s",
                    (actor.browser_session_hash,),
                )
            else:
                db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (viewer.principal,))
        result = future.result(timeout=5)
    if change != "grant":
        assert result == "UNAUTHENTICATED"
    elif surface == "bootstrap":
        assert result == "viewer"
    else:
        assert result == (
            [] if surface == "rooms" else "ROOM_SCOPE_CHANGED" if surface == "events" else "ROOM_FORBIDDEN"
        )
    assert rooms.visible(db, browser.authenticate_cookie(db, other.token), read=True)[0]["id"] == room
    assert rooms.visible(db, operator)[0]["id"] == room
    after = snapshot(db)
    for table in TABLES:
        if table not in ("principals", "principal_rooms"):
            assert after[table] == before[table], table


@pytest.mark.parametrize("surface", ["rooms", "participants", "history", "state", "events"])
def test_cookie_expiry_during_a_later_grant_wait_refuses_data(
    db: Connection[dict[str, Any]],
    database: str,
    actors: Any,
    make_viewer: Any,
    lock_wait: Any,
    surface: str,
) -> None:
    room, _first, _second, _operator = actors
    viewer = make_viewer(room)
    session = browser.login(db, viewer.token)
    actor = browser.authenticate_cookie(db, session.token)
    binding = db.execute(
        "UPDATE agent_chat.browser_sessions SET expires_at = clock_timestamp() + interval '1 second' "
        "WHERE token_hash = %s RETURNING expires_at",
        (actor.browser_session_hash,),
    ).fetchone()
    assert binding is not None
    expiry = binding["expires_at"]

    def read() -> str:
        with connect(database) as reader:
            try:
                bounded_read(reader, actor, room, surface)
            except ChatError as error:
                return error.code
        return "UNEXPECTED_DATA"

    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (viewer.principal,)
            )
            future = pool.submit(read)
            lock_wait("principal_rooms")
            # Wait on the real database clock, without changing it or the locked cookie.
            db.execute(
                "SELECT pg_sleep(GREATEST(0, extract(epoch FROM (%s::timestamptz - clock_timestamp()))))", (expiry,)
            )
        assert future.result(timeout=5) == "UNAUTHENTICATED"


@pytest.mark.parametrize("surface", ["rooms", "participants", "history", "state", "bootstrap"])
def test_http_reads_waiting_for_principal_revocation_refuse(
    http_api: Any,
    db: Connection[dict[str, Any]],
    credentials: Any,
    make_viewer: Any,
    lock_wait: Any,
    surface: str,
) -> None:
    viewer = make_viewer(UUID(credentials.room))
    headers, _ = login(http_api, viewer.token)
    path = (
        "/v1/rooms"
        if surface == "rooms"
        else "/v1/browser/session"
        if surface == "bootstrap"
        else f"/v1/rooms/{credentials.room}/{surface}"
    )
    assert http_api("GET", path, headers=headers)[0] == 200
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            db.execute("SELECT id FROM agent_chat.principals WHERE id = %s FOR UPDATE", (viewer.principal,))
            future = pool.submit(http_api, "GET", path, headers=headers)
            lock_wait("principals")
            db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (viewer.principal,))
        assert future.result(timeout=5) == (401, {"error": {"code": "UNAUTHENTICATED", "message": "UNAUTHENTICATED"}})


@pytest.mark.parametrize("change", ["revoke", "logout", "expire", "grant"])
def test_each_http_event_batch_revalidates_cookie_principal_and_scope(
    process_api: Any,
    db: Connection[dict[str, Any]],
    credentials: Any,
    make_viewer: Any,
    event: Any,
    lock_wait: Any,
    change: str,
) -> None:
    viewer = make_viewer(UUID(credentials.room))
    headers, _ = login(process_api.request, viewer.token)
    actor = resolved_actor(db, headers)
    publish(
        db,
        auth.authenticate(db, credentials.operator),
        UUID(credentials.room),
        uuid4(),
        Publication(kind="message", body="first authorized batch"),
    )
    # The next batch resolves its actor before waiting on the event clock. Changes must still win afterwards.
    process_api.restart(stream_poll=0.1)
    with process_api.stream(headers=headers) as response:
        assert response.status == 200
        assert event(response)["event"] == "message"
        with db.transaction():
            events.lock(db)
            lock_wait("event_clock")
            if change == "revoke":
                db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (viewer.principal,))
            elif change == "logout":
                browser.logout(db, actor)
            elif change == "expire":
                db.execute(
                    "UPDATE agent_chat.browser_sessions SET expires_at = clock_timestamp() - interval '1 second' "
                    "WHERE token_hash = %s",
                    (actor.browser_session_hash,),
                )
            else:
                db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (viewer.principal,))
        control = event(response)
        assert control == {
            "event": "control",
            "data": {"error": {"code": "ROOM_SCOPE_CHANGED" if change == "grant" else "UNAUTHENTICATED"}},
        }
        assert response.read() == b""
