"""Bounded history/event reads under the same clock fence as publication and pruning."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg import Connection

from . import events as event_store
from . import receipts
from .auth import authorize_room
from .models import ROLE_FILTER_STAMPS, Actor, ChatError
from .rooms import visible


def message_view(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    # The stored role is a fact about the sender at publication; it is shown under `sender` only when set.
    role = result.pop("sender_role", None)
    result["sender"] = {
        "principal_id": result.pop("sender_principal_id"),
        "session_id": result.pop("sender_session_id"),
        **{key: result.pop(f"sender_{key}") for key in ("title", "harness", "host", "native_session_id")
           if f"sender_{key}" in result},
        **({} if role is None else {"role": role}),
    }
    return result


def _check_cursor(after: int, clock: dict[str, Any]) -> None:
    if after < clock["retained_floor"]:
        raise ChatError("CURSOR_EXPIRED")
    if after > clock["position"]:
        raise ChatError("INVALID_CURSOR")


_MESSAGES = """
    SELECT e.position, m.id, m.room_id, m.thread_id, m.reply_to, m.body, m.kind,
           m.sender_principal_id, m.sender_session_id, m.sender_role, m.created_at,
           sender.title AS sender_title, sender.native_session_id AS sender_native_session_id,
           principal.harness AS sender_harness, principal.host AS sender_host,
           t.ref_key AS thread_ref_key, t.resolved_at AS thread_resolved_at,
           ARRAY(SELECT r.session_id FROM agent_chat.recipients r
                 WHERE r.message_id = m.id ORDER BY r.session_id) AS recipients
    FROM agent_chat.events e JOIN agent_chat.messages m ON m.id = e.message_id
    JOIN agent_chat.threads t ON t.id = m.thread_id
    LEFT JOIN agent_chat.sessions sender ON sender.id = m.sender_session_id
    JOIN agent_chat.principals principal ON principal.id = m.sender_principal_id
    WHERE e.kind = 'message' AND e.room_id = %s AND e.position > %s AND e.position < %s
      AND m.body IS NOT NULL AND m.expires_at > clock_timestamp()
      AND (%s::uuid IS NULL OR m.thread_id = %s) AND (%s::text IS NULL OR t.ref_key = %s)
      AND (%s::text IS NULL OR m.sender_role = %s)
