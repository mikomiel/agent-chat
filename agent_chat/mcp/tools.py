"""Tools for the optional Agent Chat MCP surface.

Every tool authenticates with the caller's instance token by constructing one
request-scoped Client. The MCP process holds no binding and no database
connection. Message bodies are read from tool arguments, sent through the
normal HTTP API, and never written to MCP logs.

Write tools are not registered unless ``enable_writes`` is true. The CLI's
selector resolution is reused so MCP and command-line clients accept the same
room, recipient, role and idempotency forms.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode
from uuid import UUID, uuid5

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_access_token
from pydantic import ValidationError

from ..cli import DEFAULT_ROOM, REPLY_KEY_NAMESPACE, _payload, _recipients, _room
from ..client import Client
from ..models import (
    ChatError,
    LaneDeclaration,
    Publication,
    Reply,
    WorkDeclaration,
)
from .config import Config

REQUEST_SECONDS = 20.0


def _client(config: Config) -> Client:
    token = get_access_token()
    if token is None:
        raise ChatError("UNAUTHENTICATED")
    return Client(
        config.agent_chat_origin,
        token.token,
        deadline=time.monotonic() + REQUEST_SECONDS,
        allow_service_http=True,
    )


def _query(**values: Any) -> str:
    pairs = {key: ("true" if value is True else "false" if value is False else str(value))
             for key, value in values.items() if value is not None}
    return urlencode(pairs)


def _uuid(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError:
        raise ChatError("INVALID_REQUEST") from None


def _run(config: Config, call) -> dict[str, Any]:
    try:
        return call(_client(config))
    except ChatError as error:
        return {"error": {"code": error.code}}
    except ValidationError:
        return {"error": {"code": "INVALID_REQUEST"}}
    except (OSError, ValueError):
        return {"error": {"code": "IO_FAILED"}}


def _own_session(client: Client) -> str:
    return _uuid(client.request("GET", "/v1/instance/status")["session_id"])


def register(mcp: FastMCP, config: Config) -> None:
    @mcp.tool
    def rooms() -> dict[str, Any]:
        """List the rooms granted to the calling session."""
        return _run(config, lambda client: client.request("GET", "/v1/rooms"))

    @mcp.tool
    def who(
        room: str = DEFAULT_ROOM,
        online: bool = False,
        limit: int = 100,
        after_session: str | None = None,
    ) -> dict[str, Any]:
        """List participants in a room, in ascending session-id order."""
        def call(client: Client) -> dict[str, Any]:
            room_id = _room(client, room)
            query = _query(online=online, limit=limit, after_session=after_session)
            return client.request("GET", f"/v1/rooms/{room_id}/participants?{query}")
        return _run(config, call)

    @mcp.tool
    def history(
        room: str = DEFAULT_ROOM,
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
        room: str = DEFAULT_ROOM,
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

    if not config.enable_writes:
        return

    @mcp.tool
    def send(
        body: str,
        key: str,
        room: str = DEFAULT_ROOM,
        kind: str = "message",
        recipients: list[str] | None = None,
        thread_id: str | None = None,
        ref_key: str | None = None,
        receipts: bool = False,
    ) -> dict[str, Any]:
        """Publish a message to a room; ``key`` is the caller-supplied idempotency UUID."""
        def call(client: Client) -> dict[str, Any]:
            room_id = _room(client, room)
            targets = _recipients(client, room_id, recipients or [])
            publication = Publication(
                kind=kind,
                body=body,
                recipients=tuple(UUID(item) for item in targets),
                thread_id=_uuid(thread_id) if thread_id is not None else None,
                ref_key=ref_key,
                receipts=receipts,
            )
            return client.request(
                "POST", f"/v1/rooms/{room_id}/messages", _payload(publication), _uuid(key)
            )
        return _run(config, call)

    @mcp.tool
    def reply(
        message: str,
        body: str,
        key: str | None = None,
        room: str | None = None,
        recipients: list[str] | None = None,
        receipts: bool = False,
    ) -> dict[str, Any]:
        """Reply to a message. Without ``key`` the one-step room is derived from the parent."""
        def call(client: Client) -> dict[str, Any]:
            message_id = _uuid(message)
            if key is None and room is not None:
                raise ChatError("INVALID_REQUEST")
            if key is None:
                targets = _recipients(client, None, recipients or [])
                derived = str(uuid5(REPLY_KEY_NAMESPACE, f"{_own_session(client)}:{message_id}"))
                payload = Reply(
                    body=body,
                    recipients=tuple(UUID(item) for item in targets),
                    receipts=receipts,
                )
                return client.request(
                    "POST", f"/v1/messages/{message_id}/replies", _payload(payload), derived
                )
            room_id = _room(client, DEFAULT_ROOM if room is None else room)
            targets = _recipients(client, room_id, recipients or [])
            publication = Publication(
                kind="reply",
                body=body,
                recipients=tuple(UUID(item) for item in targets),
                reply_to=UUID(message_id),
                receipts=receipts,
            )
            return client.request(
                "POST", f"/v1/rooms/{room_id}/messages", _payload(publication), _uuid(key)
            )
        return _run(config, call)

    @mcp.tool
    def ack(message: str) -> dict[str, Any]:
        """Acknowledge one addressed message."""
        return _run(
            config,
            lambda client: client.request(
                "POST", f"/v1/messages/{_uuid(message)}/ack", {}
            ),
        )

    def _mute(muted: bool):
        def call(client: Client) -> dict[str, Any]:
            session_id = _own_session(client)
            return client.request("POST", f"/v1/sessions/{session_id}/mute", {"muted": muted})
        return _run(config, call)

    @mcp.tool
    def mute() -> dict[str, Any]:
        """Mute delivery for the calling session."""
        return _mute(True)

    @mcp.tool
    def unmute() -> dict[str, Any]:
        """Resume delivery for the calling session."""
        return _mute(False)

    @mcp.tool
    def resolve(thread: str) -> dict[str, Any]:
        """Mark a thread resolved."""
        return _run(
            config,
            lambda client: client.request(
                "POST", f"/v1/threads/{_uuid(thread)}/resolution", {"resolved": True}
            ),
        )

    @mcp.tool
    def unresolve(thread: str) -> dict[str, Any]:
        """Reopen a resolved thread."""
        return _run(
            config,
            lambda client: client.request(
                "POST", f"/v1/threads/{_uuid(thread)}/resolution", {"resolved": False}
            ),
        )

    @mcp.tool
    def lane(lane: str | None = None, clear: bool = False) -> dict[str, Any]:
        """Declare or clear the calling instance's advisory lane."""
        if clear == (lane is not None):
            return {"error": {"code": "INVALID_REQUEST"}}

        def call(client: Client) -> dict[str, Any]:
            declaration = LaneDeclaration(lane=lane)
            return client.request(
                "POST", "/v1/instance/lane", declaration.model_dump(mode="json")
            )
        return _run(config, call)

    @mcp.tool
    def work(
        forgejo: list[str] | None = None,
        github: list[str] | None = None,
        clear: bool = False,
    ) -> dict[str, Any]:
        """Declare the repositories this session works on, or clear the declaration."""
        repositories: dict[str, list[str]] = {}
        if forgejo:
            repositories["forgejo"] = forgejo
        if github:
            repositories["github"] = github
        if clear == bool(repositories):
            return {"error": {"code": "INVALID_REQUEST"}}

        def call(client: Client) -> dict[str, Any]:
            declaration = WorkDeclaration(repositories=repositories)
            return client.request(
                "POST", "/v1/instance/work", declaration.model_dump(mode="json")
            )
        return _run(config, call)
