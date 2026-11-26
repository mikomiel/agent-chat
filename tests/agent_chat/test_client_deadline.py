"""The Client's monotonic deadline bounds slow-drip and later requests.

The socket timeout limits one receive, not elapsed time, so a peer that drips
inside that timeout is the interesting case: the body test below, and the raw
peers that keep the status line, a header line or chunk framing open. Those
three parse inside ``http.client`` without returning to the budget check, so
only interrupting the socket bounds them.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Event, Thread
from typing import Any, cast

import pytest

from agent_chat import client as client_module
from agent_chat.client import Client
from agent_chat.models import ChatError

BINDING_VALUE = "0123456789abcdef" * 4


class _DripHandler(BaseHTTPRequestHandler):
    """A peer that keeps the body open one chunk at a time, well inside the socket timeout."""

    hits: dict[str, int] = {"GET": 0, "POST": 0}

    def log_message(self, format, *args):  # noqa: A002 - the stdlib signature
        pass

    def _drip(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "4096")
        self.end_headers()
        try:
            for _ in range(80):
                self.wfile.write(b" ")
                self.wfile.flush()
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:
        self.hits["GET"] += 1
        self._drip()

    def do_POST(self) -> None:
        self.hits["POST"] += 1
        self._drip()


@pytest.fixture
def drip_server():
    _DripHandler.hits = {"GET": 0, "POST": 0}
    server = HTTPServer(("127.0.0.1", 0), _DripHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def test_a_slow_drip_cannot_outlast_the_deadline(drip_server: str) -> None:
    client = Client(drip_server, BINDING_VALUE, deadline=time.monotonic() + 0.4)
    started = time.monotonic()

    with pytest.raises(ChatError) as error:
        client.request("GET", "/v1/rooms")
    assert error.value.code == "CLI_INTERRUPTED"
    assert time.monotonic() - started < 3

    # The budget is spent: neither a later read nor a publication reaches the server.
    with pytest.raises(ChatError) as error:
        client.request("GET", "/v1/rooms")
    assert error.value.code == "CLI_INTERRUPTED"
    with pytest.raises(ChatError):
        client.request("POST", "/v1/rooms", {"action": "publish"})

    assert _DripHandler.hits == {"GET": 1, "POST": 0}


@pytest.fixture
def resolver_process(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Callable[[str], list[subprocess.Popen[bytes]]]]:
    """Substitute only the resolver child, retaining real timeout and reaping semantics."""
    popen = subprocess.Popen
    children: list[subprocess.Popen[bytes]] = []

    def install(source: str) -> list[subprocess.Popen[bytes]]:
        def launch(command: list[str], **kwargs: Any) -> subprocess.Popen[bytes]:
            command = list(command)
            command[command.index("-c") + 1] = source
            child = cast("subprocess.Popen[bytes]", popen(command, **kwargs))
            children.append(child)
            return child

        monkeypatch.setattr(subprocess, "Popen", launch)
        return children

    try:
        yield install
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_stalled_dns_is_interrupted_and_reaped(
    scheme: str,
    drip_server: str,
    monkeypatch: pytest.MonkeyPatch,
    resolver_process: Callable[[str], list[subprocess.Popen[bytes]]],
) -> None:
    port = int(drip_server.rsplit(":", 1)[1])
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    def stalled(*_args: Any, **_kwargs: Any) -> list[Any]:
        time.sleep(1.2)
        return addresses

    # The old in-process resolver must encounter the same delay as the child.
    monkeypatch.setattr(socket, "getaddrinfo", stalled)
    children = resolver_process("import time; time.sleep(1.2)")
    hostname = "127.0.0.1" if scheme == "http" else "chat.example.test"
    client = Client(f"{scheme}://{hostname}:{port}", BINDING_VALUE, deadline=time.monotonic() + 0.3)
    started = time.monotonic()

    with pytest.raises(ChatError) as error:
        client.request("GET", "/v1/rooms")
    assert error.value.code == "CLI_INTERRUPTED"
    assert time.monotonic() - started < 0.9
    assert len(children) == 1
    assert children[0].poll() is not None

    for method in ("GET", "POST"):
        with pytest.raises(ChatError) as error:
            client.request(method, "/v1/rooms")
        assert error.value.code == "CLI_INTERRUPTED"
    assert len(children) == 1
    assert _DripHandler.hits == {"GET": 0, "POST": 0}


def test_address_attempts_share_the_remaining_deadline(
    drip_server: str,
    monkeypatch: pytest.MonkeyPatch,
    resolver_process: Callable[[str], list[subprocess.Popen[bytes]]],
) -> None:
    port = int(drip_server.rsplit(":", 1)[1])
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))] * 8
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: addresses)
    children = resolver_process(f"print({json.dumps(addresses)!r})")
    attempts: list[socket.socket] = []
    timeouts: list[float] = []

    class Unreachable(socket.socket):
        def connect(self, address: Any) -> None:
            attempts.append(self)
            timeout = self.gettimeout()
            assert timeout is not None
            timeouts.append(timeout)
            time.sleep(min(0.15, timeout))
            raise TimeoutError("synthetic unreachable address")

    monkeypatch.setattr(socket, "socket", Unreachable)
    client = Client(drip_server, BINDING_VALUE, deadline=time.monotonic() + 0.4)
    started = time.monotonic()

    with pytest.raises(ChatError) as error:
        client.request("GET", "/v1/rooms")
    assert error.value.code == "CLI_INTERRUPTED"
    assert time.monotonic() - started < 0.9
    assert 2 <= len(attempts) < len(addresses)
    assert all(later < earlier for earlier, later in zip(timeouts, timeouts[1:]))
    assert all(attempt.fileno() == -1 for attempt in attempts)
    assert len(children) == 1 and children[0].poll() is not None

    before = len(attempts)
    for method in ("GET", "POST"):
        with pytest.raises(ChatError) as error:
            client.request(method, "/v1/rooms")
        assert error.value.code == "CLI_INTERRUPTED"
    assert len(attempts) == before
    assert _DripHandler.hits == {"GET": 0, "POST": 0}


class _RawPeer:
    """A raw TCP peer that sends *opening*, then one byte per interval.

    The interval sits below the socket timeout, so an inactivity timeout alone
    can never end the read. ``hold`` stops the drip, so a regression fails on
    the elapsed-time assertion instead of hanging the suite.
    """

    def __init__(self, opening: bytes | None, *, interval: float = 0.05, hold: float = 8.0) -> None:
        self._opening = opening
        self._interval = interval
        self._hold = hold
        self._closing = Event()
        self.hits = 0
        self.closed = Event()
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(1)
        self.port = self._listener.getsockname()[1]
        self._thread = Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._closing.is_set():
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            self.hits += 1
            try:
                connection.settimeout(2)
                try:
                    connection.recv(65536)
                except OSError:
                    pass
                if self._opening is None:
                    # A silent TLS peer: wait for the client to close its handshake.
                    while connection.recv(65536):
                        pass
                    continue
                connection.sendall(self._opening)
                stopped = time.monotonic() + self._hold
                while not self._closing.is_set() and time.monotonic() < stopped:
                    connection.sendall(b" ")
                    time.sleep(self._interval)
                time.sleep(self._interval)
            except OSError:
                pass
            finally:
                self.closed.set()
                connection.close()

    def close(self) -> None:
        self._closing.set()
        try:
            self._listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._listener.close()
        self._thread.join(timeout=3)
        assert not self._thread.is_alive()


@pytest.mark.parametrize("failure", ["socket", "connect"])
def test_a_failed_address_does_not_hide_a_working_address(
    failure: str,
    monkeypatch: pytest.MonkeyPatch,
    resolver_process: Callable[[str], list[subprocess.Popen[bytes]]],
) -> None:
    peer = _RawPeer(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", peer.port))] * 2
    resolver_process(f"print({json.dumps(addresses)!r})")
    make_socket = socket.socket
    attempts = 0
    refused: list[socket.socket] = []

    class Refused(socket.socket):
        def connect(self, address: Any) -> None:
            raise ConnectionRefusedError("synthetic refused address")

    def socket_factory(*args: Any, **kwargs: Any) -> socket.socket:
        nonlocal attempts
        # accept() wraps a descriptor for the peer; only count client factories.
        if kwargs.get("fileno") is not None:
            return make_socket(*args, **kwargs)
        attempts += 1
        if attempts == 1:
            if failure == "socket":
                raise OSError("synthetic unsupported address family")
            transport = Refused(*args, **kwargs)
            refused.append(transport)
            return transport
        return make_socket(*args, **kwargs)

    monkeypatch.setattr(socket, "socket", socket_factory)
    try:
        client = Client(f"http://127.0.0.1:{peer.port}", BINDING_VALUE, deadline=time.monotonic() + 1)
        assert client.request("GET", "/v1/rooms") == {}
        assert attempts == 2
        assert all(transport.fileno() == -1 for transport in refused)
        assert peer.closed.wait(timeout=1)
        assert peer.hits == 1
    finally:
        peer.close()


def test_resolver_failure_is_a_value_free_transport_refusal(
    drip_server: str,
    resolver_process: Callable[[str], list[subprocess.Popen[bytes]]],
) -> None:
    children = resolver_process("raise OSError('synthetic DNS failure')")
    client = Client(drip_server, BINDING_VALUE, deadline=time.monotonic() + 1)
    with pytest.raises(ChatError) as error:
        client.request("GET", "/v1/rooms")
    assert error.value.code == "TRANSPORT_UNAVAILABLE"
    assert children[0].poll() is not None
    assert _DripHandler.hits == {"GET": 0, "POST": 0}


@pytest.mark.parametrize(
    ("status", "payload"),
    [
        ("200 OK", '{"ok": true}'),
        ("403 Forbidden", '{"error": {"code": "ROOM_FORBIDDEN"}}'),
    ],
    ids=["success", "response-error"],
)
def test_decoding_cannot_return_a_result_after_the_deadline(
    status: str, payload: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = payload.encode("utf-8")
    peer = _RawPeer(
        f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    loads = json.loads
    deadline = time.monotonic() + 1
    decoded = False

    def delayed_loads(value: Any, *args: Any, **kwargs: Any) -> Any:
        nonlocal decoded
        result = loads(value, *args, **kwargs)
        if value == payload:
            # Only the final response decoder pauses, not DNS-result decoding.
            assert time.monotonic() < deadline
            decoded = True
            time.sleep(max(0.0, deadline - time.monotonic()) + 0.05)
        return result

    monkeypatch.setattr(json, "loads", delayed_loads)
    try:
        client = Client(f"http://127.0.0.1:{peer.port}", BINDING_VALUE, deadline=deadline)
        with pytest.raises(ChatError) as error:
            client.request("GET", "/v1/rooms")
        assert decoded
        assert error.value.code == "CLI_INTERRUPTED"
        assert peer.closed.wait(timeout=1)
        for method in ("GET", "POST"):
            with pytest.raises(ChatError) as error:
                client.request(method, "/v1/rooms")
            assert error.value.code == "CLI_INTERRUPTED"
        assert peer.hits == 1
    finally:
        peer.close()


def test_tls_handshake_gets_only_the_post_connect_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    peer = _RawPeer(None)

    class SlowConnect(socket.socket):
        def connect(self, address: Any) -> None:
            time.sleep(0.3)
            super().connect(address)

    monkeypatch.setattr(socket, "socket", SlowConnect)
    try:
        client = Client(f"https://127.0.0.1:{peer.port}", BINDING_VALUE, deadline=time.monotonic() + 0.5)
        started = time.monotonic()
        with pytest.raises(ChatError) as error:
            client.request("GET", "/v1/rooms")
        assert error.value.code == "CLI_INTERRUPTED"
        assert time.monotonic() - started < 0.7
        assert peer.closed.wait(timeout=1)
        with pytest.raises(ChatError) as error:
            client.request("POST", "/v1/rooms")
        assert error.value.code == "CLI_INTERRUPTED"
        assert peer.hits == 1
    finally:
        peer.close()


@pytest.mark.parametrize(
    "opening",
    [
        b"HTTP/1.1 200 OK",
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Unfinished: ",
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1",
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n1",
    ],
    ids=["status-line", "header-line", "chunk-framing", "connection-close-chunk-framing"],
)
def test_a_dripping_header_or_framing_cannot_outlast_the_deadline(opening: bytes) -> None:
    peer = _RawPeer(opening)
    try:
        client = Client(f"http://127.0.0.1:{peer.port}", BINDING_VALUE, deadline=time.monotonic() + 0.4)
        started = time.monotonic()

        with pytest.raises(ChatError) as error:
            client.request("GET", "/v1/rooms")
        assert error.value.code == "CLI_INTERRUPTED"
        assert time.monotonic() - started < 3

        # The interrupted connection is closed rather than abandoned mid-read.
        assert peer.closed.wait(timeout=3)

        # The budget is spent: no later request reaches the peer.
        with pytest.raises(ChatError) as error:
            client.request("POST", "/v1/rooms", {"action": "publish"})
        assert error.value.code == "CLI_INTERRUPTED"
        assert peer.hits == 1
    finally:
        peer.close()


class _Cancelled(Exception):
    """What the handlers in the next tests raise: stands for the worker's `Interrupted`."""


