"""Integration tests for the optional Streamable HTTP MCP surface."""

from __future__ import annotations

import asyncio
import json
import secrets
import socket
import time
from contextlib import closing, contextmanager
from http.client import HTTPConnection
from threading import Thread
from uuid import uuid4

import pytest
import uvicorn
from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.exceptions import ToolError

from agent_chat.client import Client as ChatClient
from agent_chat.mcp.app import create_app
from agent_chat.mcp.auth import AgentChatTokenVerifier
from agent_chat.mcp.config import Config
from agent_chat.models import ChatError


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
