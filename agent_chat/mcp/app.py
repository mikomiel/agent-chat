"""FastMCP application factory for Agent Chat."""

from __future__ import annotations

from fastmcp import FastMCP
from starlette.responses import Response

from .auth import AgentChatTokenVerifier
from .config import Config
from .tools import register


def create_mcp(config: Config) -> FastMCP:
    mcp = FastMCP(name="agent-chat", auth=AgentChatTokenVerifier(config.agent_chat_origin))
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
    allowed_hosts = sorted({config.bind_host, "127.0.0.1", "localhost", "::1"})
    app = create_mcp(config).http_app(
        path="/mcp",
        stateless_http=True,
        allowed_hosts=allowed_hosts,
    )
    return OriginGuard(app, config.public_origin)
