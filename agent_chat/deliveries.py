"""Durable chat reservations, not native calls or proof of model processing."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from uuid import UUID, uuid4

from psycopg import Connection

from . import events, receipts
from .auth import authorize_message_room, lock_agent, require_live
from .models import (
    BACKOFF_SECONDS,
    DELIVERY_MAX_AGE_SECONDS,
    DIRECT_REPLY_LIMIT,
    DIRECT_WAKE_LIMIT,
    LEASE_SECONDS,
    LOOP_REPLIES,
    LOOP_WINDOW_SECONDS,
    REPLY_LIMIT,
    WAKE_LIMIT,
    WAKE_WINDOW_SECONDS,
    Actor,
    ChatError,
    DeliveryClaim,
    DeliveryResult,
)

# The one judgement of a thread's consultation limit, for publication, pending and claim. `direct` is the thread's
# class (008_direct_threads.sql), counting the sessions `joining` would add; a thread that existed before the
# migration is never direct, because its participants are not known to be complete. `open` holds while its agent
# replies are below the class's limit and the loop detector has not tripped. Both read the thread row alone, never
# its messages. Every stamp is a counted reply and the detector needs LOOP_REPLIES of them, more than REPLY_LIMIT,
# so a thread that is not direct is closed by its counter first and only a direct thread can trip. Joins on `t`.
_CONSULTATION = """
    CROSS JOIN LATERAL (
        SELECT agent_chat.thread_direct(t.participants_complete, t.participants, %(joining)s::uuid[]) AS direct
    ) thread_class
    CROSS JOIN LATERAL (
        SELECT t.agent_replies < CASE WHEN thread_class.direct THEN %(direct_reply_limit)s ELSE %(reply_limit)s END
           AND NOT agent_chat.thread_loop_tripped(t.loop_stamps, %(loop_replies)s, %(loop_window)s) AS open
    ) consultation
"""


def _consultation_params(joining: Iterable[UUID] = ()) -> dict[str, Any]:
    return {
        "joining": list(joining),
        "reply_limit": REPLY_LIMIT,
        "direct_reply_limit": DIRECT_REPLY_LIMIT,
        "loop_replies": LOOP_REPLIES,
        "loop_window": LOOP_WINDOW_SECONDS,
    }


def consultations(
    db: Connection[dict[str, Any]], threads: Iterable[UUID], joining: Iterable[UUID] = ()
) -> dict[UUID, dict[str, Any]]:
    """`direct` and `open` per thread; reads only, so the caller's locks and the event clock keep it current."""
    rows = db.execute(
        "SELECT t.id, thread_class.direct, consultation.open FROM agent_chat.threads t"
        + _CONSULTATION
        + "WHERE t.id = ANY(%(threads)s::uuid[])",
        {**_consultation_params(joining), "threads": list(threads)},
    ).fetchall()
    return {row["id"]: row for row in rows}


def budget(db: Connection[dict[str, Any]], session: UUID) -> dict[str, Any]:
    """Caller holds the event clock; admissions are never refunded.

    The top level is the allowance of threads that are not direct, unchanged for older readers; `direct` nests the
    separate allowance of direct 1:1 threads in the same shape.
    """
    used = {
        row["allowance"]: row
        for row in db.execute(
            """
            SELECT allowance, count(*) AS used, min(admitted_at) + make_interval(secs => %(window)s) AS next_release_at
            FROM agent_chat.delivery_attempts
            WHERE session_id = %(session)s AND admitted_at > clock_timestamp() - make_interval(secs => %(window)s)
            GROUP BY allowance
        """,
            {"session": session, "window": WAKE_WINDOW_SECONDS},
        ).fetchall()
    }

    def allowance(name: str, limit: int, reply_limit: int) -> dict[str, Any]:
        row = used.get(name, {"used": 0, "next_release_at": None})
        return {
            "limit": limit,
            "used": row["used"],
            "remaining": max(0, limit - row["used"]),
            "next_release_at": row["next_release_at"],
            "reply_limit": reply_limit,
        }

    return {
        **allowance("other", WAKE_LIMIT, REPLY_LIMIT),
        "direct": allowance("direct", DIRECT_WAKE_LIMIT, DIRECT_REPLY_LIMIT),
    }


