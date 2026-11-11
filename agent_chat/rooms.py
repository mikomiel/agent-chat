"""Operator room administration never expands another principal's credential scope."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from psycopg import Connection

from . import roles
from .auth import authorize_room, lock_actor, require_current
from .models import LEASE_SECONDS, Actor, ChatError, RoomCreation, pr_ref_parts


def visible(db: Connection[dict[str, Any]], actor: Actor, *, read: bool = False) -> list[dict[str, Any]]:
    """Granted rooms, narrowed to joined rooms for an instance. Viewer reads must opt in."""
    with db.transaction():
        access = lock_actor(db, actor, allow_closed=True, read=read)
        granted = db.execute(
            """
            SELECT r.id, r.slug, r.label FROM agent_chat.rooms r
            JOIN agent_chat.principal_rooms pr ON pr.room_id = r.id
            WHERE pr.principal_id = %s ORDER BY r.slug FOR SHARE OF r, pr
        """,
            (actor.principal_id,),
        ).fetchall()
        if access in ("operator", "viewer"):
            require_current(db, actor, access)
            return granted
        # Keep grant-before-membership lock order, as authorize_room does. A stream
        # batch must not lose its authorization between listing rooms and reading events.
        memberships = db.execute(
            "SELECT room_id FROM agent_chat.memberships WHERE session_id = %s FOR SHARE", (actor.session_id,)
        ).fetchall()
        # Grant and membership locks can block; refuse an expired lease only once they are held.
        require_current(db, actor, access)
        joined = {row["room_id"] for row in memberships}
        return [row for row in granted if row["id"] in joined]


def create(db: Connection[dict[str, Any]], actor: Actor, request: RoomCreation) -> dict[str, Any]:
    with db.transaction():
        access = lock_actor(db, actor)
        if access != "operator":
            raise ChatError("SESSION_FORBIDDEN")
        created = db.execute(
            """
            INSERT INTO agent_chat.rooms(id, slug, label) VALUES (%s, %s, %s)
            ON CONFLICT (slug) DO NOTHING RETURNING id, slug, label
        """,
            (uuid4(), request.slug, request.label),
        ).fetchone()
        if created is not None:
            db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (actor.principal_id, created["id"]))
            require_current(db, actor, access)
            return created
        existing = db.execute(
            """
            SELECT r.id, r.slug, r.label FROM agent_chat.rooms r
            JOIN agent_chat.principal_rooms pr ON pr.room_id = r.id
            WHERE r.slug = %s AND pr.principal_id = %s AND r.label = %s
        """,
            (request.slug, actor.principal_id, request.label),
        ).fetchone()
        require_current(db, actor, access)
        if existing is None:
            raise ChatError("ROOM_CONFLICT")
        return existing


def join(db: Connection[dict[str, Any]], actor: Actor, room: UUID, session: UUID) -> dict[str, Any]:
    with db.transaction():
        access = authorize_room(db, actor, room)
        if access != "operator":
            raise ChatError("SESSION_FORBIDDEN")
        permitted = db.execute(
            """
            SELECT s.id FROM agent_chat.sessions s JOIN agent_chat.principals p ON p.id = s.principal_id
            JOIN agent_chat.principal_rooms pr ON pr.principal_id = p.id
            WHERE s.id = %s AND pr.room_id = %s AND NOT p.revoked FOR SHARE OF s, p, pr
        """,
            (session, room),
        ).fetchone()
        require_current(db, actor, access)
        if permitted is None:
            raise ChatError("INVALID_RECIPIENT")
        db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s) ON CONFLICT DO NOTHING", (room, session))
        require_current(db, actor, access)
        return {"room_id": room, "session_id": session}


def participants(
    db: Connection[dict[str, Any]],
    actor: Actor,
    room: UUID,
    after: UUID | None = None,
    limit: int = 100,
    online: bool = False,
) -> dict[str, Any]:
    """Roster page by session id. `online` keeps only open instances inside the lease, before paging."""
    if not 1 <= limit <= 100:
        raise ChatError("INVALID_REQUEST")
    with db.transaction():
        authorize_room(db, actor, room, read=True)
        rows = db.execute(
            """
            SELECT s.id AS session_id, s.label, s.title, p.host, p.harness, s.native_session_id,
                   s.muted, i.id AS instance_id, i.heartbeat_at,
                   COALESCE(i.heartbeat_at > clock_timestamp() - make_interval(secs => %(lease)s), false) AS online,
                   i.native_state, i.stopped, i.plan_mode,
                   i.lane, i.lane_since,
                   floor(extract(epoch FROM clock_timestamp() - i.lane_since))::integer AS lane_age_seconds,
                   COALESCE(i.repositories, '{}'::jsonb) AS repositories,
                   (SELECT max(m.created_at) FROM agent_chat.messages m
                    WHERE m.sender_session_id = s.id AND m.room_id = %(room)s AND m.body IS NOT NULL)
                       AS last_published_at,
                   (SELECT count(*) FROM agent_chat.messages m
                    WHERE m.sender_session_id = s.id AND m.room_id = %(room)s AND m.body IS NOT NULL
                      AND m.created_at > clock_timestamp() - interval '24 hours') AS messages_24h,
                   COALESCE(announced.refs, '[]'::jsonb) AS announced_refs
            FROM agent_chat.memberships m JOIN agent_chat.sessions s ON s.id = m.session_id
            JOIN agent_chat.principals p ON p.id = s.principal_id
            JOIN agent_chat.principal_rooms pr ON pr.principal_id = p.id AND pr.room_id = m.room_id
            LEFT JOIN agent_chat.instances i ON i.session_id = s.id AND i.ended_at IS NULL
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(jsonb_build_object('ref_key', x.ref_key, 'created_at', x.created_at)
                                 ORDER BY x.created_at DESC) AS refs
                FROM (
                    SELECT t.ref_key, root.created_at
                    FROM agent_chat.threads t
                    JOIN agent_chat.messages root ON root.id = t.root_message_id
                    WHERE t.room_id = %(room)s AND t.ref_key LIKE 'pr:%%' AND root.sender_session_id = s.id
                    ORDER BY root.created_at DESC
                    LIMIT 20
                ) x
            ) announced ON true
            WHERE m.room_id = %(room)s AND NOT p.revoked AND (%(after)s::uuid IS NULL OR s.id > %(after)s)
              AND (NOT %(online)s::boolean OR COALESCE(i.heartbeat_at > clock_timestamp()
                   - make_interval(secs => %(lease)s), false))
            ORDER BY s.id LIMIT %(limit)s
        """,
            {
                "lease": LEASE_SECONDS,
                "room": room,
                "after": after,
                "online": online,
                "limit": limit + 1,
            },
        ).fetchall()
        page = rows[:limit]
        for row in page:
            announced = []
            for ref in row.pop("announced_refs") or []:
                parts = pr_ref_parts(ref["ref_key"])
                if parts is not None:
                    announced.append(
                        {
                            "ref_key": ref["ref_key"],
                            "repository": parts[0],
                            "number": parts[1],
                            "created_at": ref["created_at"],
                        }
                    )
            row["announced_prs"] = announced
            # A lapsed lease cannot resume (only a fresh join revives the session): never report its last beat.
            # The work declaration belongs to the live instance, so an offline row keeps its historical lane
            # but reports no repositories; otherwise abandoned work would look current.
            if not row["online"]:
                row["native_state"] = "unknown"
                row["stopped"] = row["plan_mode"] = True
                row["repositories"] = {}
        # The mark is a room fact: it does not depend on the page, the `online` filter or the holder's lease.
        live = roles.current_all(db, room)
        return {
            "participants": page,
            "next_session_id": page[-1]["session_id"] if len(rows) > limit else None,
            "roles": live,
            "pm": live["pm"],
        }
