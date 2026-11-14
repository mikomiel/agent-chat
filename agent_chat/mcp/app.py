"""FastMCP application factory for Agent Chat."""

from __future__ import annotations

import asyncio
import os
import sys
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


READINESS_PROBE = r"""
import http.client
import sys
from urllib.parse import urlsplit

url = sys.stdin.readline().strip()
parts = urlsplit(url)
connection = None
try:
    if parts.scheme == "https":
        connection = http.client.HTTPSConnection(parts.hostname, parts.port or 443, timeout=2)
    else:
        connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=2)
    connection.request("GET", parts.path or "/readyz")
    response = connection.getresponse()
    sys.exit(0 if response.status == 200 else 1)
except Exception:
    sys.exit(1)
finally:
    if connection is not None:
        connection.close()
"""


class HealthEndpoints:
    """Serve liveness and readiness outside MCP authentication."""

    def __init__(self, app, config: Config):
        self.app = app
        self.config = config
        self._readiness: asyncio.Task[bool] | None = None

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "GET":
            if scope["path"] == "/healthz":
                await JSONResponse({"status": "ok"})(scope, receive, send)
                return
            if scope["path"] == "/readyz":
                try:
                    ready = await self._readiness_check()
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

    async def _readiness_check(self) -> bool:
        if self._readiness is None or self._readiness.done():
            self._readiness = asyncio.create_task(self._probe())
        return await asyncio.shield(self._readiness)

    async def _probe(self) -> bool:
        url = f"{self.config.agent_chat_origin.rstrip('/')}/readyz"
        environment = {
            name: os.environ[name]
            for name in ("SSL_CERT_FILE", "SSL_CERT_DIR")
            if name in os.environ
        }
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", READINESS_PROBE,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=environment,
            )
        except OSError:
            return False
        assert process.stdin is not None
        process.stdin.write(url.encode("utf-8") + b"\n")
        await process.stdin.drain()
        process.stdin.close()
        try:
            return_code = await asyncio.wait_for(process.wait(), timeout=2)
        except TimeoutError:
            process.kill()
            await process.wait()
            return False
        return return_code == 0


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
