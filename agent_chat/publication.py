"""One transaction owns publication and idempotency.

Actor is an internal authentication result. This module does not authenticate
bearer tokens and must not be exposed directly as an HTTP request schema.
"""

from __future__ import annotations

import json
from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

from psycopg import Connection

from . import deliveries, events, receipts, roles
from .auth import authorize_room, member, require_current
from .models import (
    MAX_MESSAGES_PER_SESSION_HOUR,
    QUOTA_WINDOW_SECONDS,
    UNCOUNTED_KINDS,
    Actor,
    ChatError,
    Publication,
)


def _recipients(db: Connection[dict[str, Any]], room: UUID, sessions: tuple[UUID, ...]) -> None:
    for session in sessions:
        if not member(db, room, session):
            raise ChatError("INVALID_RECIPIENT")


def _conversation(
    db: Connection[dict[str, Any]],
    room: UUID,
    request: Publication,
    message_id: UUID,
) -> tuple[UUID, UUID | None, bool]:
    """Resolve the thread; also return the parent's sender, the default recipient of a reply, and whether the
    thread already existed. An existing thread's row stays locked for `_count_reply`."""
    thread_id = request.thread_id
    default_recipient = None
    if request.reply_to is not None:
        parent = db.execute(
            """
            SELECT thread_id, sender_session_id, expires_at > clock_timestamp() AS retained
            FROM agent_chat.messages WHERE id = %s AND room_id = %s FOR SHARE
        """,
            (request.reply_to, room),
        ).fetchone()
        if parent is None:
            raise ChatError("NOT_FOUND")
        if not parent["retained"]:
            raise ChatError("MESSAGE_EXPIRED")
        if thread_id is not None and thread_id != parent["thread_id"]:
            raise ChatError("INVALID_REQUEST")
        thread_id = parent["thread_id"]
        if not request.recipients:
            default_recipient = parent["sender_session_id"]
    if request.ref_key is not None:
        # Create-or-get is serialized by the event clock every publication holds exclusively. A key that
        # pruning freed finds nothing here and starts a new thread.
        keyed = db.execute(
            "SELECT id FROM agent_chat.threads WHERE room_id = %s AND ref_key = %s", (room, request.ref_key)
        ).fetchone()
        thread_id = keyed["id"] if keyed is not None else None
    if thread_id is None:
        thread_id = uuid4()
        db.execute(
            "INSERT INTO agent_chat.threads(id, room_id, root_message_id, ref_key) VALUES (%s, %s, %s, %s)",
            (thread_id, room, message_id, request.ref_key),
        )
        return thread_id, default_recipient, False
    thread = db.execute(
        """
        SELECT 1 FROM agent_chat.threads WHERE id = %s AND room_id = %s FOR UPDATE
    """,
        (thread_id, room),
    ).fetchone()
    if thread is None:
        raise ChatError("NOT_FOUND")
    return thread_id, default_recipient, True


def _count_reply(
    db: Connection[dict[str, Any]], thread_id: UUID, actor: Actor, operator: bool, recipients: tuple[UUID, ...]
) -> None:
    """Reset or count the reply against its thread's limit, judged on the participants this message leaves."""
    if operator:
        # The reset is the publication itself, not a timestamp: the count and its stamps clear together.
        db.execute("UPDATE agent_chat.threads SET agent_replies = 0, loop_stamps = '{}' WHERE id = %s", (thread_id,))
        return
    assert actor.session_id is not None
    # The thread row is locked (`_conversation`) and the event clock excludes every other publication.
    if not deliveries.consultations(db, (thread_id,), (actor.session_id, *recipients))[thread_id]["open"]:
        raise ChatError("CONSULTATION_LIMIT")
    db.execute(
        "UPDATE agent_chat.threads SET agent_replies = agent_replies + 1, "
        "loop_stamps = loop_stamps || clock_timestamp() WHERE id = %s",
        (thread_id,),
    )


def _join(db: Connection[dict[str, Any]], thread_id: UUID, actor: Actor, recipients: tuple[UUID, ...]) -> None:
    """Record the sessions this message adds to its thread: its sender, if a session, and its recipients."""
    sessions = [session for session in (actor.session_id, *recipients) if session is not None]
    # The thread row is locked (`_conversation`) or new in this transaction. Nothing is written when none is new.
    db.execute(
        """
        UPDATE agent_chat.threads
        SET participants = participants || ARRAY(
            SELECT DISTINCT member FROM unnest(%(sessions)s::uuid[]) AS member WHERE member <> ALL(participants)
        )
        WHERE id = %(thread)s AND NOT participants @> %(sessions)s::uuid[]
    """,
        {"sessions": sessions, "thread": thread_id},
    )


