"""three room role marks, one live role per session, stamps and aliases."""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import uuid4

import psycopg
import pytest

from agent_chat import feed, publication, receipts, rooms, storage
from agent_chat.models import ChatError, Publication
from agent_chat.publication import publish
from agent_chat.storage import connect, migrate
from tests.agent_chat.conftest import seed_actor

HOURS = 48
NOT_FOUND = (404, {"error": {"code": "NOT_FOUND", "message": "NOT_FOUND"}})
ROLES = ("pm", "github_pm", "delivery_manager")


def _instance(http_api: Any, credentials: Any, name: str) -> str:
    token = secrets.token_hex(32)
    status, _binding = http_api(
        "POST",
        "/v1/sessions",
        {
            "native_session_id": name,
            "boot_id": str(uuid4()),
            "instance_token_hash": sha256(token.encode()).hexdigest(),
        },
        credentials.agent,
    )
    assert status == 200
    return token


def _mark(http_api: Any, room: Any, role: str, session: Any, token: str, *, assigned: bool = True):
    return http_api(
        "POST",
        f"/v1/rooms/{room}/roles",
        {"role": role, "session_id": str(session), "assigned": assigned},
        token,
    )


def _pm_mark(http_api: Any, room: Any, session: Any, token: str, *, pm: bool = True):
    return http_api("POST", f"/v1/rooms/{room}/pm", {"session_id": str(session), "pm": pm}, token)


def _holders(db: Any, role: str | None = None) -> list[dict[str, Any]]:
    if role is None:
        return db.execute(
            "SELECT room_id, role, session_id, set_at, last_activity_at FROM agent_chat.room_roles ORDER BY role"
        ).fetchall()
    return db.execute(
        "SELECT room_id, role, session_id, set_at, last_activity_at FROM agent_chat.room_roles WHERE role = %s",
        (role,),
    ).fetchall()


def _age(db: Any, role: str, **ago: int) -> None:
    db.execute(
        "UPDATE agent_chat.room_roles SET last_activity_at = clock_timestamp() - %s WHERE role = %s",
        (timedelta(**ago), role),
    )


def _say(db: Any, actor: Any, room: Any, body: str = "text", **fields: Any) -> dict[str, Any]:
    kind = fields.pop("kind", "message")
    return feed.message_view(publish(db, actor, room, uuid4(), Publication(kind=kind, body=body, **fields)))


def _role(view: dict[str, Any]) -> Any:
    return view["sender"].get("role")


def _page(db: Any, actor: Any, room: Any) -> dict[str, Any]:
    return rooms.participants(db, actor, room)


def _one(client: Any, sql: str) -> dict[str, Any]:
    row = client.execute(sql).fetchone()
    assert row is not None
    return row


def _count(db: Any, table: str) -> int:
    return db.execute(f"SELECT count(*) AS n FROM agent_chat.{table}").fetchone()["n"]  # noqa: S608


def test_the_expiry_is_the_decided_48_hours() -> None:
    from agent_chat import models

    assert models.ROLE_EXPIRY_HOURS == HOURS


def test_the_operator_sets_each_role_and_every_credential_reads_it(
    http_api: Any, db: Any, credentials: Any, actors: Any, make_viewer: Any, actor_factory: Any
) -> None:
    room, first, second, _operator = actors
    third = actor_factory(room)
    status, page = http_api("GET", f"/v1/rooms/{room}/participants", token=credentials.operator)
    assert status == 200 and set(page) == {"participants", "next_session_id", "roles", "pm"}
    assert page["roles"] == {"pm": None, "github_pm": None, "delivery_manager": None} and page["pm"] is None
    status, body = _mark(http_api, room, "pm", first.session_id, credentials.operator)
    assert status == 200 and body["room_id"] == str(room)
    block = body["roles"]["pm"]
    assert set(block) == {"session_id", "set_at", "last_activity_at", "expires_at"}
    assert block["session_id"] == str(first.session_id)
    moment = datetime.fromisoformat
    assert moment(block["expires_at"]) - moment(block["last_activity_at"]) == timedelta(hours=HOURS)
    assert _mark(http_api, room, "github_pm", second.session_id, credentials.operator)[0] == 200
    assert _mark(http_api, room, "delivery_manager", third.session_id, credentials.operator)[0] == 200
    page = _page(db, _operator, room)
    assert {role: (page["roles"][role] or {}).get("session_id") for role in ROLES} == {
        "pm": first.session_id,
        "github_pm": second.session_id,
        "delivery_manager": third.session_id,
    }
    assert page["pm"] == page["roles"]["pm"]
    # The pm route is the pm mark; re-setting the same holder is accepted.
    status, body = _pm_mark(http_api, room, first.session_id, credentials.operator)
    assert status == 200 and body["pm"]["session_id"] == str(first.session_id)
    page = _page(db, _operator, room)
    assert page["roles"]["pm"]["session_id"] == first.session_id
    assert page["roles"]["github_pm"]["session_id"] == second.session_id