def pending(db: Connection[dict[str, Any]], actor: Actor) -> dict[str, Any]:
    """Read candidates, not a reservation or receipt; never advance a history cursor."""
    with db.transaction():
        events.read_clock(db)
        lock_agent(db, actor)
        assert actor.session_id is not None
        response = {"session_id": actor.session_id, "instance_id": actor.instance_id, "messages": []}
        allowances = budget(db, actor.session_id)
        open_other, open_direct = allowances["remaining"] > 0, allowances["direct"]["remaining"] > 0
        if _blocked(db, actor) or not (open_other or open_direct):
            return response
        # A candidate whose allowance is spent is dropped before the limit, so it never starves the other class.
        # A retry batch is charged as a whole: to `direct` only when every member's thread is direct now.
        rows = db.execute(
            """
            WITH eligible AS MATERIALIZED (
                SELECT r.message_id, r.delivery_batch_id, e.position, octet_length(m.body) AS body_bytes,
                       thread_class.direct
                FROM agent_chat.recipients r JOIN agent_chat.messages m ON m.id = r.message_id
                JOIN agent_chat.threads t ON t.id = m.thread_id
                JOIN agent_chat.events e ON e.message_id = m.id AND e.kind = 'message'
                JOIN agent_chat.memberships member ON member.room_id = m.room_id AND member.session_id = r.session_id
                JOIN agent_chat.principal_rooms grant_row ON grant_row.room_id = m.room_id
                                                         AND grant_row.principal_id = %(principal)s
            """
            + _CONSULTATION
            + """
                WHERE r.session_id = %(session)s AND m.kind IN ('question', 'consultation', 'reply')
                  AND m.body IS NOT NULL AND m.expires_at > clock_timestamp() AND consultation.open
                  AND r.handed_at IS NULL AND r.acknowledged_at IS NULL AND r.replying_message_id IS NULL
                  AND r.uncertainty_reason IS NULL
                  AND r.stored_at > clock_timestamp() - make_interval(secs => %(max_age)s)
            )
            SELECT eligible.message_id, eligible.body_bytes, eligible.direct, b.message_ids, batch.sizes AS batch_sizes
            FROM eligible
            LEFT JOIN agent_chat.delivery_batches b ON b.id = eligible.delivery_batch_id
            LEFT JOIN LATERAL (
                SELECT jsonb_object_agg(x.message_id::text, x.body_bytes) AS sizes, bool_and(x.direct) AS direct
                FROM eligible x WHERE x.message_id = ANY(b.message_ids)
            ) batch ON true
            LEFT JOIN LATERAL (
                SELECT outcome, ordinal, completed_at FROM agent_chat.delivery_attempts
                WHERE batch_id = b.id ORDER BY ordinal DESC LIMIT 1
            ) last ON true
            WHERE NOT EXISTS (
                SELECT 1 FROM agent_chat.delivery_attempts a JOIN agent_chat.instances i ON i.id = a.instance_id
                WHERE a.session_id = %(session)s AND a.outcome IS NULL AND a.expires_at > clock_timestamp()
                  AND i.ended_at IS NULL AND i.heartbeat_at > clock_timestamp() - make_interval(secs => %(lease)s)
            ) AND CASE WHEN COALESCE(batch.direct, eligible.direct) THEN %(open_direct)s ELSE %(open_other)s END
            AND (b.id IS NULL OR (
                last.outcome IN ('failed', 'deferred') AND last.ordinal < 3
                AND last.completed_at + make_interval(
                    secs => CASE WHEN last.ordinal = 1 THEN %(first_backoff)s ELSE %(later_backoff)s END
                ) <= clock_timestamp()
                AND NOT EXISTS (SELECT 1 FROM unnest(b.message_ids) AS item(id)
                                WHERE NOT EXISTS (SELECT 1 FROM eligible x WHERE x.message_id = item.id))
            )) ORDER BY eligible.position LIMIT 16
            """,
            {
                **_consultation_params(),
                "principal": actor.principal_id,
                "session": actor.session_id,
                "open_direct": open_direct,
                "open_other": open_other,
                "lease": LEASE_SECONDS,
                "first_backoff": BACKOFF_SECONDS[0],
                "later_backoff": BACKOFF_SECONDS[1],
                "max_age": DELIVERY_MAX_AGE_SECONDS,
            },
        ).fetchall()
        ids: list[UUID] = []
        sizes: dict[str, int] = {}
        retry = False
        direct = None
        for row in rows:
            if row["message_ids"] is not None:
                if not ids:
                    ids = row["message_ids"]
                    retry = True
                    # Every member of a retry batch is in `eligible` (the NOT EXISTS above), so it has a size.
                    sizes = {str(item): row["batch_sizes"][str(item)] for item in ids}
                break  # never mix or split an existing batch
            # A new batch never mixes allowances: the first candidate's class decides it.
            if direct is None:
                direct = row["direct"]
            elif row["direct"] != direct:
                continue
            ids.append(row["message_id"])
            sizes[str(row["message_id"])] = row["body_bytes"]
        if ids:
            # Lock selected grants; the lease, retention and age are rechecked after those waits.
            if any(row["too_old"] for row in _targets(db, actor, tuple(ids))):
                ids = []  # never split a batch; the next poll no longer selects the old item
        response["messages"] = ids
        if ids:
            # Read-only sizing for the adapter's packing; an empty answer carries nothing more.
            response["sizes"] = sizes
            response["retry"] = retry
        return response


