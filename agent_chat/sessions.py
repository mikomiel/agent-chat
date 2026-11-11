"""Logical sessions survive resume; a process binding never does."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from . import deliveries, events
from .auth import lock_actor, lock_agent, require_current
from .models import (
    LEASE_SECONDS,
    MAX_LIVE_INSTANCES_PER_PRINCIPAL,
    MAX_REGISTRATIONS_PER_PRINCIPAL_HOUR,
    QUOTA_WINDOW_SECONDS,
    Actor,
    ChatError,
    Heartbeat,
    LaneDeclaration,
    Registration,
    WorkDeclaration,
)
from .protocol import session_label
from .rooms import visible


def _quota(db: Connection[dict[str, Any]], principal: UUID) -> None:
    """Refuse a new instance beyond the principal's live or hourly caps; `register` holds the principal's lock."""
    live = db.execute(
        """
        SELECT count(*) AS n FROM agent_chat.instances i JOIN agent_chat.sessions s ON s.id = i.session_id
        WHERE s.principal_id = %s AND i.ended_at IS NULL
          AND i.heartbeat_at > clock_timestamp() - make_interval(secs => %s)
    """,
        (principal, LEASE_SECONDS),
    ).fetchone()
    recent = db.execute(
        """
        SELECT count(*) AS n FROM agent_chat.instances i JOIN agent_chat.sessions s ON s.id = i.session_id
        WHERE s.principal_id = %s AND i.created_at > clock_timestamp() - make_interval(secs => %s)
    """,
        (principal, QUOTA_WINDOW_SECONDS),
    ).fetchone()
    assert live is not None and recent is not None
    if live["n"] >= MAX_LIVE_INSTANCES_PER_PRINCIPAL:
        raise ChatError("INSTANCE_LIMIT")
    if recent["n"] >= MAX_REGISTRATIONS_PER_PRINCIPAL_HOUR:
        raise ChatError("REGISTRATION_LIMIT")


def register(db: Connection[dict[str, Any]], actor: Actor, request: Registration) -> dict[str, Any]:
    if actor.session_id is not None or actor.instance_id is not None:
        raise ChatError("SESSION_FORBIDDEN")
    try:
        with db.transaction():
            principal = db.execute(
                """
                SELECT host, harness FROM agent_chat.principals
                WHERE id = %s AND kind = 'agent' AND NOT revoked FOR SHARE
            """,
                (actor.principal_id,),
            ).fetchone()
            if principal is None:
                raise ChatError("UNAUTHENTICATED")
            # Shared principal locks do not exclude one another. This lock serializes one principal's registrations
            # so the quota counts are exact. It follows the principal lock and precedes every session and instance
            # lock, so no registration waits on it while holding a row its holder needs.
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended('agent_chat.register:' || %s::text, 0))",
                (actor.principal_id,),
            )
            room = db.execute(
                """
                SELECT r.id FROM agent_chat.rooms r JOIN agent_chat.principal_rooms pr ON pr.room_id = r.id
                WHERE r.slug = 'homelab' AND pr.principal_id = %s FOR SHARE OF pr
            """,
                (actor.principal_id,),
            ).fetchone()
            if room is None:
                raise ChatError("ROOM_FORBIDDEN")
            if (
                db.execute(
                    "SELECT 1 FROM agent_chat.principals WHERE credential_hash = %s", (request.instance_token_hash,)
                ).fetchone()
                is not None
            ):
                raise ChatError("BINDING_CONFLICT")
            # Prune takes the event clock before its membership snapshot, so this
            # registration takes the same lock before its session and instance
            # writes: a batch that saw no open instance cannot then delete the
            # membership the new instance relies on. Taken after the
            # grant read, not while a room grant is waited on.
            events.lock(db)
            db.execute(
                """
                INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label)
                VALUES (%s, %s, %s, %s) ON CONFLICT (principal_id, native_session_id) DO NOTHING
            """,
                (
                    uuid4(),
                    actor.principal_id,
                    request.native_session_id,
                    session_label(principal["harness"], principal["host"], request.native_session_id),
                ),
            )
            session = db.execute(
                """
                SELECT id FROM agent_chat.sessions WHERE principal_id = %s AND native_session_id = %s FOR UPDATE
            """,
                (actor.principal_id, request.native_session_id),
            ).fetchone()
            assert session is not None
            previous = db.execute(
                """
                SELECT id, token_hash, ended_at IS NULL AND
                    heartbeat_at > clock_timestamp() - make_interval(secs => %s) AS live
                FROM agent_chat.instances WHERE session_id = %s AND boot_id = %s FOR UPDATE
            """,
                (LEASE_SECONDS, session["id"], request.boot_id),
            ).fetchone()
            if previous is not None:
                if previous["token_hash"] != request.instance_token_hash:
                    raise ChatError("BINDING_CONFLICT")
                if not previous["live"]:
                    raise ChatError("STALE_INSTANCE")
                instance_id = previous["id"]
            else:
                current = db.execute(
                    """
                    SELECT id, heartbeat_at > clock_timestamp() - make_interval(secs => %s) AS live
                    FROM agent_chat.instances WHERE session_id = %s AND ended_at IS NULL FOR UPDATE
                """,
                    (LEASE_SECONDS, session["id"]),
                ).fetchone()
                if current is not None:
                    if current["live"]:
                        raise ChatError("BINDING_CONFLICT")
                    db.execute(
                        "UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE id = %s", (current["id"],)
                    )
                _quota(db, actor.principal_id)
                instance_id = uuid4()
                db.execute(
                    """
                    INSERT INTO agent_chat.instances(id, session_id, boot_id, token_hash, lane, lane_since)
                    VALUES (%s, %s, %s, %s, %s::text, CASE WHEN %s::text IS NULL THEN NULL ELSE clock_timestamp() END)
                """,
                    (
                        instance_id,
                        session["id"],
                        request.boot_id,
                        request.instance_token_hash,
                        request.lane,
                        request.lane,
                    ),
                )
            db.execute(
                "INSERT INTO agent_chat.memberships VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (room["id"], session["id"]),
            )
            return {
                "session_id": session["id"],
                "instance_id": instance_id,
                "room_id": room["id"],
                "host": principal["host"],
                "harness": principal["harness"],
            }
    except UniqueViolation:
        # A reused token hash conflicts; its value never enters an HTTP error or log.
        raise ChatError("BINDING_CONFLICT") from None


def heartbeat(db: Connection[dict[str, Any]], actor: Actor, request: Heartbeat) -> dict[str, Any]:
    with db.transaction():
        # Take the session lock exclusively up front: no SHARE-to-UPDATE upgrade
        # against concurrent heartbeat/registration. Only this live instance owns its title.
        if lock_actor(db, actor, exclusive_session="title" in request.model_fields_set) != "instance":
            raise ChatError("SESSION_FORBIDDEN")
        if "title" in request.model_fields_set:
            db.execute(
                "UPDATE agent_chat.sessions SET title = %s WHERE id = %s AND title IS DISTINCT FROM %s",
                (request.title, actor.session_id, request.title),
            )
        row = db.execute(
            """
            UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp(), native_state = %s,
                stopped = %s, plan_mode = %s WHERE id = %s
            RETURNING id AS instance_id, heartbeat_at, native_state, stopped, plan_mode
        """,
            (request.native_state, request.stopped, request.plan_mode, actor.instance_id),
        ).fetchone()
        assert row is not None
        return row


def declare_work(db: Connection[dict[str, Any]], actor: Actor, request: WorkDeclaration) -> dict[str, Any]:
    """Set or clear the live instance's advisory work map. Nothing reads it for authorization or delivery."""
    with db.transaction():
        lock_agent(db, actor)
        row = db.execute(
            """
            UPDATE agent_chat.instances SET repositories = %s::jsonb
            WHERE id = %s
            RETURNING id AS instance_id, repositories
            """,
            (Jsonb(request.repositories), actor.instance_id),
        ).fetchone()
        assert row is not None
        return row


