"""Opaque browser sessions and purpose-separated CSRF values; no browser credential storage."""

from __future__ import annotations

import hmac
import re
import secrets
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any, Literal

from psycopg import Connection

from .auth import lock_actor
from .models import Actor, ChatError
from .protocol import token_digest

SESSION_COOKIE = "__Host-agent-chat-session"
LOGIN_COOKIE = "__Host-agent-chat-login"
SESSION_SECONDS = 28800
VIEWER_SESSION_SECONDS = 600


@dataclass(frozen=True)
class LoginSession:
    token: str = field(repr=False)
    access: Literal["operator", "viewer"]
    expires_in: int


def csrf(token: str) -> str:
    token_digest(token)
    return hmac.new(token.encode("ascii"), b"agent-chat-csrf-v1", sha256).hexdigest()


def check_csrf(token: str, supplied: str) -> None:
    if re.fullmatch(r"[0-9a-f]{64}", supplied) is None or not secrets.compare_digest(csrf(token), supplied):
        raise ChatError("CSRF_FORBIDDEN")


def authenticate_cookie(db: Connection[dict[str, Any]], token: str) -> Actor:
    digest = token_digest(token)
    binding = db.execute(
        """
        SELECT b.principal_id FROM agent_chat.browser_sessions b
        JOIN agent_chat.principals p ON p.id = b.principal_id
        WHERE b.token_hash = %s AND b.expires_at > clock_timestamp()
          AND p.kind IN ('operator', 'viewer') AND NOT p.revoked
    """,
        (digest,),
    ).fetchone()
    if binding is None:
        raise ChatError("UNAUTHENTICATED")
    return Actor(binding["principal_id"], None, None, browser_session_hash=digest)


def login(db: Connection[dict[str, Any]], token: str, previous_token: str | None = None) -> LoginSession:
    failure = None
    result = None
    with db.transaction():
        db.execute("SELECT singleton FROM agent_chat.login_guard WHERE singleton FOR UPDATE")
        # Evaluate the window after lock acquisition. The bounded array survives restart.
        guard = db.execute("""
            UPDATE agent_chat.login_guard SET failures = ARRAY(
                SELECT happened FROM unnest(failures) happened
                WHERE happened > clock_timestamp() - interval '60 seconds'
            ) WHERE singleton RETURNING cardinality(failures) AS failures
        """).fetchone()
        if guard is None:
            raise ChatError("SCHEMA_MISMATCH")
        if guard["failures"] >= 10:
            failure = "LOGIN_RATE_LIMITED"
        else:
            try:
                # Login is a separate credential purpose; no instance, host or producer fallback.
                principal = db.execute(
                    """SELECT id, kind FROM agent_chat.principals
                    WHERE credential_hash = %s AND kind IN ('operator', 'viewer') AND NOT revoked
                    AND NOT EXISTS (SELECT 1 FROM agent_chat.instances WHERE token_hash = %s) FOR SHARE""",
                    (token_digest(token), token_digest(token)),
                ).fetchone()
                if principal is None:
                    raise ChatError("UNAUTHENTICATED")
            except ChatError:
                db.execute("""
                    UPDATE agent_chat.login_guard SET failures = array_append(failures, clock_timestamp())
                    WHERE singleton
                """)
                failure = "UNAUTHENTICATED"
            else:
                session_token = secrets.token_hex(32)
                seconds = VIEWER_SESSION_SECONDS if principal["kind"] == "viewer" else SESSION_SECONDS
                result = LoginSession(session_token, principal["kind"], seconds)
                db.execute(
                    """INSERT INTO agent_chat.browser_sessions(token_hash, principal_id, created_at, expires_at)
                    SELECT %s, %s, now, now + make_interval(secs => %s)
                    FROM (SELECT clock_timestamp() AS now) clock""",
                    (token_digest(session_token), principal["id"], seconds),
                )
                if previous_token is not None and re.fullmatch(r"[0-9a-f]{64}", previous_token):
                    # Whoever owned the presented cookie: logging in as another principal ends it too.
                    db.execute(
                        "DELETE FROM agent_chat.browser_sessions WHERE token_hash = %s",
                        (token_digest(previous_token),),
                    )
    # Raising inside the transaction would roll back the failed-login counter.
    if failure is not None:
        raise ChatError(failure)
    assert result is not None
    return result


def logout(db: Connection[dict[str, Any]], actor: Actor) -> None:
    if actor.browser_session_hash is None:
        raise ChatError("UNAUTHENTICATED")
    with db.transaction():
        lock_actor(db, actor, read=True)
        db.execute("DELETE FROM agent_chat.browser_sessions WHERE token_hash = %s", (actor.browser_session_hash,))