def _message(db: Connection[dict[str, Any]], message_id: UUID) -> dict[str, Any]:
    row = db.execute(
        """
        SELECT m.id, m.room_id, m.thread_id, m.reply_to, m.body, m.kind, m.sender_principal_id,
               m.sender_session_id, m.sender_role, m.created_at, t.ref_key AS thread_ref_key,
               t.resolved_at AS thread_resolved_at
        FROM agent_chat.messages m JOIN agent_chat.threads t ON t.id = m.thread_id
        WHERE m.id = %s AND m.expires_at > clock_timestamp() AND m.body IS NOT NULL
    """,
        (message_id,),
    ).fetchone()
    if row is None:
        raise ChatError("MESSAGE_EXPIRED")
    row["recipients"] = [
        item["session_id"]
        for item in db.execute(
            "SELECT session_id FROM agent_chat.recipients WHERE message_id = %s ORDER BY session_id",
            (message_id,),
        ).fetchall()
    ]
    return row


def request_digest(room: UUID, request: Publication) -> str:
    canonical = request.model_dump(mode="json")
    # Requests stored before migration 002 were hashed without ref_key; an unkeyed request keeps that form so a
    # replay across the upgrade still matches. Other null fields stay, as the stored digests include them.
    if canonical["ref_key"] is None:
        del canonical["ref_key"]
    # Likewise a request without the receipts opt-in (migration 007) keeps its earlier digest.
    if not canonical["receipts"]:
        del canonical["receipts"]
    return sha256(
        json.dumps(
            {"room_id": str(room), "request": canonical},
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def publish(
    db: Connection[dict[str, Any]],
    actor: Actor,
    room: UUID,
    key: UUID,
    request: Publication,
) -> dict[str, Any]:
    digest = request_digest(room, request)
    scope = actor.session_id or actor.principal_id
    with db.transaction():
        # All event-writing mutations must acquire this lock before any other row locks.
        events.lock(db)
        access = authorize_room(db, actor, room)
        operator = access == "operator"
        previous = db.execute(
            """
            SELECT digest, message_id FROM agent_chat.requests
            WHERE principal_id = %s AND scope_id = %s AND key = %s
        """,
            (actor.principal_id, scope, key),
        ).fetchone()
        if previous is not None:
            if previous["digest"] != digest:
                raise ChatError("IDEMPOTENCY_CONFLICT")
            return _message(db, previous["message_id"])
        if actor.session_id is not None:
            # The exclusive event clock already serializes every publication, so this count is exact.
            sent = db.execute(
                """
                SELECT count(*) AS n FROM agent_chat.messages
                WHERE sender_session_id = %s AND created_at > clock_timestamp() - make_interval(secs => %s)
            """,
                (actor.session_id, QUOTA_WINDOW_SECONDS),
            ).fetchone()
            assert sent is not None
            if sent["n"] >= MAX_MESSAGES_PER_SESSION_HOUR:
                raise ChatError("PUBLICATION_LIMIT")
        message_id = uuid4()
        thread_id, default_recipient, existing = _conversation(db, room, request, message_id)
        recipients = request.recipients
        # The parent's sender may have left the room since. That drops the default, not the reply.
        if default_recipient is not None and member(db, room, default_recipient):
            recipients = (default_recipient,)
        _recipients(db, room, recipients)
        # A root is never counted. Status and coordination kinds are exempt: nothing delivers them, so none drives
        # a session to answer. The final recipients decide whether the thread is direct after this message.
        if existing and request.kind not in UNCOUNTED_KINDS:
            _count_reply(db, thread_id, actor, operator, recipients)
        # Every check that can refuse for the request's own sake has run. The stamp and the mark's extension are one
        # statement; the late lease check below still rolls both back with the message.
        role = roles.stamp(db, room, actor)
        db.execute(
            """
            INSERT INTO agent_chat.messages
                (id, room_id, thread_id, reply_to, sender_principal_id, sender_session_id, kind, body,
                 receipts_requested, sender_role)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
            (
                message_id,
                room,
                thread_id,
                request.reply_to,
                actor.principal_id,
                actor.session_id,
                request.kind,
                request.body,
                request.receipts,
                role,
            ),
        )
        for recipient in recipients:
            db.execute(
                "INSERT INTO agent_chat.recipients(message_id, session_id) VALUES (%s, %s)", (message_id, recipient)
            )
        _join(db, thread_id, actor, recipients)
        db.execute(
            """
            INSERT INTO agent_chat.requests(principal_id, scope_id, key, digest, message_id)
            VALUES (%s, %s, %s, %s, %s)
        """,
            (actor.principal_id, scope, key, digest, message_id),
        )
        events.append(db, room, "message", message_id)
        if request.reply_to is not None and actor.session_id is not None:
            receipts.replied(db, actor, room, request.reply_to, message_id)
        # Recipient administration and the reply receipt can wait after room authorization. A late
        # expiry must roll back every publication record, including events and the first-reply receipt.
        require_current(db, actor, access)
        return _message(db, message_id)
