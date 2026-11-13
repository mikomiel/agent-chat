"""Integration tests for the optional Streamable HTTP MCP surface."""

from __future__ import annotations

import asyncio
import json
import socket
import time
from contextlib import closing, contextmanager
from http.client import HTTPConnection
from threading import Thread

import uvicorn
from fastmcp import Client
from fastmcp.client.auth import BearerAuth

from agent_chat.mcp.app import create_app
from agent_chat.mcp.auth import AgentChatTokenVerifier
from agent_chat.mcp.config import Config


@contextmanager
def serve_mcp(process_api, *, public_origin=None):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)
        port = listener.getsockname()[1]
        config = Config(
            bind_host="127.0.0.1",
            port=port,
            agent_chat_origin=process_api.origin,
            public_origin=public_origin,
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
