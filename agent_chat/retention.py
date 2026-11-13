"""Bounded maintenance transactions; no scheduler or startup side effect."""

from typing import Any

from psycopg import Connection

from . import deliveries, events
from .models import WAKE_WINDOW_SECONDS, ChatError


def prune(db: Connection[dict[str, Any]], limit: int = 100) -> dict[str, int]:
    if not 1 <= limit <= 1000:
        raise ChatError("INVALID_REQUEST")
    with db.transaction():
        clock = events.lock(db)
        # Age out memberships first so a session whose instance is ended below keeps its membership for this pass:
        # a message addressed to the session stays acceptable for a week after its last heartbeat. The 168 hours
        # (seven days) far exceed the lease; rejoining recreates the row (`INSERT ... ON CONFLICT DO NOTHING`).
        memberships = db.execute(
            """
            DELETE FROM agent_chat.memberships WHERE (room_id, session_id) IN (
                SELECT m.room_id, m.session_id FROM agent_chat.memberships m
                LEFT JOIN LATERAL (
                    SELECT max(i.heartbeat_at) AS last_seen, bool_or(i.ended_at IS NULL) AS open
                    FROM agent_chat.instances i WHERE i.session_id = m.session_id
                ) seen ON true
                WHERE NOT COALESCE(seen.open, false)
                  AND COALESCE(seen.last_seen <= clock_timestamp() - interval '168 hours', true)
                ORDER BY seen.last_seen NULLS FIRST, m.room_id, m.session_id LIMIT %s FOR UPDATE OF m
            )
        """,
            (limit,),
        ).rowcount
        # End instances whose heartbeat lapsed a day ago, before reconcile, so the same pass settles their attempts.
        # A live worker heartbeats every 30 seconds against a 90 second lease; only dead processes match.
        ended_instances = db.execute(
            """
            WITH lapsed AS (
                SELECT id FROM agent_chat.instances
                WHERE ended_at IS NULL AND heartbeat_at <= clock_timestamp() - interval '24 hours'
                ORDER BY heartbeat_at, id LIMIT %s FOR UPDATE
            ) UPDATE agent_chat.instances SET ended_at = clock_timestamp()
              WHERE id IN (SELECT id FROM lapsed) RETURNING id
        """,
            (limit,),
        ).rowcount
        reservations = deliveries.reconcile(db, limit=limit)
        expired_undelivered = deliveries.expire_undelivered(db, limit=limit)
        # Expire only a cursor prefix. A backwards wall-clock adjustment must not
        # expire a later event while silently skipping an earlier retained event.
        tail = db.execute(
            """
            SELECT position, created_at <= clock_timestamp() - interval '720 hours' AS expired
            FROM agent_chat.events ORDER BY position LIMIT %s
        """,
            (limit,),
        ).fetchall()
        floor = clock["retained_floor"]
        for event in tail:
            if not event["expired"]:
                break
            floor = event["position"]
        removed_events = db.execute("DELETE FROM agent_chat.events WHERE position <= %s", (floor,)).rowcount
        db.execute("UPDATE agent_chat.event_clock SET retained_floor = %s WHERE singleton", (floor,))
        redacted = db.execute(
            """
            WITH expired AS (
                SELECT id FROM agent_chat.messages
                WHERE expires_at <= clock_timestamp() AND body IS NOT NULL
                ORDER BY expires_at, id LIMIT %s FOR UPDATE
            ) UPDATE agent_chat.messages SET body = NULL
              WHERE id IN (SELECT id FROM expired) RETURNING id
        """,
            (limit,),
        ).fetchall()
        ids = [row["id"] for row in redacted]
        db.execute("DELETE FROM agent_chat.requests WHERE message_id = ANY(%s)", (ids,))
        db.execute("DELETE FROM agent_chat.recipients WHERE message_id = ANY(%s)", (ids,))
        # Keep admission evidence even if its message just expired. A resume or
        # prune must not refill the rolling wake budget. No content is stored here.
        removed_batches = db.execute(
            """
            DELETE FROM agent_chat.delivery_batches b WHERE b.id IN (
                SELECT candidate.id FROM agent_chat.delivery_batches candidate
                WHERE NOT EXISTS (SELECT 1 FROM agent_chat.recipients r WHERE r.delivery_batch_id = candidate.id)
                  AND NOT EXISTS (SELECT 1 FROM agent_chat.delivery_attempts a WHERE a.batch_id = candidate.id
                      AND (a.outcome IS NULL
                           OR a.admitted_at > clock_timestamp() - make_interval(secs => %s)))
                ORDER BY candidate.id LIMIT %s
            )
        """,
            (WAKE_WINDOW_SECONDS, limit),
        ).rowcount
        # Remove leaf tombstones only. A retained child or event keeps its parent.
        # Subsequent batches collect ancestors, including the final thread root.
        deleted = db.execute(
            """
            WITH leaves AS (
                SELECT m.id FROM agent_chat.messages m
                JOIN agent_chat.threads t ON t.id = m.thread_id
                WHERE m.body IS NULL
                  AND NOT EXISTS (SELECT 1 FROM agent_chat.messages child WHERE child.reply_to = m.id)
                  AND NOT EXISTS (SELECT 1 FROM agent_chat.events e WHERE e.message_id = m.id)
                  AND NOT EXISTS (SELECT 1 FROM agent_chat.recipients r WHERE r.replying_message_id = m.id)
                  AND (m.id <> t.root_message_id OR NOT EXISTS (
                      SELECT 1 FROM agent_chat.messages sibling WHERE sibling.thread_id = t.id AND sibling.id <> m.id
                  ))
                ORDER BY m.expires_at, m.id LIMIT %s FOR UPDATE OF m
            ) DELETE FROM agent_chat.messages WHERE id IN (SELECT id FROM leaves) RETURNING thread_id
        """,
            (limit,),
        ).fetchall()
        db.execute(
            """
            DELETE FROM agent_chat.threads t WHERE id = ANY(%s)
              AND NOT EXISTS (SELECT 1 FROM agent_chat.messages m WHERE m.thread_id = t.id)
        """,
            ([row["thread_id"] for row in deleted],),
        )
        # Authentication expiry is eight hours, not the conversation retention window.
        removed_browser_sessions = db.execute(
            """
            DELETE FROM agent_chat.browser_sessions WHERE token_hash IN (
                SELECT token_hash FROM agent_chat.browser_sessions
                WHERE expires_at <= clock_timestamp() ORDER BY expires_at, token_hash LIMIT %s FOR UPDATE
            )
        """,
            (limit,),
        ).rowcount
        # Room state rows are independent of events; one that expired long ago is no longer worth showing as stale.
        removed_state = db.execute(
            """
            DELETE FROM agent_chat.room_state WHERE (room_id, state_key) IN (
                SELECT room_id, state_key FROM agent_chat.room_state
                WHERE expires_at <= clock_timestamp() - interval '720 hours'
                ORDER BY expires_at, room_id, state_key LIMIT %s FOR UPDATE
            )
        """,
            (limit,),
        ).rowcount
        return {
            "events": removed_events,
            "redacted": len(redacted),
            "deleted": len(deleted),
            "ended_instances": ended_instances,
            "memberships": memberships,
            "expired_undelivered": expired_undelivered,
            # Every other progress-making operation belongs in the maintenance
            # result too; admin.prune stops on a result whose counts are all zero.
            "reservations": reservations,
            "delivery_batches": removed_batches,
            "browser_sessions": removed_browser_sessions,
            "room_state": removed_state,
        }