def declare_lane(db: Connection[dict[str, Any]], actor: Actor, request: LaneDeclaration) -> dict[str, Any]:
    """Set or clear the advisory lane. Nothing reads it for authorization, delivery or admission."""
    with db.transaction():
        lock_agent(db, actor)
        # `lane_since` moves only when the value changes; a repeat keeps the declaration's age.
        row = db.execute(
            """
            UPDATE agent_chat.instances
            SET lane = %s::text,
                lane_since = CASE WHEN %s::text IS NULL THEN NULL
                                  WHEN lane IS DISTINCT FROM %s::text THEN clock_timestamp() ELSE lane_since END
            WHERE id = %s
            RETURNING id AS instance_id, lane, lane_since,
                      floor(extract(epoch FROM clock_timestamp() - lane_since))::integer AS lane_age_seconds
        """,
            (request.lane, request.lane, request.lane, actor.instance_id),
        ).fetchone()
        assert row is not None
        return row


def end(db: Connection[dict[str, Any]], actor: Actor) -> dict[str, Any]:
    with db.transaction():
        # End also settles abandoned reservations; preserve clock-first ordering.
        events.lock(db)
        # A repeated end may close only this same old binding, never its replacement.
        lock_agent(db, actor, allow_closed=True)
        row = db.execute(
            """
            UPDATE agent_chat.instances SET ended_at = COALESCE(ended_at, clock_timestamp()),
                native_state = 'unknown', stopped = true, plan_mode = true WHERE id = %s
            RETURNING id AS instance_id, ended_at
        """,
            (actor.instance_id,),
        ).fetchone()
        assert row is not None
        deliveries.reconcile(db, instance_id=actor.instance_id)
        return row


