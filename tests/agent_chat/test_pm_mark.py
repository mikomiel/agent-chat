"""the Forgejo PM alias of the room role marks, its expiry, the stamp and the operator route."""

from __future__ import annotations

import logging
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from hashlib import sha256
from http.cookies import SimpleCookie
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from pydantic import ValidationError

from agent_chat import browser, feed, publication, receipts, rooms, sessions, storage
from agent_chat.models import ChatError, Heartbeat, Publication, RoomCreation
from agent_chat.publication import publish
from agent_chat.storage import connect, migrate
from tests.agent_chat.conftest import seed_actor

ORIGIN = "https://chat.test"
# The decided expiry. `test_the_expiry_is_the_decided_48_hours` pins `models.ROLE_EXPIRY_HOURS` to it.
HOURS = 48
NOT_FOUND = (404, {"error": {"code": "NOT_FOUND", "message": "NOT_FOUND"}})


@pytest.fixture
def public_origin() -> str:
    return ORIGIN


def _mark(api: Any, room: Any, session: Any, token: str, *, pm: bool = True) -> tuple[int, dict[str, Any]]:
    return api("POST", f"/v1/rooms/{room}/pm", {"session_id": str(session), "pm": pm}, token)


def _holders(db: Any) -> list[dict[str, Any]]:
    return db.execute(
        "SELECT room_id, session_id, set_at, last_activity_at FROM agent_chat.room_roles "
        "WHERE role = 'pm' ORDER BY room_id"
    ).fetchall()


def _age(db: Any, **ago: int) -> None:
    db.execute(
        "UPDATE agent_chat.room_roles SET last_activity_at = clock_timestamp() - %s "
        "WHERE role = 'pm'",
        (timedelta(**ago),),
    )


def _say(db: Any, actor: Any, room: Any, body: str = "text", **fields: Any) -> dict[str, Any]:
    kind = fields.pop("kind", "message")
    return feed.message_view(publish(db, actor, room, uuid4(), Publication(kind=kind, body=body, **fields)))


def _role(view: dict[str, Any]) -> Any:
    return view["sender"].get("role")


def _pm(db: Any, actor: Any, room: Any) -> Any:
    return rooms.participants(db, actor, room)["pm"]


def _count(db: Any, table: str) -> int:
    return db.execute(f"SELECT count(*) AS n FROM agent_chat.{table}").fetchone()["n"]  # noqa: S608


def _one(client: Any, sql: str) -> dict[str, Any]:
    row = client.execute(sql).fetchone()
    assert row is not None
    return row


def _instance(api: Any, credentials: Any, name: str) -> tuple[str, dict[str, Any]]:
    token = secrets.token_hex(32)
    digest = sha256(token.encode()).hexdigest()
    status, binding = api(
        "POST",
        "/v1/sessions",
        {"native_session_id": name, "boot_id": str(uuid4()), "instance_token_hash": digest},
        credentials.agent,
    )
    assert status == 200
    return token, binding


def _login(api: Any, token: str) -> dict[str, str]:
    status, challenge, headers = api("GET", "/v1/login", include_headers=True)
    assert status == 200
    jar = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            jar.load(value)
    status, session, headers = api(
        "POST",
        "/v1/login",
        {"token": token},
        headers={
            "Origin": ORIGIN,
            "Cookie": f"{browser.LOGIN_COOKIE}={jar[browser.LOGIN_COOKIE].value}",
            "X-CSRF-Token": challenge["csrf_token"],
        },
        include_headers=True,
    )
    assert status == 200
    for name, value in headers:
        if name.lower() == "set-cookie":
            jar.load(value)
    return {
        "Origin": ORIGIN,
        "Cookie": f"{browser.SESSION_COOKIE}={jar[browser.SESSION_COOKIE].value}",
        "X-CSRF-Token": session["csrf_token"],
    }


def test_the_expiry_is_the_decided_48_hours() -> None:
    from agent_chat import models

    assert models.ROLE_EXPIRY_HOURS == HOURS


