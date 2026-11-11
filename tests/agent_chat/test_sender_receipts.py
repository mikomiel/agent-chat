"""Sender receipts (migration 007): non-waking, at most one per message, recipient and state, policy by kind."""

import json
from hashlib import sha256
from uuid import UUID, uuid4

import pytest

from agent_chat import deliveries, receipts, sessions, state
from agent_chat.auth import authenticate_producer
from agent_chat.models import (
    COORDINATION_KINDS,
    ChatError,
    DeliveryClaim,
    DeliveryResult,
    Heartbeat,
    Publication,
    ReceiptDelivery,
    StateUpsert,
)
from agent_chat.publication import publish, request_digest
from agent_chat.retention import prune

EXCLUDED_KINDS = ("status", *COORDINATION_KINDS)


@pytest.fixture
def delivery_enabled():
    return True


def ledger(db, message=None):
    """Every receipt row as (sender, state, recipient), optionally for one message."""
    rows = db.execute(
        """SELECT message_id, sender_session_id, state, recipient_session_id FROM agent_chat.sender_receipts
        ORDER BY created_at, id"""
    ).fetchall()
    return [
        (row["sender_session_id"], row["state"], row["recipient_session_id"])
        for row in rows
        if message is None or row["message_id"] == message
    ]


def wake_ledger(db):
    """Everything a wake or a delivery admission writes, per session."""
    return {
        "attempts": db.execute(
            "SELECT session_id, count(*) AS n FROM agent_chat.delivery_attempts GROUP BY session_id ORDER BY 1"
        ).fetchall(),
        "batches": db.execute("SELECT count(*) AS n FROM agent_chat.delivery_batches").fetchone()["n"],
    }


def clock(db):
    return db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"]


def ready(db, actor):
    sessions.heartbeat(db, actor, Heartbeat(native_state="idle", stopped=False, plan_mode=False))


def send(db, actor, room, kind, recipients=(), **fields):
    return publish(
        db, actor, room, uuid4(), Publication(kind=kind, body=f"synthetic {kind}", recipients=recipients, **fields)
    )


def hand(db, actor, message):
    """Claim and settle `handed`, the adapter's report that native output succeeded."""
    grant = deliveries.claim(db, actor, uuid4(), DeliveryClaim(messages=(message,)))
    assert grant["dispatch"] is True
    return deliveries.result(db, actor, grant["attempt"]["id"], DeliveryResult(outcome="handed"))


@pytest.mark.parametrize(
    ("kind", "requested", "expected"),
    [
        ("question", False, True),
        ("question", True, True),
        ("consultation", False, True),
        ("message", False, False),
        ("message", True, True),
        ("reply", False, False),
        ("reply", True, True),
        *((kind, requested, False) for kind in EXCLUDED_KINDS for requested in (False, True)),
    ],
)
def test_the_policy_by_kind(kind, requested, expected):
    assert receipts.eligible(kind, requested, uuid4()) is expected
    # An operator or browser publication has no sending session to notify.
    assert receipts.eligible(kind, requested, None) is False


def test_a_question_gets_one_handed_and_one_acked_receipt_and_nothing_wakes(db, actors):
    room, sender, target, _ = actors
    ready(db, sender)
    ready(db, target)
    question = send(db, sender, room, "question", (target.session_id,))["id"]
    assert ledger(db) == []
    hand(db, target, question)
    assert ledger(db) == [(sender.session_id, "handed", target.session_id)]
    # The receipt neither admits nor offers anything to the sender, and charges no wake budget.
    before = wake_ledger(db)
    assert [row["session_id"] for row in before["attempts"]] == [target.session_id]
    assert deliveries.budget(db, sender.session_id)["used"] == 0
    assert deliveries.pending(db, sender)["messages"] == []
    position = clock(db)
    receipts.acknowledge(db, target, question)
    assert clock(db) == position + 1  # the existing receipt event only; the ledger writes no replay event
    assert ledger(db) == [
        (sender.session_id, "handed", target.session_id),
        (sender.session_id, "acked", target.session_id),
    ]
    receipts.acknowledge(db, target, question)
    assert len(ledger(db)) == 2
    assert clock(db) == position + 1
    assert wake_ledger(db) == before
    assert deliveries.budget(db, sender.session_id)["used"] == 0
    assert deliveries.pending(db, sender)["messages"] == []


def test_a_settlement_other_than_handed_creates_no_receipt(db, actors):
    room, sender, target, _ = actors
    ready(db, target)
    question = send(db, sender, room, "question", (target.session_id,))["id"]
    grant = deliveries.claim(db, target, uuid4(), DeliveryClaim(messages=(question,)))
    assert ledger(db) == []  # a claim is a reservation, not a handoff
    deliveries.result(db, target, grant["attempt"]["id"], DeliveryResult(outcome="deferred", reason="busy"))
    assert ledger(db) == []


