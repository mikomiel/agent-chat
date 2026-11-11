"""Token purposes and transaction-time fences shared by session and message operations."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from psycopg import Connection

from .models import LEASE_SECONDS, Actor, ChatError, ProducerActor
from .protocol import token_digest

Access = Literal["operator", "instance", "viewer"]


def authenticate(db: Connection[dict[str, Any]], token: str, *, registration: bool = False) -> Actor:
    digest = token_digest(token)
    principal = db.execute(
        """
        SELECT id FROM agent_chat.principals
        WHERE credential_hash = %s AND NOT revoked AND kind = %s
    """,
        (digest, "agent" if registration else "operator"),
    ).fetchone()
    if principal is not None:
        return Actor(principal["id"], None, None)
    if not registration:
        instance = db.execute(
            """
            SELECT p.id AS principal_id, s.id AS session_id, i.id AS instance_id
            FROM agent_chat.instances i JOIN agent_chat.sessions s ON s.id = i.session_id
            JOIN agent_chat.principals p ON p.id = s.principal_id
            WHERE i.token_hash = %s AND NOT p.revoked
              AND NOT EXISTS (SELECT 1 FROM agent_chat.principals WHERE credential_hash = %s)
        """,
            (digest, digest),
        ).fetchone()
        if instance is not None:
            return Actor(instance["principal_id"], instance["session_id"], instance["instance_id"])
    raise ChatError("UNAUTHENTICATED")


def authenticate_producer(db: Connection[dict[str, Any]], token: str) -> ProducerActor:
    """Match only a live producer credential. `authenticate` never accepts one, so a producer token reaches
    no route except the one that calls this."""
    principal = db.execute(
        """
        SELECT id, host, producer FROM agent_chat.principals
        WHERE credential_hash = %s AND kind = 'producer' AND NOT revoked
    """,
        (token_digest(token),),
    ).fetchone()
    if principal is None:
        raise ChatError("UNAUTHENTICATED")
    return ProducerActor(principal["id"], principal["host"], principal["producer"])


def lock_producer(db: Connection[dict[str, Any]], actor: ProducerActor, room: UUID) -> ProducerActor:
    """Caller holds the event clock. Lock the live principal, then its grant to the room, and return the
    identity those locked rows carry."""
    principal = db.execute(
        """
        SELECT host, producer FROM agent_chat.principals
        WHERE id = %s AND kind = 'producer' AND NOT revoked FOR SHARE
    """,
        (actor.principal_id,),
    ).fetchone()
    if principal is None:
        raise ChatError("UNAUTHENTICATED")
    allowed = db.execute(
        "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s FOR SHARE",
        (actor.principal_id, room),
    ).fetchone()
    if allowed is None:
        raise ChatError("ROOM_FORBIDDEN")
    return ProducerActor(actor.principal_id, principal["host"], principal["producer"])


def lock_actor(
    db: Connection[dict[str, Any]], actor: Actor, *, allow_closed: bool = False,
    exclusive_session: bool = False, read: bool = False,
) -> Access:
    """Caller holds a transaction; lock principal, session, then instance in that order."""
    principal = db.execute(
        "SELECT kind FROM agent_chat.principals WHERE id = %s AND NOT revoked FOR SHARE",
        (actor.principal_id,),
    ).fetchone()
    if principal is None:
        raise ChatError("UNAUTHENTICATED")
    kind = principal["kind"]
    if kind == "viewer" and not read:
        raise ChatError("SESSION_FORBIDDEN")
    if kind in ("operator", "viewer"):
        if actor.session_id is not None or actor.instance_id is not None:
            raise ChatError("SESSION_FORBIDDEN")
        if kind == "viewer" and actor.browser_session_hash is None:
            raise ChatError("UNAUTHENTICATED")
        if actor.browser_session_hash is not None:
            binding = db.execute(
                """
                SELECT token_hash FROM agent_chat.browser_sessions
                WHERE token_hash = %s AND principal_id = %s FOR UPDATE
            """,
                (actor.browser_session_hash, actor.principal_id),
            ).fetchone()
            if binding is None:
                raise ChatError("UNAUTHENTICATED")
            require_current(db, actor, kind)
        return kind
    if kind != "agent" or actor.browser_session_hash is not None:
        raise ChatError("SESSION_FORBIDDEN")
    session = db.execute(
        """
        SELECT id FROM agent_chat.sessions WHERE id = %s AND principal_id = %s
    """
        + (" FOR UPDATE" if exclusive_session else " FOR SHARE"),
        (actor.session_id, actor.principal_id),
    ).fetchone()
    if session is None:
        raise ChatError("STALE_INSTANCE")
    # Exclusive instance locking also serializes heartbeat/end without lock upgrades.
    instance = db.execute(
        """
        SELECT id FROM agent_chat.instances WHERE id = %s AND session_id = %s FOR UPDATE
    """,
        (actor.instance_id, actor.session_id),
    ).fetchone()
    if instance is None:
        raise ChatError("STALE_INSTANCE")
    if not allow_closed:
        require_live(db, actor)
    return "instance"


def require_current(db: Connection[dict[str, Any]], actor: Actor, access: Access) -> None:
    # The principal and binding are already locked. Time, unlike those rows, can change during a later wait.
    if access == "instance":
        require_live(db, actor)
    elif actor.browser_session_hash is not None:
        binding = db.execute(
            """SELECT expires_at > clock_timestamp() AS live FROM agent_chat.browser_sessions
            WHERE token_hash = %s AND principal_id = %s""",
            (actor.browser_session_hash, actor.principal_id),
        ).fetchone()
        if binding is None or not binding["live"]:
            raise ChatError("UNAUTHENTICATED")


def require_live(db: Connection[dict[str, Any]], actor: Actor) -> None:
    """Refuse an ended or expired lease. Call it after every lock wait the operation can still incur:
    a WHERE predicate on SELECT FOR UPDATE can be evaluated before its wait, so a late request could
    otherwise act on a lease that expired while it waited."""
    live = db.execute(
        """
        SELECT ended_at IS NULL AND heartbeat_at > clock_timestamp() - make_interval(secs => %s) AS live
        FROM agent_chat.instances WHERE id = %s
    """,
        (LEASE_SECONDS, actor.instance_id),
    ).fetchone()
    assert live is not None
    if not live["live"]:
        raise ChatError("STALE_INSTANCE")


def lock_agent(db: Connection[dict[str, Any]], actor: Actor, *, allow_closed: bool = False) -> None:
    """`lock_actor` for operations only an agent instance may perform."""
    if lock_actor(db, actor, allow_closed=allow_closed) != "instance":
        raise ChatError("SESSION_FORBIDDEN")


def authorize_room(db: Connection[dict[str, Any]], actor: Actor, room: UUID, *, read: bool = False) -> Access:
    """Viewer authority is opt-in for reads; every default path still refuses viewer operations.

    Always derive access from locked rows, never from a caller-supplied operator shortcut.
    """
    access = lock_actor(db, actor, allow_closed=True, read=read)
    allowed = db.execute(
        """
        SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s FOR SHARE
    """,
        (actor.principal_id, room),
    ).fetchone()
    member = (
        access in ("operator", "viewer")
        or db.execute(
            """
        SELECT 1 FROM agent_chat.memberships WHERE session_id = %s AND room_id = %s FOR SHARE
    """,
            (actor.session_id, room),
        ).fetchone()
        is not None
    )
    require_current(db, actor, access)
    if allowed is None or not member:
        raise ChatError("ROOM_FORBIDDEN")
    return access


def member(db: Connection[dict[str, Any]], room: UUID, session: UUID) -> bool:
    """Whether the session is still authorized in the room; lock the rows that say so."""
    return (
        db.execute(
            """
            SELECT s.id FROM agent_chat.sessions s
            JOIN agent_chat.principals p ON p.id = s.principal_id
            JOIN agent_chat.principal_rooms pr ON pr.principal_id = p.id
            JOIN agent_chat.memberships m ON m.session_id = s.id AND m.room_id = pr.room_id
            WHERE s.id = %s AND m.room_id = %s AND NOT p.revoked
            FOR SHARE OF s, p, pr, m
        """,
            (session, room),
        ).fetchone()
        is not None
    )


def authorize_message_room(
    db: Connection[dict[str, Any]], actor: Actor, room: UUID
) -> Access:
    """`authorize_room` for a room learned from a message ID: a refusal reads as NOT_FOUND, never as existence."""
    try:
        return authorize_room(db, actor, room)
    except ChatError as error:
        if error.code == "ROOM_FORBIDDEN":
            raise ChatError("NOT_FOUND") from None
        raise
