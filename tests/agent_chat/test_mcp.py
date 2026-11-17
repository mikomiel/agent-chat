"""Integration tests for the optional Streamable HTTP MCP surface."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import shutil
import socket
import ssl
import subprocess
import time
from contextlib import closing, contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4

import pytest
import uvicorn
from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.exceptions import ToolError
from fastmcp.server import auth as fastmcp_auth
from psycopg import sql

from agent_chat.client import Client as ChatClient
from agent_chat.mcp.app import create_app
from agent_chat.mcp.auth import AgentChatTokenVerifier, UpstreamUnavailable, _upstream_unavailable
from agent_chat.mcp.config import Config
from agent_chat.models import ChatError
from agent_chat.storage import connect


class DestinationHandler(BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):
        type(self).hits += 1
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args):
        pass


def redirect_handler(destination_port):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{destination_port}/login")
            self.end_headers()

        def log_message(self, *_args):
            pass

    return Handler


class ReadyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ready"}')

    def log_message(self, *_args):
        pass


class BadGatewayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(502)
        self.end_headers()

    def log_message(self, *_args):
        pass


class RawStatusHandler(BaseHTTPRequestHandler):
    """A complete answer: `self.server.status`, `self.server.content_type` and `self.server.body`."""

    def do_GET(self):
        body = self.server.body
        self.send_response(self.server.status)
        self.send_header("Content-Type", self.server.content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class SlowHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(4)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args):
        pass


@contextmanager
def tls_server(handler, context):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def make_certificate(tmp_path):
    openssl = shutil.which("openssl")
    assert openssl is not None, "UNAVAILABLE: openssl required for real TLS tests"
    key, cert = tmp_path / "key.pem", tmp_path / "cert.pem"
    subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
         "-keyout", str(key), "-out", str(cert)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    return context, cert


@contextmanager
def http_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def serve_mcp(process_api, *, public_origin=None, enable_writes=False, agent_chat_origin=None):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)
        port = listener.getsockname()[1]
        config = Config(
            bind_host="127.0.0.1",
            port=port,
            agent_chat_origin=agent_chat_origin or process_api.origin,
            public_origin=public_origin,
            enable_writes=enable_writes,
        )
        server = uvicorn.Server(
            uvicorn.Config(
                create_app(config),
                log_config=None,
                access_log=False,
                lifespan="on",
                ws="none",
                proxy_headers=False,
            )
        )
        thread = Thread(target=server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 8
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline, "MCP server did not start"
                time.sleep(0.01)
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            thread.join(timeout=8)
            assert not thread.is_alive(), "MCP server survived teardown"


def get_text(origin, path):
    with closing(HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=5)) as connection:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read().decode()


def get_json(origin, path):
    with closing(HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=5)) as connection:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, json.loads(response.read())


def call(origin, token, name, arguments=None):
    async def run():
        async with Client(f"{origin}/mcp", auth=BearerAuth(token)) as client:
            return await client.call_tool(name, arguments or {})
    result = asyncio.run(run())
    if isinstance(result.data, dict):
        return result.data
    return json.loads(result.content[0].text)


def tool_names(origin, token):
    async def run():
        async with Client(f"{origin}/mcp", auth=BearerAuth(token)) as client:
            return [tool.name for tool in await client.list_tools()]
    return asyncio.run(run())


def resource_uris(origin, token):
    async def run():
        async with Client(f"{origin}/mcp", auth=BearerAuth(token)) as client:
            return [str(resource.uri) for resource in await client.list_resources()]
    return asyncio.run(run())


def read_resource(origin, token, uri):
    async def run():
        async with Client(f"{origin}/mcp", auth=BearerAuth(token)) as client:
            result = await client.read_resource(uri)
            return result[0].text
    return asyncio.run(run())


TOOL_CALL = json.dumps(
    {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "status", "arguments": {}}}
).encode()
UPSTREAM_UNAVAILABLE_LINE = "code=UPSTREAM_UNAVAILABLE route=unmatched status=503 exc=UpstreamUnavailable"


def post_tool_call(origin, token):
    """One raw `tools/call` of `status`: the HTTP status, the response headers and the body."""
    with closing(HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=8)) as connection:
        connection.request(
            "POST", "/mcp", body=TOOL_CALL,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": "Bearer " + token,
            },
        )
        response = connection.getresponse()
        body = response.read()
        return response.status, response.headers, body


def tool_call_counters(origin):
    status, text = get_text(origin, "/metrics")
    assert status == 200
    return [line for line in text.splitlines() if line.startswith("agent_chat_mcp_tool_calls_total")]


@contextmanager
def database_refusing_connections(cluster, db):
    """As when PostgreSQL is stopped: a new connection to the test database fails at once."""
    name = db.execute("SELECT current_database() AS name").fetchone()["name"]
    # PostgreSQL refuses to change the current database's setting, so a connection to the cluster's own does it.
    with connect(cluster) as admin:
        admin.execute(sql.SQL("ALTER DATABASE {} ALLOW_CONNECTIONS false").format(sql.Identifier(name)))
        try:
            yield
        finally:
            admin.execute(sql.SQL("ALTER DATABASE {} ALLOW_CONNECTIONS true").format(sql.Identifier(name)))


def error_log_records(caplog):
    """The lines of the shared error log, the one the API writes `code=... route=... status=... exc=...` to."""
    return [record for record in caplog.records if record.name == "agent_chat.api"]


def test_packaged_skill_is_served_as_an_authenticated_resource(process_api, credentials, register):
    token, _ = register(process_api, credentials, "mcp-skill")
    with serve_mcp(process_api) as origin:
        uris = resource_uris(origin, token)
        assert "skill://agent-chat/SKILL.md" in uris
        text = read_resource(origin, token, "skill://agent-chat/SKILL.md")
        assert "Agent Chat" in text
        assert "untrusted peer data" in text
        assert "status" in text


def test_health_and_readiness_are_unauthenticated(process_api):
    with serve_mcp(process_api) as origin:
        assert get_json(origin, "/healthz") == (200, {"status": "ok"})
        assert get_json(origin, "/readyz") == (200, {"status": "ready"})


def test_readiness_refuses_an_unreachable_upstream(process_api):
    with serve_mcp(process_api, agent_chat_origin="http://127.0.0.1:1") as origin:
        status, body = get_json(origin, "/readyz")
        assert status == 503
        assert body == {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}


def test_readiness_uses_the_mcp_ca_configuration(process_api, tmp_path, monkeypatch):
    context, cert = make_certificate(tmp_path)
    with tls_server(ReadyHandler, context) as upstream:
        origin = f"https://127.0.0.1:{upstream.server_port}"
        monkeypatch.setenv("SSL_CERT_FILE", str(cert))
        with serve_mcp(process_api, agent_chat_origin=origin) as mcp:
            assert get_json(mcp, "/readyz") == (200, {"status": "ready"})
            monkeypatch.delenv("SSL_CERT_FILE")
            assert get_json(mcp, "/readyz") == (
                503, {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}
            )


def test_readiness_does_not_follow_redirects(process_api):
    DestinationHandler.hits = 0
    with http_server(DestinationHandler) as destination:
        with http_server(redirect_handler(destination.server_port)) as redirect:
            origin = f"http://127.0.0.1:{redirect.server_port}"
            with serve_mcp(process_api, agent_chat_origin=origin) as mcp:
                status, body = get_json(mcp, "/readyz")
                assert status == 503
                assert body == {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}
                assert DestinationHandler.hits == 0


def test_readiness_has_an_absolute_deadline(process_api):
    with http_server(SlowHandler) as upstream:
        origin = f"http://127.0.0.1:{upstream.server_port}"
        with serve_mcp(process_api, agent_chat_origin=origin) as mcp:
            started = time.monotonic()
            status, body = get_json(mcp, "/readyz")
            assert status == 503
            assert body == {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}
            assert time.monotonic() - started < 3


def test_mcp_metrics_expose_tool_outcomes(process_api, credentials, register):
    token, _ = register(process_api, credentials, "mcp-metrics")
    with serve_mcp(process_api) as origin:
        assert call(origin, token, "status")["session_id"]
        status, text = get_text(origin, "/metrics")
        assert status == 200
        assert "agent_chat_mcp_tool_calls_total" in text
        assert 'tool="status"' in text
        assert 'outcome="ok"' in text


def test_read_tools_are_scoped_to_the_calling_instance(process_api, credentials, register):
    token_a, binding_a = register(process_api, credentials, "mcp-a")
    token_b, binding_b = register(process_api, credentials, "mcp-b")
    with serve_mcp(process_api) as origin:
        assert sorted(tool_names(origin, token_a)) == ["history", "rooms", "state", "status", "who"]
        status_a = call(origin, token_a, "status")
        status_b = call(origin, token_b, "status")
        assert status_a["session_id"] == binding_a["session_id"]
        assert status_b["session_id"] == binding_b["session_id"]
        assert status_a["session_id"] != status_b["session_id"]
        assert "error" not in status_a and "error" not in status_b
        assert call(origin, token_a, "rooms")["rooms"]
        page = call(origin, token_a, "who", {"room": "homelab", "limit": 1})
        assert len(page["participants"]) == 1 and page["next_session_id"]
        assert call(origin, token_a, "who", {"room": credentials.room})["participants"]
        assert "messages" in call(origin, token_a, "history", {"room": "homelab", "limit": 1})
        assert "entries" in call(origin, token_a, "state", {"room": "homelab"})
        refused = call(
            origin, token_a, "who",
            {"room": "00000000-0000-4000-8000-000000000099"},
        )
        assert refused == {"error": {"code": "ROOM_FORBIDDEN"}}


SESSION = "00000000-0000-4000-8000-000000000001"
INSTANCE = "00000000-0000-4000-8000-000000000002"


@pytest.mark.parametrize(
    "status",
    [
        {},
        {"session_id": SESSION, "instance_id": INSTANCE},
        {"session_id": SESSION, "instance_id": INSTANCE, "online": None},
        {"session_id": SESSION, "instance_id": INSTANCE, "online": "false"},
        {"session_id": SESSION, "instance_id": INSTANCE, "online": 0},
        {"session_id": "not-a-uuid", "instance_id": INSTANCE, "online": True},
    ],
)
def test_incomplete_liveness_evidence_is_rejected(monkeypatch, status):
    verifier = AgentChatTokenVerifier("http://127.0.0.1:1")
    monkeypatch.setattr(verifier, "_status", lambda _token: status)
    assert asyncio.run(verifier.verify_token(secrets.token_hex(32))) is None


def test_complete_liveness_evidence_is_accepted(monkeypatch):
    verifier = AgentChatTokenVerifier("http://127.0.0.1:1")
    monkeypatch.setattr(
        verifier,
        "_status",
        lambda _token: {"session_id": SESSION, "instance_id": INSTANCE, "online": True},
    )
    token = asyncio.run(verifier.verify_token(secrets.token_hex(32)))
    assert token is not None
    assert token.client_id == SESSION
    assert token.scopes == ["chat:read"]
    assert "instance_id" in token.claims


@pytest.mark.parametrize(
    "failure",
    [
        ChatError("TRANSPORT_UNAVAILABLE"),
        ChatError("SERVICE_UNAVAILABLE"),
        ChatError("CLI_INTERRUPTED"),
        ChatError("DATABASE_UNAVAILABLE"),
        OSError("synthetic-private-detail"),
    ],
    ids=["transport", "server_5xx", "deadline", "database", "os_error"],
)
def test_no_verdict_from_the_service_is_not_a_rejection(monkeypatch, failure):
    verifier = AgentChatTokenVerifier("http://127.0.0.1:1")

    def unavailable(_token):
        raise failure

    monkeypatch.setattr(verifier, "_status", unavailable)
    with pytest.raises(UpstreamUnavailable) as error:
        asyncio.run(verifier.verify_token(secrets.token_hex(32)))
    assert error.value.args == ()


@pytest.mark.parametrize(
    "failure",
    [
        ChatError("UNAUTHENTICATED"),
        ChatError("SESSION_FORBIDDEN"),
        ChatError("STALE_INSTANCE"),
        ChatError("HTTP_REFUSED"),
        ChatError("REDIRECT_REFUSED"),
        ValueError("synthetic"),
        TypeError("synthetic"),
    ],
    ids=["401", "403", "409", "unnamed_refusal", "redirect", "value_error", "type_error"],
)
def test_a_refusal_stays_a_rejection(monkeypatch, failure):
    verifier = AgentChatTokenVerifier("http://127.0.0.1:1")

    def refused(_token):
        raise failure

    monkeypatch.setattr(verifier, "_status", refused)
    assert asyncio.run(verifier.verify_token(secrets.token_hex(32))) is None


def test_internal_service_origin_authenticates_and_calls_a_tool(process_api, credentials, register, monkeypatch):
    token, binding = register(process_api, credentials, "mcp-service-origin")
    port = int(process_api.origin.rsplit(":", 1)[1])

    class Resolver:
        returncode = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def communicate(self, timeout=None):
            addresses = socket.getaddrinfo("127.0.0.1", port, type=socket.SOCK_STREAM)
            return json.dumps(addresses).encode(), b""

        def poll(self):
            return 0

        def kill(self):
            return None

        def wait(self):
            return 0

    monkeypatch.setattr("agent_chat.client.subprocess.Popen", lambda *_args, **_kwargs: Resolver())
    with serve_mcp(
        process_api,
        agent_chat_origin=f"http://agent-chat:{port}",
        enable_writes=True,
    ) as origin:
        status = call(origin, token, "status")
        assert status["session_id"] == binding["session_id"]
        sent = call(
            origin, token, "send",
            {"room": "homelab", "body": "service origin write", "key": str(uuid4())},
        )
        assert "error" not in sent


def test_client_requires_an_explicit_internal_http_allowance():
    token = "a" * 64
    with pytest.raises(ChatError):
        ChatClient("http://agent-chat:8443", token)
    assert ChatClient("http://agent-chat:8443", token, allow_service_http=True)._origin == "http://agent-chat:8443"


@pytest.mark.parametrize(
    "origin",
    [
        "http://[2606:4700:4700::1111]:8443",
        "http://134744072:8443",
        "http://0x7f000001:8443",
        "http://0177.0.0.1:8443",
        "http://evil.example:8443",
    ],
)
def test_internal_service_origin_rejects_ip_literals(origin):
    with pytest.raises(ValueError):
        Config(agent_chat_origin=origin)


def test_internal_service_origin_is_allowed_but_public_http_is_not():
    assert Config(agent_chat_origin="http://agent-chat:8443").agent_chat_origin == "http://agent-chat:8443"
    with pytest.raises(ValueError):
        Config(agent_chat_origin="http://evil.example:8443")


def test_operator_and_viewer_tokens_are_rejected(process_api, credentials, make_viewer):
    verifier = AgentChatTokenVerifier(process_api.origin)
    viewer = make_viewer(credentials.room)
    assert asyncio.run(verifier.verify_token(credentials.operator)) is None
    assert asyncio.run(verifier.verify_token(viewer.token)) is None


def test_revoked_instance_is_rejected(process_api, credentials, register, db):
    token, binding = register(process_api, credentials, "mcp-revoked")
    verifier = AgentChatTokenVerifier(process_api.origin)
    assert asyncio.run(verifier.verify_token(token)) is not None
    db.execute(
        "UPDATE agent_chat.principals SET revoked = true WHERE id = "
        "(SELECT principal_id FROM agent_chat.sessions WHERE id = %s)",
        (binding["session_id"],),
    )
    assert asyncio.run(verifier.verify_token(token)) is None


def test_database_outage_answers_503_and_the_same_token_works_after_it(
    process_api, credentials, register, db, postgres_cluster, caplog
):
    token, binding = register(process_api, credentials, "mcp-outage")
    caplog.set_level(logging.WARNING, logger="agent_chat.api")
    with serve_mcp(process_api) as origin:
        # The control: this exact request authenticates and runs the tool.
        status, _headers, _body = post_tool_call(origin, token)
        assert status == 200
        executed = tool_call_counters(origin)
        assert executed and all('tool="status"' in line for line in executed)
        with database_refusing_connections(postgres_cluster, db):
            # The service's own answer to the same token, as the issue records it.
            status, refusal = process_api.request("GET", "/v1/instance/status", token=token)
            assert (status, refusal["error"]["code"]) == (503, "DATABASE_UNAVAILABLE")
            status, headers, body = post_tool_call(origin, token)
            assert status == 503
            assert headers["Retry-After"] == "5"
            assert headers["Content-Type"] == "application/json"
            assert json.loads(body) == {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}
            assert "WWW-Authenticate" not in headers
        assert tool_call_counters(origin) == executed
        # The outage was not remembered as a bad token: the same token needs no new registration.
        assert call(origin, token, "status")["session_id"] == binding["session_id"]
    (record,) = error_log_records(caplog)
    assert record.levelno == logging.WARNING
    assert record.getMessage() == UPSTREAM_UNAVAILABLE_LINE
    assert record.exc_info is None
    assert token not in caplog.text


@pytest.mark.parametrize("upstream", ["refused", "bad_gateway"])
def test_unreachable_or_failing_server_answers_503_not_401(process_api, caplog, upstream):
    token = secrets.token_hex(32)
    caplog.set_level(logging.WARNING, logger="agent_chat.api")
    with http_server(BadGatewayHandler) as gateway:
        origin = "http://127.0.0.1:1" if upstream == "refused" else f"http://127.0.0.1:{gateway.server_port}"
        with serve_mcp(process_api, agent_chat_origin=origin) as mcp:
            status, headers, body = post_tool_call(mcp, token)
            assert status == 503
            assert headers["Retry-After"] == "5"
            assert json.loads(body) == {"status": "not_ready", "code": "UPSTREAM_UNAVAILABLE"}
    (record,) = error_log_records(caplog)
    assert record.getMessage() == UPSTREAM_UNAVAILABLE_LINE
    assert token not in caplog.text


@pytest.mark.parametrize(
    ("status", "content_type", "body", "expected"),
    [
        (200, "application/json", b"[]", 401),
        (200, "application/json", b"null", 401),
        (200, "application/json", b"not json", 401),
        (204, "application/json", b"", 401),
        (201, "application/json", b"[]", 401),
        (201, "application/json", b"{}", 401),
        (202, "text/plain", b"accepted", 401),
        (401, "text/plain", b"Unauthorized", 401),
        (403, "text/html", b"<h1>Forbidden</h1>", 401),
        (404, "text/html", b"", 401),
        (403, "application/json", b"[]", 401),
        (429, "text/plain", b"Too Many Requests", 503),
        (429, "application/json", b'{"detail": "Too Many Requests"}', 503),
        (408, "application/json", b"{}", 503),
        (404, "application/json", b'{"detail": "Not Found"}', 401),
        (408, "text/plain", b"", 503),
        (502, "text/html", b"<h1>Bad Gateway</h1>", 503),
        (503, "text/plain", b"", 503),
    ],
)
def test_a_complete_answer_without_the_service_envelope_is_classified_by_status(
    process_api, caplog, status, content_type, body, expected
):
    token = secrets.token_hex(32)
    caplog.set_level(logging.WARNING, logger="agent_chat.api")
    with http_server(RawStatusHandler) as upstream:
        upstream.status, upstream.content_type, upstream.body = status, content_type, body
        with serve_mcp(process_api, agent_chat_origin=f"http://127.0.0.1:{upstream.server_port}") as mcp:
            answer, headers, _body = post_tool_call(mcp, token)
    assert answer == expected
    assert ("Retry-After" in headers) == (expected == 503)
    assert len(error_log_records(caplog)) == (expected == 503)


def test_rejected_tokens_still_answer_401_while_the_service_is_up(process_api, credentials, register, db, caplog):
    token, binding = register(process_api, credentials, "mcp-rejected")
    lapsed, lapsed_binding = register(process_api, credentials, "mcp-lapsed")
    caplog.set_level(logging.WARNING, logger="agent_chat.api")
    with serve_mcp(process_api) as origin:
        # Both tokens are live until the service refuses or lapses them.
        assert post_tool_call(origin, token)[0] == post_tool_call(origin, lapsed)[0] == 200
        executed = tool_call_counters(origin)
        db.execute(
            "UPDATE agent_chat.principals SET revoked = true WHERE id = "
            "(SELECT principal_id FROM agent_chat.sessions WHERE id = %s)",
            (binding["session_id"],),
        )
        db.execute(
            "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '10 minutes' "
            "WHERE session_id = %s",
            (lapsed_binding["session_id"],),
        )
        for rejected in (token, lapsed, secrets.token_hex(32), credentials.operator, "not-a-token"):
            status, headers, _body = post_tool_call(origin, rejected)
            assert status == 401
            assert 'error="invalid_token"' in headers["WWW-Authenticate"]
            assert "Retry-After" not in headers
        assert tool_call_counters(origin) == executed
    assert error_log_records(caplog) == []


def test_mcp_requires_a_bearer_token(process_api):
    with serve_mcp(process_api) as origin:
        with closing(HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=5)) as connection:
            connection.request(
                "POST", "/mcp", body=b"{}",
                headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
            )
            response = connection.getresponse()
            assert response.status == 401


def test_valid_public_origin_reaches_authentication(process_api):
    with serve_mcp(process_api, public_origin="https://chat.example.invalid") as origin:
        with closing(HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=5)) as connection:
            connection.request(
                "POST", "/mcp", body=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "Host": "chat.example.invalid",
                    "Origin": "https://chat.example.invalid",
                },
            )
            response = connection.getresponse()
            assert response.status == 401


def test_invalid_origin_is_rejected(process_api):
    with serve_mcp(process_api, public_origin="https://chat.example.invalid") as origin:
        with closing(HTTPConnection("127.0.0.1", int(origin.rsplit(":", 1)[1]), timeout=5)) as connection:
            connection.request(
                "POST", "/mcp", body=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "Origin": "https://evil.example",
                },
            )
            response = connection.getresponse()
            assert response.status == 403


WRITE_TOOLS = [
    "ack", "history", "lane", "mute", "reply", "resolve", "rooms",
    "send", "state", "status", "unmute", "unresolve", "who", "work",
]


def test_write_tools_are_registered_only_when_enabled(process_api, credentials, register):
    token, _ = register(process_api, credentials, "mcp-write-tools")
    with serve_mcp(process_api) as origin:
        assert "send" not in tool_names(origin, token)
    with serve_mcp(process_api, enable_writes=True) as origin:
        assert sorted(tool_names(origin, token)) == WRITE_TOOLS


def test_write_tools_publish_reply_and_ack(process_api, credentials, register):
    token_a, binding_a = register(process_api, credentials, "mcp-write-a")
    token_b, binding_b = register(process_api, credentials, "mcp-write-b")
    with serve_mcp(process_api, enable_writes=True) as origin:
        sent = call(
            origin, token_a, "send",
            {
                "room": "homelab",
                "body": "synthetic mcp write",
                "key": str(uuid4()),
                "recipients": [binding_b["session_id"]],
            },
        )
        assert "error" not in sent
        message_id = sent["id"]
        thread_id = sent["thread_id"]
        history = call(origin, token_b, "history", {"room": "homelab", "limit": 10})
        assert any(row.get("id") == message_id for row in history["messages"])

        acknowledged = call(origin, token_b, "ack", {"message": message_id})
        assert "error" not in acknowledged

        replied = call(
            origin, token_b, "reply",
            {
                "message": message_id,
                "body": "synthetic mcp reply",
                "key": str(uuid4()),
                "recipients": [binding_a["session_id"]],
            },
        )
        assert "error" not in replied
        assert replied["reply_to"] == message_id

        one_step = call(
            origin, token_b, "reply",
            {
                "message": message_id,
                "body": "synthetic one-step reply",
                "recipients": [binding_a["session_id"]],
            },
        )
        assert "error" not in one_step

        assert "error" not in call(origin, token_a, "resolve", {"thread": thread_id})
        assert "error" not in call(origin, token_a, "unresolve", {"thread": thread_id})


def test_explicit_key_reply_cannot_post_to_a_different_room(process_api, credentials, register, db):
    token, binding = register(process_api, credentials, "mcp-room-bound-reply")
    with serve_mcp(process_api, enable_writes=True) as origin:
        root = call(
            origin, token, "send",
            {"room": "homelab", "body": "homelab root", "key": str(uuid4())},
        )
        assert "error" not in root
        status, private = process_api.request(
            "POST", "/v1/rooms", {"slug": "private", "label": "Private"}, credentials.operator
        )
        assert status == 200
        db.execute(
            "INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)",
            (credentials.principal, private["id"]),
        )
        db.execute(
            "INSERT INTO agent_chat.memberships VALUES (%s, %s)",
            (private["id"], binding["session_id"]),
        )
        refused = call(
            origin, token, "reply",
            {
                "message": root["id"],
                "room": "private",
                "body": "wrong room",
                "key": str(uuid4()),
            },
        )
        assert "error" in refused
        assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 1


def test_invalid_write_arguments_do_not_echo_body_or_log_it(process_api, credentials, register, caplog):
    token, _ = register(process_api, credentials, "mcp-invalid-arguments")
    marker = "SYNTHETIC_PRIVATE_" + secrets.token_hex(8)
    caplog.set_level("WARNING", logger="fastmcp.server.server")
    with serve_mcp(process_api, enable_writes=True) as origin:
        async def invoke():
            async with Client(f"{origin}/mcp", auth=BearerAuth(token)) as client:
                return await client.call_tool("send", {"body": marker})

        with pytest.raises(ToolError) as error:
            asyncio.run(invoke())
    assert marker not in str(error.value)
    assert marker not in caplog.text


def test_write_tools_declare_lane_work_and_mute(process_api, credentials, register):
    token, _ = register(process_api, credentials, "mcp-coordination")
    with serve_mcp(process_api, enable_writes=True) as origin:
        assert "error" not in call(origin, token, "lane", {"lane": "project::0123456789ab-0123"})
        assert "error" not in call(origin, token, "lane", {"clear": True})
        assert "error" not in call(origin, token, "work", {"github": ["owner/repo"]})
        assert "error" not in call(origin, token, "work", {"clear": True})
        assert "error" not in call(origin, token, "mute")
        assert "error" not in call(origin, token, "unmute")


def test_the_verifier_keeps_fastmcp_default_middleware_and_only_adds_on_error():
    # get_middleware copies FastMCP's default pair to add `on_error`. A FastMCP upgrade that changes the
    # default set must fail here rather than silently drop a middleware.
    verifier = AgentChatTokenVerifier.__new__(AgentChatTokenVerifier)
    ours = verifier.get_middleware()
    default = fastmcp_auth.TokenVerifier.get_middleware(verifier)
    assert [m.cls for m in ours] == [m.cls for m in default]
    assert ours[0].kwargs["on_error"] is _upstream_unavailable
    for mine, theirs in zip(ours, default, strict=True):
        assert mine.args == theirs.args
        added = {key: value for key, value in mine.kwargs.items() if key != "on_error"}
        assert added.keys() == theirs.kwargs.keys()
        for key, value in added.items():
            assert type(value) is type(theirs.kwargs[key])
            assert vars(value) == vars(theirs.kwargs[key])
