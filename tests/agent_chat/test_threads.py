"""Entity-keyed threads and their resolution. Both are advisory: neither gates posting, delivery or retention."""

import json
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from agent_chat import threads
from agent_chat.models import COORDINATION_KINDS, ChatError, Publication
from agent_chat.publication import publish, request_digest
from agent_chat.retention import prune
from agent_chat.storage import connect

PR = "pr:owner/project#4638"
LANE = "lane:owner/project::de3b47545dc0-de56e9b4bbbe6341"
LEGACY_LANE = "lane:owner/project::legacy-0123456789abcdef"
RESOURCE = "resource:node-a:ci-validation"
MALFORMED = [
    "free text",
    "",
    "pr:project#12",
    "pr:owner/project#0",
    "pr:owner/project#012",
    "pr:owner/project#12\n",
    "pr:owner/project#12345678901",
    "lane:project",
    "lane:owner/project::",
    "lane:owner/project::bad_suffix",
    "resource:Node-A:ci-validation",
    "resource:node-a",
    "resource:node-a:ci:validation",
    "issue:owner/project#1",
    "pr:" + "a" * 41 + "/b#1",
]


def keyed(db, actor, room, key, kind="message", body="keyed", **fields):
    return publish(db, actor, room, uuid4(), Publication(kind=kind, body=body, ref_key=key, **fields))


def count(db, table, where="true"):
    return db.execute(f"SELECT count(*) AS n FROM agent_chat.{table} WHERE {where}").fetchone()["n"]  # noqa: S608


def thread_events(db):
    return count(db, "events", "kind = 'thread'")


def other_room(db, *principals):
    room = uuid4()
    db.execute("INSERT INTO agent_chat.rooms VALUES (%s, %s, 'Other')", (room, "other-" + room.hex[:8]))
    for principal in principals:
        db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, room))
    return room


def test_concurrent_publications_with_one_ref_key_make_one_thread(db, actors, database, lock_wait):
    room, sender, target, _ = actors
    with connect(database) as first, connect(database) as second, ThreadPoolExecutor(max_workers=1) as pool:
        with first.transaction():
            one = publish(first, sender, room, uuid4(), Publication(kind="message", body="one", ref_key=PR))
            future = pool.submit(
                publish, second, target, room, uuid4(), Publication(kind="message", body="two", ref_key=PR)
            )
            lock_wait("event_clock")
            assert not future.done()
        two = future.result(timeout=5)
    assert one["thread_id"] == two["thread_id"]
    assert count(db, "threads") == 1 and count(db, "messages") == 2
    assert one["thread_ref_key"] == two["thread_ref_key"] == PR


@pytest.mark.parametrize("key", [PR, LANE, LEGACY_LANE, RESOURCE])
@pytest.mark.parametrize("kind", ["message", "status", *COORDINATION_KINDS])
def test_each_valid_key_form_opens_and_rejoins_a_thread_for_each_allowed_kind(db, actors, key, kind):
    room, sender, target, _ = actors
    first = keyed(db, sender, room, key, kind)
    again = keyed(db, target, room, key, "message")
    assert first["thread_id"] == again["thread_id"] and first["thread_ref_key"] == key
    assert first["thread_resolved_at"] is None


@pytest.mark.parametrize("key", MALFORMED)
def test_malformed_keys_are_refused_before_storage(db, actors, http_api, credentials, key):
    with pytest.raises(ValidationError):
        Publication(kind="message", body="x", ref_key=key)
    status, body = http_api(
        "POST",
        f"/v1/rooms/{credentials.room}/messages",
        {"kind": "message", "body": "x", "ref_key": key},
        credentials.operator,
        {"Idempotency-Key": str(uuid4())},
    )
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")
    assert count(db, "messages") == 0 and count(db, "threads") == 0


@pytest.mark.parametrize(
    "fields",
    [
        {"kind": "message", "thread_id": UUID(int=1)},
        {"kind": "reply", "reply_to": UUID(int=1)},
        {"kind": "question", "recipients": (UUID(int=2),)},
        {"kind": "consultation", "recipients": (UUID(int=2),)},
    ],
)
def test_ref_key_cannot_join_another_thread_or_open_a_wake_eligible_one(db, fields):
    with pytest.raises(ValidationError):
        Publication(body="x", ref_key=PR, **fields)
    assert count(db, "threads") == 0


def test_the_same_key_in_two_rooms_is_two_threads(db, actors):
    room, sender, _, operator = actors
    elsewhere = other_room(db, sender.principal_id, operator.principal_id)
    db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (elsewhere, sender.session_id))
    first = keyed(db, sender, room, PR)
    second = keyed(db, sender, elsewhere, PR)
    assert first["thread_id"] != second["thread_id"]
    assert count(db, "threads") == 2


