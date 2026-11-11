"""Display metadata never changes addressing, authority or delivery receipts."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from agent_chat import feed, rooms, sessions, storage
from agent_chat.models import Actor, ChatError, Heartbeat, Publication
from agent_chat.publication import publish


def beat(**fields):
    return Heartbeat(native_state="idle", stopped=False, plan_mode=False, **fields)


@pytest.mark.parametrize("title", [
    "", " ", " padded", "trailing ", "x" * 129, "line\nbreak", "tab\t", "x\x00", "x\x7f", "x\u202e", "x\u2069", 12,
    "x\x85y", "x\u2028y", "x\u200ey",
])
def test_invalid_titles_are_rejected(title):
    with pytest.raises(ValidationError):
        beat(title=title)


def test_titles_rename_clear_and_survive_legacy_heartbeat_without_changing_identity(db, actors):
    room, first, second, operator = actors
    before = db.execute("SELECT id, label, native_session_id FROM agent_chat.sessions ORDER BY id").fetchall()
    sessions.heartbeat(db, first, beat(title="Repair queue"))
    sessions.heartbeat(db, second, beat(title="Repair queue"))
    rows = rooms.participants(db, operator, room)["participants"]
    assert [row["title"] for row in rows] == ["Repair queue", "Repair queue"]
    sessions.heartbeat(db, first, beat())
    assert sessions.status(db, first)["title"] == "Repair queue"
    sessions.heartbeat(db, first, beat(title="Renamed"))
    assert sessions.status(db, first)["title"] == "Renamed"
    sessions.heartbeat(db, first, beat(title=None))
    assert sessions.status(db, first)["title"] is None
    assert sessions.status(db, second)["title"] == "Repair queue"
    assert db.execute("SELECT id, label, native_session_id FROM agent_chat.sessions ORDER BY id").fetchall() == before
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


def test_only_the_live_instance_can_change_its_own_title(db, actors):
    room, first, second, operator = actors
    sessions.heartbeat(db, first, beat(title="Owner"))
    for actor in (operator, Actor(first.principal_id, second.session_id, first.instance_id)):
        with pytest.raises(ChatError):
            sessions.heartbeat(db, actor, beat(title="Impersonator"))
    sessions.end(db, first)
    with pytest.raises(ChatError, match="STALE_INSTANCE"):
        sessions.heartbeat(db, first, beat(title="Stale"))
    row = db.execute("SELECT title FROM agent_chat.sessions WHERE id = %s", (first.session_id,)).fetchone()
    assert row["title"] == "Owner"
    with pytest.raises(ChatError, match="ROOM_FORBIDDEN"):
        rooms.participants(db, second, uuid4())


def test_history_events_and_receipts_project_titles_without_participant_page(db, actors):
    room, first, second, operator = actors
    sessions.heartbeat(db, first, beat(title="Sender"))
    sessions.heartbeat(db, second, beat(title="Recipient"))
    message = publish(db, first, room, uuid4(), Publication(
        kind="question", body="Synthetic question", recipients=[second.session_id],
    ))
    row = feed.history(db, operator, room)["messages"][0]
    assert row["id"] == message["id"]
    assert row["sender"]["title"] == "Sender"
    assert row["sender"]["harness"] == "pi"
    assert row["receipts"][0]["title"] == "Recipient"
    event = next(e for e in feed.events(db, operator, 0)["events"] if e["data"].get("message_id") == message["id"])
    assert event["data"]["message"]["sender"]["title"] == "Sender"
    sessions.heartbeat(db, first, beat(title="Current name"))
    assert feed.history(db, operator, room)["messages"][0]["sender"]["title"] == "Current name"
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients").fetchone()["acknowledged_at"] is None


def test_migration_004_preserves_existing_identity_and_is_repeatable(database, monkeypatch):
    with storage.connect(database) as db:
        monkeypatch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:3])
        storage.migrate(db)
        principal, session = uuid4(), uuid4()
        db.execute(
            "INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness) "
            "VALUES (%s, 'agent', %s, 'test', 'pi')", (principal, "a" * 64),
        )
        db.execute(
            "INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label) "
            "VALUES (%s, %s, 'native', 'stable')", (session, principal),
        )
        monkeypatch.undo()
        storage.migrate(db)
        storage.migrate(db)
        assert db.execute("SELECT id, native_session_id, label, title FROM agent_chat.sessions").fetchone() == {
            "id": session, "native_session_id": "native", "label": "stable", "title": None,
        }