def test_the_operator_sets_the_mark_and_every_credential_reads_it(
    http_api: Any, db: Any, credentials: Any, actors: Any, make_viewer: Any
) -> None:
    room, first, second, operator = actors
    status, roster = http_api("GET", f"/v1/rooms/{room}/participants", token=credentials.operator)
    assert status == 200 and set(roster) == {"participants", "next_session_id", "roles", "pm"} and roster["pm"] is None
    assert roster["roles"] == {"pm": None, "github_pm": None, "delivery_manager": None}
    events = _count(db, "events")
    status, body = _mark(http_api, room, first.session_id, credentials.operator)
    assert status == 200 and body["room_id"] == str(room)
    block = body["pm"]
    assert set(block) == {"session_id", "set_at", "last_activity_at", "expires_at"}
    assert block["session_id"] == str(first.session_id)
    moment = datetime.fromisoformat
    assert moment(block["expires_at"]) - moment(block["last_activity_at"]) == timedelta(hours=HOURS)
    assert moment(block["set_at"]) == moment(block["last_activity_at"])
    assert http_api("GET", f"/v1/rooms/{room}/participants", token=credentials.operator)[1]["pm"] == block
    viewer = browser.authenticate_cookie(db, browser.login(db, make_viewer(room).token).token)
    seen = [_pm(db, actor, room) for actor in (operator, first, second, viewer)]
    assert all(item == seen[0] for item in seen) and seen[0]["session_id"] == first.session_id
    # Set and clear append no event: another open reader sees the change at its next roster read.
    assert _count(db, "events") == events


