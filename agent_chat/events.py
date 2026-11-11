"""Clock-first mutations share one allocator; no transport or model work occurs here."""

from typing import Any, LiteralString
from uuid import UUID

from psycopg import Connection

from .models import ChatError

_SHARED = "SELECT position, retained_floor FROM agent_chat.event_clock WHERE singleton FOR SHARE"
_EXCLUSIVE = "SELECT position, retained_floor FROM agent_chat.event_clock WHERE singleton FOR UPDATE"


def _take(db: Connection[dict[str, Any]], query: LiteralString) -> dict[str, Any]:
    row = db.execute(query).fetchone()
    if row is None:
        raise ChatError("SCHEMA_MISMATCH")
    return row


def read_clock(db: Connection[dict[str, Any]]) -> dict[str, Any]:
    """Hold the clock shared: a stable position and floor through this read, with publication and pruning excluded."""
    return _take(db, _SHARED)


def lock(db: Connection[dict[str, Any]]) -> dict[str, Any]:
    """Hold the clock exclusively. Every event-writing mutation takes this before any other row lock."""
    return _take(db, _EXCLUSIVE)


def append(
    db: Connection[dict[str, Any]],
    room: UUID,
    kind: str,
    message: UUID | None = None,
    session: UUID | None = None,
    state_key: str | None = None,
) -> None:
    # The caller holds the clock before authorization and all other row locks.
    db.execute(
        """
        WITH next_event AS (
            UPDATE agent_chat.event_clock SET position = position + 1 WHERE singleton RETURNING position
        ) INSERT INTO agent_chat.events(position, room_id, kind, message_id, session_id, state_key)
          SELECT position, %s, %s, %s, %s, %s FROM next_event
    """,
        (room, kind, message, session, state_key),
    )
