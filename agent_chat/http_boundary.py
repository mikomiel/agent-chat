"""Bound request bytes before FastAPI parses JSON; never reflect submitted values."""

import asyncio
import logging
import re
from collections.abc import Mapping
from urllib.parse import parse_qsl

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

SECURITY_HEADERS = {
    "cache-control": "no-store",
    "content-security-policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}


LOG = logging.getLogger("agent_chat.api")
UNMATCHED = "unmatched"


def log_error(level: int, code: str, route: str, status: int, exc: str, *, mid_stream: bool = False) -> None:
    # The one format for every logged error: a fixed vocabulary of four fields. The route is the matched template
    # or UNMATCHED, so a path value, query, body, header and exception message never reach the journal.
    # A failure after the event stream started has no handler to log it: its status is the 200 already sent,
    # and the extra `phase=stream` marks it.
    suffix = " phase=stream" if mid_stream else ""
    LOG.log(level, "code=%s route=%s status=%d exc=%s" + suffix, code, route, status, exc)


def error_response(code: str, status: int, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": code}}, status_code=status, headers={**(headers or {}), **SECURITY_HEADERS}
    )


async def refuse(code: str, status: int, scope: Scope, receive: Receive, send: Send) -> None:
    # Refused before routing, so there is no route and no exception object.
    log_error(logging.WARNING, code, UNMATCHED, status, "none")
    await error_response(code, status)(scope, receive, send)


class RequestBoundary:
    def __init__(self, app: ASGIApp, public_origin: str | None = None):
        self.app = app
        self.public_origin = public_origin.encode("ascii") if public_origin is not None else None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = [name.lower() for name, _ in scope["headers"]]
        origins = [value for name, value in scope["headers"] if name.lower() == b"origin"]
        cookie = b"cookie" in headers
        mutation = scope["method"] not in ("GET", "HEAD", "OPTIONS")
        if (
            (origins and (len(origins) != 1 or self.public_origin is None or origins[0] != self.public_origin))
            or (cookie and self.public_origin is None)
            or (mutation and (cookie or scope["path"] == "/v1/login") and origins != [self.public_origin])
        ):
            await refuse("SESSION_FORBIDDEN", 403, scope, receive, send)
            return
        if cookie and b"authorization" in headers:
            await refuse("UNAUTHENTICATED", 401, scope, receive, send)
            return
        if scope["query_string"]:
            allowed = set()
            if scope["method"] == "GET":
                if scope["path"] == "/v1/events":
                    allowed = {"after"}
                elif re.fullmatch(r"/v1/rooms/[^/]+/history", scope["path"]):
                    allowed = {"after", "before", "limit", "thread_id", "ref_key", "sender_role"}
                elif re.fullmatch(r"/v1/rooms/[^/]+/state", scope["path"]):
                    allowed = {"ref_key", "after_key", "limit"}
                elif re.fullmatch(r"/v1/rooms/[^/]+/participants", scope["path"]):
                    allowed = {"after_session", "limit", "online"}
            try:
                if len(scope["query_string"]) > 4096:
                    raise ValueError
                pairs = parse_qsl(
                    scope["query_string"].decode("ascii"),
                    keep_blank_values=True,
                    strict_parsing=True,
                    errors="strict",
                    # One field per accepted key, so the cap cannot drift below the allowlist above.
                    max_num_fields=max(len(allowed), 1),
                )
                keys = [key for key, _ in pairs]
                if set(keys) - allowed or len(set(keys)) != len(keys):
                    raise ValueError
            except (ValueError, UnicodeError):
                await refuse("INVALID_REQUEST", 422, scope, receive, send)
                return
        if any(headers.count(name) > 1 for name in (b"authorization", b"cookie", b"last-event-id")):
            await refuse("UNAUTHENTICATED", 401, scope, receive, send)
            return
        body = bytearray()
        oversized = False
        try:
            async with asyncio.timeout(5):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > 131072:
                        oversized = True
                        break
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            await refuse("REQUEST_TIMEOUT", 408, scope, receive, send)
            return
        if oversized:
            await refuse("REQUEST_TOO_LARGE", 413, scope, receive, send)
            return
        if body and scope["method"] in ("GET", "HEAD"):
            await refuse("INVALID_REQUEST", 422, scope, receive, send)
            return
        consumed = False

        async def buffered_receive() -> Message:
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        async def private_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    (name, value)
                    for name, value in message["headers"]
                    if name.decode("latin-1").lower() not in SECURITY_HEADERS
                ] + [(name.encode("ascii"), value.encode("ascii")) for name, value in SECURITY_HEADERS.items()]
            await send(message)

        await self.app(scope, buffered_receive, private_send)