def test_a_session_may_not_hold_two_live_roles(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, _second, _operator = actors
    assert _mark(http_api, room, "pm", first.session_id, credentials.operator)[0] == 200
    before = _holders(db)
    status, body = _mark(http_api, room, "github_pm", first.session_id, credentials.operator)
    assert (status, body["error"]["code"]) == (409, "ROLE_CONFLICT")
    assert _holders(db) == before
    assert _mark(http_api, room, "pm", first.session_id, credentials.operator, assigned=False)[0] == 200
    assert _mark(http_api, room, "github_pm", first.session_id, credentials.operator)[0] == 200
    assert [row["role"] for row in _holders(db)] == ["github_pm"]


def test_each_role_stamps_its_wire_value(
    http_api: Any, db: Any, credentials: Any, actors: Any, actor_factory: Any
) -> None:
    room, first, second, operator = actors
    third = actor_factory(room)
    for role, session in (("pm", first), ("github_pm", second), ("delivery_manager", third)):
        assert _mark(http_api, room, role, session.session_id, credentials.operator)[0] == 200
    published = {
        "forgejo": _say(db, first, room, "f"),
        "github": _say(db, second, room, "g"),
        "delivery": _say(db, third, room, "d"),
        "peer": _say(db, seed_actor(db, room), room, "p"),
    }
    assert {name: _role(view) for name, view in published.items()} == {
        "forgejo": "pm",
        "github": "github_pm",
        "delivery": "delivery_manager",
        "peer": None,
    }
    history = {item["body"]: _role(item) for item in feed.history(db, operator, room)["messages"]}
    assert history == {"f": "pm", "g": "github_pm", "d": "delivery_manager", "p": None}
    streamed = {
        item["data"]["message"]["body"]: _role(item["data"]["message"])
        for item in feed.events(db, operator, 0)["events"]
        if item["event"] == "message"
    }
    assert streamed == {"f": "pm", "g": "github_pm", "d": "delivery_manager", "p": None}


def test_history_maps_the_pm_alias_to_the_forgejo_stamp(
    http_api: Any, db: Any, credentials: Any, actors: Any, actor_factory: Any
) -> None:
    room, first, second, operator = actors
    third = actor_factory(room)
    for role, session in (("pm", first), ("github_pm", second), ("delivery_manager", third)):
        assert _mark(http_api, room, role, session.session_id, credentials.operator)[0] == 200
    sent = {
        "f": _say(db, first, room, "f")["id"],
        "g": _say(db, second, room, "g")["id"],
        "d": _say(db, third, room, "d")["id"],
    }
    for stamp, expected in (
        ("pm", sent["f"]),
        ("forgejo_pm", sent["f"]),
        ("forgejo-pm", sent["f"]),
        ("github_pm", sent["g"]),
        ("delivery_manager", sent["d"]),
        ("dm", sent["d"]),
    ):
        filtered = feed.history(db, operator, room, sender_role=stamp)["messages"]
        assert [item["id"] for item in filtered] == [expected]
    status, body = http_api("GET", f"/v1/rooms/{room}/history?sender_role=github_pm", token=credentials.operator)
    assert status == 200 and [item["id"] for item in body["messages"]] == [str(sent["g"])]
    assert http_api("GET", f"/v1/rooms/{room}/history?sender_role=admin", token=credentials.operator)[0] == 422


def test_only_the_operator_changes_a_role(
    http_api: Any, db: Any, credentials: Any, actors: Any, make_viewer: Any, actor_factory: Any
) -> None:
    room, first, _second, _operator = actors
    peer = _instance(http_api, credentials, "peer")
    viewer = make_viewer(room)
    assert _mark(http_api, room, "pm", first.session_id, credentials.operator)[0] == 200
    before = _holders(db)
    for token, expected, code in (
        (peer, 403, "SESSION_FORBIDDEN"),
        (viewer.token, 401, "UNAUTHENTICATED"),
    ):
        status, body = _mark(http_api, room, "github_pm", first.session_id, token)
        assert (status, body["error"]["code"]) == (expected, code)
    assert http_api(
        "POST",
        f"/v1/rooms/{room}/roles",
        {"role": "github_pm", "session_id": str(first.session_id), "assigned": True},
    )[0] == 401
    assert _holders(db) == before
    outsider = actor_factory(room)
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (outsider.session_id,))
    assert _mark(http_api, room, "github_pm", outsider.session_id, credentials.operator) == (
        422,
        {"error": {"code": "INVALID_RECIPIENT", "message": "INVALID_RECIPIENT"}},
    )
    assert _mark(http_api, room, "github_pm", first.session_id, credentials.operator, assigned=False) == NOT_FOUND


