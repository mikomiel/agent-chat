"""Adapter lifecycle against real HTTP/PostgreSQL, including lost commit receipts."""

import json
import socket
import struct
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from agent_chat import instance_client, instance_worker
from agent_chat.instance_file import InstanceSecret, read_instance
from agent_chat.models import ChatError, DeliveryClaim, DeliveryResult, Heartbeat, ReceiptDelivery

ROOT = Path(__file__).resolve().parents[2]


def envelope(code):
    """The service's error body."""
    return {"error": {"code": code, "message": code}}


@pytest.fixture
def peer(process_api, credentials, tmp_path):
    """A fault boundary in front of the real API, never a fake registration."""
    state = SimpleNamespace(mode="normal", calls=[], path=None)
    directory = tmp_path / "instance"
    directory.mkdir(mode=0o700)
    boot = uuid4()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def exchange(self):
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"]))) if self.command == "POST" else None
            record = read_instance(state.path) if state.path and state.path.exists() else None
            state.calls.append(
                {
                    "path": self.path,
                    "host_auth": token == credentials.agent,
                    "instance_auth": record is not None and token == record.token,
                    "persisted_digest": record is not None
                    and body is not None
                    and body.get("instance_token_hash") == sha256(record.token.encode()).hexdigest(),
                }
            )
            status, result = process_api.request(self.command, self.path, body, token)
            mode, state.mode = state.mode, "normal"
            if mode == "drop":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            if mode == "bad_gateway":
                # What a proxy answers while the server restarts: a complete non-200 that is not JSON.
                data = b"Bad Gateway"
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if mode in ("unavailable", "redirect", "html_403", "unknown_code"):
                # Complete replies a gateway or the service itself gives: its own 503 for a database failure, a
                # redirect, a proxy's HTML refusal, and the envelope of a code this client does not know.
                status, content_type, data = {
                    "unavailable": (503, "application/json", json.dumps(envelope("DATABASE_UNAVAILABLE")).encode()),
                    "redirect": (302, "text/plain", b""),
                    "html_403": (403, "text/html", b"<html><body>Forbidden</body></html>"),
                    "unknown_code": (409, "application/json", json.dumps(envelope("SYNTHETIC_UNKNOWN")).encode()),
                }[mode]
                self.send_response(status)
                if mode == "redirect":
                    self.send_header("Location", "/elsewhere")
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if mode in ("redirect_cut", "redirect_header_cut", "redirect_chunked_cut"):
                # Redirects cut after their status line: short of the body their headers declare, inside their
                # headers, and inside chunked framing.
                self.wfile.write(
                    {
                        "redirect_cut": b"HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 64\r\n\r\n",
                        "redirect_header_cut": b"HTTP/1.1 302 Found\r\nLocation: /elsew",
                        "redirect_chunked_cut": b"HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\n"
                        b"Transfer-Encoding: chunked\r\n\r\n5\r\nab",
                    }[mode]
                )
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_WR)
                self.close_connection = True
                return
            if mode == "many_headers":
                # A complete proxy refusal with more header lines than http.client accepts: the parser rejects it.
                self.send_response(403)
                for index in range(101):
                    self.send_header(f"X-Synthetic-{index}", "1")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if mode == "bad_status":
                # A complete reply whose status line is not HTTP: the parser rejects it.
                self.wfile.write(b"SYNTHETIC GARBAGE\r\n\r\n")
                self.close_connection = True
                return
            if mode in ("partial_status", "unframed_cut", "chunked_cut", "chunked_bad_size"):
                # Replies cut short: in the status line, in the headers of a reply that has not declared its length,
                # in chunked framing, and with a chunk size that is not hex. The request was read in full first.
                chunked = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
                self.wfile.write(
                    {
                        "partial_status": b"HTTP/1.1 20",
                        "unframed_cut": b"HTTP/1.1 200 OK\r\nContent-Type: appl",
                        "chunked_cut": chunked + b"5\r\nab",
                        "chunked_bad_size": chunked + b"zz\r\nab\r\n0\r\n\r\n",
                    }[mode]
                )
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_WR)
                self.close_connection = True
                return
            if mode == "status_600":
                # A complete reply whose three-digit status is above every 5xx: an answer, not a server failure.
                data = json.dumps(envelope("DATABASE_UNAVAILABLE")).encode()
                self.send_response(600)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if mode == "reset_in_headers":
                # A 403 status line, then a reset inside the headers: http.client gives no status before the headers
                # are read, so the try got no status.
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nX-Synthetic: 1\r\n")
                self.wfile.flush()
                time.sleep(0.3)
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                self.connection.close()
                self.close_connection = True
                return
            if mode == "reset_after_status":
                # A 200 whose connection is reset after its headers: a socket error once the status is in. The pause
                # lets the client read the headers first; closing with a zero linger sends a reset, not an end.
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "64")
                self.end_headers()
                self.wfile.flush()
                time.sleep(0.3)
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                self.connection.close()
                self.close_connection = True
                return
            if mode == "truncated":
                # A 200 whose body stops before its declared length: a read failure, not a malformed body.
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data) + 16))
                self.end_headers()
                self.wfile.write(data)
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            if mode in ("null_body", "invalid_json", "list_body"):
                # A complete HTTP 200 whose JSON body breaks the protocol, not a transport failure.
                data = {"null_body": b"null", "invalid_json": b"{", "list_body": b"[]"}[mode]
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if mode in ("created_object", "no_content"):
                # A complete 2xx other than 200: the service never answers one, so it breaks the protocol.
                status, data = (201, b"{}") if mode == "created_object" else (204, b"")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if mode == "invalid_id":
                result["instance_id"] = "not-a-uuid"
            elif mode == "different_id":
                result["instance_id"] = str(uuid4())
            elif mode == "other_attempt":
                result["id"] = str(uuid4())
            elif mode == "wrong_harness":
                result["harness"] = "codex"
            data = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_POST = exchange
        do_GET = exchange

    server = HTTPServer(("127.0.0.1", 0), Handler)
    origin = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
    try:
        thread.start()
    except BaseException:
        server.server_close()
        raise

    def join(*, process_boot=boot, **kwargs):
        state.path = directory / f"{process_boot}.json"
        args = {"server_origin": origin, "host_token": credentials.agent, "harness": "pi", "enabled": True}
        args.update(kwargs)
        return instance_client.join_instance(directory, "pi-native", process_boot, **args)

    try:
        yield SimpleNamespace(join=join, state=state, directory=directory, boot=boot, origin=origin)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive(), "registration fault boundary survived teardown"