def test_a_new_holder_replaces_the_old_one_in_one_step(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    status, body = _mark(http_api, room, second.session_id, credentials.operator)
    assert status == 200 and body["pm"]["session_id"] == str(second.session_id)
    assert [row["session_id"] for row in _holders(db)] == [second.session_id]
    assert _pm(db, operator, room)["session_id"] == second.session_id
    assert _role(_say(db, first, room)) is None and _role(_say(db, second, room)) == "pm"


def test_concurrent_sets_leave_exactly_one_holder(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, _operator = actors
    for _ in range(3):
        with ThreadPoolExecutor(2) as pool:
            results = list(
                pool.map(
                    lambda session: _mark(http_api, room, session, credentials.operator),
                    (first.session_id, second.session_id),
                )
            )
        assert [status for status, _body in results] == [200, 200]
        holders = _holders(db)
        assert len(holders) == 1 and holders[0]["session_id"] in (first.session_id, second.session_id)


def test_only_the_operator_sets_or_clears_the_mark(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, _second, _operator = actors
    peer, _ = _instance(http_api, credentials, "peer")
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    before = _holders(db)
    for pm in (True, False):
        assert _mark(http_api, room, first.session_id, peer, pm=pm) == (
            403,
            {"error": {"code": "SESSION_FORBIDDEN", "message": "SESSION_FORBIDDEN"}},
        )
        assert _mark(http_api, room, first.session_id, credentials.agent, pm=pm)[0] == 401
        assert http_api("POST", f"/v1/rooms/{room}/pm", {"session_id": str(first.session_id), "pm": pm})[0] == 401
    assert _holders(db) == before


def test_the_target_must_be_a_current_member_with_a_live_principal(
    http_api: Any, db: Any, credentials: Any, actors: Any, actor_factory: Any
) -> None:
    room, first, _second, _operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    outsider, revoked = actor_factory(room), actor_factory(room)
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (outsider.session_id,))
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (revoked.principal_id,))
    before = _holders(db)
    for target in (outsider.session_id, revoked.session_id, uuid4()):
        assert _mark(http_api, room, target, credentials.operator) == (
            422,
            {"error": {"code": "INVALID_RECIPIENT", "message": "INVALID_RECIPIENT"}},
        )
    assert _holders(db) == before


def test_clear_names_the_live_holder(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator, pm=False) == NOT_FOUND
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    before = _holders(db)
    assert _mark(http_api, room, second.session_id, credentials.operator, pm=False) == NOT_FOUND
    assert _holders(db) == before
    status, body = _mark(http_api, room, first.session_id, credentials.operator, pm=False)
    assert (status, body) == (200, {"room_id": str(room), "pm": None})
    assert _holders(db) == [] and _pm(db, operator, room) is None


def test_the_mark_expires_after_48_hours_without_holder_activity(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, _second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    _age(db, hours=47, minutes=59)
    live = _pm(db, operator, room)
    assert live is not None and live["session_id"] == first.session_id
    _age(db, hours=48, minutes=1)
    assert _pm(db, operator, room) is None
    # An expired mark reads as no mark, so a clear that names its holder is refused like any other.
    assert _mark(http_api, room, first.session_id, credentials.operator, pm=False) == NOT_FOUND


def test_an_expired_mark_is_not_revived_by_the_holder(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, _second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    _age(db, hours=48, minutes=1)
    stale = _holders(db)
    assert _role(_say(db, first, room)) is None
    question = publish(
        db, operator, room, uuid4(), Publication(kind="question", body="q", recipients=(first.session_id,))
    )
    receipts.acknowledge(db, first, question["id"])
    assert _holders(db) == stale and _pm(db, operator, room) is None
    # Only a new operator set makes the session the holder again.
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    assert _role(_say(db, first, room)) == "pm"


def test_the_live_holder_is_stamped_in_every_view_and_a_peer_is_not(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    mine, theirs = _say(db, first, room, "from the holder"), _say(db, second, room, "from a peer")
    assert mine["sender"] == {"principal_id": first.principal_id, "session_id": first.session_id, "role": "pm"}
    assert theirs["sender"] == {"principal_id": second.principal_id, "session_id": second.session_id}
    history = feed.history(db, operator, room)["messages"]
    assert [(item["id"], _role(item)) for item in history] == [(mine["id"], "pm"), (theirs["id"], None)]
    events = feed.events(db, operator, 0)["events"]
    streamed = [item["data"]["message"] for item in events if item["event"] == "message"]
    assert [(item["id"], _role(item)) for item in streamed] == [(mine["id"], "pm"), (theirs["id"], None)]
    # The role lives under `sender` only; the storage column never reaches a view.
    assert all("sender_role" not in view for view in (mine, theirs, *history, *streamed))


def test_the_stamp_is_historical(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    _say(db, first, room, "a1")
    assert _mark(http_api, room, second.session_id, credentials.operator)[0] == 200
    _say(db, first, room, "a2")
    _say(db, second, room, "b1")
    assert _mark(http_api, room, second.session_id, credentials.operator, pm=False)[0] == 200
    roles = {item["body"]: _role(item) for item in feed.history(db, operator, room)["messages"]}
    assert roles == {"a1": "pm", "a2": None, "b1": "pm"}


def test_a_replay_returns_the_stored_stamp_and_does_not_extend_the_mark(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, second, _operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    key, request = uuid4(), Publication(kind="message", body="once")
    original = feed.message_view(publish(db, first, room, key, request))
    assert _role(original) == "pm"
    _age(db, hours=10)
    aged = _holders(db)
    assert feed.message_view(publish(db, first, room, key, request)) == original
    assert _holders(db) == aged
    assert _mark(http_api, room, second.session_id, credentials.operator)[0] == 200
    assert feed.message_view(publish(db, first, room, key, request)) == original
    assert _count(db, "messages") == 1


def test_a_publication_request_cannot_carry_a_role(http_api: Any, db: Any, credentials: Any) -> None:
    with pytest.raises(ValidationError):
        Publication.model_validate({"kind": "message", "body": "forged", "sender_role": "pm"})
    token, _ = _instance(http_api, credentials, "forger")
    for field in ("sender_role", "role"):
        status, body = http_api(
            "POST",
            f"/v1/rooms/{credentials.room}/messages",
            {"kind": "message", "body": "forged", field: "pm"},
            token,
            {"Idempotency-Key": str(uuid4())},
        )
        assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")
    assert _count(db, "messages") == 0


def test_a_refused_publication_does_not_extend_the_mark(
    http_api: Any, db: Any, credentials: Any, actors: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    room, first, _second, _operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    _age(db, hours=10)
    aged = _holders(db)
    with pytest.raises(ChatError, match="^INVALID_RECIPIENT$"):
        _say(db, first, room, "to nobody", recipients=(uuid4(),))
    assert _holders(db) == aged

    def late(*_args: Any) -> None:
        raise ChatError("STALE_INSTANCE")

    # The late lease check runs after the stamp: it rolls the extension back together with the message.
    monkeypatch.setattr(publication, "require_current", late)
    with pytest.raises(ChatError, match="^STALE_INSTANCE$"):
        _say(db, first, room, "too late")
    assert _holders(db) == aged and _count(db, "messages") == 0


def test_an_acknowledgement_by_the_holder_extends_only_its_own_mark_in_that_room(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, second, operator = actors
    other = rooms.create(db, operator, RoomCreation(slug="other", label="Other"))["id"]
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (first.principal_id, other))
    db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (other, first.session_id))
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    db.execute(
        "INSERT INTO agent_chat.room_roles "
        "(room_id, role, session_id, set_at, last_activity_at) "
        "VALUES (%s, 'pm', %s, clock_timestamp(), clock_timestamp())",
        (other, first.session_id),
    )

    def activity() -> dict[UUID, datetime]:
        return {row["room_id"]: row["last_activity_at"] for row in _holders(db)}

    _age(db, hours=10)
    aged = activity()
    both = (first.session_id, second.session_id)
    question = publish(db, operator, room, uuid4(), Publication(kind="question", body="q", recipients=both))
    receipts.acknowledge(db, second, question["id"])
    assert activity() == aged
    receipts.acknowledge(db, first, question["id"])
    after = activity()
    assert after[other] == aged[other] and after[room] - aged[room] >= timedelta(hours=9)
    # A repeated acknowledgement changes nothing, so it extends nothing.
    _age(db, hours=10)
    aged = activity()
    receipts.acknowledge(db, first, question["id"])
    assert activity() == aged


def test_other_activity_does_not_extend_the_mark(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    _age(db, hours=10)
    aged = _holders(db)
    _say(db, second, room, "from a peer")
    question = publish(
        db, operator, room, uuid4(), Publication(kind="question", body="q", recipients=(second.session_id,))
    )
    receipts.acknowledge(db, second, question["id"])
    sessions.heartbeat(db, first, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    assert _holders(db) == aged


@pytest.mark.parametrize("change", ["revoked", "left"])
def test_a_mark_whose_holder_was_revoked_or_left_the_room_is_not_live(
    http_api: Any, db: Any, credentials: Any, actors: Any, change: str
) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    if change == "revoked":
        db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (first.principal_id,))
    else:
        db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (first.session_id,))
    assert _pm(db, operator, room) is None
    assert _mark(http_api, room, first.session_id, credentials.operator, pm=False) == NOT_FOUND
    assert len(_holders(db)) == 1  # the stale row stays until the next set replaces it
    assert _mark(http_api, room, second.session_id, credentials.operator)[0] == 200
    assert [row["session_id"] for row in _holders(db)] == [second.session_id]


def test_the_roster_block_does_not_depend_on_paging_or_the_online_filter(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, _second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
    offline = rooms.participants(db, operator, room, limit=1, online=True)
    assert offline["participants"] == [] and offline["pm"]["session_id"] == first.session_id
    paged = rooms.participants(db, operator, room, limit=1)
    assert len(paged["participants"]) == 1 and paged["pm"]["session_id"] == first.session_id


def test_history_filters_by_sender_role_in_cursor_order(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    sent = {name: _say(db, actor, room, name)["id"] for actor, name in ((first, "a1"), (second, "b1"), (first, "a2"))}
    assert [item["id"] for item in feed.history(db, operator, room)["messages"]] == list(sent.values())
    stamped = [sent["a1"], sent["a2"]]
    assert [item["id"] for item in feed.history(db, operator, room, sender_role="pm")["messages"]] == stamped
    page = feed.history(db, operator, room, limit=1, sender_role="pm")
    assert [item["id"] for item in page["messages"]] == stamped[:1] and page["has_more"]
    rest = feed.history(db, operator, room, after=int(page["next_cursor"]), sender_role="pm")
    assert [item["id"] for item in rest["messages"]] == stamped[1:]
    status, body = http_api("GET", f"/v1/rooms/{room}/history?sender_role=pm", token=credentials.operator)
    assert status == 200 and [item["id"] for item in body["messages"]] == [str(item) for item in stamped]
    assert http_api("GET", f"/v1/rooms/{room}/history?sender_role=admin", token=credentials.operator)[0] == 422


def test_a_scoped_read_cursor_skips_a_stored_pm_instruction(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, second, _operator = actors
    lane = "lane:owner/project::de3b47545dc0-de56e9b4bbbe6341"
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    progress = _say(db, second, room, "lane progress", kind="status", ref_key=lane)
    # The instruction is stored in a separate addressed conversation, after the lane message.
    instruction = _say(db, first, room, "stop publishing", kind="question", recipients=(second.session_id,))
    assert _role(instruction) == "pm"
    # An exhausted scoped page names the room clock, which is already past the instruction.
    scoped = feed.history(db, second, room, ref_key=lane)
    assert [item["id"] for item in scoped["messages"]] == [progress["id"]] and not scoped["has_more"]
    assert scoped["next_cursor"] == scoped["position"]
    reused = feed.history(db, second, room, after=int(scoped["next_cursor"]), sender_role="pm")
    assert reused["messages"] == [] and not reused["has_more"]
    # A PM cursor that starts without `after` reads from the retained floor and finds it.
    pm = feed.history(db, second, room, sender_role="pm")
    assert [item["id"] for item in pm["messages"]] == [instruction["id"]] and not pm["has_more"]


@pytest.mark.parametrize(
    "payload",
    [
        {"pm": True},
        {"session_id": "not-a-uuid", "pm": True},
        {"session_id": str(uuid4()), "pm": "yes"},
        {"session_id": str(uuid4()), "pm": 1},
        {"session_id": str(uuid4()), "pm": True, "role": "pm"},
    ],
    ids=["no-session", "bad-session", "string-flag", "integer-flag", "extra-field"],
)
def test_the_route_refuses_a_malformed_request(
    http_api: Any, db: Any, credentials: Any, payload: dict[str, Any]
) -> None:
    status, body = http_api("POST", f"/v1/rooms/{credentials.room}/pm", payload, credentials.operator)
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")
    assert _holders(db) == []


def test_a_set_or_clear_logs_one_identifier_line_after_it_committed(
    http_api: Any, db: Any, credentials: Any, actors: Any, caplog: pytest.LogCaptureFixture
) -> None:
    room, first, second, _operator = actors
    caplog.set_level(logging.INFO, logger="agent_chat.api")

    def lines() -> list[str]:
        return [
            record.getMessage()
            for record in caplog.records
            if record.name == "agent_chat.api" and record.getMessage().startswith("pm_mark")
        ]

    peer, _ = _instance(http_api, credentials, "peer")
    assert _mark(http_api, room, first.session_id, peer)[0] == 403
    assert _mark(http_api, room, uuid4(), credentials.operator)[0] == 422
    assert _mark(http_api, room, second.session_id, credentials.operator, pm=False)[0] == 404
    assert lines() == []
    assert _mark(http_api, room, first.session_id, credentials.operator)[0] == 200
    assert lines() == [f"pm_mark action=set room={room} session={first.session_id}"]
    assert _mark(http_api, room, first.session_id, credentials.operator, pm=False)[0] == 200
    assert lines()[1:] == [f"pm_mark action=clear room={room} session={first.session_id}"]
    assert credentials.operator not in caplog.text and peer not in caplog.text


def test_the_route_applies_the_csrf_rule_to_cookie_authentication(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, _second, _operator = actors
    headers = _login(http_api, credentials.operator)
    path, payload = f"/v1/rooms/{room}/pm", {"session_id": str(first.session_id), "pm": True}
    without = {name: value for name, value in headers.items() if name != "X-CSRF-Token"}
    assert http_api("POST", path, payload, headers=without)[0] == 403
    assert _holders(db) == []
    status, body = http_api("POST", path, payload, headers=headers)
    assert status == 200 and body["pm"]["session_id"] == str(first.session_id)


def test_011_carries_009_and_leaves_existing_messages_without_a_role(
    database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with connect(database) as client:
        with monkeypatch.context() as patch:
            patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:9])
            migrate(client)
        room = _one(client, "SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'")["id"]
        sender = seed_actor(client, room)
        thread, message = uuid4(), uuid4()
        with client.transaction():
            client.execute(
                "INSERT INTO agent_chat.threads(id, room_id, root_message_id) VALUES (%s, %s, %s)",
                (thread, room, message),
            )
            client.execute(
                """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, sender_session_id,
                       kind, body) VALUES (%s, %s, %s, %s, %s, 'message', 'written before 011')""",
                (message, room, thread, sender.principal_id, sender.session_id),
            )
        assert _one(client, "SELECT to_regclass('agent_chat.room_pm') AS name")["name"] is not None
        migrate(client)
        migrate(client)
        versions = [row["version"] for row in client.execute("SELECT version FROM agent_chat.schema_migrations")]
        assert versions == list(range(1, len(storage.MIGRATIONS) + 1)) and storage.MIGRATIONS[8] == "009_pm_mark.sql"
        assert storage.MIGRATIONS[-1] == "011_roles_and_work.sql"
        assert _one(client, "SELECT to_regclass('agent_chat.room_pm') AS name")["name"] is None
        assert _one(client, "SELECT to_regclass('agent_chat.room_roles') AS name")["name"] is not None
        assert client.execute("SELECT sender_role FROM agent_chat.messages").fetchall() == [{"sender_role": None}]
        # The set of stamps is closed by the database: a new role needs a new migration.
        with pytest.raises(psycopg.errors.CheckViolation):
            client.execute("UPDATE agent_chat.messages SET sender_role = 'operator'")
        for role in ("pm", "github_pm", "delivery_manager"):
            client.execute("UPDATE agent_chat.messages SET sender_role = %s", (role,))


def test_a_sender_role_does_not_change_the_notice_fields_the_adapters_read() -> None:
    from agent_chat.instance_client import _body_fields

    row = {
        "body": "hello",
        "sender": {"principal_id": str(uuid4()), "session_id": str(uuid4())},
        "created_at": "2026-11-06T10:00:00+00:00",
        "thread_id": str(uuid4()),
    }
    stamped = {**row, "sender": {**row["sender"], "role": "pm"}}
    assert _body_fields(stamped, 100_000) == _body_fields(row, 100_000)
