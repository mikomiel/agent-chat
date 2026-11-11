"""Recipient processing declarations are separate from transport evidence.

This module also owns sender receipts: a non-waking ledger that tells the sending session its message reached
`handed` or `acked` (migration 007). A `replied` receipt is the reply message itself and follows the wake rules.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Literal
from uuid import UUID, uuid4

from psycopg import Connection

from . import events, roles
from .auth import authorize_message_room, lock_actor, lock_agent, require_live
from .models import RECEIPT_FEED_LIMIT, Actor, ChatError, ReceiptDelivery
from .rooms import visible

# Kinds that carry sender receipts by default, and kinds that carry them only when the sender opted in.
# Every other kind (status, models.COORDINATION_KINDS) never does: this is an allowlist, so a new kind starts without.
RECEIPTS_BY_DEFAULT = ("question", "consultation")
RECEIPTS_ON_REQUEST = ("message", "reply")


def eligible(kind: str, requested: bool, sender_session: UUID | None) -> bool:
    """The one receipt policy. Callers apply it to an addressed message, so `addressed` is implied.

    An operator or browser publication has no sending session and nobody to notify.
    """
    if sender_session is None:
        return False
    return kind in RECEIPTS_BY_DEFAULT or (kind in RECEIPTS_ON_REQUEST and requested)


def record(
    db: Connection[dict[str, Any]], state: Literal["handed", "acked"], reached: Iterable[tuple[UUID, UUID]]
) -> None:
    """Record one sender receipt per (message, recipient) that just reached `state`, where the policy allows.

    Called only inside the transaction that made that state change, under the exclusive event clock. A repeat
    creates nothing (`ON CONFLICT DO NOTHING`). It writes no replay event and touches no delivery or wake ledger,
    so it can wake nothing.
    """
    pairs = list(reached)
    if not pairs:
        return
    senders = {
        row["id"]: row["sender_session_id"]
        for row in db.execute(
            "SELECT id, kind, sender_session_id, receipts_requested FROM agent_chat.messages "
            "WHERE id = ANY(%s::uuid[])",
            ([message for message, _recipient in pairs],),
        ).fetchall()
        if eligible(row["kind"], row["receipts_requested"], row["sender_session_id"])
    }
    for message, recipient in pairs:
        if message in senders:
            db.execute(
                """
                INSERT INTO agent_chat.sender_receipts(id, message_id, sender_session_id, state, recipient_session_id)
                VALUES (%s, %s, %s, %s, %s) ON CONFLICT (message_id, recipient_session_id, state) DO NOTHING
            """,
                (uuid4(), message, senders[message], state, recipient),
            )


_UNDELIVERED = """
    SELECT sr.id, sr.message_id, sr.state, sr.recipient_session_id, p.harness AS recipient_harness,
           p.host AS recipient_host, sr.created_at
    FROM agent_chat.sender_receipts sr JOIN agent_chat.messages m ON m.id = sr.message_id
    JOIN agent_chat.sessions s ON s.id = sr.recipient_session_id
    JOIN agent_chat.principals p ON p.id = s.principal_id
    WHERE sr.sender_session_id = %s AND sr.delivered_at IS NULL
      AND m.room_id = ANY(%s::uuid[]) AND m.body IS NOT NULL AND m.expires_at > clock_timestamp()
    ORDER BY sr.created_at, sr.id LIMIT %s
