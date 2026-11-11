"""Opt-in API factory. No credential loading, migrations, listener or activation on import."""

# Keep annotations eager: FastAPI's route dependencies refer to the factory-local connection function.
import asyncio
import json
import logging
import secrets
import time
from collections.abc import Iterator
from http import HTTPStatus
from importlib.resources import files
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, Header, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from psycopg import Connection
from psycopg import Error as DatabaseError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.responses import StreamingResponse

from . import browser, deliveries, feed, receipts, roles, sessions, state, threads
from . import events as event_store
from . import rooms as room_store
from .auth import authenticate, authenticate_producer, lock_actor
from .http_boundary import LOG, UNMATCHED, RequestBoundary, error_response, log_error
from .models import (
    HTTP_ERROR_STATUS,
    REF_KEY_PATTERN,
    STATE_KEY_PATTERN,
    Actor,
    ChatError,
    DeliveryClaim,
    DeliveryResult,
    EmptyRequest,
    Heartbeat,
    LaneDeclaration,
    Login,
    Membership,
    Mute,
    PmMark,
    Publication,
    ReceiptDelivery,
    Registration,
    Reply,
    Resolution,
    RoleMark,
    RoomCreation,
    StateUpsert,
    WorkDeclaration,
)
from .protocol import cursor, validate_origin
from .publication import publish
from .storage import MIGRATIONS, connect


def _log_handled(
    level: int, request: Request, code: str, status: int, error: Exception, *, mid_stream: bool = False
) -> None:
    route = getattr(request.scope.get("route"), "path", UNMATCHED)
    log_error(level, code, route, status, type(error).__name__, mid_stream=mid_stream)


