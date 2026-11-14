"""FastMCP application factory for Agent Chat."""

from __future__ import annotations

import asyncio
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.exceptions import ValidationError as FastMCPValidationError
from fastmcp.server.middleware import Middleware
from fastmcp.server.providers.skills import SkillsDirectoryProvider
from starlette.responses import JSONResponse, Response

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
    skills = Path(__file__).resolve().parent.parent / "skills"
    if skills.is_dir():
        mcp.add_provider(SkillsDirectoryProvider(roots=skills))
    register(mcp, config)
    return mcp


class HealthEndpoints:
    """Serve liveness and readiness outside MCP authentication."""

    def __init__(self, app, config: Config):
        self.app = app
        self.config = config

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "GET":
            if scope["path"] == "/healthz":
                await JSONResponse({"status": "ok"})(scope, receive, send)
                return
            if scope["path"] == "/readyz":
                try:
                    ready = await asyncio.to_thread(self._upstream_ready)
                except Exception:
                    ready = False
                if ready:
                    await JSONResponse({"status": "ready"})(scope, receive, send)
                else:
                    await JSONResponse(
                        {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"},
                        status_code=503,
                    )(scope, receive, send)
                return
        await self.app(scope, receive, send)

    def _upstream_ready(self) -> bool:
        url = f"{self.config.agent_chat_origin.rstrip('/')}/readyz"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(url, timeout=2) as response:
                return response.status == 200
        except (OSError, ValueError):
            return False


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
    return HealthEndpoints(OriginGuard(app, config.public_origin), config)