"""


def sender_feed(db: Connection[dict[str, Any]], actor: Actor) -> dict[str, Any]:
    """The live instance's own undelivered receipts, oldest first; reading marks nothing delivered.

    Only receipts of retained messages in rooms the session may still read are shown.
    """
    with db.transaction():
        events.read_clock(db)
        lock_agent(db, actor)
        rooms = [room["id"] for room in visible(db, actor)]
        rows = db.execute(_UNDELIVERED, (actor.session_id, rooms, RECEIPT_FEED_LIMIT)).fetchall()
        return {"session_id": actor.session_id, "instance_id": actor.instance_id, "receipts": rows}


def mark_delivered(db: Connection[dict[str, Any]], actor: Actor, request: ReceiptDelivery) -> dict[str, Any]:
    """Record that the adapter output these receipts. Idempotent; IDs of another session are ignored, not disclosed.

    `delivered` lists the requested IDs the session owns, whether this call or an earlier one marked them.
    """
    with db.transaction():
        events.read_clock(db)
        lock_agent(db, actor)
        rows = db.execute(
            """
            UPDATE agent_chat.sender_receipts SET delivered_at = COALESCE(delivered_at, clock_timestamp())
            WHERE id = ANY(%s::uuid[]) AND sender_session_id = %s RETURNING id
        """,
            (list(request.receipts), actor.session_id),
        ).fetchall()
        # The UPDATE can wait on a receipt row lock. Recheck the lease after that wait.
        require_live(db, actor)
        return {
            "session_id": actor.session_id,
            "instance_id": actor.instance_id,
            "delivered": sorted(row["id"] for row in rows),
        }


def snapshots(db: Connection[dict[str, Any]], messages: list[UUID]) -> dict[UUID, list[dict[str, Any]]]:
    # Callers supply only authorized message IDs while holding the read/write clock.
    # An unsettled claim whose reservation expired or whose instance ended is shown as the outcome
    # `deliveries.reconcile` will persist, so a dead adapter never leaves a receipt `claimed`.
    rows = db.execute(
        """
        SELECT r.message_id, r.session_id, r.stored_at, r.handed_at, r.acknowledged_at,
               r.replying_message_id, r.uncertainty_reason, s.title, p.harness, p.host, s.native_session_id,
               CASE WHEN a.id IS NOT NULL THEN jsonb_build_object(
                   'attempt', a.ordinal,
                   'outcome', CASE WHEN a.outcome IS NOT NULL THEN a.outcome
                                   WHEN a.lapsed THEN 'uncertain' ELSE 'claimed' END,
                   'reason', CASE WHEN a.outcome IS NULL AND a.lapsed THEN 'claim_expired' ELSE a.reason END
               ) END AS delivery
        FROM agent_chat.recipients r JOIN agent_chat.messages m ON m.id = r.message_id
        JOIN agent_chat.sessions s ON s.id = r.session_id
        JOIN agent_chat.principals p ON p.id = s.principal_id
        LEFT JOIN LATERAL (
            SELECT d.id, d.ordinal, d.outcome, d.reason,
                   d.expires_at <= clock_timestamp() OR i.ended_at IS NOT NULL AS lapsed
            FROM agent_chat.delivery_attempts d JOIN agent_chat.instances i ON i.id = d.instance_id
            WHERE d.batch_id = r.delivery_batch_id ORDER BY d.ordinal DESC LIMIT 1
        ) a ON true
        WHERE r.message_id = ANY(%s::uuid[]) AND m.expires_at > clock_timestamp() AND m.body IS NOT NULL
        ORDER BY r.message_id, r.session_id
    """,
        (messages,),
    ).fetchall()
    result: dict[UUID, list[dict[str, Any]]] = {}
    for row in rows:
        result.setdefault(row["message_id"], []).append(row)
    return result


def locate(db: Connection[dict[str, Any]], actor: Actor, message: UUID) -> dict[str, Any]:
    """Caller holds the clock. This mutation helper never admits viewer access or discloses hidden IDs."""
    lock_actor(db, actor)
    row = db.execute(
        """
        SELECT id, room_id, thread_id
        FROM agent_chat.messages WHERE id = %s
    """,
        (message,),
    ).fetchone()
    if row is None:
        raise ChatError("NOT_FOUND")
    authorize_message_room(db, actor, row["room_id"])
    return row


def target(db: Connection[dict[str, Any]], actor: Actor, message: UUID) -> dict[str, Any]:
    """`locate` a message that must still be retained."""
    row = locate(db, actor, message)
    # Authorization can wait for grant locks. Evaluate expiry after those waits.
    retained = db.execute(
        "SELECT body IS NOT NULL AND expires_at > clock_timestamp() AS retained "
        "FROM agent_chat.messages WHERE id = %s",
        (message,),
    ).fetchone()
    if retained is None or not retained["retained"]:
        raise ChatError("MESSAGE_EXPIRED")
    return row


def acknowledge(db: Connection[dict[str, Any]], actor: Actor, message: UUID) -> dict[str, Any]:
    with db.transaction():
        events.lock(db)
        lock_agent(db, actor)
        parent = target(db, actor, message)
        changed = db.execute(
            """
            UPDATE agent_chat.recipients SET acknowledged_at = clock_timestamp()
            WHERE message_id = %s AND session_id = %s AND acknowledged_at IS NULL
        """,
            (message, actor.session_id),
        ).rowcount
        if changed:
            assert actor.session_id is not None
            # Its foreign-key checks can wait on row locks, so it precedes the lease recheck below.
            record(db, "acked", [(message, actor.session_id)])
            # A first acknowledgement is the holder's own action in the message's room; a repeat changes nothing.
            roles.touch(db, parent["room_id"], actor.session_id)
        # The UPDATE can wait on the recipient row lock. Recheck lease and retention after that wait.
        require_live(db, actor)
        current = next(
            (row for row in snapshots(db, [message]).get(message, []) if row["session_id"] == actor.session_id), None
        )
        if current is None:
            recipient = db.execute(
                "SELECT 1 FROM agent_chat.recipients WHERE message_id = %s AND session_id = %s",
                (message, actor.session_id),
            ).fetchone()
            raise ChatError("MESSAGE_EXPIRED" if recipient else "SESSION_FORBIDDEN")
        if changed:
            events.append(db, parent["room_id"], "receipt", message, actor.session_id)
        return current


def replied(db: Connection[dict[str, Any]], actor: Actor, room: UUID, parent: UUID, reply: UUID) -> None:
    """Called only inside publication's clock-locked transaction; first reply wins."""
    changed = db.execute(
        """
        UPDATE agent_chat.recipients SET replying_message_id = %s
        WHERE message_id = %s AND session_id = %s AND replying_message_id IS NULL
    """,
        (reply, parent, actor.session_id),
    ).rowcount
    if changed:
        events.append(db, room, "receipt", parent, actor.session_id)