def create_app(
    dsn: str,
    *,
    enabled: bool = False,
    public_origin: str | None = None,
    delivery_enabled: bool = False,
    stream_lifetime: float = 60,
    stream_poll: float = 1,
) -> FastAPI:
    if not enabled:
        raise ChatError("INTEGRATION_DISABLED")
    if stream_lifetime <= 0 or stream_poll <= 0:
        raise ValueError("event stream lifetime and poll interval must be positive")
    if public_origin is not None:
        try:
            validate_origin(public_origin, https_only=True)
        except ChatError:
            raise ValueError("public_origin must be a canonical HTTPS origin") from None
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.add_middleware(RequestBoundary, public_origin=public_origin)

    @app.exception_handler(ChatError)
    async def chat_error(request: Request, error: ChatError):
        status = HTTP_ERROR_STATUS.get(error.code, 503)
        _log_handled(logging.WARNING, request, error.code, status, error)
        return error_response(error.code, status)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        # FastAPI's default includes the submitted input, which can be private.
        _log_handled(logging.WARNING, request, "INVALID_REQUEST", 422, error)
        return error_response("INVALID_REQUEST", 422)

    @app.exception_handler(DatabaseError)
    async def database_error(request: Request, error: DatabaseError):
        _log_handled(logging.ERROR, request, "DATABASE_UNAVAILABLE", 503, error)
        return error_response("DATABASE_UNAVAILABLE", 503)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        # Unknown routes and methods. FastAPI's default {"detail": ...} is not this API's envelope.
        code = HTTPStatus(error.status_code).name
        _log_handled(logging.WARNING, request, code, error.status_code, error)
        return error_response(code, error.status_code, error.headers)

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, _error: Exception):
        # Runs outside RequestBoundary, so the security headers come from error_response itself.
        # The body names nothing; the server still logs the traceback.
        return error_response("INTERNAL_ERROR", 500)

    def connection() -> Iterator[Connection[dict[str, Any]]]:
        with connect(dsn) as db:
            yield db

    def bearer(request: Request) -> str:
        authorization = request.headers.get("authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not separator:
            raise ChatError("UNAUTHENTICATED")
        return token

    def current_actor(request: Request, db: Connection[dict[str, Any]]) -> Actor:
        cookie = request.cookies.get(browser.SESSION_COOKIE)
        if cookie is None:
            return authenticate(db, bearer(request))
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            browser.check_csrf(cookie, request.headers.get("x-csrf-token", ""))
        return browser.authenticate_cookie(db, cookie)

    if public_origin is not None:

        @app.get("/")
        def viewer():
            return Response(files("agent_chat").joinpath("web/index.html").read_bytes(), media_type="text/html")

        @app.get("/ui/{asset}")
        def viewer_asset(asset: str):
            # No generic directory mount, path joining from arbitrary input or index listing.
            assets = {
                "chat.js": "text/javascript",
                "chat.css": "text/css",
                "Manrope-Variable.ttf": "font/ttf",
            }
            if asset not in assets:
                raise ChatError("NOT_FOUND")
            return Response(files("agent_chat").joinpath("web", asset).read_bytes(), media_type=assets[asset])

        @app.get("/v1/login")
        def login_challenge(response: Response):
            nonce = secrets.token_hex(32)
            response.set_cookie(
                browser.LOGIN_COOKIE, nonce, max_age=600, path="/", secure=True, httponly=True, samesite="strict"
            )
            return {"csrf_token": browser.csrf(nonce)}

        @app.post("/v1/login")
        def login(
            payload: Login,
            request: Request,
            response: Response,
            db: Annotated[Connection[dict[str, Any]], Depends(connection)],
        ):
            browser.check_csrf(request.cookies.get(browser.LOGIN_COOKIE, ""), request.headers.get("x-csrf-token", ""))
            session = browser.login(db, payload.token, request.cookies.get(browser.SESSION_COOKIE))
            response.set_cookie(
                browser.SESSION_COOKIE,
                session.token,
                max_age=session.expires_in,
                path="/",
                secure=True,
                httponly=True,
                samesite="strict",
            )
            response.delete_cookie(browser.LOGIN_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
            return {
                "csrf_token": browser.csrf(session.token), "expires_in": session.expires_in, "access": session.access,
            }

        @app.get("/v1/browser/session")
        def browser_session(request: Request, db: Annotated[Connection[dict[str, Any]], Depends(connection)]):
            actor = current_actor(request, db)
            if actor.browser_session_hash is None:
                raise ChatError("UNAUTHENTICATED")
            with db.transaction():
                access = lock_actor(db, actor, read=True)
            return {
                "principal_id": actor.principal_id,
                "access": access,
                "csrf_token": browser.csrf(request.cookies[browser.SESSION_COOKIE]),
            }

        @app.post("/v1/logout")
        def logout(
            request: Request,
            response: Response,
            db: Annotated[Connection[dict[str, Any]], Depends(connection)],
            payload: EmptyRequest = EmptyRequest(),
        ):
            browser.logout(db, current_actor(request, db))
            response.delete_cookie(browser.SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
            return {"status": "logged_out"}

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/readyz")
    def ready(db: Annotated[Connection[dict[str, Any]], Depends(connection)]):
        # Readiness requires the application schema, not merely a reachable PostgreSQL.
        if (
            db.execute(
                """
            SELECT 1 FROM agent_chat.event_clock WHERE singleton
            AND (SELECT array_agg(version ORDER BY version) FROM agent_chat.schema_migrations) = %s::integer[]
        """,
                (list(range(1, len(MIGRATIONS) + 1)),),
            ).fetchone()
            is None
        ):
            raise ChatError("SCHEMA_MISMATCH")
        return {"status": "ready"}

    @app.post("/v1/sessions")
    def register(
        payload: Registration,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return sessions.register(db, authenticate(db, token, registration=True), payload)

    @app.post("/v1/instance/heartbeat")
    def heartbeat(
        payload: Heartbeat,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return sessions.heartbeat(db, authenticate(db, token), payload)

    @app.post("/v1/instance/lane")
    def declare_lane(
        payload: LaneDeclaration,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return sessions.declare_lane(db, authenticate(db, token), payload)

    @app.post("/v1/instance/work")
    def declare_work(
        payload: WorkDeclaration,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return sessions.declare_work(db, authenticate(db, token), payload)

    @app.post("/v1/instance/end")
    def end(
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
        payload: EmptyRequest = EmptyRequest(),
    ):
        return sessions.end(db, authenticate(db, token))

    @app.get("/v1/instance/status")
    def instance_status(
        token: Annotated[str, Depends(bearer)], db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        return sessions.status(db, authenticate(db, token), delivery_enabled=delivery_enabled)

    @app.get("/v1/instance/deliveries/pending")
    def pending_deliveries(
        token: Annotated[str, Depends(bearer)], db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        actor = authenticate(db, token)
        if not delivery_enabled:
            raise ChatError("DELIVERY_DISABLED")
        return deliveries.pending(db, actor)

    @app.post("/v1/instance/deliveries/claim")
    def claim_delivery(
        payload: DeliveryClaim,
        token: Annotated[str, Depends(bearer)],
        key: Annotated[UUID, Header(alias="Idempotency-Key")],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        actor = authenticate(db, token)
        if not delivery_enabled:
            raise ChatError("DELIVERY_DISABLED")
        return deliveries.claim(db, actor, key, payload)

    @app.post("/v1/instance/deliveries/{attempt}/result")
    def delivery_result(
        attempt: UUID,
        payload: DeliveryResult,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        # Disabling new admissions must not discard an already-issued reservation's evidence.
        return deliveries.result(db, authenticate(db, token), attempt, payload)

    @app.get("/v1/instance/receipts")
    def sender_receipts(
        token: Annotated[str, Depends(bearer)], db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        # The sender's non-waking receipt ledger is independent of delivery admission: an ack needs no claim.
        return receipts.sender_feed(db, authenticate(db, token))

    @app.post("/v1/instance/receipts/delivered")
    def sender_receipts_delivered(
        payload: ReceiptDelivery,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return receipts.mark_delivered(db, authenticate(db, token), payload)

    @app.post("/v1/sessions/{session}/mute")
    def mute(
        session: UUID, payload: Mute, request: Request, db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        return sessions.mute(db, current_actor(request, db), session, payload.muted)

    @app.post("/v1/threads/{thread}/resolution")
    def resolve_thread(
        thread: UUID,
        payload: Resolution,
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return threads.resolve(db, current_actor(request, db), thread, payload.resolved)

    @app.post("/v1/messages/{message}/ack")
    def acknowledge(
        message: UUID,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
        payload: EmptyRequest = EmptyRequest(),
    ):
        return receipts.acknowledge(db, authenticate(db, token), message)

    @app.post("/v1/messages/{message}/replies")
    def reply(
        message: UUID,
        payload: Reply,
        request: Request,
        key: Annotated[UUID, Header(alias="Idempotency-Key")],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        actor = current_actor(request, db)
        with db.transaction():
            event_store.lock(db)
            # `publish` answers a repeated key before it reads the parent, so a replay survives the parent's expiry.
            parent = receipts.locate(db, actor, message)
            publication = Publication(
                kind="reply", body=payload.body, recipients=payload.recipients, reply_to=message,
                receipts=payload.receipts,
            )
            return feed.message_view(publish(db, actor, parent["room_id"], key, publication))

    @app.get("/v1/rooms")
    def rooms(
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return {"rooms": room_store.visible(db, current_actor(request, db), read=True)}

    @app.post("/v1/rooms")
    def create_room(
        payload: RoomCreation, request: Request, db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        return room_store.create(db, current_actor(request, db), payload)

    @app.post("/v1/rooms/{room}/memberships")
    def join_room(
        room: UUID,
        payload: Membership,
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        return room_store.join(db, current_actor(request, db), room, payload.session_id)

    @app.post("/v1/rooms/{room}/pm")
    def pm_mark(
        room: UUID, payload: PmMark, request: Request, db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        # Operator only: the domain call refuses every other credential before it reads or writes the mark.
        change = roles.assign if payload.pm else roles.clear
        result = change(db, current_actor(request, db), room, "pm", payload.session_id)
        # The domain call has committed. A refused or rolled-back call raised and never logs. The line holds
        # identifiers only; it is the audit trail of the mark, which has no event or history table of its own.
        LOG.info("pm_mark action=%s room=%s session=%s", "set" if payload.pm else "clear", room, payload.session_id)
        return {"room_id": result["room_id"], "pm": result["roles"]["pm"]}

    @app.post("/v1/rooms/{room}/roles")
    def role_mark(
        room: UUID, payload: RoleMark, request: Request, db: Annotated[Connection[dict[str, Any]], Depends(connection)]
    ):
        # Operator only: the domain call refuses every other credential before it reads or writes a mark.
        change = roles.assign if payload.assigned else roles.clear
        result = change(db, current_actor(request, db), room, payload.role, payload.session_id)
        LOG.info(
            "role_mark action=%s role=%s room=%s session=%s",
            "set" if payload.assigned else "clear",
            payload.role,
            room,
            payload.session_id,
        )
        return result

    @app.get("/v1/rooms/{room}/participants")
    def participants(
        room: UUID,
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
        after_session: UUID | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 100,
        online: bool = False,
    ):
        return room_store.participants(db, current_actor(request, db), room, after_session, limit, online)

    @app.get("/v1/rooms/{room}/history")
    def history(
        room: UUID,
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
        after: str | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 100,
        thread_id: UUID | None = None,
        before: str | None = None,
        ref_key: Annotated[str | None, Query(pattern=REF_KEY_PATTERN)] = None,
        sender_role: Literal["pm", "forgejo_pm", "forgejo-pm", "github_pm", "github-pm",
                               "delivery_manager", "delivery-manager", "dm"] | None = None,
    ):
        return feed.history(
            db,
            current_actor(request, db),
            room,
            cursor(after) if after is not None else None,
            limit,
            thread_id,
            cursor(before) if before is not None else None,
            ref_key,
            sender_role,
        )

    @app.post("/v1/rooms/{room}/state")
    def upsert_state(
        room: UUID,
        payload: StateUpsert,
        token: Annotated[str, Depends(bearer)],
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        # A producer credential, never a cookie: authenticate_producer is the only door it opens.
        return state.upsert(db, authenticate_producer(db, token), room, payload)

    @app.get("/v1/rooms/{room}/state")
    def read_state(
        room: UUID,
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
        ref_key: Annotated[str | None, Query(pattern=REF_KEY_PATTERN)] = None,
        after_key: Annotated[str | None, Query(pattern=STATE_KEY_PATTERN)] = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 100,
    ):
        return state.read(db, current_actor(request, db), room, ref_key, after_key, limit)

    @app.get("/v1/events")
    async def events(request: Request, after: str = "0"):
        position = cursor(after)
        header = request.headers.get("last-event-id")
        if header is not None:
            position = cursor(header)  # Both inputs are validated; header wins.

        def read_batch(cursor: int, expected: tuple[UUID, ...] | None):
            # Never suspend an HTTP stream with a database connection or row lock held.
            with connect(dsn) as db:
                return feed.events(db, current_actor(request, db), cursor, expected)

        batch = await run_in_threadpool(read_batch, position, None)

        async def stream():
            nonlocal batch
            started = last_comment = time.monotonic()
            yield ": connected\n\n"
            while True:
                for event in batch["events"]:
                    data = json.dumps(jsonable_encoder(event["data"]), separators=(",", ":"))
                    yield f"id: {event['id']}\nevent: {event['event']}\ndata: {data}\n\n"
                # Bound each connection lifetime; reconnect uses the last durable event ID.
                if time.monotonic() - started >= stream_lifetime:
                    return
                # A full page means the client is behind; poll only once it has caught up.
                if not batch["full"]:
                    await asyncio.sleep(stream_poll)
                try:
                    batch = await run_in_threadpool(read_batch, batch["next_cursor"], batch["rooms"])
                except (ChatError, DatabaseError) as error:
                    code = error.code if isinstance(error, ChatError) else "DATABASE_UNAVAILABLE"
                    level = logging.WARNING if isinstance(error, ChatError) else logging.ERROR
                    _log_handled(level, request, code, 200, error, mid_stream=True)
                    # Headers already went out. This control has no id and cannot advance replay.
                    yield "event: control\ndata: " + json.dumps({"error": {"code": code}}) + "\n\n"
                    return
                if time.monotonic() - last_comment >= 15:
                    yield ": keepalive\n\n"
                    last_comment = time.monotonic()

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
        )

    @app.post("/v1/rooms/{room}/messages")
    def message(
        room: UUID,
        payload: Publication,
        key: Annotated[UUID, Header(alias="Idempotency-Key")],
        request: Request,
        db: Annotated[Connection[dict[str, Any]], Depends(connection)],
    ):
        stored = publish(db, current_actor(request, db), room, key, payload)
        return feed.message_view(stored)

    return app
