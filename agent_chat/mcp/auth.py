"""Request-scoped authentication for the Agent Chat MCP service.

The MCP process holds no instance binding. Every MCP request presents the
caller's Agent Chat instance token; the verifier asks the local service whether
that token names a live instance. Tool calls then use the same token against the
service HTTP API. No token is cached, logged, or copied into claims.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from uuid import UUID

from fastmcp.server.auth import AccessToken, TokenVerifier

from ..client import Client
from ..models import ChatError

VERIFY_SECONDS = 5.0


def _canonical_uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = UUID(value)
    except ValueError:
        return None
    return str(parsed) if str(parsed) == value else None


class AgentChatTokenVerifier(TokenVerifier):
    """Verify an Agent Chat instance token through GET /v1/instance/status."""

    def __init__(self, agent_chat_origin: str):
        super().__init__()
        self._origin = agent_chat_origin

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            status = await asyncio.to_thread(self._status, token)
        except (ChatError, OSError, ValueError, TypeError):
            return None
        if not isinstance(status, dict):
            return None
        session_id = _canonical_uuid(status.get("session_id"))
        instance_id = _canonical_uuid(status.get("instance_id"))
        if session_id is None or instance_id is None or status.get("online") is not True:
            return None
        return AccessToken(
            token=token,
            client_id=session_id,
            scopes=["chat:read"],
            claims={"session_id": session_id, "instance_id": instance_id},
        )

    def _status(self, token: str) -> dict[str, Any]:
        client = Client(self._origin, token, deadline=time.monotonic() + VERIFY_SECONDS)
        return client.request("GET", "/v1/instance/status")