def test_a_plain_message_carries_receipts_only_with_the_opt_in(db, actors):
    room, sender, target, _ = actors
    plain = send(db, sender, room, "message", (target.session_id,))["id"]
    receipts.acknowledge(db, target, plain)
    assert ledger(db, plain) == []
    opted = send(db, sender, room, "message", (target.session_id,), receipts=True)["id"]
    receipts.acknowledge(db, target, opted)
    receipts.acknowledge(db, target, opted)
    assert ledger(db, opted) == [(sender.session_id, "acked", target.session_id)]


@pytest.mark.parametrize("kind", EXCLUDED_KINDS)
def test_an_excluded_kind_carries_no_receipt_even_when_opted_in(db, actors, kind):
    room, sender, target, _ = actors
    message = send(db, sender, room, kind, (target.session_id,), receipts=True)["id"]
    # The opt-in is stored as given; the policy ignores it for this kind.
    stored = db.execute("SELECT receipts_requested FROM agent_chat.messages WHERE id = %s", (message,)).fetchone()
    assert stored["receipts_requested"] is True
    receipts.acknowledge(db, target, message)
    assert ledger(db) == []


def test_each_recipient_gets_its_own_receipt(db, actors, actor_factory):
    room, sender, target, _ = actors
    other = actor_factory(room)
    question = send(db, sender, room, "question", (target.session_id, other.session_id))["id"]
    receipts.acknowledge(db, target, question)
    receipts.acknowledge(db, other, question)
    assert sorted(ledger(db, question), key=str) == sorted(
        [(sender.session_id, "acked", target.session_id), (sender.session_id, "acked", other.session_id)], key=str
    )


def test_a_reply_is_the_replied_receipt_and_its_own_opt_in_covers_only_itself(db, actors):
    room, sender, target, _ = actors
    question = send(db, sender, room, "question", (target.session_id,))["id"]
    reply = send(db, target, room, "reply", reply_to=question, receipts=True)
    # The reply itself is the `replied` receipt: no ledger row records it.
    assert ledger(db) == []
    assert reply["recipients"] == [sender.session_id]
    receipts.acknowledge(db, sender, reply["id"])
    assert ledger(db, reply["id"]) == [(target.session_id, "acked", sender.session_id)]
    assert ledger(db, question) == []


def test_an_operator_question_has_no_sender_to_notify(db, actors):
    room, _sender, target, operator = actors
    question = send(db, operator, room, "question", (target.session_id,))["id"]
    receipts.acknowledge(db, target, question)
    assert ledger(db) == []


def test_a_room_state_record_creates_no_receipt(db, actors, make_producer):
    room, _sender, _target, _ = actors
    producer = authenticate_producer(db, make_producer().token)
    entry = {"state_key": "validation-lease:node-a:leaf", "value": {"held": True}, "ttl_seconds": 60}
    state.upsert(db, producer, room, StateUpsert.model_validate({"entries": [entry]}))
    assert ledger(db) == []


def test_the_opt_in_is_part_of_the_digest_only_when_set():
    room = UUID(int=7)
    plain = request_digest(room, Publication(kind="message", body="same request"))
    explicit = request_digest(room, Publication(kind="message", body="same request", receipts=False))
    opted = request_digest(room, Publication(kind="message", body="same request", receipts=True))
    assert plain == explicit != opted
    # A request stored before migration 007 was hashed without the field; without the opt-in it still matches.
    legacy = {"kind": "message", "body": "same request", "recipients": [], "thread_id": None, "reply_to": None}
    encoded = json.dumps(
        {"room_id": str(room), "request": legacy}, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    legacy_digest = sha256(encoded.encode("utf-8")).hexdigest()
    # The digest the pre-007 code (8c36e42cc) computes for this request.
    assert legacy_digest == "dea1909c95fb58529eac7931140ddd0a37ce83e77c888eaa11f827c19d19542d"
    assert plain == legacy_digest
    assert explicit == legacy_digest
    assert opted != legacy_digest


def test_the_feed_hides_a_redacted_message_and_retention_collects_its_receipts(db, actors):
    room, sender, target, _ = actors
    question = send(db, sender, room, "question", (target.session_id,))["id"]
    receipts.acknowledge(db, target, question)
    (row,) = receipts.sender_feed(db, sender)["receipts"]
    assert row["message_id"] == question and row["state"] == "acked"
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = %s", (question,)
    )
    assert receipts.sender_feed(db, sender)["receipts"] == []
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours' WHERE message_id = %s",
        (question,),
    )
    assert prune(db)["deleted"] == 1
    assert db.execute("SELECT 1 FROM agent_chat.messages WHERE id = %s", (question,)).fetchone() is None
    assert ledger(db) == []


def test_the_feed_shows_only_rooms_the_session_may_still_read(db, actors):
    room, sender, target, _ = actors
    question = send(db, sender, room, "question", (target.session_id,))["id"]
    receipts.acknowledge(db, target, question)
    assert len(receipts.sender_feed(db, sender)["receipts"]) == 1
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (sender.session_id,))
    assert receipts.sender_feed(db, sender)["receipts"] == []
    assert len(ledger(db)) == 1  # hidden, not deleted


