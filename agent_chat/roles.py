"""Room role marks: pm (the Forgejo PM), github_pm and delivery_manager.

At most one holder per role per room and at most one live role per session. Only the operator sets or clears a
mark; a mark grants no permission, approval, ordering, lock or scheduling authority. The Forgejo PM's wire
stamp stays `pm` (the historical value, so existing messages and `--from pm` keep their meaning); the other
roles stamp their own value. A mark lapses after `ROLE_EXPIRY_HOURS` without its holder's own authenticated
publication or acknowledgement; expiry is final until the operator sets it again. Every writer holds the event
clock first, as every mutation does.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg import Connection

from . import events
from .auth import authorize_room, member, require_current
from .models import ROLE_EXPIRY_HOURS, ROLE_NAMES, ROLE_SELECTORS, Actor, ChatError

# The three storage roles; `forgejo-pm`/`forgejo_pm` are aliases of `pm`.
ROLES = ROLE_NAMES


def canonical(role: str) -> str:
    """The storage role for a selector or storage name; INVALID_REQUEST for anything else."""
    if role in ROLES:
        return role
    try:
        return ROLE_SELECTORS[role]
    except KeyError:
        raise ChatError("INVALID_REQUEST") from None


def current_all(db: Connection[dict[str, Any]], room: UUID) -> dict[str, dict[str, Any] | None]:
    """Every live mark of the room as a role-keyed map; an invalid or expired row reads as None."""
    rows = db.execute(
        """
        SELECT rr.role, rr.session_id, rr.set_at, rr.last_activity_at,
               rr.last_activity_at + make_interval(hours => %(hours)s) AS expires_at
        FROM agent_chat.room_roles rr
        JOIN agent_chat.sessions s ON s.id = rr.session_id
        JOIN agent_chat.principals p ON p.id = s.principal_id AND NOT p.revoked
        JOIN agent_chat.principal_rooms pr ON pr.principal_id = p.id AND pr.room_id = rr.room_id
        JOIN agent_chat.memberships m ON m.session_id = rr.session_id AND m.room_id = rr.room_id
        WHERE rr.room_id = %(room)s AND rr.role = ANY(%(roles)s)
          AND rr.last_activity_at > clock_timestamp() - make_interval(hours => %(hours)s)
        ORDER BY rr.role
        """,
        {"room": room, "roles": list(ROLES), "hours": ROLE_EXPIRY_HOURS},
    ).fetchall()
    fields = ("session_id", "set_at", "last_activity_at", "expires_at")
    live = {row["role"]: {key: row[key] for key in fields} for row in rows}
    return {role: live.get(role) for role in ROLES}


def current(db: Connection[dict[str, Any]], room: UUID, role: str) -> dict[str, Any] | None:
    """The live mark of one role, or None. One definition: `current_all`."""
    return current_all(db, room)[canonical(role)]


def touch(db: Connection[dict[str, Any]], room: UUID, session: UUID) -> list[str]:
    """Extend every live role `session` holds in `room`; return the roles it extended.

    The holder's authenticated publication or first acknowledgement is the only action that reaches here. The
    caller has already authorized the action; the update and the liveness test are one statement.
    """
    rows = db.execute(
        """
        UPDATE agent_chat.room_roles SET last_activity_at = clock_timestamp()
        WHERE room_id = %s AND session_id = %s
          AND last_activity_at > clock_timestamp() - make_interval(hours => %s)
        RETURNING role
        """,
        (room, session, ROLE_EXPIRY_HOURS),
    ).fetchall()
    return [row["role"] for row in rows]


def stamp(db: Connection[dict[str, Any]], room: UUID, actor: Actor) -> str | None:
    """The wire role to store on a message `actor` is publishing now, or None.

    Only server state decides it. An operator has no session and so never carries a role. One live role per
    session is enforced by `assign`, so at most one stamp can apply.
    """
    if actor.session_id is None:
        return None
    held = touch(db, room, actor.session_id)
    return held[0] if held else None


def assign(
    db: Connection[dict[str, Any]], actor: Actor, room: UUID, role: str, session: UUID
) -> dict[str, Any]:
    """Operator only: make `session` the holder of `role`, replacing that role's previous holder.

    A session that already holds a different live role is refused with ROLE_CONFLICT: the one-hop layering
    (the delivery manager coordinates the two PMs) requires one role per session.
    """
    target = canonical(role)
    with db.transaction():
        events.lock(db)
        access = authorize_room(db, actor, room)
        if access != "operator":
            raise ChatError("SESSION_FORBIDDEN")
        if not member(db, room, session):
            raise ChatError("INVALID_RECIPIENT")
        held = db.execute(
            """
            SELECT role FROM agent_chat.room_roles
            WHERE room_id = %s AND session_id = %s
              AND last_activity_at > clock_timestamp() - make_interval(hours => %s)
            FOR UPDATE
            """,
            (room, session, ROLE_EXPIRY_HOURS),
        ).fetchall()
        if any(row["role"] != target for row in held):
            raise ChatError("ROLE_CONFLICT")
        db.execute(
            """
            INSERT INTO agent_chat.room_roles (room_id, role, session_id, set_at, last_activity_at)
            SELECT %s::uuid, %s::text, %s::uuid, clock.t, clock.t
            FROM (SELECT clock_timestamp() AS t) AS clock
            ON CONFLICT (room_id, role) DO UPDATE SET
                session_id = EXCLUDED.session_id, set_at = EXCLUDED.set_at,
                last_activity_at = EXCLUDED.last_activity_at
            """,
            (room, target, session),
        )
        require_current(db, actor, access)
        return {"room_id": room, "roles": current_all(db, room)}


def clear(
    db: Connection[dict[str, Any]], actor: Actor, room: UUID, role: str, session: UUID
) -> dict[str, Any]:
    """Operator only: remove the live mark of `role`, which must be `session`'s. Anything else is NOT_FOUND."""
    target = canonical(role)
    with db.transaction():
        events.lock(db)
        access = authorize_room(db, actor, room)
        if access != "operator":
            raise ChatError("SESSION_FORBIDDEN")
        live = current(db, room, target)
        if live is None or live["session_id"] != session:
            raise ChatError("NOT_FOUND")
        db.execute(
            "DELETE FROM agent_chat.room_roles WHERE room_id = %s AND role = %s AND session_id = %s",
            (room, target, session),
        )
        require_current(db, actor, access)
        return {"room_id": room, "roles": current_all(db, room)}
