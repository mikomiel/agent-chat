import secrets
import threading
import time
from uuid import uuid4

import pytest

from agent_chat import sessions
from agent_chat.models import Actor, ChatError, Publication, Registration
from agent_chat.publication import publish
from agent_chat.retention import prune
from agent_chat.rooms import join
from agent_chat.storage import connect


def expire(db, message_id):
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = %s",
        (message_id,),
    )
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours' WHERE message_id = %s",
        (message_id,),
    )


def test_retained_reply_keeps_redacted_parent_then_collects_thread(db, actors, event_log):
    room, sender, target, _ = actors
    parent = publish(
        db, sender, room, uuid4(), Publication(kind="question", body="expired body", recipients=(target.session_id,))
    )
    reply = publish(db, target, room, uuid4(), Publication(kind="reply", body="retained body", reply_to=parent["id"]))
    expire(db, parent["id"])
    assert prune(db) == {
        "events": 1,
        "redacted": 1,
        "deleted": 0,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }
    rows = db.execute("SELECT id, body FROM agent_chat.messages").fetchall()
    assert {row["id"]: row["body"] for row in rows} == {parent["id"]: None, reply["id"]: "retained body"}
    assert db.execute("SELECT message_id FROM agent_chat.requests").fetchall() == [{"message_id": reply["id"]}]
    with pytest.raises(ChatError, match="^CURSOR_EXPIRED$"):
        event_log(db, sender)
    assert event_log(db, sender, after=1) == [
        {"position": 2, "kind": "message", "message_id": reply["id"]},
        {"position": 3, "kind": "receipt", "message_id": parent["id"]},
    ]
    with pytest.raises(ChatError, match="^MESSAGE_EXPIRED$"):
        publish(db, sender, room, uuid4(), Publication(kind="reply", body="no resurrection", reply_to=parent["id"]))
    expire(db, reply["id"])
    assert prune(db) == {
        "events": 2,
        "redacted": 1,
        "deleted": 1,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }
    assert prune(db) == {
        "events": 0,
        "redacted": 0,
        "deleted": 1,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }
    assert db.execute("SELECT id FROM agent_chat.threads").fetchall() == []
    assert db.execute("SELECT message_id FROM agent_chat.recipients").fetchall() == []
    assert db.execute("SELECT message_id FROM agent_chat.requests").fetchall() == []
    assert prune(db) == {
        "events": 0,
        "redacted": 0,
        "deleted": 0,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }


def test_retention_never_skips_retained_event_in_cursor_prefix(db, actors, event_log):
    room, sender, _, _ = actors
    first = publish(db, sender, room, uuid4(), Publication(kind="message", body="retained first"))
    second = publish(db, sender, room, uuid4(), Publication(kind="message", body="expired out of order"))
    expire(db, second["id"])
    assert prune(db) == {
        "events": 0,
        "redacted": 1,
        "deleted": 0,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }
    assert event_log(db, sender) == [
        {"position": 1, "kind": "message", "message_id": first["id"]},
        {"position": 2, "kind": "message", "message_id": second["id"]},
    ]
    expire(db, first["id"])
    assert prune(db) == {
        "events": 2,
        "redacted": 1,
        "deleted": 2,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }


def test_batches_are_bounded_and_cursor_does_not_reset(db, actors, event_log):
    room, sender, _, _ = actors
    for _ in range(3):
        result = publish(db, sender, room, uuid4(), Publication(kind="message", body="expired"))
        expire(db, result["id"])
    for _ in range(3):
        assert prune(db, limit=1) == {
            "events": 1,
            "redacted": 1,
            "deleted": 1,
            "ended_instances": 0,
            "memberships": 0,
            "expired_undelivered": 0,
        }
    fresh = publish(db, sender, room, uuid4(), Publication(kind="message", body="new"))
    assert event_log(db, sender, after=3) == [{"position": 4, "kind": "message", "message_id": fresh["id"]}]
    assert prune(db) == {
        "events": 0,
        "redacted": 0,
        "deleted": 0,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
    }


def test_root_is_retained_for_same_thread_messages_without_reply_edge(db, actors):
    room, sender, _, _ = actors
    parent = publish(db, sender, room, uuid4(), Publication(kind="message", body="root"))
    child = publish(
        db, sender, room, uuid4(), Publication(kind="message", body="continuation", thread_id=parent["thread_id"])
    )
    expire(db, parent["id"])
    assert prune(db)["deleted"] == 0
    expire(db, child["id"])
    assert prune(db)["deleted"] == 1
    assert prune(db)["deleted"] == 1
    assert db.execute("SELECT id FROM agent_chat.threads").fetchall() == []