def test_roles_expire_independently(
    http_api: Any, db: Any, credentials: Any, actors: Any, actor_factory: Any
) -> None:
    room, first, second, operator = actors
    third = actor_factory(room)
    for role, session in (("pm", first), ("github_pm", second), ("delivery_manager", third)):
        assert _mark(http_api, room, role, session.session_id, credentials.operator)[0] == 200
    _age(db, "github_pm", hours=47, minutes=59)
    page = _page(db, operator, room)
    assert page["roles"]["github_pm"]["session_id"] == second.session_id
    _age(db, "github_pm", hours=48, minutes=1)
    page = _page(db, operator, room)
    assert page["roles"]["github_pm"] is None
    assert page["roles"]["pm"]["session_id"] == first.session_id
    assert page["roles"]["delivery_manager"]["session_id"] == third.session_id
    assert _role(_say(db, second, room, "late")) is None
    assert _role(_say(db, first, room, "live")) == "pm"


def test_an_acknowledgement_extends_only_the_holders_role(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    room, first, second, operator = actors
    assert _mark(http_api, room, "pm", first.session_id, credentials.operator)[0] == 200
    assert _mark(http_api, room, "github_pm", second.session_id, credentials.operator)[0] == 200
    _age(db, "pm", hours=10)
    _age(db, "github_pm", hours=10)
    aged = {row["role"]: row["last_activity_at"] for row in _holders(db)}
    question = publish(
        db,
        operator,
        room,
        uuid4(),
        Publication(kind="question", body="q", recipients=(first.session_id, second.session_id)),
    )
    receipts.acknowledge(db, second, question["id"])
    now = {row["role"]: row["last_activity_at"] for row in _holders(db)}
    assert now["pm"] == aged["pm"]
    assert now["github_pm"] > aged["github_pm"]
    receipts.acknowledge(db, first, question["id"])
    assert {row["role"]: row["last_activity_at"] for row in _holders(db)}["pm"] > aged["pm"]


def test_a_refused_publication_does_not_extend_the_role(
    http_api: Any, db: Any, credentials: Any, actors: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    room, first, _second, _operator = actors
    assert _mark(http_api, room, "pm", first.session_id, credentials.operator)[0] == 200
    _age(db, "pm", hours=10)
    aged = _holders(db)
    with pytest.raises(ChatError, match="^INVALID_RECIPIENT$"):
        _say(db, first, room, "to nobody", recipients=(uuid4(),))
    assert _holders(db) == aged

    def late(*_args: Any) -> None:
        raise ChatError("STALE_INSTANCE")

    monkeypatch.setattr(publication, "require_current", late)
    with pytest.raises(ChatError, match="^STALE_INSTANCE$"):
        _say(db, first, room, "too late")
    assert _holders(db) == aged and _count(db, "messages") == 0


def test_the_roles_route_logs_one_line_per_success(
    http_api: Any, db: Any, credentials: Any, actors: Any, caplog: pytest.LogCaptureFixture
) -> None:
    room, first, _second, _operator = actors
    caplog.set_level(logging.INFO, logger="agent_chat.api")

    def lines(prefix: str) -> list[str]:
        return [
            record.getMessage()
            for record in caplog.records
            if record.name == "agent_chat.api" and record.getMessage().startswith(prefix)
        ]

    peer = _instance(http_api, credentials, "peer")
    assert _mark(http_api, room, "github_pm", first.session_id, peer)[0] == 403
    assert _mark(http_api, room, "github_pm", first.session_id, credentials.operator, assigned=False) == NOT_FOUND
    assert lines("role_mark") == []
    assert _mark(http_api, room, "github_pm", first.session_id, credentials.operator)[0] == 200
    assert lines("role_mark") == [f"role_mark action=set role=github_pm room={room} session={first.session_id}"]
    assert _mark(http_api, room, "github_pm", first.session_id, credentials.operator, assigned=False)[0] == 200
    assert lines("role_mark")[1:] == [f"role_mark action=clear role=github_pm room={room} session={first.session_id}"]
    assert peer not in caplog.text


def test_the_route_refuses_a_malformed_role_request(
    http_api: Any, db: Any, credentials: Any
) -> None:
    session_id = str(uuid4())
    for payload in (
        {"role": "admin", "session_id": session_id, "assigned": True},
        {"role": "github_pm", "session_id": "not-a-uuid", "assigned": True},
        {"role": "github_pm", "session_id": session_id, "assigned": "yes"},
        {"role": "github_pm", "session_id": session_id},
        {"role": "github_pm", "session_id": session_id, "assigned": True, "extra": 1},
    ):
        status, body = http_api("POST", f"/v1/rooms/{credentials.room}/roles", payload, credentials.operator)
        assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")
    assert _holders(db) == []


def test_migration_011_copies_the_pm_mark_and_widens_the_stamp(
    database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with connect(database) as client:
        with monkeypatch.context() as patch:
            patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:9])
            migrate(client)
        room = _one(client, "SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'")["id"]
        holder = seed_actor(client, room)
        client.execute(
            "INSERT INTO agent_chat.room_pm "
            "(room_id, session_id, set_at, last_activity_at) "
            "VALUES (%s, %s, clock_timestamp(), clock_timestamp())",
            (room, holder.session_id),
        )
        thread, message = uuid4(), uuid4()
        with client.transaction():
            client.execute(
                "INSERT INTO agent_chat.threads(id, room_id, root_message_id) VALUES (%s, %s, %s)",
                (thread, room, message),
            )
            client.execute(
                """INSERT INTO agent_chat.messages
                   (id, room_id, thread_id, sender_principal_id, sender_session_id, kind, body, sender_role)
                   VALUES (%s, %s, %s, %s, %s, 'message', 'before 011', 'pm')""",
                (message, room, thread, holder.principal_id, holder.session_id),
            )
        migrate(client)
        versions = [row["version"] for row in client.execute("SELECT version FROM agent_chat.schema_migrations")]
        assert versions == list(range(1, len(storage.MIGRATIONS) + 1)) and storage.MIGRATIONS[-1].startswith("011")
        assert _one(client, "SELECT to_regclass('agent_chat.room_pm') AS name")["name"] is None
        roles = client.execute("SELECT role, session_id FROM agent_chat.room_roles").fetchall()
        assert roles == [{"role": "pm", "session_id": holder.session_id}]
        assert client.execute("SELECT sender_role FROM agent_chat.messages").fetchall() == [{"sender_role": "pm"}]
        with pytest.raises(psycopg.errors.CheckViolation):
            client.execute("UPDATE agent_chat.messages SET sender_role = 'operator'")
        for role in ("pm", "github_pm", "delivery_manager"):
            client.execute("UPDATE agent_chat.messages SET sender_role = %s", (role,))