def status(db: Connection[dict[str, Any]], actor: Actor, *, delivery_enabled: bool = False) -> dict[str, Any]:
    with db.transaction():
        events.read_clock(db)
        lock_agent(db, actor)
        allowed = visible(db, actor)
        state = db.execute(
            """
            SELECT s.id AS session_id, s.label, s.title, s.muted, i.id AS instance_id,
                   i.heartbeat_at, i.native_state, i.stopped, i.plan_mode, i.lane, i.lane_since, i.repositories,
                   floor(extract(epoch FROM clock_timestamp() - i.lane_since))::integer AS lane_age_seconds,
                   i.heartbeat_at > clock_timestamp() - make_interval(secs => %s) AS online
            FROM agent_chat.sessions s JOIN agent_chat.instances i ON i.session_id = s.id
            WHERE i.id = %s
        """,
            (LEASE_SECONDS, actor.instance_id),
        ).fetchone()
        assert state is not None
        counts = db.execute(
            """
            SELECT count(*) FILTER (WHERE r.uncertainty_reason IS NULL) AS pending,
                   count(*) FILTER (WHERE r.uncertainty_reason IS NOT NULL) AS uncertain
            FROM agent_chat.recipients r JOIN agent_chat.messages m ON m.id = r.message_id
            WHERE r.session_id = %s AND m.room_id = ANY(%s::uuid[])
              AND m.body IS NOT NULL AND m.expires_at > clock_timestamp()
              AND r.acknowledged_at IS NULL AND r.replying_message_id IS NULL
        """,
            (actor.session_id, [room["id"] for room in allowed]),
        ).fetchone()
        state.update(counts or {})
        assert actor.session_id is not None
        state.update(
            rooms=allowed,
            delivery_supported=delivery_enabled,
            wake_budget=deliveries.budget(db, actor.session_id) if delivery_enabled else None,
        )
        return state


def mute(db: Connection[dict[str, Any]], actor: Actor, session: UUID, muted: bool) -> dict[str, Any]:
    with db.transaction():
        events.lock(db)
        # Self mutation needs the session UPDATE lock before the instance lock.
        # Upgrading SHARE afterwards would deadlock against a concurrent heartbeat.
        access = lock_actor(db, actor, exclusive_session=True)
        operator = access == "operator"
        if not operator and actor.session_id != session:
            raise ChatError("SESSION_FORBIDDEN")
        if operator:
            owner = db.execute("SELECT principal_id FROM agent_chat.sessions WHERE id = %s", (session,)).fetchone()
            if (
                owner is None
                or db.execute(
                    "SELECT id FROM agent_chat.principals WHERE id = %s AND NOT revoked FOR SHARE",
                    (owner["principal_id"],),
                ).fetchone()
                is None
            ):
                raise ChatError("NOT_FOUND")
        target = db.execute(
            "SELECT principal_id, muted FROM agent_chat.sessions WHERE id = %s FOR UPDATE", (session,)
        ).fetchone()
        if target is None:
            raise ChatError("NOT_FOUND")
        target_rooms = db.execute(
            """
            SELECT m.room_id FROM agent_chat.memberships m
            JOIN agent_chat.principal_rooms pr ON pr.room_id = m.room_id
            JOIN agent_chat.principals p ON p.id = pr.principal_id
            WHERE m.session_id = %s AND pr.principal_id = %s AND NOT p.revoked
            FOR SHARE OF pr, m, p
        """,
            (session, target["principal_id"]),
        ).fetchall()
        room_ids = {row["room_id"] for row in target_rooms}
        if operator:
            permitted = {row["id"] for row in visible(db, actor)}
            # This is one global session flag; partial room access cannot authorize
            # changing that flag for hidden rooms.
            if not room_ids or not room_ids.issubset(permitted):
                raise ChatError("NOT_FOUND")
        require_current(db, actor, access)
        if target["muted"] != muted:
            db.execute("UPDATE agent_chat.sessions SET muted = %s WHERE id = %s", (muted, session))
            for room in sorted(room_ids):
                events.append(db, room, "control", session=session)
        return {"session_id": session, "muted": muted}