def _timer_signalling_in_start(
    started: list[threading.Timer], phase: dict[str, bool], signal_now: Callable[[], None]
) -> type[threading.Timer]:
    """A Timer whose `start` first runs `signal_now`, and records that it is inside the start while it does."""

    class SignallingTimer(threading.Timer):
        def start(self) -> None:
            started.append(self)
            phase["in_start"] = True
            try:
                signal_now()
                super().start()
            finally:
                phase["in_start"] = False

    return SignallingTimer


@pytest.mark.skipif(not hasattr(signal, "pthread_sigmask"), reason="no POSIX signal masks")
def test_a_raising_signal_handler_never_runs_inside_the_watchdog_start(monkeypatch: pytest.MonkeyPatch) -> None:
    # Review 6065344121 (P2): the worker's receipts cancel raises from its handler, and a raise inside `Thread.start`,
    # in its wait on an internal condition, is not safe. A signal mask blocks only the thread that sets it. The kernel
    # gives a signal that is aimed at the process to any other thread that does not block it, and the interpreter then
    # runs the handler on the main thread wherever that is, the start included. So the handler asks first
    # (`defer_signal`), and the watchdog runs it again once the start is over and cancels its timer as the exception
    # leaves. `sink` is the other thread: the outcome does not depend on the runner having one, as pytest-xdist does.
    deferred: list[int] = []  # each call that was asked to wait
    ran: list[bool] = []  # each call that did the handler's work: was it inside the start?
    started: list[threading.Timer] = []
    phase = {"in_start": False}

    def handler(signum: int, _frame: Any) -> None:
        if client_module.defer_signal(signum):
            deferred.append(signum)
            return
        ran.append(phase["in_start"])
        raise _Cancelled

    def signal_inside_the_start() -> None:
        os.kill(os.getpid(), signal.SIGUSR1)
        # `kill` returns before `sink` has taken the signal, and the interpreter runs the handler on this thread
        # between two statements. Wait for that here, so the signal always lands inside the start. Bounded: a signal
        # that never comes fails the test, it does not hang it.
        give_up = time.monotonic() + 5
        while not (deferred or ran) and time.monotonic() < give_up:
            time.sleep(0.005)
        assert deferred or ran, "the signal never reached the handler"

    release = threading.Event()
    sink = threading.Thread(target=release.wait, daemon=True)
    sink.start()
    previous = signal.signal(signal.SIGUSR1, handler)
    try:
        monkeypatch.setattr(
            client_module.threading, "Timer", _timer_signalling_in_start(started, phase, signal_inside_the_start)
        )
        with socket.socket() as transport, pytest.raises(_Cancelled):
            client_module._DeadlineWatchdog(time.monotonic() + 30, transport)
    finally:
        signal.signal(signal.SIGUSR1, previous)
        release.set()
        sink.join(timeout=5)
    assert ran == [False]  # the handler did its work once, and after the start
    assert deferred == [signal.SIGUSR1]  # and it had been asked to wait once, inside it
    assert len(started) == 1
    started[0].join(timeout=5)
    assert not started[0].is_alive()  # cancelled: it ended long before its 30 s interval


