"""The worker resolves the server host once at join; later requests connect to those addresses only.

The servers here are private loopback peers and every credential is synthetic. A named host needs HTTPS, so
the TLS wrap is replaced by one that records the verified name and keeps the plain socket.
"""

from __future__ import annotations

import io
import json
import os
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest

from agent_chat import client, instance_client, instance_file, instance_worker
from agent_chat.instance_file import InstanceSecret, prepare_instance, read_instance
from agent_chat.models import ChatError, Heartbeat

ROOT = Path(__file__).resolve().parents[2]
HOST_TOKEN = secrets.token_hex(32)  # a fresh fake host token per run
HOSTNAME = "chat.example.test"
IDLE = Heartbeat(native_state="idle", stopped=False, plan_mode=False)


def _refused_port() -> int:
    """A loopback port that nothing listens on, so a connect to it is refused at once."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _entry(port: int) -> list[Any]:
    """One getaddrinfo row as the resolver child prints it."""
    return [socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ["127.0.0.1", port]]


@pytest.fixture
def children(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[subprocess.Popen[bytes]]]:
    """Every resolver child started in this process, killed by its exact handle if a test leaves one."""
    popen = subprocess.Popen
    started: list[subprocess.Popen[bytes]] = []

    def launch(*args: Any, **kwargs: Any) -> subprocess.Popen[bytes]:
        child = popen(*args, **kwargs)
        started.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", launch)
    try:
        yield started
    finally:
        for child in started:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)


class _Server:
    """A loopback peer that answers the lifecycle paths for one synthetic binding and records each Host header."""

    def __init__(self) -> None:
        self.session_id, self.instance_id = str(uuid4()), str(uuid4())
        self.hosts: list[tuple[str, str]] = []
        state = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the stdlib signature
                pass

            def _answer(self) -> None:
                state.hosts.append((self.path, self.headers.get("Host", "")))
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                binding = {"instance_id": state.instance_id, "session_id": state.session_id}
                if self.path == "/v1/sessions":
                    result = binding | {"room_id": str(uuid4()), "host": "synthetic-host", "harness": "pi"}
                else:
                    result = binding
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _answer

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_port
        self._thread = Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=3)


@pytest.fixture
def server() -> Iterator[_Server]:
    peer = _Server()
    try:
        yield peer
    finally:
        peer.close()


def test_requests_after_join_never_resolve_and_keep_the_host_name(
    server: _Server, children: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Fails on the old code: join_instance has no join-time resolution and the binding keeps no addresses."""
    refused = _refused_port()
    # The child lists an address that refuses first, then the peer: the getaddrinfo order is kept.
    monkeypatch.setattr(client, "_RESOLVER", f"print({json.dumps([_entry(refused), _entry(server.port)])!r})")
    verified: list[str | None] = []

    def plain_wrap(
        _context: ssl.SSLContext, transport: socket.socket, *, server_hostname: str | None = None, **_kwargs: Any
    ) -> socket.socket:
        verified.append(server_hostname)
        return transport  # the peer speaks plain HTTP; only the verified name matters here

    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", plain_wrap)
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    origin = f"https://{HOSTNAME}:{server.port}"

    instance = instance_client.join_instance(
        directory,
        "resolve-native",
        uuid4(),
        server_origin=origin,
        host_token=HOST_TOKEN,
        harness="pi",
        enabled=True,
        resolve_by=time.monotonic() + 5,
    )
    assert len(children) == 1 and children[0].returncode == 0
    assert instance.addresses == (
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", refused)),
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", server.port)),
    )

    def no_lookup(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a request after the join looked the host up")

    # Neither the in-process resolver nor a resolver child may run once the binding exists.
    monkeypatch.setattr(socket, "getaddrinfo", no_lookup)
    monkeypatch.setattr(subprocess, "Popen", no_lookup)
    assert instance_client.heartbeat(instance, IDLE)["instance_id"] == server.instance_id
    assert instance_client.status(instance)["session_id"] == server.session_id
    assert instance_client.end(instance)["instance_id"] == server.instance_id

    assert [path for path, _host in server.hosts] == [
        "/v1/sessions",
        "/v1/instance/heartbeat",
        "/v1/instance/status",
        "/v1/instance/end",
    ]
    assert {host for _path, host in server.hosts} == {f"{HOSTNAME}:{server.port}"}
    assert verified == [HOSTNAME] * 4


def test_a_hanging_resolver_at_join_is_bounded_by_the_join_deadline(
    children: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Fails on the old code: the join resolved in process, so the stalled lookup held it for the full stall."""

    def stalled(*_args: Any, **_kwargs: Any) -> Any:
        time.sleep(3)
        raise socket.gaierror("synthetic stalled lookup")

    # The old in-process resolver meets the same stall as the child, so only the bound differs.
    monkeypatch.setattr(socket, "getaddrinfo", stalled)
    monkeypatch.setattr(client, "_RESOLVER", "import time; time.sleep(30)")
    monkeypatch.setattr(instance_worker, "REQUEST_SECONDS", 0.5)
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    frame = {
        "id": 0,
        "op": "join",
        "enabled": True,
        "directory": str(directory),
        "native_session_id": "stall-native",
        "boot_id": str(uuid4()),
        "server_origin": f"https://{HOSTNAME}:8443",
        "host_token": HOST_TOKEN,
        "harness": "pi",
    }
    started = time.monotonic()
    with pytest.raises(ChatError) as error:
        instance_worker._join(frame)
    assert time.monotonic() - started < 2
    # The code that a failed connection has, which every integration's rejoin policy already handles.
    assert error.value.code == "TRANSPORT_UNAVAILABLE"
    assert len(children) == 1 and children[0].poll() is not None
    # The join never removes its record: it stays for a retry of the same boot or the next start's stale sweep.
    assert [path.name for path in directory.iterdir()] == [f"{frame['boot_id']}.json"]


def test_the_worker_alarm_cuts_a_hanging_join_lookup_short_as_a_transport_refusal(
    children: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The production order: the alarm armed before the join frame fires before the lookup's own deadline.

    Fails on the old code: no resolver child exists, and the in-process lookup is not the replaced stall. This pins
    the code and the reaped child on the alarm's path, the one the worker takes in production.
    """
    monkeypatch.setattr(client, "_RESOLVER", "import time; time.sleep(30)")
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    frame = {
        "id": 0,
        "op": "join",
        "enabled": True,
        "directory": str(directory),
        "native_session_id": "alarm-native",
        "boot_id": str(uuid4()),
        "server_origin": f"https://{HOSTNAME}:8443",
        "host_token": HOST_TOKEN,
        "harness": "pi",
    }
    previous = signal.signal(signal.SIGALRM, instance_worker._interrupt)
    try:
        signal.setitimer(signal.ITIMER_REAL, 0.3)  # well inside REQUEST_SECONDS, the lookup's own deadline
        started = time.monotonic()
        with pytest.raises(ChatError) as error:
            instance_worker._join(frame)
        assert time.monotonic() - started < 2
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    # Not REQUEST_UNCERTAIN, which a bare timeout escaping the join would become.
    assert error.value.code == "TRANSPORT_UNAVAILABLE"
    assert len(children) == 1 and children[0].poll() is not None
    # The join never removes its record: it stays for a retry of the same boot or the next start's stale sweep.
    assert [path.name for path in directory.iterdir()] == [f"{frame['boot_id']}.json"]


def test_the_join_lookup_gets_what_is_left_of_the_worker_alarm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fails on the old code: the lookup got a fresh REQUEST_SECONDS after the frame, past the worker's deadline."""
    seen: dict[str, float] = {}

    def capture(*_args: Any, resolve_by: float, **_kwargs: Any) -> Any:
        seen["left"] = resolve_by - time.monotonic()
        raise ChatError("TRANSPORT_UNAVAILABLE")

    monkeypatch.setattr(instance_client, "join_instance", capture)
    frame = {
        "id": 0,
        "op": "join",
        "enabled": True,
        "directory": "/nonexistent-binding",
        "native_session_id": "budget-native",
        "boot_id": str(uuid4()),
        "server_origin": f"https://{HOSTNAME}:8443",
        "host_token": HOST_TOKEN,
        "harness": "pi",
    }
    previous = signal.signal(signal.SIGALRM, instance_worker._interrupt)
    try:
        signal.setitimer(signal.ITIMER_REAL, 5)
        time.sleep(0.2)  # the parent is slow to send the frame
        with pytest.raises(ChatError):
            instance_worker._join(frame)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    assert 0 < seen["left"] <= 4.85


@pytest.mark.parametrize(
    ("cause", "expected"),
    [("deadline", (ChatError, "CLI_INTERRUPTED")), ("alarm", (client.Interrupted, None))],
)
def test_a_resolver_that_cannot_be_reaped_is_abandoned_within_two_seconds_of_the_deadline(
    cause: str, expected: tuple[type[Exception], str | None], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fails on a1ce007: the kill was followed by a wait with no bound, and so was the context manager's exit.

    The child stands for one stuck in uninterruptible I/O: the kill reaches it and it stays alive. An unbounded wait
    would hold the worker past its deadline for as long as the child stays stuck.
    """
    created: list[Any] = []

    class Unreapable:
        returncode = None

        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            self.stdout = io.BytesIO()
            self.killed = False
            created.append(self)

        def __enter__(self) -> Unreapable:
            return self

        def __exit__(self, *_exception: object) -> None:
            self.stdout.close()
            self.wait()  # as the exit of a real Popen does, with no bound

        def communicate(self, timeout: float | None = None) -> Any:
            assert timeout is not None
            time.sleep(timeout)  # the lookup is still pending when its time is up
            if cause == "alarm":
                raise client.Interrupted("worker interrupted")
            raise subprocess.TimeoutExpired("resolver", timeout)

        def poll(self) -> None:
            return None

        def kill(self) -> None:
            self.killed = True

        def wait(self, timeout: float | None = None) -> int:
            assert timeout is not None, "an unbounded wait on a child that stays alive"
            time.sleep(timeout)
            raise subprocess.TimeoutExpired("resolver", timeout)

    monkeypatch.setattr(subprocess, "Popen", Unreapable)
    deadline = time.monotonic() + 0.3
    with pytest.raises((ChatError, client.Interrupted)) as raised:
        client._resolve(HOSTNAME, 443, deadline=deadline)
    assert time.monotonic() - deadline < 2
    # What the caller sees is what it saw before: the deadline is CLI_INTERRUPTED, and the alarm stays the alarm.
    assert (type(raised.value), getattr(raised.value, "code", None)) == expected
    (resolver,) = created
    assert resolver.killed
    assert resolver.stdout.closed


def _join_with_refused_addresses(
    monkeypatch: pytest.MonkeyPatch, directory: Path, boot_id: UUID
) -> instance_client.JoinedInstance:
    """A join whose lookup succeeds and lists two addresses that both refuse the connection."""
    listed = [_entry(_refused_port()), _entry(_refused_port())]
    monkeypatch.setattr(client, "_RESOLVER", f"print({json.dumps(listed)!r})")
    return instance_client.join_instance(
        directory,
        "refused-native",
        boot_id,
        server_origin=f"https://{HOSTNAME}:8443",
        host_token=HOST_TOKEN,
        harness="pi",
        enabled=True,
        resolve_by=time.monotonic() + 5,
    )


@pytest.mark.parametrize("earlier", [False, True], ids=["created-by-this-join", "left-by-an-earlier-attempt"])
def test_a_registration_that_reaches_no_address_keeps_the_record(
    earlier: bool, children: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Fails on a1ce007 for a record that this join created: the join removed it after a request it never sent.

    A retry of the same boot may already use the record, so the join leaves it, whoever wrote it. A record from an
    earlier attempt that may have registered is the retry's only proof; it stays too, and keeps its token.
    """
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    boot_id = uuid4()
    saved = None
    if earlier:
        saved = prepare_instance(directory, "refused-native", boot_id, server_origin=f"https://{HOSTNAME}:8443")
    with pytest.raises(ChatError) as error:
        _join_with_refused_addresses(monkeypatch, directory, boot_id)
    assert error.value.code == "TRANSPORT_UNAVAILABLE"
    assert len(children) == 1 and children[0].returncode == 0  # the lookup itself succeeded
    assert [path.name for path in directory.iterdir()] == [f"{boot_id}.json"]
    if saved is not None:
        assert read_instance(directory / f"{boot_id}.json").token == saved.token


def test_a_failed_join_leaves_the_record_that_a_retry_of_the_same_boot_registered_with(
    server: _Server, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Fails on a1ce007: the first join removed the record, though the retry had registered with its token.

    The owner repeats the exact boot while the first join is still looking the host up. The retry reads the saved
    token and registers. When the first join then fails, a removal would leave a registered instance that no later
    join of this boot could recover: each would write a new token and meet BINDING_CONFLICT. The retry runs inside the
    first join's lookup, so the interleaving is exact, and the first join has plenty of time left.
    """
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    boot_id = uuid4()
    origin = f"http://127.0.0.1:{server.port}"
    retries: list[instance_client.JoinedInstance] = []

    def lookup_during_which_the_retry_runs(_origin: str, *, deadline: float) -> tuple[client.Address, ...]:
        # The retry takes no `resolve_by`: it registers by a plain request to the server.
        retries.append(
            instance_client.join_instance(
                directory,
                "race-native",
                boot_id,
                server_origin=origin,
                host_token=HOST_TOKEN,
                harness="pi",
                enabled=True,
            )
        )
        # The first join's lookup then lists one address, and it refuses the connection.
        return ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", _refused_port())),)

    monkeypatch.setattr(instance_client, "resolve_origin", lookup_during_which_the_retry_runs)
    with pytest.raises(ChatError) as error:
        instance_client.join_instance(
            directory,
            "race-native",
            boot_id,
            server_origin=origin,
            host_token=HOST_TOKEN,
            harness="pi",
            enabled=True,
            resolve_by=time.monotonic() + 60,
        )
    assert error.value.code == "TRANSPORT_UNAVAILABLE"
    assert [path for path, _host in server.hosts] == ["/v1/sessions"]  # only the retry registered
    path = directory / f"{boot_id}.json"
    assert path.exists(), "the first join removed the record of the instance that the retry registered"
    assert read_instance(path).token == retries[0].binding.token


def test_a_same_boot_retry_marks_an_old_record_live_before_its_lookup(
    server: _Server, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Fails on 584ab63: the retry adopted an hour-old record and a sibling's sweep removed it during the lookup."""
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    boot_id = uuid4()
    origin = f"http://127.0.0.1:{server.port}"
    path = directory / f"{boot_id}.json"
    prepare_instance(directory, "old-native", boot_id, server_origin=origin)
    old = time.time() - 2 * instance_file.SWEEP_STALE_SECONDS
    os.utime(path, (old, old))
    swept: list[int] = []

    def lookup_during_which_a_sibling_sweeps(_origin: str, *, deadline: float) -> tuple[client.Address, ...]:
        swept.append(instance_file.sweep_stale(directory, uuid4()))
        return ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", server.port)),)

    monkeypatch.setattr(instance_client, "resolve_origin", lookup_during_which_a_sibling_sweeps)
    joined = instance_client.join_instance(
        directory,
        "old-native",
        boot_id,
        server_origin=origin,
        host_token=HOST_TOKEN,
        harness="pi",
        enabled=True,
        resolve_by=time.monotonic() + 60,
    )
    assert swept == [0]
    assert path.exists(), "a sibling's sweep removed the record the retry registered with"
    assert read_instance(path).token == joined.binding.token


def test_an_alarm_in_the_record_step_ends_the_join_and_keeps_the_earlier_record(
    children: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Fails on 36cc973: its existence probe swallowed the alarm, and the join went on to delete the record.

    The alarm fires at the first file system call that names the binding directory, whichever step makes it.
    """
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    boot_id = uuid4()
    earlier = prepare_instance(directory, "refused-native", boot_id, server_origin=f"https://{HOSTNAME}:8443")
    fired: list[str] = []

    def alarm_once(name: str, original: Any) -> Any:
        def call(path: Any, *args: Any, **kwargs: Any) -> Any:
            if not fired and kwargs.get("dir_fd") is None and str(directory) in str(path):
                fired.append(name)
                raise client.Interrupted("worker interrupted")
            return original(path, *args, **kwargs)

        return call

    monkeypatch.setattr(os, "lstat", alarm_once("lstat", os.lstat))
    monkeypatch.setattr(os, "open", alarm_once("open", os.open))
    with pytest.raises(client.Interrupted):
        _join_with_refused_addresses(monkeypatch, directory, boot_id)
    assert fired
    assert children == []  # neither the lookup nor the registration ran after the alarm
    monkeypatch.undo()
    assert read_instance(directory / f"{boot_id}.json").token == earlier.token


@pytest.mark.parametrize(
    ("origin", "destination", "host_header", "verified"),
    [
        ("https://[2001:db8::1:2]", ("2001:db8::1:2", 443), "[2001:db8::1:2]", ["2001:db8::1:2"]),
        ("http://[::1]", ("::1", 80), "[::1]", []),
    ],
    ids=["https-default-port", "http-default-port"],
)
def test_an_ipv6_literal_on_the_default_port_keeps_its_whole_address(
    origin: str,
    destination: tuple[str, int],
    host_header: str,
    verified: list[str],
    server: _Server,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fails on 36cc973: with no port, http.client read the literal's last group as one and verified 2001:db8::1."""
    seen_destinations: list[tuple[str, int]] = []
    seen_names: list[str | None] = []
    connect_pinned = client._connect_pinned

    def record_destination(addresses: Any, destination: tuple[str, int], *args: Any, **kwargs: Any) -> Any:
        seen_destinations.append(destination)
        return connect_pinned(addresses, destination, *args, **kwargs)

    def plain_wrap(
        _context: ssl.SSLContext, transport: socket.socket, *, server_hostname: str | None = None, **_kwargs: Any
    ) -> socket.socket:
        seen_names.append(server_hostname)
        return transport

    monkeypatch.setattr(client, "_connect_pinned", record_destination)
    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", plain_wrap)
    pinned = ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", server.port)),)
    result = client.Client(origin, HOST_TOKEN, addresses=pinned).request("GET", "/v1/instance/status")
    assert result["instance_id"] == server.instance_id
    assert seen_destinations == [destination]
    assert seen_names == verified
    assert server.hosts == [("/v1/instance/status", host_header)]  # a default port stays out of the header


def test_an_unsafe_binding_directory_fails_before_any_lookup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Fails on f00a0a7: the lookup ran first, so its failure hid BINDING_FILE_UNSAFE."""

    def no_lookup(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("the join looked the host up before checking its binding directory")

    monkeypatch.setattr(socket, "getaddrinfo", no_lookup)
    monkeypatch.setattr(subprocess, "Popen", no_lookup)
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    directory.chmod(0o755)
    with pytest.raises(ChatError) as error:
        instance_client.join_instance(
            directory,
            "unsafe-native",
            uuid4(),
            server_origin=f"https://{HOSTNAME}:8443",
            host_token=HOST_TOKEN,
            harness="pi",
            enabled=True,
            resolve_by=time.monotonic() + 5,
        )
    assert error.value.code == "BINDING_FILE_UNSAFE"
    assert list(directory.iterdir()) == []


def _children_of(pid: int) -> list[int]:
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                stat = (entry / "stat").read_text()
            except OSError:
                continue
            # The command name is parenthesised and may contain spaces; the parent pid is the second field after it.
            if int(stat.rsplit(")", 1)[1].split()[1]) == pid:
                found.append(int(entry.name))
    return found


def _alive(pid: int) -> bool:
    """A process that exists and is not a zombie: a killed child waits as a zombie until it is reaped."""
    try:
        return (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def _kill_the_worker_during_its_join_lookup(tmp_path: Path, setup: str, *, gone_within: float) -> None:
    """Start the real worker with `setup` run first, kill it while the lookup blocks, and wait for the child to go.

    Only the lookup in the resolver child is replaced, by one that never answers.
    """
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    frame = {
        "id": 0,
        "op": "join",
        "enabled": True,
        "directory": str(directory),
        "native_session_id": "killed-native",
        "boot_id": str(uuid4()),
        "server_origin": f"https://{HOSTNAME}:8443",
        "host_token": HOST_TOKEN,
        "harness": "pi",
    }
    source = (
        "import agent_chat.client as client; client._RESOLVER = 'import time; time.sleep(60)'\n"
        "from agent_chat import instance_worker\n" + setup + "raise SystemExit(instance_worker.main())\n"
    )
    resolver: int | None = None
    with subprocess.Popen(
        [sys.executable, "-c", source],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=ROOT,
        env={},
    ) as worker:
        try:
            assert worker.stdin is not None
            worker.stdin.write((json.dumps(frame) + "\n").encode())
            worker.stdin.flush()
            until = time.monotonic() + 10
            while resolver is None and time.monotonic() < until:
                found = _children_of(worker.pid)
                resolver = found[0] if found else None
                time.sleep(0.02)
            assert resolver is not None, "the join started no resolver child"
            time.sleep(0.5)  # past the child's start-up, so it is blocked in the lookup itself
            assert _alive(resolver)
            worker.kill()
            worker.wait(timeout=5)
            until = time.monotonic() + gone_within
            while _alive(resolver) and time.monotonic() < until:
                time.sleep(0.02)
            assert not _alive(resolver), "the resolver child outlived the killed worker"
        finally:
            if worker.poll() is None:
                worker.kill()
            if resolver is not None and _alive(resolver):
                os.kill(resolver, signal.SIGKILL)  # by exact pid, only on failure


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="the parent-death signal is Linux-only")
def test_a_killed_worker_leaves_no_resolver_behind(tmp_path: Path) -> None:
    """Fails on the old code: no resolver child exists, the join resolves in the worker itself."""
    # The worker keeps its 20-second limit, so only the parent-death signal can end the child this soon.
    _kill_the_worker_during_its_join_lookup(tmp_path, "", gone_within=3)


@pytest.mark.skipif(os.name != "posix", reason="the child's own alarm needs POSIX signals")
def test_a_resolver_whose_death_signal_is_refused_ends_at_its_own_alarm(tmp_path: Path) -> None:
    """Fails on f00a0a7: with prctl refused, nothing bounded the child, which slept on after the worker died."""
    setup = (
        "refused = client._DIE_WITH_PARENT.replace('prctl(1,9,0,0,0)', 'prctl(-1,0,0,0,0)')\n"
        "assert refused != client._DIE_WITH_PARENT, 'the death-signal call was not found'\n"
        "client._DIE_WITH_PARENT = refused  # an invalid option: prctl fails with EINVAL, as a denying sandbox would\n"
        "instance_worker.REQUEST_SECONDS = 2\n"
    )
    # The child's alarm is the 2-second join limit rounded up, counted from its start; the margin covers the rest.
    _kill_the_worker_during_its_join_lookup(tmp_path, setup, gone_within=2 + 2)


def test_refused_cached_addresses_answer_transport_unavailable_and_the_worker_keeps_serving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fails on the old code: a binding keeps no addresses, so there is nothing to connect to without a lookup."""
    pinned = (
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", 1)),
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", 2)),
    )
    instance = instance_client.JoinedInstance(
        InstanceSecret("refused-native", uuid4(), "1" * 64, f"https://{HOSTNAME}:8443"),
        uuid4(),
        uuid4(),
        uuid4(),
        "synthetic-host",
        "pi",
        pinned,
    )
    attempts: list[Any] = []

    class Refused(socket.socket):
        def connect(self, address: Any) -> None:
            attempts.append(address)
            raise ConnectionRefusedError("synthetic refused address")

    def no_lookup(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a request re-resolved the host")

    heartbeat = {"native_state": "idle", "stopped": False, "plan_mode": False}
    frames = iter(
        [
            {"id": 0, "op": "join", "directory": "/synthetic", "host_token": "synthetic-host-secret"},
            {"id": 1, "op": "heartbeat", "state": heartbeat},
            {"id": 2, "op": "pending"},
            {"id": 3, "op": "heartbeat", "state": heartbeat},
        ]
    )
    output = io.BytesIO()

    def readline(_size: int) -> bytes:
        frame = next(frames, None)
        return b"" if frame is None else (json.dumps(frame) + "\n").encode()

    monkeypatch.setattr(socket, "socket", Refused)
    monkeypatch.setattr(socket, "getaddrinfo", no_lookup)
    monkeypatch.setattr(subprocess, "Popen", no_lookup)
    monkeypatch.setattr(instance_worker, "_join", lambda _request: instance)
    monkeypatch.setattr(
        instance_worker,
        "sys",
        SimpleNamespace(
            stdin=SimpleNamespace(buffer=SimpleNamespace(readline=readline)), stdout=SimpleNamespace(buffer=output)
        ),
    )
    monkeypatch.setattr(
        instance_worker,
        "signal",
        SimpleNamespace(
            SIGALRM=14, SIGTERM=15, ITIMER_REAL=0, signal=lambda *_args: None, setitimer=lambda *_args: None
        ),
    )
    code = instance_worker.main()
    replies = [json.loads(line) for line in output.getvalue().splitlines()]
    # Each request is a tolerated outage, not a fatal error: the worker answers the next frame.
    assert [reply["result"] for reply in replies[1:]] == [{"refused": "TRANSPORT_UNAVAILABLE"}] * 3
    # Every request, and the end at EOF, tried each cached address in order and nothing else.
    assert attempts == [("127.0.0.1", 1), ("127.0.0.1", 2)] * 4
    assert code == 1  # the end at EOF failed too; the server lease remains the fallback


def test_an_ip_literal_origin_is_not_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fails on the old code: there is no join-time resolution to skip."""

    def no_lookup(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("an IP literal was looked up")

    monkeypatch.setattr(socket, "getaddrinfo", no_lookup)
    monkeypatch.setattr(subprocess, "Popen", no_lookup)
    deadline = time.monotonic() + 1
    assert client.resolve_origin("http://127.0.0.1:8080", deadline=deadline) == (
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", 8080)),
    )
    assert client.resolve_origin("https://[::1]:8443", deadline=deadline) == (
        (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("::1", 8443, 0, 0)),
    )


def test_the_worker_alarm_during_a_connect_ends_the_request_without_trying_the_next_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fails on the previous version: the address loop took the alarm for a failed address and tried the next."""
    pinned = (
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", 1)),
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("127.0.0.1", 2)),
    )
    instance = instance_client.JoinedInstance(
        InstanceSecret("alarm-native", uuid4(), "1" * 64, f"https://{HOSTNAME}:8443"),
        uuid4(),
        uuid4(),
        uuid4(),
        "synthetic-host",
        "pi",
        pinned,
    )
    attempts: list[Any] = []

    class Blocking(socket.socket):
        def connect(self, address: Any) -> None:
            attempts.append(address)
            if address == ("127.0.0.1", 1):
                time.sleep(5)  # a connect that hangs inside the socket timeout; only the alarm ends it
            raise ConnectionRefusedError("synthetic refused address")

    monkeypatch.setattr(socket, "socket", Blocking)
    previous = signal.signal(signal.SIGALRM, instance_worker._interrupt)
    try:
        signal.setitimer(signal.ITIMER_REAL, 0.3)
        started = time.monotonic()
        with pytest.raises(ChatError) as error:
            instance_client.heartbeat(instance, IDLE)
        assert time.monotonic() - started < 2
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    assert attempts == [("127.0.0.1", 1)]  # the second address is never tried after the alarm
    # The alarm before the request is sent is a transport failure, for a POST too, as it was before.
    assert error.value.code == "TRANSPORT_UNAVAILABLE"
