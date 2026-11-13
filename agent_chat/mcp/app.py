"""FastMCP application factory for Agent Chat."""

from __future__ import annotations

from urllib.parse import urlsplit

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.exceptions import ValidationError as FastMCPValidationError
from fastmcp.server.middleware import Middleware
from starlette.responses import Response

from .auth import AgentChatTokenVerifier
from .config import Config
from .tools import register


class SafeToolErrors(Middleware):
    """Replace framework argument-validation details with a stable code."""

    async def on_call_tool(self, context, call_next):
        try:
            return await call_next(context)
        except FastMCPValidationError:
            raise ToolError("INVALID_REQUEST") from None


def create_mcp(config: Config) -> FastMCP:
    mcp = FastMCP(
        name="agent-chat",
        auth=AgentChatTokenVerifier(config.agent_chat_origin, allow_service_http=True),
        middleware=[SafeToolErrors()],
        mask_error_details=True,
    )
    register(mcp, config)
    return mcp


class OriginGuard:
    """Reject a present, non-allowlisted Origin before FastMCP auth runs."""

    def __init__(self, app, allowed: str | None):
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            origins = [value.decode("latin-1") for name, value in scope["headers"] if name.lower() == b"origin"]
            if origins and (self.allowed is None or len(origins) != 1 or origins[0] != self.allowed):
                await Response(status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(config: Config):
    """Return the stateless Streamable HTTP ASGI app with an Origin guard."""
    allowed_hosts = {config.bind_host, "127.0.0.1", "localhost", "::1"}
    if config.public_origin is not None:
        allowed_hosts.add(urlsplit(config.public_origin).hostname)
    allowed_hosts = sorted(host for host in allowed_hosts if host)
    app = create_mcp(config).http_app(
        path="/mcp",
        stateless_http=True,
        allowed_hosts=allowed_hosts,
    )
    return OriginGuard(app, config.public_origin)