"""
_OLDEST_FIRST = _MESSAGES + " ORDER BY e.position LIMIT %s"
_NEWEST_FIRST = _MESSAGES + " ORDER BY e.position DESC LIMIT %s"
_NO_UPPER_BOUND = 9223372036854775807
EVENT_PAGE = 16


def history(
    db: Connection[dict[str, Any]],
    actor: Actor,
    room: UUID,
    after: int | None = None,
    limit: int = 100,
    thread: UUID | None = None,
    before: int | None = None,
    ref_key: str | None = None,
    sender_role: str | None = None,
) -> dict[str, Any]:
    """Forward pages start at `after` (default: the retained floor). A `before` page holds the newest
    messages below that cursor, in commit order; a cursor above the clock reads the newest page. `sender_role`
    keeps only the messages the service stamped with that role."""
    exclusive = (after is not None and before is not None) or (thread is not None and ref_key is not None)
    if not 1 <= limit <= 100 or exclusive:
        raise ChatError("INVALID_REQUEST")
    stamp = None
    if sender_role is not None:
        stamp = ROLE_FILTER_STAMPS.get(sender_role)
        if stamp is None:
            raise ChatError("INVALID_REQUEST")
    with db.transaction():
        clock = event_store.read_clock(db)
        authorize_room(db, actor, room, read=True)
        start = clock["retained_floor"] if after is None else after
        _check_cursor(start, clock)
        rows = db.execute(
            _OLDEST_FIRST if before is None else _NEWEST_FIRST,
            (
                room, start, _NO_UPPER_BOUND if before is None else before,
                thread, thread, ref_key, ref_key, stamp, stamp, limit + 1,
            ),
        ).fetchall()
        more = len(rows) > limit
        page = rows[:limit]
        if before is not None:
            page.reverse()
        # A forward page continues after its last row; a `before` page continues before its first, whether or
        # not more rows follow. Only an exhausted forward page names the clock, which reads as "caught up". A
        # `before` page must never answer with the forward head, or a caller paging backwards would re-read the
        # newest page instead of stopping.
        if before is not None:
            next_cursor = page[0]["position"] if page else clock["position"]
        else:
            next_cursor = page[-1]["position"] if more else clock["position"]
        receipt_rows = receipts.snapshots(db, [row["id"] for row in page])
        for row in page:
            row["cursor"] = str(row.pop("position"))
            row["receipts"] = receipt_rows.get(row["id"], [])
        return {
            "messages": [message_view(row) for row in page],
            "next_cursor": str(next_cursor),
            "retained_floor": str(clock["retained_floor"]),
            "position": str(clock["position"]),
            "has_more": more,
        }


def events(
    db: Connection[dict[str, Any]], actor: Actor, after: int, expected_rooms: tuple[UUID, ...] | None = None
) -> dict[str, Any]:
    with db.transaction():
        clock = event_store.read_clock(db)
        allowed = tuple(sorted(row["id"] for row in visible(db, actor, read=True)))
        if expected_rooms is not None and allowed != expected_rooms:
            # A new room may contain history older than this cursor. Close on additions too.
            raise ChatError("ROOM_SCOPE_CHANGED")
        _check_cursor(after, clock)
        rows = db.execute(
            """
            SELECT e.position, e.kind AS event_kind, e.room_id AS event_room, e.message_id,
                   e.session_id AS event_session,
                   CASE WHEN EXISTS (
                       SELECT 1 FROM agent_chat.memberships member
                       JOIN agent_chat.principal_rooms grant_row ON grant_row.room_id = member.room_id
                       JOIN agent_chat.principals principal ON principal.id = grant_row.principal_id
                       WHERE member.session_id = s.id AND member.room_id = e.room_id
                         AND grant_row.principal_id = s.principal_id AND NOT principal.revoked
                   ) THEN s.muted END AS current_muted,
                   e.state_key AS event_state_key, state.ref_key AS state_ref_key,
                   t.ref_key AS thread_ref_key, t.resolved_at AS thread_resolved_at,
                   m.id, m.room_id, m.thread_id, m.reply_to, m.kind,
                   CASE WHEN m.expires_at > clock_timestamp() THEN m.body ELSE NULL END AS body,
                   m.sender_principal_id, m.sender_session_id, m.sender_role, m.created_at,
                   sender.title AS sender_title, sender.native_session_id AS sender_native_session_id,
                   principal.harness AS sender_harness, principal.host AS sender_host,
                   ARRAY(SELECT r.session_id FROM agent_chat.recipients r
                         WHERE r.message_id = m.id ORDER BY r.session_id) AS recipients
            FROM agent_chat.events e LEFT JOIN agent_chat.messages m ON m.id = e.message_id
            LEFT JOIN agent_chat.sessions s ON s.id = e.session_id
            LEFT JOIN agent_chat.sessions sender ON sender.id = m.sender_session_id
            LEFT JOIN agent_chat.principals principal ON principal.id = m.sender_principal_id
            LEFT JOIN agent_chat.threads t ON t.id = m.thread_id
            LEFT JOIN agent_chat.room_state state ON state.room_id = e.room_id AND state.state_key = e.state_key
            WHERE e.room_id = ANY(%s::uuid[]) AND e.position > %s ORDER BY e.position LIMIT %s
        """,
            (list(allowed), after, EVENT_PAGE),
        ).fetchall()
        receipt_rows = receipts.snapshots(db, [row["message_id"] for row in rows if row["message_id"] is not None])
        result: list[dict[str, Any]] = []
        for row in rows:
            position, kind, room, message_id = (
                row.pop(k) for k in ("position", "event_kind", "event_room", "message_id")
            )
            session, muted = row.pop("event_session"), row.pop("current_muted")
            state_key, state_ref = row.pop("event_state_key"), row.pop("state_ref_key")
            data = {"room_id": room, "message_id": message_id}
            if kind == "state":
                # An invalidation only: the value is read from the state table, never from the replay log. The key
                # may no longer exist (pruned), in which case it has no ref_key to report.
                data = {"room_id": room, "state_key": state_key, "ref_key": state_ref}
            elif kind == "thread":
                data = {"room_id": room, "thread_id": row["thread_id"]}
            elif kind == "message":
                row["receipts"] = receipt_rows.get(message_id, [])
                data["message"] = message_view(row) if row["body"] is not None else None
            elif kind == "receipt":
                data.update(
                    session_id=session,
                    receipt=next(
                        (item for item in receipt_rows.get(message_id, []) if item["session_id"] == session), None
                    ),
                )
            else:
                data.update(session_id=session, muted=muted)
            result.append({"id": str(position), "event": kind, "data": data})
        # Advancing the in-memory scan over inaccessible rooms is safe; reconnect may
        # repeat that scan. Only actual durable events receive an SSE id on the wire.
        full = len(rows) == EVENT_PAGE
        next_cursor = int(result[-1]["id"]) if full else clock["position"]
        # A full page means the reader is behind: it should read the next page at once.
        return {"events": result, "next_cursor": next_cursor, "rooms": allowed, "full": full}