def test_the_same_idempotency_key_with_another_ref_key_conflicts(db, actors):
    room, sender, _, _ = actors
    key = uuid4()
    request = Publication(kind="message", body="same body", ref_key=PR)
    first = publish(db, sender, room, key, request)
    assert publish(db, sender, room, key, request) == first
    with pytest.raises(ChatError, match="^IDEMPOTENCY_CONFLICT$"):
        publish(db, sender, room, key, Publication(kind="message", body="same body", ref_key=RESOURCE))
    assert count(db, "messages") == 1


@pytest.mark.parametrize(
    ("fields", "digest"),
    [
        # Digests produced by the pre-002 server (55ca2c45) for room UUID(int=7).
        (
            {"kind": "message", "body": "same request"},
            "dea1909c95fb58529eac7931140ddd0a37ce83e77c888eaa11f827c19d19542d",
        ),
        (
            {"kind": "reply", "body": "ok", "reply_to": UUID(int=1), "recipients": (UUID(int=3), UUID(int=2))},
            "880861d7b143f473660cec8b9128618f9967c2a16c5443edd117dc57929b8ae5",
        ),
        (
            {"kind": "message", "body": "zażółć", "thread_id": UUID(int=4)},
            "e19703fccf504cc706cc22e3a6d029af162e0f9cf3c5a27d1fb63c10e17833d1",
        ),
    ],
)
def test_an_unkeyed_request_keeps_its_pre_002_digest(fields, digest):
    assert request_digest(UUID(int=7), Publication(**fields)) == digest


def test_a_ref_key_is_part_of_the_digest():
    unkeyed, pr, resource = (
        request_digest(UUID(int=7), Publication(kind="message", body="same request", ref_key=ref_key))
        for ref_key in (None, PR, RESOURCE)
    )
    assert len({unkeyed, pr, resource}) == 3


def test_a_request_stored_before_002_replays_after_the_upgrade(db, actors):
    room, sender, _, _ = actors
    key = uuid4()
    request = Publication(kind="message", body="same request")
    first = publish(db, sender, room, key, request)
    # Rewrite the stored digest the way the pre-002 server computed it: the request without a ref_key field.
    legacy = {"kind": "message", "body": "same request", "recipients": [], "thread_id": None, "reply_to": None}
    canonical = json.dumps({"room_id": str(room), "request": legacy}, sort_keys=True, separators=(",", ":"))
    db.execute("UPDATE agent_chat.requests SET digest = %s", (sha256(canonical.encode()).hexdigest(),))
    assert publish(db, sender, room, key, request) == first
    assert (count(db, "messages"), count(db, "requests"), count(db, "events", "kind = 'message'")) == (1, 1, 1)
    with pytest.raises(ChatError, match="^IDEMPOTENCY_CONFLICT$"):
        publish(db, sender, room, key, Publication(kind="message", body="same request", ref_key=PR))


def test_a_key_freed_by_pruning_starts_a_new_thread(db, actors):
    room, sender, _, _ = actors
    first = keyed(db, sender, room, PR)
    db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 hour'")
    db.execute("UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours'")
    for _ in range(3):
        prune(db)
    assert count(db, "threads") == 0
    second = keyed(db, sender, room, PR)
    assert second["thread_id"] != first["thread_id"] and second["thread_ref_key"] == PR


def test_operator_posts_reset_the_reply_counter_in_a_keyed_thread(db, actors):
    room, sender, target, operator = actors
    keyed(db, sender, room, PR)
    for _ in range(3):
        keyed(db, target, room, PR)
    assert db.execute("SELECT agent_replies FROM agent_chat.threads").fetchone()["agent_replies"] == 3
    keyed(db, operator, room, PR)
    assert db.execute("SELECT agent_replies FROM agent_chat.threads").fetchone()["agent_replies"] == 0
    assert count(db, "threads") == 1 and count(db, "messages") == 5


def test_history_by_ref_key_is_exact_and_exclusive_with_a_thread_filter(http_api, credentials, db, actors):
    room, sender, _, _ = actors
    keyed_message = keyed(db, sender, room, PR, body="in the keyed thread")
    publish(db, sender, room, uuid4(), Publication(kind="message", body="unkeyed"))
    path = f"/v1/rooms/{credentials.room}/history"
    status, page = http_api("GET", f"{path}?ref_key=" + PR.replace("#", "%23"), token=credentials.operator)
    assert status == 200
    assert [m["id"] for m in page["messages"]] == [str(keyed_message["id"])]
    assert page["messages"][0]["thread_ref_key"] == PR and page["messages"][0]["thread_resolved_at"] is None
    status, empty = http_api("GET", f"{path}?ref_key=" + RESOURCE, token=credentials.operator)
    assert status == 200 and empty["messages"] == []
    both = f"{path}?ref_key={RESOURCE}&thread_id={uuid4()}"
    assert http_api("GET", both, token=credentials.operator)[0] == 422
    assert http_api("GET", f"{path}?ref_key=free%20text", token=credentials.operator)[0] == 422