@pytest.mark.parametrize("enabled", [{}, {"enabled": False}, {"enabled": 1}])
def test_join_is_explicit_and_disabled_before_file_or_network_activity(peer, db, credentials, enabled):
    with pytest.raises(ChatError, match="INTEGRATION_DISABLED"):
        instance_client.join_instance(
            peer.directory,
            "pi-native",
            peer.boot,
            server_origin=peer.origin,
            host_token=credentials.agent,
            harness="pi",
            **enabled,
        )
    assert list(peer.directory.iterdir()) == [] and peer.state.calls == []
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 0


@pytest.mark.parametrize("harness", ["deepseek", "opencode"])
def test_an_admitted_deepseek_or_opencode_principal_registers_an_instance(peer, db, harness):
    db.execute("UPDATE agent_chat.principals SET harness = %s WHERE kind = 'agent'", (harness,))
    joined = peer.join(harness=harness)
    assert joined.harness == harness
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 1
    assert instance_client.status(joined)["online"] is True


def test_an_unknown_harness_is_refused_before_any_file_or_network_activity(peer, db):
    with pytest.raises(ChatError, match="INVALID_REQUEST"):
        peer.join(harness="vim")
    assert list(peer.directory.iterdir()) == [] and peer.state.calls == []
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 0


def test_title_heartbeat_serialization_preserves_omitted_and_explicit_null(peer):
    joined = peer.join()
    instance_client.heartbeat(joined, Heartbeat(
        native_state="idle", stopped=False, plan_mode=False, title="Native title",
    ))
    assert instance_client.status(joined)["title"] == "Native title"
    instance_client.heartbeat(joined, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    assert instance_client.status(joined)["title"] == "Native title"
    instance_client.heartbeat(joined, Heartbeat(native_state="idle", stopped=False, plan_mode=False, title=None))
    assert instance_client.status(joined)["title"] is None


def test_lifecycle_separates_host_and_instance_authority_and_preserves_stop(peer, db):
    joined = peer.join()
    assert joined.host == "synthetic-host" and joined.harness == "pi"
    assert peer.state.calls == [
        {"path": "/v1/sessions", "host_auth": True, "instance_auth": False, "persisted_digest": True}
    ]
    assert joined.binding.token not in repr(joined)
    before = instance_client.status(joined)
    assert before["stopped"] is True and before["plan_mode"] is True
    assert instance_client.status(joined)["heartbeat_at"] == before["heartbeat_at"]
    state = Heartbeat(native_state="idle", stopped=False, plan_mode=False)
    observed = instance_client.heartbeat(joined, state)
    assert observed["native_state"] == "idle" and observed["stopped"] is False
    assert instance_client.status(joined)["heartbeat_at"] == observed["heartbeat_at"]
    ended = instance_client.end(joined)
    assert instance_client.end(joined) == ended
    with pytest.raises(ChatError, match="STALE_INSTANCE"):
        instance_client.heartbeat(joined, state)
    assert all(call["instance_auth"] and not call["host_auth"] for call in peer.state.calls[1:])
    assert db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"] == 0


def test_lost_registration_response_recovers_exact_persisted_boot_without_renewal(peer, db):
    peer.state.mode = "drop"
    with pytest.raises(ChatError, match="REQUEST_UNCERTAIN"):
        peer.join()
    assert len(peer.state.calls) == 1, "transport retried without its lifecycle owner"
    saved = peer.state.path.read_bytes()
    before = db.execute("SELECT id, heartbeat_at FROM agent_chat.instances").fetchall()
    assert len(before) == 1
    joined = peer.join()
    assert joined.instance_id == before[0]["id"]
    assert peer.state.path.read_bytes() == saved
    assert db.execute("SELECT id, heartbeat_at FROM agent_chat.instances").fetchall() == before
    assert instance_client.status(joined)["stopped"] is True


@pytest.mark.parametrize("mode", ["invalid_id", "wrong_harness"])
def test_invalid_registration_receipt_is_uncertain_not_a_new_identity(peer, db, mode):
    peer.state.mode = mode
    with pytest.raises(ChatError, match="REQUEST_UNCERTAIN"):
        peer.join()
    saved = peer.state.path.read_bytes()
    assert len(peer.state.calls) == 1
    assert db.execute("SELECT count(*) AS n FROM agent_chat.instances").fetchone()["n"] == 1
    joined = peer.join()
    assert peer.state.path.read_bytes() == saved
    assert instance_client.status(joined)["instance_id"] == str(joined.instance_id)


def test_new_process_cannot_take_over_and_old_end_cannot_close_replacement(peer, db):
    first = peer.join()
    db.execute("UPDATE agent_chat.sessions SET muted = true WHERE id = %s", (first.session_id,))
    next_boot = uuid4()
    with pytest.raises(ChatError, match="BINDING_CONFLICT"):
        peer.join(process_boot=next_boot)
    candidate = peer.state.path.read_bytes()
    instance_client.end(first)
    replacement = peer.join(process_boot=next_boot)
    assert replacement.session_id == first.session_id and replacement.instance_id != first.instance_id
    assert peer.state.path.read_bytes() == candidate
    assert instance_client.status(replacement)["muted"] is True
    instance_client.end(first)
    assert instance_client.status(replacement)["online"] is True
    with pytest.raises(ChatError, match="STALE_INSTANCE"):
        instance_client.heartbeat(first, Heartbeat(native_state="idle", stopped=False, plan_mode=False))


def test_lifecycle_never_uses_host_token_to_bypass_instance_revocation(peer, db):
    joined = peer.join()
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE kind = 'agent'")
    for call in (instance_client.status, instance_client.end):
        with pytest.raises(ChatError, match="UNAUTHENTICATED"):
            call(joined)
    assert len(peer.state.calls) == 3 and not any(call["host_auth"] for call in peer.state.calls[1:])


def test_response_binding_mismatch_does_not_hide_a_committed_heartbeat(peer):
    joined = peer.join()
    peer.state.mode = "different_id"
    # A foreign binding is a protocol violation, never an outage the worker tolerates.
    with pytest.raises(ChatError, match="INVALID_RESPONSE"):
        instance_client.heartbeat(joined, Heartbeat(native_state="busy", stopped=True, plan_mode=True))
    assert len(peer.state.calls) == 2
    assert instance_client.status(joined)["native_state"] == "busy"
    peer.state.mode = "different_id"
    with pytest.raises(ChatError, match="TRANSPORT_UNAVAILABLE"):
        instance_client.status(joined)


@pytest.mark.parametrize("mode", ["null_body", "invalid_json", "list_body"])
def test_a_malformed_200_is_invalid_for_pending_and_heartbeat_only(peer, mode):
    # the worker tolerates outages on these two, so a protocol violation must not look like one.
    joined = peer.join()
    peer.state.mode = mode
    with pytest.raises(ChatError, match="INVALID_RESPONSE"):
        instance_client.pending(joined)
    peer.state.mode = mode
    with pytest.raises(ChatError, match="INVALID_RESPONSE"):
        instance_client.heartbeat(joined, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    peer.state.mode = mode
    with pytest.raises(ChatError, match="TRANSPORT_UNAVAILABLE"):
        instance_client.status(joined)


@pytest.mark.parametrize(
    ("mode", "plain_get"), [("created_object", "HTTP_REFUSED"), ("no_content", "TRANSPORT_UNAVAILABLE")]
)
def test_another_complete_2xx_is_invalid_for_pending_and_heartbeat_only(peer, mode, plain_get):
    # A GET (pending) and a POST (heartbeat) that name `invalid` fail at once; a call without it keeps its code.
    joined = peer.join()
    peer.state.mode = mode
    with pytest.raises(ChatError, match="^INVALID_RESPONSE$"):
        instance_client.pending(joined)
    peer.state.mode = mode
    with pytest.raises(ChatError, match="^INVALID_RESPONSE$"):
        instance_client.heartbeat(joined, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    peer.state.mode = mode
    with pytest.raises(ChatError, match=f"^{plain_get}$"):
        instance_client.status(joined)


def test_a_server_reply_carrying_refused_is_invalid_not_an_outage(monkeypatch):
    # A gateway that answers 200 with the worker's own outage marker must not look like a tolerated outage.
    instance = _canned(
        monkeypatch,
        lambda instance_id, session_id: {
            "instance_id": instance_id, "session_id": session_id, "messages": [], "refused": "SERVICE_UNAVAILABLE"
        },
    )
    with pytest.raises(ChatError, match="^INVALID_RESPONSE$"):
        instance_client.heartbeat(instance, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    with pytest.raises(ChatError, match="^INVALID_RESPONSE$"):
        instance_client.pending(instance)
    with pytest.raises(ChatError, match="^TRANSPORT_UNAVAILABLE$"):
        instance_client.status(instance)


def _worker_frame(process: subprocess.Popen[str], frame: dict) -> dict:
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(json.dumps(frame) + "\n")
    process.stdin.flush()
    return json.loads(process.stdout.readline())


FAULTED = {
    "pending": ({"id": 1, "op": "pending"}, "/v1/instance/deliveries/pending", "TRANSPORT_UNAVAILABLE"),
    "heartbeat": (
        {"id": 1, "op": "heartbeat", "state": {"native_state": "idle", "stopped": False, "plan_mode": False}},
        "/v1/instance/heartbeat",
        "REQUEST_UNCERTAIN",
    ),
}


@pytest.mark.parametrize("operation", ["pending", "heartbeat"])
@pytest.mark.parametrize("mode", ["null_body", "invalid_json", "drop", "truncated", "bad_gateway"])
def test_a_live_worker_ends_on_a_malformed_200_but_rides_out_a_lost_connection(
    peer, credentials, db, operation, mode
):
    # through the real worker, client and server: only the faulted reply differs.
    frame, path, outage = FAULTED[operation]
    join = {
        "id": 0, "op": "join", "enabled": True, "directory": str(peer.directory),
        "native_session_id": "pi-native", "boot_id": str(peer.boot), "server_origin": peer.origin,
        "host_token": credentials.agent, "harness": "pi",
    }
    with subprocess.Popen(
        [sys.executable, "-m", "agent_chat.instance_worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=ROOT, env={},
    ) as process:
        try:
            assert "result" in _worker_frame(process, join)
            peer.state.mode = mode
            reply = _worker_frame(process, frame)
            if mode in ("drop", "truncated", "bad_gateway"):
                # The controls: a lost connection, a body cut short or a proxy error stays a tolerated outage.
                assert reply == {"id": 1, "result": {"refused": outage}}
                assert process.poll() is None
                assert process.stdin is not None
                process.stdin.close()
                assert process.wait(timeout=30) == 0
            else:
                # Stdin stays open: the protocol violation alone ends the worker.
                assert reply == {"id": 1, "error": {"code": "INVALID_RESPONSE"}}
                assert process.wait(timeout=30) == 1
            assert process.stderr is not None and process.stderr.read() == ""
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
    assert [call["path"] for call in peer.state.calls] == ["/v1/sessions", path, "/v1/instance/end"]
    assert db.execute("SELECT ended_at FROM agent_chat.instances").fetchone()["ended_at"] is not None


# #176: the worker sends a settlement again only when the request got no status, or a 5xx. Each test below runs the
# worker's settle through the real client and server, with the faulted reply set before it, and counts the POSTs that
# the server saw. `tests/agent_chat/test_instance_worker.py` tests the loop itself against a scripted client.
SETTLEMENT = {"outcome": "handed", "reason": None}


def _open_attempt(peer, process_api, credentials, send):
    """A joined instance that holds one granted attempt, and the attempt's id."""
    joined = peer.join()
    instance_client.heartbeat(joined, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    send(process_api, credentials, "synthetic coordination", kind="question", recipients=[str(joined.session_id)])
    # The boundary forwards no request headers, so the claim, which needs an Idempotency-Key, goes to the service.
    status, grant = process_api.request(
        "POST",
        "/v1/instance/deliveries/claim",
        {"messages": instance_client.pending(joined)["messages"]},
        joined.binding.token,
        {"Idempotency-Key": str(uuid4())},
    )
    assert (status, grant["dispatch"]) == (200, True)
    return joined, grant["attempt"]["id"]


def _settle_frame(attempt, result=SETTLEMENT):
    return {"id": 1, "op": "settle", "attempt": attempt, "result": result}


def _settle_posts(peer):
    return [call for call in peer.state.calls if call["path"].endswith("/result")]


def test_a_chat_error_is_answered_unless_the_client_marks_it_unanswered():
    assert ChatError("REQUEST_UNCERTAIN").unanswered is False
    assert ChatError("REQUEST_UNCERTAIN", unanswered=True).unanswered is True


@pytest.mark.parametrize("shape", ["unpinned", "unpinned_with_deadline", "pinned_with_deadline"])
def test_a_connection_that_is_refused_is_unanswered(shape):
    # The three ways the client connects: with the standard library's own connect, with a name that a child resolves
    # before a deadline, and to the addresses of a join before a deadline, which is how the worker's settle connects.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    pinned = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", port)),)
    instance = instance_client.JoinedInstance(
        InstanceSecret("refused-native", uuid4(), "1" * 64, f"http://127.0.0.1:{port}"),
        uuid4(), uuid4(), uuid4(), "synthetic-host", "pi",
        addresses=pinned if shape == "pinned_with_deadline" else (),
    )
    deadline = None if shape == "unpinned" else time.monotonic() + 10
    with pytest.raises(ChatError) as caught:
        instance_client.settle(instance, uuid4(), DeliveryResult(outcome="handed", reason=None), deadline=deadline)
    assert (caught.value.code, caught.value.unanswered) == ("TRANSPORT_UNAVAILABLE", True)


@pytest.mark.parametrize("delivery_enabled", [True])
@pytest.mark.parametrize(
    "mode", ["unavailable", "drop", "bad_gateway", "partial_status", "reset_in_headers"]
)
def test_the_worker_sends_a_settle_again_when_it_got_no_status_or_a_5xx(
    peer, process_api, credentials, send, db, mode
):
    # A 503 with the service's envelope, a connection lost before any reply, a proxy's 502, a status line cut short
    # and a reset inside the headers. The server has already settled the attempt, as it has when a reply is lost, so
    # the second POST gets the recorded result.
    joined, attempt = _open_attempt(peer, process_api, credentials, send)
    peer.state.mode = mode
    assert instance_worker._delivery(joined, _settle_frame(attempt)) == {"attempt_id": attempt, **SETTLEMENT}
    assert len(_settle_posts(peer)) == 2
    stored = db.execute("SELECT outcome, reason FROM agent_chat.delivery_attempts WHERE id = %s", (attempt,))
    assert stored.fetchone() == SETTLEMENT


@pytest.mark.parametrize("delivery_enabled", [True])
@pytest.mark.parametrize(
    "mode",
    [
        "redirect",
        "html_403",
        "unknown_code",
        "other_attempt",
        "many_headers",
        "bad_status",
        "status_600",
        "truncated",
        "reset_after_status",
        "unframed_cut",
        "chunked_cut",
        "chunked_bad_size",
        "redirect_cut",
        "redirect_header_cut",
    ],
)
def test_the_worker_does_not_send_a_settle_again_after_a_status_that_is_not_5xx(
    peer, process_api, credentials, send, mode
):
    # A redirect, a proxy's HTML 403, a 4xx with a code this client does not know, a 200 that names another attempt,
    # a complete reply with status 600, replies the HTTP parser rejects (too many headers, a status line that is not
    # HTTP), and replies cut after their status was read: in the body, by a reset, in chunked framing, and by an end
    # inside the headers, which http.client reads as their end (also for redirects). The client gives each the code
    # of a request that may have been sent, but the service sends a status below 500 only once the request is
    # committed or refused, so the error ends the worker after one POST.
    joined, attempt = _open_attempt(peer, process_api, credentials, send)
    peer.state.mode = mode
    with pytest.raises(ChatError) as caught:
        instance_worker._delivery(joined, _settle_frame(attempt))
    assert caught.value.code == "REQUEST_UNCERTAIN" and caught.value.unanswered is False
    assert len(_settle_posts(peer)) == 1


@pytest.mark.parametrize("operation", ["status", "pending"])
def test_a_get_is_refused_at_a_redirect_whose_body_never_completes(peer, operation):
    # The client refuses a redirect at its status line and never waits for its body.
    joined = peer.join()
    peer.state.mode = "redirect_chunked_cut"
    with pytest.raises(ChatError) as caught:
        getattr(instance_client, operation)(joined)
    assert (caught.value.code, caught.value.unanswered) == ("REDIRECT_REFUSED", False)


@pytest.mark.parametrize("delivery_enabled", [True])
def test_the_worker_answers_a_settle_that_the_server_refused_as_refused_and_sends_it_once(
    peer, process_api, credentials, send
):
    joined, attempt = _open_attempt(peer, process_api, credentials, send)
    instance_client.settle(joined, UUID(attempt), DeliveryResult(outcome="deferred", reason="busy"))
    peer.state.calls.clear()
    # Another outcome for a settled attempt is the ledger's definite refusal, DELIVERY_CLOSED.
    assert instance_worker._delivery(joined, _settle_frame(attempt)) == {"refused": "DELIVERY_CLOSED"}
    assert len(_settle_posts(peer)) == 1


def test_origin_conflict_and_invalid_host_token_refuse_before_registration(peer):
    peer.join()
    saved = peer.state.path.read_bytes()
    with pytest.raises(ChatError, match="BINDING_FILE_CONFLICT"):
        peer.join(server_origin="https://different.invalid")
    assert len(peer.state.calls) == 1 and peer.state.path.read_bytes() == saved
    with pytest.raises(ChatError):
        peer.join(process_boot=uuid4(), host_token="invalid\r\ncredential")
    assert not peer.state.path.exists() and len(peer.state.calls) == 1


class _Canned:
    """A server reply fixed by the test, for the response shapes a real server never sends."""

    reply: dict = {}

    def __init__(self, *_args, **_kwargs):
        pass

    def request(self, *_args, **_kwargs):
        return json.loads(json.dumps(self.reply))


def _canned(monkeypatch, reply):
    """A joined instance whose server answers `reply(instance_id, session_id)` to every request."""
    instance = SimpleNamespace(
        binding=SimpleNamespace(server_origin="http://127.0.0.1:9", token="t"), instance_id=uuid4(), session_id=uuid4()
    )
    fixed = reply(str(instance.instance_id), str(instance.session_id))
    monkeypatch.setattr(instance_client, "Client", type("Canned", (_Canned,), {"reply": fixed}))
    return instance


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"sizes": {}, "retry": False},
        {"sizes": {"ID": 5, "other": 5}, "retry": False},
        {"sizes": {"ID": True}, "retry": False},
        {"sizes": {"ID": -1}, "retry": False},
        {"sizes": {"ID": 5.0}, "retry": False},
        {"sizes": {"ID": "5"}, "retry": False},
        {"sizes": ["ID"], "retry": False},
        {"sizes": {"ID": 5}, "retry": 0},
        {"sizes": {"ID": 5}},
        {"retry": False},
    ],
)
def test_pending_sizing_validates_what_the_server_sent(monkeypatch, extra):
    message = str(uuid4())
    sizes = extra.get("sizes")
    if isinstance(sizes, dict):
        extra = {**extra, "sizes": {(message if key == "ID" else key): value for key, value in sizes.items()}}
    elif sizes is not None:
        extra = {**extra, "sizes": [message]}
    instance = _canned(
        monkeypatch,
        lambda instance_id, session_id: {
            "instance_id": instance_id,
            "session_id": session_id,
            "messages": [message],
            **extra,
        },
    )
    if not extra:
        # An older server sends no sizing: the result keeps its old shape and the caller claims the whole list.
        assert instance_client.pending(instance, True) == {"messages": [message]}
    else:
        with pytest.raises(ChatError, match="INVALID_RESPONSE"):
            instance_client.pending(instance, True)
    # Without sizing the result never changes, whatever the server sent.
    assert instance_client.pending(instance) == {"messages": [message]}


def _granted(message, **changes):
    now = datetime.now(UTC)
    row = {
        "id": message,
        "room_id": str(uuid4()),
        "history_after": "7",
        "kind": "question",
        "body": "hello",
        "sender": {"principal_id": str(uuid4()), "session_id": str(uuid4())},
        "created_at": now.isoformat(),
        "thread_id": str(uuid4()),
        "secret_upstream_extra": "never",
    }
    row.update(changes)
    return row


def _grant_reply(instance_id, rows):
    admitted = datetime.now(UTC)
    return {
        "dispatch": True,
        "attempt": {
            "id": str(uuid4()),
            "instance_id": instance_id,
            "admitted_at": admitted.isoformat(),
            "expires_at": (admitted + timedelta(seconds=20)).isoformat(),
            "outcome": None,
        },
        "messages": rows,
    }


@pytest.mark.parametrize("bodies", [False, True])
def test_claim_whitelist_names_every_field_and_drops_upstream_extras(monkeypatch, bodies):
    message = str(uuid4())
    instance = _canned(monkeypatch, lambda instance_id, _session: _grant_reply(instance_id, [_granted(message)]))
    grant = instance_client.claim(instance, uuid4(), DeliveryClaim(messages=[message]), bodies)
    row = grant["messages"][0]
    assert "secret_upstream_extra" not in json.dumps(grant)
    assert ("body" in row) is bodies and ("admitted_at" in grant) is bodies
    if bodies:
        assert row["body"] == "hello" and row["body_truncated"] is False


@pytest.mark.parametrize(
    "changes",
    [
        {"body": ""},
        {"body": 5},
        {"sender": None},
        {"sender": {"principal_id": "not-a-uuid", "session_id": None}},
        {"sender": {"principal_id": str(uuid4()), "session_id": 5}},
        {"created_at": "2026-01-01T00:00:00"},
        {"created_at": "yesterday"},
        # Valid with an offset, but not representable in UTC: bodies mode writes UTC and refuses it.
        {"created_at": "9999-12-31T23:59:59-05:00"},
        {"created_at": "0001-01-01T00:00:00+05:00"},
        {"thread_id": "x"},
    ],
)
def test_claim_with_bodies_refuses_invalid_content_as_uncertain(monkeypatch, changes):
    message = str(uuid4())
    instance = _canned(
        monkeypatch, lambda instance_id, _session: _grant_reply(instance_id, [_granted(message, **changes)])
    )
    with pytest.raises(ChatError, match="REQUEST_UNCERTAIN"):
        instance_client.claim(instance, uuid4(), DeliveryClaim(messages=[message]), True)
    # The same row is fine for the metadata grant: only bodies mode reads these fields.
    assert instance_client.claim(instance, uuid4(), DeliveryClaim(messages=[message]))["dispatch"] is True


@pytest.mark.parametrize("refused", [False, True])
def test_a_claim_or_settlement_carrying_refused_is_uncertain(monkeypatch, refused):
    # The claim and settlement paths call the server directly: the worker's outage marker there is uncertain too.
    message, attempt = str(uuid4()), uuid4()
    marker = {"refused": "SERVICE_UNAVAILABLE"} if refused else {}
    instance = _canned(
        monkeypatch, lambda instance_id, _session: {**_grant_reply(instance_id, [_granted(message)]), **marker}
    )
    claim = DeliveryClaim(messages=[message])
    if refused:
        with pytest.raises(ChatError, match="^REQUEST_UNCERTAIN$"):
            instance_client.claim(instance, uuid4(), claim)
    else:
        assert instance_client.claim(instance, uuid4(), claim)["dispatch"] is True
    result = DeliveryResult(outcome="handed")
    instance = _canned(
        monkeypatch,
        lambda instance_id, _session: {
            "instance_id": instance_id, "id": str(attempt), "outcome": "handed", "reason": None, **marker
        },
    )
    if refused:
        with pytest.raises(ChatError, match="^REQUEST_UNCERTAIN$"):
            instance_client.settle(instance, attempt, result)
    else:
        assert instance_client.settle(instance, attempt, result)["outcome"] == "handed"


def _grant_at(instance_id, rows, admitted_at, expires_at):
    reply = _grant_reply(instance_id, rows)
    reply["attempt"].update(admitted_at=admitted_at, expires_at=expires_at)
    return reply


def test_claim_with_bodies_writes_both_server_times_in_utc(monkeypatch):
    # Python reads an offset with seconds; the Node renderer reads only +HH:MM, so the claim writes UTC.
    message = str(uuid4())
    row = _granted(message, created_at="2026-10-30T12:00:00+05:30:15")
    instance = _canned(
        monkeypatch,
        lambda instance_id, _session: _grant_at(
            instance_id, [row], "2026-10-30T12:00:01.250000+05:30:15", "2026-10-30T12:00:21+05:30:15"
        ),
    )
    grant = instance_client.claim(instance, uuid4(), DeliveryClaim(messages=[message]), True)
    assert grant["messages"][0]["created_at"] == "2026-10-30T06:29:45+00:00"
    assert grant["admitted_at"] == "2026-10-30T06:29:46.250000+00:00"
    assert grant["reservation_ms"] == 19_750


def test_claim_with_bodies_refuses_a_grant_time_it_cannot_write_in_utc(monkeypatch):
    message = str(uuid4())
    instance = _canned(
        monkeypatch,
        lambda instance_id, _session: _grant_at(
            instance_id, [_granted(message)], "9999-12-31T23:59:50-05:00", "9999-12-31T23:59:59-05:00"
        ),
    )
    with pytest.raises(ChatError, match="REQUEST_UNCERTAIN"):
        instance_client.claim(instance, uuid4(), DeliveryClaim(messages=[message]), True)
    # The metadata grant never writes the time, so the same grant is fine there.
    assert instance_client.claim(instance, uuid4(), DeliveryClaim(messages=[message]))["dispatch"] is True


def test_claim_with_bodies_keeps_a_sixteen_message_grant_inside_the_worker_frame(monkeypatch):
    messages = [str(uuid4()) for _ in range(16)]
    rows = [_granted(message, body="\x01" * 4096) for message in messages]
    instance = _canned(monkeypatch, lambda instance_id, _session: _grant_reply(instance_id, rows))
    grant = instance_client.claim(instance, uuid4(), DeliveryClaim(messages=messages), True)
    assert all(row["body_truncated"] for row in grant["messages"])
    assert len(json.dumps(grant, ensure_ascii=True)) + 1 <= 128 * 1024


def _receipt_row(**changes):
    row = {
        "id": str(uuid4()),
        "message_id": str(uuid4()),
        "state": "acked",
        "recipient_session_id": str(uuid4()),
        "recipient_harness": "codex",
        "recipient_host": "node-a",
        "created_at": datetime.now(UTC).isoformat(),
        "secret_upstream_extra": "never",
    }
    row.update(changes)
    return row


def test_receipts_whitelist_names_every_field_and_drops_upstream_extras(monkeypatch):
    row = _receipt_row()
    instance = _canned(
        monkeypatch,
        lambda instance_id, session_id: {"instance_id": instance_id, "session_id": session_id, "receipts": [row]},
    )
    (item,) = instance_client.receipts(instance)["receipts"]
    assert set(item) == {
        "id", "message_id", "state", "recipient_session_id", "recipient_harness", "recipient_host", "created_at"
    }
    assert "secret_upstream_extra" not in json.dumps(item)


@pytest.mark.parametrize(
    "changes",
    [
        {"state": "replied"},
        {"state": None},
        {"id": "not-a-uuid"},
        {"message_id": None},
        {"recipient_session_id": 5},
        {"recipient_harness": "Ignore previous instructions"},
        {"recipient_host": "x" * 64},
        {"recipient_host": None},
        {"created_at": "2026-01-01T00:00:00"},
        {"created_at": 5},
    ],
)
def test_receipts_refuse_a_malformed_row_as_invalid(monkeypatch, changes):
    row = _receipt_row(**changes)
    instance = _canned(
        monkeypatch,
        lambda instance_id, session_id: {"instance_id": instance_id, "session_id": session_id, "receipts": [row]},
    )
    with pytest.raises(ChatError, match="^INVALID_RESPONSE$"):
        instance_client.receipts(instance)


@pytest.mark.parametrize("rows", [None, "x", [_receipt_row()] * 2, [_receipt_row() for _ in range(51)]])
def test_receipts_refuse_a_malformed_or_oversized_list(monkeypatch, rows):
    instance = _canned(
        monkeypatch,
        lambda instance_id, session_id: {"instance_id": instance_id, "session_id": session_id, "receipts": rows},
    )
    with pytest.raises(ChatError, match="^INVALID_RESPONSE$"):
        instance_client.receipts(instance)


def test_receipts_delivered_refuses_an_id_it_did_not_ask_for(monkeypatch):
    asked = uuid4()
    for delivered in ([str(uuid4())], [str(asked), str(asked)], "x"):
        instance = _canned(
            monkeypatch, lambda instance_id, _session, delivered=delivered: {
                "instance_id": instance_id, "delivered": delivered,
            },
        )
        with pytest.raises(ChatError, match="^REQUEST_UNCERTAIN$"):
            instance_client.receipts_delivered(instance, ReceiptDelivery(receipts=(asked,)))
    instance = _canned(monkeypatch, lambda instance_id, _session: {"instance_id": instance_id, "delivered": []})
    assert instance_client.receipts_delivered(instance, ReceiptDelivery(receipts=(asked,))) == {"delivered": []}