def _blocked(db: Connection[dict[str, Any]], actor: Actor) -> bool:
    state = db.execute(
        """SELECT s.muted, i.stopped, i.plan_mode, i.native_state FROM agent_chat.sessions s
        JOIN agent_chat.instances i ON i.session_id = s.id WHERE i.id = %s""",
        (actor.instance_id,),
    ).fetchone()
    assert state is not None
    return bool(state["muted"] or state["stopped"] or state["plan_mode"] or state["native_state"] == "unknown")


def _targets(db: Connection[dict[str, Any]], actor: Actor, ids: tuple[UUID, ...]) -> list[dict[str, Any]]:
    # Resolve ownership before disclosing message existence. The clock excludes
    # publication/pruning; grant locks then protect every selected room.
    rows = db.execute(
        """
        SELECT m.*, r.delivery_batch_id, r.handed_at, r.acknowledged_at, r.replying_message_id,
               r.uncertainty_reason, e.position
        FROM agent_chat.messages m JOIN agent_chat.recipients r ON r.message_id = m.id
        LEFT JOIN agent_chat.events e ON e.message_id = m.id AND e.kind = 'message'
        WHERE m.id = ANY(%s::uuid[]) AND r.session_id = %s ORDER BY e.position, m.id
    """,
        (list(ids), actor.session_id),
    ).fetchall()
    if len(rows) != len(ids):
        raise ChatError("NOT_FOUND")
    # Each authorization rechecks the lease after its grant locks, which can block without changing any row.
    for room in sorted({row["room_id"] for row in rows}):
        authorize_message_room(db, actor, room)
    _require_retained(db, ids)
    return _recipient_state(db, actor, rows)


def _require_retained(db: Connection[dict[str, Any]], ids: tuple[UUID, ...]) -> None:
    expired = db.execute(
        "SELECT 1 FROM agent_chat.messages WHERE id = ANY(%s::uuid[]) "
        "AND (body IS NULL OR expires_at <= clock_timestamp()) LIMIT 1",
        (list(ids),),
    ).fetchone()
    if expired is not None:
        raise ChatError("MESSAGE_EXPIRED")


