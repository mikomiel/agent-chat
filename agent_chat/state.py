"""Room state: the latest observed value per key, written only by an authenticated producer.

The value is untrusted observation data, never an instruction or a grant. The table owns it; an event only
invalidates a reader's view. The server clock stamps every time, so a producer's clock is never used.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from uuid import UUID

from psycopg import Connection
from psycopg.errors import CheckViolation
from psycopg.types.json import Jsonb

from . import events
from .auth import authorize_room, lock_producer
from .models import Actor, ChatError, ProducerActor, StateUpsert


def _namespace(actor: ProducerActor, request: StateUpsert) -> None:
    prefix = f"{actor.producer}:{actor.host}:"
    resource = f"resource:{actor.host}:"
    for entry in request.entries:
        if actor.producer == "validation-lease" and (
            entry.state_key not in {prefix + name for name in ("leaf", "c1", "shared")}
            or entry.ref_key not in (None, resource + "ci-validation")
        ):
            raise ChatError("STATE_KEY_FORBIDDEN")
        if not entry.state_key.startswith(prefix) or (
            entry.ref_key is not None and not entry.ref_key.startswith(resource)
        ):
            raise ChatError("STATE_KEY_FORBIDDEN")


def upsert(db: Connection[dict[str, Any]], actor: ProducerActor, room: UUID, request: StateUpsert) -> dict[str, Any]:
    try:
        with db.transaction():
            events.lock(db)
            actor = lock_producer(db, actor, room)
            # The whole batch is refused before any row is written.
            _namespace(actor, request)
            # One reading stamps the batch, so no entry's expiry can exceed its own observation by more than its TTL.
            now = db.execute("SELECT clock_timestamp() AS now").fetchone()
            assert now is not None
            observed = now["now"]
            results: list[dict[str, Any]] = []
            for entry in sorted(request.entries, key=lambda item: item.state_key):
                expires = observed + timedelta(seconds=entry.ttl_seconds)
                value = Jsonb(entry.value)
                previous = db.execute(
                    """
                    SELECT value = %s AS same_value, ref_key IS NOT DISTINCT FROM %s AS same_ref,
                           producer_principal_id = %s AS same_producer, expires_at > %s AS fresh
                    FROM agent_chat.room_state WHERE room_id = %s AND state_key = %s FOR UPDATE
                """,
                    (value, entry.ref_key, actor.principal_id, observed, room, entry.state_key),
                ).fetchone()
                # A new key, a changed value or ref_key, a different credential, or a return from stale is a
                # change. Only an identical value on a fresh row is a silent refresh.
                changed = not (
                    previous is not None
                    and previous["fresh"]
                    and previous["same_value"]
                    and previous["same_ref"]
                    and previous["same_producer"]
                )
                if previous is None:
                    db.execute(
                        """
                        INSERT INTO agent_chat.room_state(room_id, state_key, ref_key, value, producer_principal_id,
                                                          changed_at, observed_at, expires_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                        (room, entry.state_key, entry.ref_key, value, actor.principal_id, observed, observed, expires),
                    )
                elif changed:
                    db.execute(
                        """
                        UPDATE agent_chat.room_state
                        SET ref_key = %s, value = %s, producer_principal_id = %s,
                            changed_at = %s, observed_at = %s, expires_at = %s
                        WHERE room_id = %s AND state_key = %s
                    """,
                        (entry.ref_key, value, actor.principal_id, observed, observed, expires, room, entry.state_key),
                    )
                else:
                    db.execute(
                        """
                        UPDATE agent_chat.room_state SET observed_at = %s, expires_at = %s
                        WHERE room_id = %s AND state_key = %s
                    """,
                        (observed, expires, room, entry.state_key),
                    )
                if changed:
                    events.append(db, room, "state", state_key=entry.state_key)
                results.append(
                    {"state_key": entry.state_key, "changed": changed, "observed_at": observed, "expires_at": expires}
                )
            return {"entries": results}
    except CheckViolation:
        # A value the model's size estimate admitted but the database's jsonb text form refused.
        raise ChatError("INVALID_REQUEST") from None


def read(
    db: Connection[dict[str, Any]],
    actor: Actor,
    room: UUID,
    ref_key: str | None = None,
    after_key: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Staleness, age and remaining lifetime are computed here, on the server clock, from one reading."""
    if not 1 <= limit <= 100:
        raise ChatError("INVALID_REQUEST")
    with db.transaction():
        authorize_room(db, actor, room, read=True)
        clock = db.execute("SELECT clock_timestamp() AS now").fetchone()
        assert clock is not None
        rows = db.execute(
            """
            SELECT s.state_key, s.ref_key, s.value, p.host, p.producer, s.changed_at, s.observed_at, s.expires_at,
                   GREATEST(0, floor(extract(epoch FROM s.expires_at - %(now)s)))::integer AS expires_in_seconds,
                   GREATEST(0, floor(extract(epoch FROM %(now)s - s.observed_at)))::integer AS age_seconds,
                   CASE WHEN p.revoked THEN 'revoked' WHEN s.expires_at <= %(now)s THEN 'expired' END AS stale_reason
            FROM agent_chat.room_state s JOIN agent_chat.principals p ON p.id = s.producer_principal_id
            WHERE s.room_id = %(room)s AND (%(ref)s::text IS NULL OR s.ref_key = %(ref)s)
              AND (%(after)s::text IS NULL OR s.state_key > %(after)s)
            ORDER BY s.state_key LIMIT %(limit)s
        """,
            {"now": clock["now"], "room": room, "ref": ref_key, "after": after_key, "limit": limit + 1},
        ).fetchall()
        page = rows[:limit]
        entries = []
        for row in page:
            producer = {"host": row.pop("host"), "producer": row.pop("producer")}
            entries.append({**row, "producer": producer, "stale": row["stale_reason"] is not None})
        return {
            "server_time": clock["now"],
            "entries": entries,
            "next_key": page[-1]["state_key"] if len(rows) > limit else None,
        }