@pytest.mark.skipif(not hasattr(signal, "pthread_sigmask"), reason="no POSIX signal masks")
def test_a_handler_that_does_not_defer_waits_for_the_signal_mask(monkeypatch: pytest.MonkeyPatch) -> None:
    # The other guard, for a handler that never calls `defer_signal`, as the default SIGINT handler does not. The
    # signal is aimed at the main thread itself, which blocks it while the timer starts, so it waits there whatever
    # other threads the runner has, and the handler runs when the mask is lifted, after the start.
    ran: list[bool] = []
    started: list[threading.Timer] = []
    phase = {"in_start": False}

    def handler(_signum: int, _frame: Any) -> None:
        ran.append(phase["in_start"])
        raise _Cancelled

    previous = signal.signal(signal.SIGUSR1, handler)
    try:
        monkeypatch.setattr(
            client_module.threading,
            "Timer",
            _timer_signalling_in_start(
                started, phase, lambda: signal.pthread_kill(threading.get_ident(), signal.SIGUSR1)
            ),
        )
        with socket.socket() as transport, pytest.raises(_Cancelled):
            client_module._DeadlineWatchdog(time.monotonic() + 30, transport)
    finally:
        signal.signal(signal.SIGUSR1, previous)
    assert ran == [False]
    assert len(started) == 1
    started[0].join(timeout=5)
    assert not started[0].is_alive()  # cancelled: it ended long before its 30 s interval


