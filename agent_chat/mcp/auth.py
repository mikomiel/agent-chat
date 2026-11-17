"""Request-scoped authentication for the Agent Chat MCP service.

The MCP process holds no instance binding. Every MCP request presents the
caller's Agent Chat instance token; the verifier asks the local service whether
that token names a live instance. Tool calls then use the same token against the
service HTTP API. No token is cached, logged, or copied into claims.

The verifier tells a rejection from an outage. A token the service refuses, or
names offline or stale, is rejected: the request answers 401. When the service
cannot answer at all, there is no verdict on the token: the request answers 503
with `Retry-After`, is never authenticated, and the same token works once the
service is back.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from uuid import UUID

from fastmcp.server.auth import AccessToken, TokenVerifier
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend
from starlette.authentication import AuthenticationError
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response

from ..client import Client
from ..http_boundary import UNMATCHED, log_error
from ..models import ChatError

VERIFY_SECONDS = 5.0
RETRY_AFTER_SECONDS = 5
# What `GET /readyz` answers while the service is down. A request that cannot be verified answers the same body.
UPSTREAM_UNAVAILABLE_BODY = {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}
# The codes `Client.request("GET", ...)` raises when the service gives no verdict. A 5xx answer arrives as
# SERVICE_UNAVAILABLE (TRANSPORT_UNAVAILABLE when its body is not JSON), whatever its code, so the server's 503
# DATABASE_UNAVAILABLE never arrives under its own name; it is listed in case the client ever reports it as sent.
# CLI_INTERRUPTED is this call's whole-operation deadline (VERIFY_SECONDS). Any other code is a refusal by the
# service, or an answer the client cannot read as an outage, and stays a rejection.
UPSTREAM_CODES = frozenset(
    {"TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "CLI_INTERRUPTED", "DATABASE_UNAVAILABLE"}
)


class UpstreamUnavailable(AuthenticationError):
    """The service gave no verdict on the token. It carries no text, so no failure detail reaches a response or log."""


def _upstream_unavailable(_connection: HTTPConnection, error: AuthenticationError) -> Response:
    # Runs before routing, so the route is `unmatched`, as for the API's other pre-routing refusals.
    # The exception type is the only failure detail logged.
    log_error(logging.WARNING, "UPSTREAM_UNAVAILABLE", UNMATCHED, 503, type(error).__name__)
    return JSONResponse(
        UPSTREAM_UNAVAILABLE_BODY, status_code=503, headers={"Retry-After": str(RETRY_AFTER_SECONDS)}
    )


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

    def __init__(self, agent_chat_origin: str, *, allow_service_http: bool = False):
        super().__init__()
        self._origin = agent_chat_origin
        self._allow_service_http = allow_service_http

    def get_middleware(self) -> list[Middleware]:
        # FastMCP's own pair, with `on_error` added: without it Starlette answers an AuthenticationError with a
        # 400 and the exception text.
        return [
            Middleware(AuthenticationMiddleware, backend=BearerAuthBackend(self), on_error=_upstream_unavailable),
            Middleware(AuthContextMiddleware),
        ]

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            status = await asyncio.to_thread(self._status, token)
        except ChatError as error:
            if error.code in UPSTREAM_CODES:
                raise UpstreamUnavailable from None
            return None
        except OSError:
            raise UpstreamUnavailable from None
        except (ValueError, TypeError):
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
        client = Client(
            self._origin,
            token,
            deadline=time.monotonic() + VERIFY_SECONDS,
            allow_service_http=self._allow_service_http,
        )
        return client.request("GET", "/v1/instance/status")