def resolve(http_api, token, thread, resolved):
    return http_api("POST", f"/v1/threads/{thread}/resolution", {"resolved": resolved}, token)


def test_resolution_appends_one_event_per_change_and_none_for_a_repeat(http_api, credentials, db, actors):
    room, sender, _, _ = actors
    thread = keyed(db, sender, room, PR)["thread_id"]
    assert thread_events(db) == 0
    status, done = resolve(http_api, credentials.operator, thread, True)
    assert status == 200 and done["resolved"] is True and done["ref_key"] == PR and done["resolved_at"]
    assert thread_events(db) == 1
    assert resolve(http_api, credentials.operator, thread, True)[1]["resolved_at"] == done["resolved_at"]
    assert thread_events(db) == 1
    row = db.execute("SELECT resolved_at, resolved_by_principal_id FROM agent_chat.threads").fetchone()
    assert row["resolved_at"] is not None and row["resolved_by_principal_id"] is not None
    assert resolve(http_api, credentials.operator, thread, False)[1]["resolved_at"] is None
    assert thread_events(db) == 2
    assert resolve(http_api, credentials.operator, thread, False)[0] == 200
    assert thread_events(db) == 2
    row = db.execute("SELECT resolved_at, resolved_by_principal_id FROM agent_chat.threads").fetchone()
    assert row["resolved_at"] is None and row["resolved_by_principal_id"] is None
    assert db.execute("SELECT message_id FROM agent_chat.events WHERE kind = 'thread'").fetchone()[
        "message_id"
    ] == db.execute("SELECT root_message_id FROM agent_chat.threads").fetchone()["root_message_id"]


def test_a_live_member_instance_may_resolve_and_the_event_records_its_session(
    http_api, credentials, db, actors, register
):
    room, sender, _, _ = actors
    token, binding = register(SimpleNamespace(request=http_api), credentials, "resolver")
    thread = keyed(db, sender, room, LANE)["thread_id"]
    assert resolve(http_api, token, thread, True)[0] == 200
    event = db.execute("SELECT session_id FROM agent_chat.events WHERE kind = 'thread'").fetchone()
    assert str(event["session_id"]) == binding["session_id"]


def test_resolution_is_hidden_from_non_members_outsiders_and_unknown_threads(db, actors, actor_factory):
    room, sender, _, operator = actors
    thread = keyed(db, sender, room, PR)["thread_id"]
    non_member = actor_factory(room)
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (non_member.session_id,))
    outsider_room = other_room(db)
    outsider = actor_factory(outsider_room)
    for actor in (non_member, outsider):
        with pytest.raises(ChatError, match="^NOT_FOUND$"):
            threads.resolve(db, actor, thread, True)
    with pytest.raises(ChatError, match="^NOT_FOUND$"):
        threads.resolve(db, operator, uuid4(), True)
    assert db.execute("SELECT resolved_at FROM agent_chat.threads").fetchone()["resolved_at"] is None
    assert thread_events(db) == 0


def test_posting_into_a_resolved_thread_succeeds_and_the_thread_stays_resolved(db, actors):
    room, sender, target, operator = actors
    thread = keyed(db, sender, room, PR)["thread_id"]
    threads.resolve(db, operator, thread, True)
    after = keyed(db, target, room, PR, body="late news")
    assert after["thread_id"] == thread and after["thread_resolved_at"] is not None
    publish(db, target, room, uuid4(), Publication(kind="message", body="plain", thread_id=thread))
    assert db.execute("SELECT resolved_at FROM agent_chat.threads").fetchone()["resolved_at"] is not None
    assert thread_events(db) == 1


def test_prune_keeps_the_root_while_its_thread_event_is_retained(db, actors):
    room, sender, _, operator = actors
    root = keyed(db, sender, room, PR)
    threads.resolve(db, operator, root["thread_id"], True)
    db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 hour'")
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours' WHERE kind = 'message'"
    )
    for _ in range(3):
        prune(db)
    assert count(db, "threads") == 1 and count(db, "messages", "body IS NULL") == 1
    db.execute("UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours'")
    for _ in range(3):
        prune(db)
    assert count(db, "threads") == 0 and count(db, "messages") == 0


def test_a_thread_event_is_streamed_as_an_invalidation_without_a_message(process_api, credentials, db, actors, event):
    room, sender, _, _ = actors
    thread = keyed(db, sender, room, PR)["thread_id"]
    cursor = db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"]
    with process_api.stream(f"/v1/events?after={cursor}", token=credentials.operator) as response:
        assert resolve(process_api.request, credentials.operator, thread, True)[0] == 200
        frame = event(response)
    assert frame["event"] == "thread"
    assert frame["data"] == {"room_id": credentials.room, "thread_id": str(thread)}