@pytest.mark.skipif(not hasattr(signal, "SIGUSR2"), reason="no POSIX signals")
def test_every_deferred_handler_runs_once_even_when_an_earlier_one_raises() -> None:
    # The worker's cancel raises, and its SIGTERM handler records that it came before it raises too. A cancel that
    # raised first must not hide the SIGTERM behind it: that would answer `refused` and serve on after a stop.
    worked: list[int] = []

    class First(Exception):
        pass

    class Second(Exception):
        pass

    def raising(error: type[Exception]) -> Callable[[int, Any], None]:
        def handler(signum: int, _frame: Any) -> None:
            if client_module.defer_signal(signum):
                return
            worked.append(signum)
            raise error

        return handler

    previous = [signal.signal(signal.SIGUSR1, raising(First)), signal.signal(signal.SIGUSR2, raising(Second))]
    try:
        with pytest.raises(First):  # the first exception leaves, the second is dropped
            with client_module._deferring_signals():
                signal.raise_signal(signal.SIGUSR1)
                signal.raise_signal(signal.SIGUSR2)
                signal.raise_signal(signal.SIGUSR1)  # the same signal again: recorded once, as the kernel would
                assert worked == []  # none of them did its work inside the block
        assert worked == [signal.SIGUSR1, signal.SIGUSR2]
        assert client_module.defer_signal(signal.SIGUSR1) is False  # and nothing is deferred once it is over
    finally:
        signal.signal(signal.SIGUSR1, previous[0])
        signal.signal(signal.SIGUSR2, previous[1])


def test_nothing_is_deferred_off_the_main_thread() -> None:
    answers: list[bool] = []

    def other_thread() -> None:
        with client_module._deferring_signals():
            answers.append(client_module.defer_signal(signal.SIGINT))  # a handler never runs here: nothing to hold

    thread = threading.Thread(target=other_thread)
    thread.start()
    thread.join(timeout=5)
    assert answers == [False]