def _recipient_state(db: Connection[dict[str, Any]], actor: Actor, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Eligibility and age are read again after lock waits and settlement, so neither decision can be stale.
    fresh = {
        row["message_id"]: row
        for row in db.execute(
            """
            SELECT message_id, delivery_batch_id, handed_at, acknowledged_at, replying_message_id, uncertainty_reason,
                   stored_at <= clock_timestamp() - make_interval(secs => %s) AS too_old
            FROM agent_chat.recipients WHERE session_id = %s AND message_id = ANY(%s::uuid[])
        """,
            (DELIVERY_MAX_AGE_SECONDS, actor.session_id, [row["id"] for row in rows]),
        ).fetchall()
    }
    for row in rows:
        row.update({key: value for key, value in fresh[row["id"]].items() if key != "message_id"})
    return rows


def _finish(
    db: Connection[dict[str, Any]], attempt: dict[str, Any], outcome: str, reason: str | None
) -> dict[str, Any]:
    updated = db.execute(
        """
        UPDATE agent_chat.delivery_attempts SET outcome = %s, reason = %s, completed_at = clock_timestamp()
        WHERE id = %s AND outcome IS NULL RETURNING *
    """,
        (outcome, reason, attempt["id"]),
    ).fetchone()
    assert updated is not None
    changed = db.execute(
        """
        UPDATE agent_chat.recipients r SET
            handed_at = CASE WHEN %s = 'handed' THEN COALESCE(r.handed_at, %s) ELSE r.handed_at END,
            uncertainty_reason = CASE WHEN %s = 'uncertain' THEN COALESCE(r.uncertainty_reason, %s)
                                      ELSE r.uncertainty_reason END
        FROM agent_chat.messages m WHERE m.id = r.message_id AND r.delivery_batch_id = %s
          AND m.body IS NOT NULL AND m.expires_at > clock_timestamp()
        RETURNING r.message_id, r.session_id, m.room_id
    """,
        (outcome, updated["completed_at"], outcome, reason, attempt["batch_id"]),
    ).fetchall()
    for row in changed:
        events.append(db, row["room_id"], "receipt", row["message_id"], row["session_id"])
    if outcome == "handed":
        # RETURNING lists every retained member of the batch whatever the outcome; only a handoff is a receipt.
        receipts.record(db, "handed", [(row["message_id"], row["session_id"]) for row in changed])
    return updated


def reconcile(
    db: Connection[dict[str, Any]], limit: int = 100, session: UUID | None = None, instance_id: UUID | None = None
) -> None:
    """Caller holds clock first. Expired reservations are terminal, never reclaimed."""
    rows = db.execute(
        """
        SELECT a.* FROM agent_chat.delivery_attempts a JOIN agent_chat.instances i ON i.id = a.instance_id
        WHERE a.outcome IS NULL AND (a.expires_at <= clock_timestamp() OR i.ended_at IS NOT NULL)
          AND (%s::uuid IS NULL OR a.session_id = %s)
          AND (%s::uuid IS NULL OR a.instance_id = %s)
        ORDER BY a.expires_at, a.id LIMIT %s
    """,
        (session, session, instance_id, instance_id, limit),
    ).fetchall()
    for row in rows:
        _finish(db, row, "uncertain", "claim_expired")


def expire_undelivered(db: Connection[dict[str, Any]], limit: int = 100, session: UUID | None = None) -> int:
    """Caller holds clock first. Settle items past the age limit that no open attempt still covers."""
    changed = db.execute(
        """
        WITH due AS (
            SELECT r.message_id, r.session_id FROM agent_chat.recipients r
            JOIN agent_chat.messages m ON m.id = r.message_id
            WHERE m.kind IN ('question', 'consultation', 'reply')
              AND m.body IS NOT NULL AND m.expires_at > clock_timestamp()
              AND r.handed_at IS NULL AND r.acknowledged_at IS NULL AND r.replying_message_id IS NULL
              AND r.uncertainty_reason IS NULL
              AND r.stored_at <= clock_timestamp() - make_interval(secs => %(max_age)s)
              AND (%(session)s::uuid IS NULL OR r.session_id = %(session)s)
              AND NOT EXISTS (SELECT 1 FROM agent_chat.delivery_attempts a
                              WHERE a.batch_id = r.delivery_batch_id AND a.outcome IS NULL)
            ORDER BY r.stored_at, r.message_id, r.session_id LIMIT %(limit)s FOR UPDATE OF r
        )
        UPDATE agent_chat.recipients r SET uncertainty_reason = 'expired_undelivered'
        FROM due JOIN agent_chat.messages m ON m.id = due.message_id
        WHERE r.message_id = due.message_id AND r.session_id = due.session_id
        RETURNING r.message_id, r.session_id, m.room_id
    """,
        {"max_age": DELIVERY_MAX_AGE_SECONDS, "session": session, "limit": limit},
    ).fetchall()
    for row in changed:
        events.append(db, row["room_id"], "receipt", row["message_id"], row["session_id"])
    return len(changed)


def _view(attempt: dict[str, Any]) -> dict[str, Any]:
    return {
        key: attempt[key]
        for key in (
            "id",
            "batch_id",
            "instance_id",
            "ordinal",
            "admitted_at",
            "expires_at",
            "outcome",
            "reason",
            "completed_at",
        )
    }


def _claim(
    db: Connection[dict[str, Any]], actor: Actor, key: UUID, request: DeliveryClaim, rows: list[dict[str, Any]]
) -> dict[str, Any]:
    previous = db.execute(
        """
        SELECT a.*, b.message_ids FROM agent_chat.delivery_attempts a
        JOIN agent_chat.delivery_batches b ON b.id = a.batch_id
        WHERE a.session_id = %s AND a.request_key = %s
    """,
        (actor.session_id, key),
    ).fetchone()
    if previous is not None:
        if tuple(previous["message_ids"]) != request.messages:
            raise ChatError("IDEMPOTENCY_CONFLICT")
        if previous["instance_id"] != actor.instance_id:
            raise ChatError("STALE_INSTANCE")
        return {"dispatch": False, "attempt": _view(previous), "messages": []}
    if _blocked(db, actor):
        raise ChatError("DELIVERY_BLOCKED")
    if (
        db.execute(
            "SELECT 1 FROM agent_chat.delivery_attempts WHERE session_id = %s AND outcome IS NULL", (actor.session_id,)
        ).fetchone()
        is not None
    ):
        raise ChatError("DELIVERY_IN_FLIGHT")
    batches = {row["delivery_batch_id"] for row in rows}
    ordinal = 1
    if batches != {None}:
        if len(batches) != 1:
            raise ChatError("DELIVERY_BATCH_CONFLICT")
        batch_id = next(iter(batches))
        batch = db.execute("SELECT message_ids FROM agent_chat.delivery_batches WHERE id = %s", (batch_id,)).fetchone()
        # A recipient naming a batch that is gone is a stored inconsistency, not a caller error: refuse it
        # with the same code as a mismatched batch instead of letting an AssertionError become INTERNAL_ERROR.
        if batch is None or tuple(batch["message_ids"]) != request.messages:
            raise ChatError("DELIVERY_BATCH_CONFLICT")
        last = db.execute(
            """
            SELECT *, completed_at + make_interval(
                          secs => CASE WHEN ordinal = 1 THEN %s ELSE %s END
                      ) > clock_timestamp() AS backing_off
            FROM agent_chat.delivery_attempts WHERE batch_id = %s ORDER BY ordinal DESC LIMIT 1
        """,
            (*BACKOFF_SECONDS, batch_id),
        ).fetchone()
        # A batch with no attempt has nothing to continue; retention keeps one alive only while it has attempts,
        # so this is a defence-in-depth refusal rather than an assertion that would surface as INTERNAL_ERROR.
        if last is None:
            raise ChatError("DELIVERY_CLOSED")
        if last["outcome"] not in ("failed", "deferred"):
            raise ChatError("DELIVERY_CLOSED")
        if last["ordinal"] >= 3:
            raise ChatError("DELIVERY_EXHAUSTED")
        if last["backing_off"]:
            raise ChatError("DELIVERY_BACKOFF")
        ordinal = last["ordinal"] + 1
    else:
        batch_id = uuid4()
    if any(
        row["kind"] not in ("question", "consultation", "reply")
        or row["position"] is None
        or row["too_old"]
        or any(
            row[field] is not None
            for field in ("handed_at", "acknowledged_at", "replying_message_id", "uncertainty_reason")
        )
        for row in rows
    ):
        raise ChatError("DELIVERY_INELIGIBLE")
    # The exclusive event clock already orders this read after every publication; it takes no row lock.
    threads = consultations(db, {row["thread_id"] for row in rows})
    if not all(thread["open"] for thread in threads.values()):
        raise ChatError("CONSULTATION_LIMIT")
    # Charged to `direct` only when every message is in a direct thread; a mixed set is charged to `other`.
    allowance = "direct" if all(thread["direct"] for thread in threads.values()) else "other"
    assert actor.session_id is not None
    allowances = budget(db, actor.session_id)
    if (allowances["direct"] if allowance == "direct" else allowances)["remaining"] == 0:
        raise ChatError("WAKE_LIMIT")
    if ordinal == 1:
        db.execute(
            "INSERT INTO agent_chat.delivery_batches VALUES (%s, %s, %s)",
            (batch_id, actor.session_id, list(request.messages)),
        )
        db.execute(
            "UPDATE agent_chat.recipients SET delivery_batch_id = %s WHERE session_id = %s "
            "AND message_id = ANY(%s::uuid[])",
            (batch_id, actor.session_id, list(request.messages)),
        )
    attempt = db.execute(
        """
        WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
        INSERT INTO agent_chat.delivery_attempts(id, batch_id, session_id, instance_id, request_key,
                                                ordinal, admitted_at, expires_at, allowance)
        SELECT %s, %s, %s, i.id, %s, %s, instant.now,
               LEAST(instant.now + interval '30 seconds', i.heartbeat_at + make_interval(secs => %s)), %s
        FROM agent_chat.instances i CROSS JOIN instant WHERE i.id = %s AND i.ended_at IS NULL
          AND i.heartbeat_at > instant.now - make_interval(secs => %s)
        RETURNING *
    """,
        (
            uuid4(),
            batch_id,
            actor.session_id,
            key,
            ordinal,
            LEASE_SECONDS,
            allowance,
            actor.instance_id,
            LEASE_SECONDS,
        ),
    ).fetchone()
    if attempt is None:
        raise ChatError("STALE_INSTANCE")
    messages = []
    for row in rows:
        content = {key: row[key] for key in ("id", "room_id", "thread_id", "reply_to", "body", "kind", "created_at")}
        content["history_after"] = str(row["position"] - 1)
        content["sender"] = {"principal_id": row["sender_principal_id"], "session_id": row["sender_session_id"]}
        messages.append(content)
        events.append(db, row["room_id"], "receipt", row["id"], actor.session_id)
    return {"dispatch": True, "attempt": _view(attempt), "messages": messages}


def claim(db: Connection[dict[str, Any]], actor: Actor, key: UUID, request: DeliveryClaim) -> dict[str, Any]:
    with db.transaction():
        events.lock(db)
        lock_agent(db, actor)
        try:
            rows = _targets(db, actor, request.messages)
            reconcile(db, session=actor.session_id)
            expire_undelivered(db, session=actor.session_id)
            rows = _recipient_state(db, actor, rows)
            # A refusal rolls back only this admission, not expiry reconciliation.
            with db.transaction():
                return _claim(db, actor, key, request, rows)
        except ChatError as caught:
            reconcile(db, session=actor.session_id)
            expire_undelivered(db, session=actor.session_id)
            error = caught
    raise error


def result(db: Connection[dict[str, Any]], actor: Actor, attempt_id: UUID, request: DeliveryResult) -> dict[str, Any]:
    with db.transaction():
        events.lock(db)
        lock_agent(db, actor)
        try:
            attempt = db.execute(
                """
                SELECT a.*, b.message_ids FROM agent_chat.delivery_attempts a
                JOIN agent_chat.delivery_batches b ON b.id = a.batch_id
                WHERE a.id = %s AND a.session_id = %s AND a.instance_id = %s
            """,
                (attempt_id, actor.session_id, actor.instance_id),
            ).fetchone()
            if attempt is None:
                raise ChatError("NOT_FOUND")
            ids = tuple(attempt["message_ids"])
            _targets(db, actor, ids)
            # Keep expiry committed even if grant waits leave a late result refused.
            reconcile(db, session=actor.session_id)
            expire_undelivered(db, session=actor.session_id)
            current = db.execute("SELECT * FROM agent_chat.delivery_attempts WHERE id = %s", (attempt_id,)).fetchone()
            assert current is not None
            if current["outcome"] is not None:
                if (current["outcome"], current["reason"]) != (request.outcome, request.reason):
                    raise ChatError("DELIVERY_CLOSED")
                return _view(current)
            # A refusal rolls back only this settlement, not expiry reconciliation.
            with db.transaction():
                settled = _finish(db, current, request.outcome, request.reason)
                # Its receipt's foreign-key checks can wait on row locks, such as the sender's session row.
                # Recheck lease, retention and reservation after that wait.
                require_live(db, actor)
                _require_retained(db, ids)
                reserved = db.execute(
                    "SELECT expires_at > clock_timestamp() AS reserved "
                    "FROM agent_chat.delivery_attempts WHERE id = %s",
                    (attempt_id,),
                ).fetchone()
                assert reserved is not None
                if not reserved["reserved"]:
                    raise ChatError("DELIVERY_CLOSED")
                return _view(settled)
        except ChatError as caught:
            reconcile(db, session=actor.session_id)
            expire_undelivered(db, session=actor.session_id)
            error = caught
    raise error