def test_the_feed_is_oldest_first_and_bounded(db, actors):
    room, sender, target, _ = actors
    for _ in range(receipts.RECEIPT_FEED_LIMIT + 1):
        receipts.acknowledge(db, target, send(db, sender, room, "question", (target.session_id,))["id"])
    rows = receipts.sender_feed(db, sender)["receipts"]
    assert len(rows) == receipts.RECEIPT_FEED_LIMIT
    assert [row["created_at"] for row in rows] == sorted(row["created_at"] for row in rows)
    receipts.mark_delivered(db, sender, ReceiptDelivery(receipts=tuple(row["id"] for row in rows)))
    assert len(receipts.sender_feed(db, sender)["receipts"]) == 1


def test_feed_and_delivered_marks_are_owner_scoped_and_idempotent_over_http(process_api, credentials, register, db):
    http_api = process_api.request
    sender_token, sender = register(process_api, credentials, "sender")
    target_token, target = register(process_api, credentials, "target")
    status, question = http_api(
        "POST",
        f"/v1/rooms/{credentials.room}/messages",
        {"kind": "question", "body": "synthetic", "recipients": [target["session_id"]]},
        sender_token,
        {"Idempotency-Key": str(uuid4())},
    )
    assert status == 200
    assert http_api("POST", f"/v1/messages/{question['id']}/ack", {}, target_token)[0] == 200
    status, feed = http_api("GET", "/v1/instance/receipts", token=sender_token)
    assert status == 200 and feed["session_id"] == sender["session_id"]
    assert feed["instance_id"] == sender["instance_id"]
    (row,) = feed["receipts"]
    assert set(row) == {
        "id", "message_id", "state", "recipient_session_id", "recipient_harness", "recipient_host", "created_at"
    }
    assert (row["message_id"], row["state"], row["recipient_session_id"]) == (
        question["id"], "acked", target["session_id"]
    )
    assert (row["recipient_harness"], row["recipient_host"]) == ("pi", "synthetic-host")
    # The recipient sees none of the sender's receipts and cannot mark them.
    assert http_api("GET", "/v1/instance/receipts", token=target_token)[1]["receipts"] == []
    marked = http_api("POST", "/v1/instance/receipts/delivered", {"receipts": [row["id"]]}, target_token)
    assert marked == (200, {"session_id": target["session_id"], "instance_id": target["instance_id"], "delivered": []})
    assert http_api("GET", "/v1/instance/receipts", token=sender_token)[1]["receipts"] == [row]
    # The owner marks it; a foreign or unknown ID beside it is ignored, and a repeat is the same answer.
    payload = {"receipts": [row["id"], str(uuid4())]}
    first = http_api("POST", "/v1/instance/receipts/delivered", payload, sender_token)
    assert first == (200, {"session_id": sender["session_id"], "instance_id": sender["instance_id"],
                           "delivered": [row["id"]]})
    delivered_at = db.execute("SELECT delivered_at FROM agent_chat.sender_receipts").fetchone()["delivered_at"]
    assert delivered_at is not None
    assert http_api("POST", "/v1/instance/receipts/delivered", payload, sender_token) == first
    assert db.execute("SELECT delivered_at FROM agent_chat.sender_receipts").fetchone()["delivered_at"] == delivered_at
    assert http_api("GET", "/v1/instance/receipts", token=sender_token)[1]["receipts"] == []


@pytest.mark.parametrize(
    "payload", [{}, {"receipts": []}, {"receipts": ["x"]}, {"receipts": [str(uuid4())] * 51}, {"receipts": 1},
                {"receipts": [str(uuid4())], "extra": True}],
)
def test_a_delivered_mark_is_strictly_shaped(process_api, credentials, register, payload):
    token, _ = register(process_api, credentials, "sender")
    status, body = process_api.request("POST", "/v1/instance/receipts/delivered", payload, token)
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")


def test_only_a_live_instance_reads_or_marks_receipts(http_api, credentials):
    for method, path, payload in (
        ("GET", "/v1/instance/receipts", None),
        ("POST", "/v1/instance/receipts/delivered", {"receipts": [str(uuid4())]}),
    ):
        status, body = http_api(method, path, payload, credentials.operator)
        assert (status, body["error"]["code"]) == (403, "SESSION_FORBIDDEN")
        status, body = http_api(method, path, payload, credentials.agent)
        assert (status, body["error"]["code"]) == (401, "UNAUTHENTICATED")


def test_an_ended_instance_cannot_read_its_receipts(db, actors):
    room, sender, target, _ = actors
    receipts.acknowledge(db, target, send(db, sender, room, "question", (target.session_id,))["id"])
    db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE id = %s", (sender.instance_id,))
    for call in (
        lambda: receipts.sender_feed(db, sender),
        lambda: receipts.mark_delivered(db, sender, ReceiptDelivery(receipts=(uuid4(),))),
    ):
        with pytest.raises(ChatError, match="^STALE_INSTANCE$"):
            call()