@pytest.mark.parametrize("limit", [0, 1001])
def test_maintenance_rejects_unbounded_batches(db, limit):
    with pytest.raises(ChatError, match="^INVALID_REQUEST$"):
        prune(db, limit)


def test_future_cursor_and_expired_idempotent_response_are_not_silently_accepted(db, actors, event_log):
    room, sender, _, _ = actors
    key = uuid4()
    request = Publication(kind="message", body="expired")
    message = publish(db, sender, room, key, request)
    with pytest.raises(ChatError, match="^INVALID_CURSOR$"):
        event_log(db, sender, after=2)
    expire(db, message["id"])
    with pytest.raises(ChatError, match="^MESSAGE_EXPIRED$"):
        publish(db, sender, room, key, request)


def age(db, actor, interval):
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - %s::interval WHERE id = %s",
        (interval, actor.instance_id),
    )


def ended(db, actor):
    return db.execute("SELECT ended_at FROM agent_chat.instances WHERE id = %s", (actor.instance_id,)).fetchone()[
        "ended_at"
    ]


def members(db, room):
    return {
        row["session_id"]
        for row in db.execute("SELECT session_id FROM agent_chat.memberships WHERE room_id = %s", (room,))
    }


def test_instance_lapsed_over_a_day_is_ended_and_a_live_one_is_not(db, actors):
    _, lapsed, live, _ = actors
    age(db, lapsed, "25 hours")
    assert prune(db) == {
        "events": 0,
        "redacted": 0,
        "deleted": 0,
        "ended_instances": 1,
        "memberships": 0,
        "expired_undelivered": 0,
    }
    assert ended(db, lapsed) is not None
    assert ended(db, live) is None
    assert prune(db)["ended_instances"] == 0


def test_instance_past_its_lease_but_inside_a_day_is_not_ended(db, actors):
    _, sender, _, _ = actors
    age(db, sender, "91 minutes")  # one hour and a half past the 90 second lease
    assert prune(db)["ended_instances"] == 0
    assert ended(db, sender) is None


def test_membership_ages_out_only_after_a_week_without_an_open_instance(db, actors):
    room, stale, open_instance, _ = actors
    age(db, stale, "8 days")
    db.execute("UPDATE agent_chat.instances SET ended_at = heartbeat_at WHERE id = %s", (stale.instance_id,))
    age(db, open_instance, "8 days")
    # The open instance is ended by this pass, which does not by itself free its session's membership.
    result = prune(db)
    assert (result["ended_instances"], result["memberships"]) == (1, 1)
    assert members(db, room) == {open_instance.session_id}
    assert ended(db, open_instance) is not None
    assert prune(db)["memberships"] == 1
    assert members(db, room) == set()
    assert db.execute("SELECT count(*) AS n FROM agent_chat.sessions").fetchone()["n"] == 2


def test_session_seen_two_days_ago_keeps_its_membership(db, actors):
    room, sender, _, _ = actors
    age(db, sender, "2 days")
    db.execute("UPDATE agent_chat.instances SET ended_at = heartbeat_at WHERE id = %s", (sender.instance_id,))
    assert prune(db)["memberships"] == 0
    assert sender.session_id in members(db, room)


def test_session_without_any_instance_loses_its_membership(db, actors):
    room, sender, _, _ = actors
    db.execute("DELETE FROM agent_chat.instances WHERE id = %s", (sender.instance_id,))
    assert prune(db)["memberships"] == 1
    assert sender.session_id not in members(db, room)


def test_join_restores_an_aged_out_membership(db, actors):
    room, sender, _, operator = actors
    age(db, sender, "8 days")
    db.execute("UPDATE agent_chat.instances SET ended_at = heartbeat_at WHERE id = %s", (sender.instance_id,))
    assert prune(db)["memberships"] == 1
    assert sender.session_id not in members(db, room)
    join(db, operator, room, sender.session_id)
    assert sender.session_id in members(db, room)
    # Without an open instance the restored row is aged out again by the next pass; only a live binding keeps it.
    assert prune(db)["memberships"] == 1
    assert sender.session_id not in members(db, room)
    db.execute(
        "UPDATE agent_chat.instances SET ended_at = NULL, heartbeat_at = clock_timestamp() WHERE id = %s",
        (sender.instance_id,),
    )
    join(db, operator, room, sender.session_id)
    assert prune(db)["memberships"] == 0
    assert sender.session_id in members(db, room)


