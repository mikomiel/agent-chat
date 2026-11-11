"""Thread resolution: an advisory flag that never gates posting, delivery or retention of the thread's messages."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg import Connection

from . import events
from .auth import authorize_message_room, lock_actor, require_current
from .models import Actor, ChatError


def resolve(db: Connection[dict[str, Any]], actor: Actor, thread: UUID, resolved: bool) -> dict[str, Any]:
    with db.transaction():
        events.lock(db)
        access = lock_actor(db, actor)
        row = db.execute(
            "SELECT room_id, root_message_id FROM agent_chat.threads WHERE id = %s", (thread,)
        ).fetchone()
        if row is None:
            raise ChatError("NOT_FOUND")
        # An inaccessible thread reads as absent, never as existing.
        authorize_message_room(db, actor, row["room_id"])
        current = db.execute(
            "SELECT ref_key, resolved_at FROM agent_chat.threads WHERE id = %s FOR UPDATE", (thread,)
        ).fetchone()
        assert current is not None
        # Repeating the current value writes nothing and appends no event, as mute does.
        if (current["resolved_at"] is not None) != resolved:
            current = db.execute(
                """
                UPDATE agent_chat.threads
                SET resolved_at = CASE WHEN %s THEN clock_timestamp() END,
                    resolved_by_principal_id = CASE WHEN %s THEN %s::uuid END
                WHERE id = %s RETURNING ref_key, resolved_at
            """,
                (resolved, resolved, actor.principal_id, thread),
            ).fetchone()
            assert current is not None
            # The root message keeps the event's foreign key valid while the event is retained.
            events.append(db, row["room_id"], "thread", row["root_message_id"], actor.session_id)
        require_current(db, actor, access)
        return {
            "thread_id": thread,
            "ref_key": current["ref_key"],
            "resolved": resolved,
            "resolved_at": current["resolved_at"],
        }
