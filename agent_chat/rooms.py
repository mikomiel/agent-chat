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


# The row keys `fields` may name: the default row, plus keys that exist only on request.
ROSTER_FIELDS = (
    "session_id", "label", "title", "host", "harness", "native_session_id", "muted", "instance_id", "heartbeat_at",
    "online", "native_state", "stopped", "plan_mode", "lane", "lane_since", "lane_age_seconds", "repositories",
    "last_published_at", "messages_24h", "announced_prs", "last_seen_at", "recent_refs",
    "model", "recent_counterparts",
)
RECENT_REFS = 5
RECENT_COUNTERPARTS = 5


def participants(
    db: Connection[dict[str, Any]],
    actor: Actor,
    room: UUID,
    after: UUID | None = None,
    limit: int = 100,
    online: bool = False,
    *,
    sort: str = "session",
    harness: str | None = None,
    host: str | None = None,
    repository: str | None = None,
    ref: str | None = None,
    q: str | None = None,
    fields: str | None = None,
) -> dict[str, Any]:
    """Roster page. `sort="session"` pages by session id. `sort="activity"` is one page, with no continuation: live
    sessions first, then newest `last_seen_at`, then newest `last_published_at`, then session id. `online`,
    `harness`, `host`, `repository` (a live session's declared work), `ref` (published into that thread key) and `q`
    (case-insensitive substring of label or title) all filter before paging. `fields` projects the row keys;
    `last_seen_at`, `recent_refs`, `model` and `recent_counterparts` are projected on request."""
    names = None if fields is None else fields.split(",")
    if (
        not 1 <= limit <= 100
        or sort not in ("session", "activity")
        or (sort == "activity" and after is not None)
        or (names is not None and not set(names) <= set(ROSTER_FIELDS))
    ):
        raise ChatError("INVALID_REQUEST")
    activity = sort == "activity"
    order = (
        "liveness.online DESC, last_seen_at DESC NULLS LAST, last_published_at DESC NULLS LAST, s.id"
        if activity
        else "s.id"
    )
    with db.transaction():
        authorize_room(db, actor, room, read=True)
        # `ref` and `recent_refs` read messages of this room only, under the rule `feed.history` applies: unredacted
        # and unexpired, with no per-recipient filter. A reader of the room learns nothing here that history does
        # not already show. Each subquery scopes the room once, through the table it reaches first.
        rows = db.execute(
            """
            SELECT s.id AS session_id, s.label, s.title, s.model, p.host, p.harness, s.native_session_id,
                   s.muted, i.id AS instance_id, i.heartbeat_at, liveness.online,
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
                   COALESCE(announced.refs, '[]'::jsonb) AS announced_refs,
                   CASE WHEN %(seen)s::boolean THEN GREATEST(
                       (SELECT max(b.heartbeat_at) FROM agent_chat.instances b WHERE b.session_id = s.id),
                       (SELECT max(m.created_at) FROM agent_chat.messages m
                        WHERE m.sender_session_id = s.id AND m.room_id = %(room)s AND m.body IS NOT NULL)
                   ) END AS last_seen_at,
                   CASE WHEN %(refs)s::boolean THEN (
                       SELECT COALESCE(jsonb_agg(jsonb_build_object('ref_key', r.ref_key, 'last_at', r.last_at)
                                                 ORDER BY r.last_at DESC, r.ref_key), '[]'::jsonb)
                       FROM (
                           SELECT t.ref_key, max(x.created_at) AS last_at
                           FROM agent_chat.messages x JOIN agent_chat.threads t ON t.id = x.thread_id
                           WHERE x.sender_session_id = s.id AND x.room_id = %(room)s AND t.ref_key IS NOT NULL
                             AND x.body IS NOT NULL AND x.expires_at > clock_timestamp()
                           GROUP BY t.ref_key ORDER BY last_at DESC, t.ref_key LIMIT %(recent)s
                       ) r
                   ) END AS recent_refs,
                   CASE WHEN %(counterparts)s::boolean THEN (
                       SELECT COALESCE(jsonb_agg(peer ORDER BY newest DESC, peer), '[]'::jsonb)
                       FROM (
                           SELECT peer, max(x.created_at) AS newest
                           FROM (
                               SELECT r.session_id AS peer, m.id
                               FROM agent_chat.messages m JOIN agent_chat.recipients r ON r.message_id = m.id
                               WHERE m.sender_session_id = s.id
                               UNION ALL
                               SELECT m.sender_session_id, r.message_id
                               FROM agent_chat.recipients r JOIN agent_chat.messages m ON m.id = r.message_id
                               WHERE r.session_id = s.id
                               UNION ALL
                               SELECT parent.sender_session_id, reply.id
                               FROM agent_chat.messages reply
                               JOIN agent_chat.messages parent ON parent.id = reply.reply_to
                               WHERE reply.sender_session_id = s.id AND parent.body IS NOT NULL
                                 AND parent.expires_at > clock_timestamp()
                               UNION ALL
                               SELECT reply.sender_session_id, reply.id
                               FROM agent_chat.messages parent
                               JOIN agent_chat.messages reply ON reply.reply_to = parent.id
                               WHERE parent.sender_session_id = s.id AND parent.body IS NOT NULL
                                 AND parent.expires_at > clock_timestamp()
                           ) links
                           JOIN agent_chat.messages x ON x.id = links.id
                           WHERE x.room_id = %(room)s AND x.body IS NOT NULL AND x.expires_at > clock_timestamp()
                             AND peer IS NOT NULL AND peer <> s.id
                           GROUP BY peer ORDER BY newest DESC, peer LIMIT %(recent_counterparts)s
                       ) counterpart
                   ) END AS recent_counterparts
            FROM agent_chat.memberships m JOIN agent_chat.sessions s ON s.id = m.session_id
            JOIN agent_chat.principals p ON p.id = s.principal_id
            JOIN agent_chat.principal_rooms pr ON pr.principal_id = p.id AND pr.room_id = m.room_id
            LEFT JOIN agent_chat.instances i ON i.session_id = s.id AND i.ended_at IS NULL
            CROSS JOIN LATERAL (
                SELECT COALESCE(i.heartbeat_at > clock_timestamp() - make_interval(secs => %(lease)s), false) AS online
            ) liveness
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
              AND (NOT %(online)s::boolean OR liveness.online)
              AND (%(harness)s::text IS NULL OR p.harness = %(harness)s)
              AND (%(host)s::text IS NULL OR p.host = %(host)s)
              AND (%(repository)s::text IS NULL OR (liveness.online
                   AND ((i.repositories -> 'forgejo') ? %(repository)s::text
                        OR (i.repositories -> 'github') ? %(repository)s::text)))
              AND (%(ref)s::text IS NULL OR EXISTS (
                   SELECT 1 FROM agent_chat.threads t JOIN agent_chat.messages x ON x.thread_id = t.id
                   WHERE t.room_id = %(room)s AND t.ref_key = %(ref)s AND x.sender_session_id = s.id
                     AND x.body IS NOT NULL AND x.expires_at > clock_timestamp()))
              AND (%(q)s::text IS NULL OR strpos(lower(s.label), lower(%(q)s::text)) > 0
                   OR strpos(lower(COALESCE(s.title, '')), lower(%(q)s::text)) > 0)
            ORDER BY """
            + order
            + " LIMIT %(limit)s",
            {
                "lease": LEASE_SECONDS,
                "room": room,
                "after": after,
                "online": online,
                "harness": harness,
                "host": host,
                "repository": repository,
                "ref": ref,
                "q": q,
                # Computed per row only when read: by the activity order, or when `fields` names the key.
                "seen": activity or (names is not None and "last_seen_at" in names),
                "refs": names is not None and "recent_refs" in names,
                "recent": RECENT_REFS,
                "counterparts": names is not None and "recent_counterparts" in names,
                "recent_counterparts": RECENT_COUNTERPARTS,
                "limit": limit + 1,
            },
        ).fetchall()
        page = rows[:limit]
        for row in page:
            announced = []
            for ref_row in row.pop("announced_refs") or []:
                parts = pr_ref_parts(ref_row["ref_key"])
                if parts is not None:
                    announced.append(
                        {
                            "ref_key": ref_row["ref_key"],
                            "repository": parts[0],
                            "number": parts[1],
                            "created_at": ref_row["created_at"],
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
        # The activity order has no continuation: its sort key moves while a caller would page.
        next_session = page[-1]["session_id"] if len(rows) > limit and not activity else None
        # Project last: the continuation above and the offline blanking read keys the caller may not name.
        if names is None:
            for row in page:
                del row["last_seen_at"], row["recent_refs"], row["model"], row["recent_counterparts"]
        else:
            page = [{name: row[name] for name in names} for row in page]
        # The mark is a room fact: it does not depend on the page, the `online` filter or the holder's lease.
        live = roles.current_all(db, room)
        return {
            "participants": page,
            "next_session_id": next_session,
            "roles": live,
            "pm": live["pm"],
        }
