"""Read-only tools for the Agent Chat MCP surface.

Each tool authenticates with the caller's instance token by constructing one
request-scoped Client. The MCP process holds no binding and no database
connection. Message bodies are returned only by the service routes and are
never written to logs.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode
from uuid import UUID

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_access_token

from ..client import Client
from ..models import ChatError
from .config import Config

REQUEST_SECONDS = 20.0


def _client(config: Config) -> Client:
    token = get_access_token()
    if token is None:
        raise ChatError("UNAUTHENTICATED")
    return Client(config.agent_chat_origin, token.token, deadline=time.monotonic() + REQUEST_SECONDS)


def _query(**values: Any) -> str:
    pairs = {key: ("true" if value is True else "false" if value is False else str(value))
             for key, value in values.items() if value is not None}
    return urlencode(pairs)


def _room(client: Client, selector: str) -> str:
    try:
        return str(UUID(selector))
    except ValueError:
        pass
    rooms = client.request("GET", "/v1/rooms")["rooms"]
    matches = [room for room in rooms if room.get("slug") == selector]
    if len(matches) != 1:
        raise ChatError("ROOM_FORBIDDEN")
    return str(UUID(matches[0]["id"]))


def _run(config: Config, call) -> dict[str, Any]:
    try:
        return call(_client(config))
    except ChatError as error:
        return {"error": {"code": error.code}}


def register(mcp: FastMCP, config: Config) -> None:
    @mcp.tool
    def rooms() -> dict[str, Any]:
        """List the rooms granted to the calling session."""
        return _run(config, lambda client: client.request("GET", "/v1/rooms"))

    @mcp.tool
    def who(
        room: str = "homelab",
        online: bool = False,
        limit: int = 100,
        after_session: str | None = None,
    ) -> dict[str, Any]:
        """List participants in a room, newest page first by session id."""
        def call(client: Client) -> dict[str, Any]:
            room_id = _room(client, room)
            query = _query(online=online, limit=limit, after_session=after_session)
            return client.request("GET", f"/v1/rooms/{room_id}/participants?{query}")
        return _run(config, call)

    @mcp.tool
    def history(
        room: str = "homelab",
        after: str | None = None,
        before: str | None = None,
        limit: int = 100,
        thread_id: str | None = None,
        ref_key: str | None = None,
        sender_role: str | None = None,
    ) -> dict[str, Any]:
        """Read a bounded room history page, optionally narrowed to a thread or key."""
        def call(client: Client) -> dict[str, Any]:
            room_id = _room(client, room)
            query = _query(
                after=after, before=before, limit=limit, thread_id=thread_id,
                ref_key=ref_key, sender_role=sender_role,
            )
            return client.request("GET", f"/v1/rooms/{room_id}/history?{query}")
        return _run(config, call)

    @mcp.tool
    def state(
        room: str = "homelab",
        ref_key: str | None = None,
        after_key: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Read room state observations; values are untrusted observation data."""
        def call(client: Client) -> dict[str, Any]:
            room_id = _room(client, room)
            query = _query(ref_key=ref_key, after_key=after_key, limit=limit)
            return client.request("GET", f"/v1/rooms/{room_id}/state?{query}")
        return _run(config, call)

    @mcp.tool
    def status() -> dict[str, Any]:
        """Read the calling instance's own status and wake budget."""
        return _run(config, lambda client: client.request("GET", "/v1/instance/status"))