def test_limit_bounds_instance_ending_and_membership_age_out(db, actors):
    room, first, second, _ = actors
    for actor in (first, second):
        age(db, actor, "25 hours")
    assert prune(db, limit=1)["ended_instances"] == 1
    assert prune(db, limit=1)["ended_instances"] == 1
    assert prune(db, limit=1)["ended_instances"] == 0
    for actor in (first, second):
        age(db, actor, "8 days")
    assert prune(db, limit=1)["memberships"] == 1
    assert len(members(db, room) & {first.session_id, second.session_id}) == 1
    assert prune(db, limit=1)["memberships"] == 1
    assert prune(db, limit=1)["memberships"] == 0


def test_prune_settles_items_never_handed_within_the_age_limit(db, actors):
    room, sender, target, _ = actors
    old = publish(
        db, sender, room, uuid4(), Publication(kind="question", body="stale", recipients=(target.session_id,))
    )
    fresh = publish(
        db, sender, room, uuid4(), Publication(kind="question", body="fresh", recipients=(target.session_id,))
    )
    db.execute(
        "UPDATE agent_chat.recipients SET stored_at = clock_timestamp() - interval '25 hours' WHERE message_id = %s",
        (old["id"],),
    )
    assert prune(db)["expired_undelivered"] == 1
    rows = db.execute("SELECT message_id, uncertainty_reason FROM agent_chat.recipients").fetchall()
    assert {row["message_id"]: row["uncertainty_reason"] for row in rows} == {
        old["id"]: "expired_undelivered",
        fresh["id"]: None,
    }
    assert prune(db)["expired_undelivered"] == 0


def test_a_registration_waits_for_the_event_clock_before_it_writes(database, db, actors):
    """prune takes the event clock before its membership snapshot, so a
    registration that did not take the clock could add an open instance while
    prune deletes the membership that instance relies on. The registration must
    be blocked before its session or instance writes."""
    room, _sender, target, _ = actors
    native = db.execute(
        "SELECT native_session_id FROM agent_chat.sessions WHERE id = %s", (target.session_id,)
    ).fetchone()["native_session_id"]
    db.execute(
        "UPDATE agent_chat.instances SET ended_at = clock_timestamp(), "
        "heartbeat_at = clock_timestamp() - interval '8 days' WHERE session_id = %s",
        (target.session_id,),
    )
    actor = Actor(target.principal_id, None, None)
    registration = Registration(
        native_session_id=native, boot_id=uuid4(), instance_token_hash=secrets.token_hex(32)
    )
    outcome: dict[str, object] = {}

    def run() -> None:
        try:
            with connect(database) as writer:
                outcome["registration"] = sessions.register(writer, actor, registration)
        except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
            outcome["error"] = exc

    thread = threading.Thread(target=run, name="register")
    try:
        with connect(database) as holder:
            holder.execute("BEGIN")
            holder.execute("SELECT position FROM agent_chat.event_clock WHERE singleton FOR UPDATE")
            thread.start()
            deadline = time.monotonic() + 5
            waiting = False
            while time.monotonic() < deadline:
                # The holding transaction caches the statistics snapshot otherwise.
                holder.execute("SELECT pg_stat_clear_snapshot()")
                lock_row = holder.execute(
                    "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() "
                    "AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%event_clock%'"
                ).fetchone()
                assert lock_row is not None
                waiting = lock_row["n"] > 0
                if waiting:
                    break
                time.sleep(0.01)
            assert waiting, "the registration did not wait for the event clock"
            instance_row = db.execute(
                "SELECT count(*) AS n FROM agent_chat.instances WHERE session_id = %s AND ended_at IS NULL",
                (target.session_id,),
            ).fetchone()
            assert instance_row is not None
            assert instance_row["n"] == 0, "the registration wrote its instance before taking the clock"
            holder.execute("COMMIT")
            thread.join(10)
    finally:
        if thread.is_alive():
            thread.join(10)
    assert "error" not in outcome, outcome.get("error")
    registered = outcome["registration"]
    assert isinstance(registered, dict)
    assert registered["instance_id"] is not None
    assert target.session_id in members(db, room), "the registration lost its membership"
