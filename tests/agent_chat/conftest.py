"""Real PostgreSQL, private Unix socket, no external DSN or production credentials."""

from __future__ import annotations

import importlib.util
import json
import os
import pwd
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from functools import partial
from hashlib import sha256
from http.client import HTTPConnection
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
import uvicorn
from psycopg import sql
from psycopg.conninfo import make_conninfo

from agent_chat import feed
from agent_chat.api import create_app
from agent_chat.models import Actor
from agent_chat.storage import connect, migrate


def _register(service, credentials, name):
    token = secrets.token_hex(32)
    status, binding = service.request(
        "POST",
        "/v1/sessions",
        {
            "native_session_id": name,
            "boot_id": str(uuid4()),
            "instance_token_hash": sha256(token.encode()).hexdigest(),
        },
        credentials.agent,
    )
    assert status == 200
    return token, binding


def _send(service, credentials, body, token=None, **fields):
    status, message = service.request(
        "POST",
        f"/v1/rooms/{credentials.room}/messages",
        {"kind": "message", "body": body, **fields},
        token or credentials.operator,
        {"Idempotency-Key": str(uuid4())},
    )
    assert status == 200
    return message


def _event(response):
    frame = {}
    for _ in range(200):
        line = response.readline(131072)
        assert line, "stream ended before expected event"
        if line == b"\n":
            if frame:
                frame["data"] = json.loads(frame["data"])
                return frame
            continue
        if line.startswith(b":"):
            continue
        key, value = line.decode().rstrip("\n").split(": ", 1)
        frame[key] = value
    pytest.fail("SSE event did not complete")


@pytest.fixture(name="register")
def register_fixture():
    return _register


@pytest.fixture(name="send")
def send_fixture():
    return _send


@pytest.fixture(name="event")
def event_fixture():
    return _event


@pytest.fixture
def lock_wait(db):
    """Block until `count` other backends wait on row locks inside statements containing `fragment`."""

    def wait(fragment, *, count=1, timeout=2):
        deadline = time.monotonic() + timeout
        while True:
            # Statistics snapshots otherwise remain cached inside a lock-holding transaction.
            db.execute("SELECT pg_stat_clear_snapshot()")
            waiting = db.execute(
                """
                SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()
                AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE %s
            """,
                ("%" + fragment + "%",),
            ).fetchone()["n"]
            if waiting >= count:
                return
            assert time.monotonic() < deadline, "request did not wait at the required lock boundary: " + fragment
            time.sleep(0.01)

    return wait


#: Seconds from arranging an expiry to its crossing. The request under test must reach its lock wait before
#: the crossing, so lock-wait deadlines equal this value. The request then keeps waiting until the test has
#: seen the crossing and released its lock: the margin plus that release lag must stay below the lock limit
#: of the service (`SERVICE_LOCK_BUDGET`).
EXPIRY_MARGIN = 2

#: Seconds a service child may wait for a lock, or run a statement, while its test waits out `EXPIRY_MARGIN`.
#: Production ends a lock wait after 3 s and a statement after 5 s (`agent_chat.storage.connect`). That left
#: the test 1 s to release its lock after the crossing. This budget leaves 4 s. It stays below the 8 s
#: timeout of `http_request`, which covers the whole request.
SERVICE_LOCK_BUDGET = 6


@pytest.fixture
def expiry_margin():
    return EXPIRY_MARGIN


@pytest.fixture
def service_lock_budget(request):
    """`SERVICE_LOCK_BUDGET` for a test that waits out `expiry_margin`; None keeps the production limits."""
    return SERVICE_LOCK_BUDGET if "expiry_margin" in request.fixturenames else None


@pytest.fixture
def public_origin():
    return None


@pytest.fixture
def delivery_enabled():
    return False


@dataclass(frozen=True)
class Credentials:
    agent: str = field(repr=False)
    operator: str = field(repr=False)
    principal: str
    room: str


@pytest.fixture
def credentials(db):
    room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'").fetchone()["id"]
    tokens = [secrets.token_hex(32), secrets.token_hex(32)]
    principals = [uuid4(), uuid4()]
    for index, kind in enumerate(("agent", "operator")):
        db.execute(
            """INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness)
            VALUES (%s, %s, %s, %s, %s)""",
            (
                principals[index],
                kind,
                sha256(tokens[index].encode()).hexdigest(),
                "synthetic-host" if index == 0 else None,
                "pi" if index == 0 else None,
            ),
        )
        db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principals[index], room))
    return Credentials(tokens[0], tokens[1], str(principals[0]), str(room))


def http_request(port, method, path, payload=None, token=None, headers=None, raw=None, include_headers=False):
    with closing(HTTPConnection("127.0.0.1", port, timeout=8)) as connection:
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        body = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        assert response.getheader("Cache-Control") == "no-store"
        if include_headers:
            return response.status, data, response.getheaders()
        return response.status, data


@pytest.fixture
def http_api(database, db, public_origin, delivery_enabled):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        port = listener.getsockname()[1]
        server = uvicorn.Server(
            uvicorn.Config(
                create_app(database, enabled=True, public_origin=public_origin, delivery_enabled=delivery_enabled),
                log_config=None,
                access_log=False,
                lifespan="off",
                ws="none",
                proxy_headers=False,
                timeout_graceful_shutdown=3,
            )
        )
        thread = Thread(target=server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                if not thread.is_alive() or time.monotonic() >= deadline:
                    pytest.fail("isolated HTTP server failed to start")
                time.sleep(0.01)

            yield partial(http_request, port)
        finally:
            server.should_exit = True
            thread.join(timeout=8)
            assert not thread.is_alive(), "isolated HTTP server survived teardown"


@pytest.fixture
def process_api(database, db, public_origin, delivery_enabled, service_lock_budget):
    """One real service child; restart preserves only PostgreSQL and the listening socket."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        port = listener.getsockname()[1]
        child = None

        request = partial(http_request, port)

        @contextmanager
        def stream(path="/v1/events", token=None, headers=None):
            with closing(HTTPConnection("127.0.0.1", port, timeout=5)) as client:
                supplied = dict(headers or {})
                if token is not None:
                    supplied["Authorization"] = "Bearer " + token
                client.request("GET", path, headers=supplied)
                response = client.getresponse()
                try:
                    yield response
                finally:
                    response.close()

        def stop():
            nonlocal child
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
                    pytest.fail("disposable HTTP process required forced termination")

        def restart(*, enable_delivery=delivery_enabled, stream_poll=1):
            nonlocal child
            stop()
            child = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name("http_server_fixture.py"))],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                pass_fds=(listener.fileno(),),
                env={"PATH": os.defpath, "LANG": "C.UTF-8"},
                text=True,
            )
            assert child.stdin is not None
            child.stdin.write(
                json.dumps(
                    {
                        "database": database,
                        "origin": public_origin,
                        "fd": listener.fileno(),
                        "delivery_enabled": enable_delivery,
                        "stream_poll": stream_poll,
                        "lock_budget": service_lock_budget,
                    }
                )
                + "\n"
            )
            child.stdin.close()
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    pytest.fail("disposable HTTP process exited during startup")
                try:
                    if request("GET", "/healthz")[0] == 200:
                        return child.pid
                except (OSError, TimeoutError):
                    pass
                time.sleep(0.02)
            pytest.fail("disposable HTTP process did not become healthy")

        try:
            restart()
            yield SimpleNamespace(request=request, stream=stream, stop=stop, restart=restart, origin=f"http://127.0.0.1:{port}")
        finally:
            stop()


def _load_postgres_binaries():
    """The sibling discovery module; importlib import mode puts no test directory on sys.path."""
    path = Path(__file__).with_name("postgres_binaries.py")
    spec = importlib.util.spec_from_file_location("agent_chat_postgres_binaries", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def postgres_cluster():
    configured = os.environ.get("PG_TEST_BIN_DIR")
    initdb = str(Path(configured) / "initdb") if configured else shutil.which("initdb")
    # Order: PG_TEST_BIN_DIR, then PATH, then the highest Debian
    # /usr/lib/postgresql/<N>/bin. The pre-run probe applies the same rule.
    binaries = Path(initdb).parent if initdb is not None else _load_postgres_binaries().distro_bin_dir()
    if binaries is None:
        pytest.fail(
            "UNAVAILABLE: PostgreSQL binaries required; set PG_TEST_BIN_DIR, put initdb on PATH, "
            "or install postgresql-<N> (no external database accepted)"
        )
    for name in ("initdb", "postgres"):
        if not (binaries / name).is_file():
            pytest.fail(f"configured PostgreSQL executable missing: {name}")
    # A lowered-UID child cannot traverse the suite's root-only TMPDIR, so only
    # the root-drop path gives it a separate private root under /tmp; do not
    # relax the suite directory permissions. Everyone else keeps the data
    # directory under the default tempdir (TMPDIR): CI points it at disk because
    # the unit's /tmp is a small tmpfs, and every xdist worker starts a cluster.
    # The socket directory stays under /tmp in both cases: a Unix socket path is
    # limited to about 107 bytes, which a long TMPDIR can exceed, and a socket
    # file takes no space.
    drops_privilege = os.geteuid() == 0
    with (
        tempfile.TemporaryDirectory(
            prefix="agent-chat-test-", dir="/tmp" if drops_privilege else None
        ) as directory,
        tempfile.TemporaryDirectory(prefix="agent-chat-sock-", dir="/tmp") as socket_directory,
    ):
        root = Path(directory)
        sockets = Path(socket_directory)
        uid = gid = None
        if drops_privilege:
            # Drop privilege only for our disposable database, never mutate an account.
            account = pwd.getpwnam("nobody")
            uid, gid = account.pw_uid, account.pw_gid
            os.chown(root, uid, gid)
            os.chown(sockets, uid, gid)
        env = {"PATH": os.defpath, "LANG": "C", "HOME": str(root)}
        if os.environ.get("LD_LIBRARY_PATH"):
            env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
        data = root / "data"
        subprocess.run(
            [
                str(binaries / "initdb"),
                "-D",
                str(data),
                "--no-locale",
                "--encoding=UTF8",
                "--auth-local=trust",
                "--auth-host=reject",
                "-U",
                "postgres",
            ],
            check=True,
            cwd=root,
            env=env,
            timeout=30,
            user=uid,
            group=gid,
            extra_groups=[] if uid is not None else None,
        )
        dsn = make_conninfo(host=str(sockets), port=5432, user="postgres", dbname="postgres", connect_timeout=1)
        with (root / "server.log").open("w+") as log:
            proc = subprocess.Popen(
                [
                    str(binaries / "postgres"),
                    "-D",
                    str(data),
                    "-c",
                    "listen_addresses=",
                    "-c",
                    f"unix_socket_directories={sockets}",
                    "-c",
                    "unix_socket_permissions=0700",
                    "-c",
                    "shared_buffers=16MB",
                    "-c",
                    "max_connections=20",
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                cwd=root,
                env=env,
                user=uid,
                group=gid,
                extra_groups=[] if uid is not None else None,
            )
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        with psycopg.connect(dsn):
                            break
                    except psycopg.OperationalError:
                        if proc.poll() is not None or time.monotonic() >= deadline:
                            log.seek(0)
                            pytest.fail(f"isolated PostgreSQL did not become ready: {log.read()}")
                        time.sleep(0.05)
                yield dsn
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)


def _drop_database(admin, dsn, name):
    # Cleanup can wait on a checkpoint. A 5s product statement timeout is too short
    # when several xdist workers drop databases together; this budget is test-only.
    admin.execute("SET statement_timeout = '30s'")
    # Observe only slow cleanup. No extra connection on the normal fast path;
    # no query text, DSN, database names, credentials or conversation content.
    done = Event()
    admin_pid = admin.info.backend_pid
    waits = []
    observer_errors = []

    def observe():
        if done.wait(1):
            return
        try:
            with psycopg.connect(
                dsn, autocommit=True, connect_timeout=1, options="-c statement_timeout=1000"
            ) as observer:
                for _ in range(20):
                    if done.is_set():
                        break
                    row = observer.execute(
                        """SELECT wait_event_type, wait_event,
                            (SELECT count(*) FROM pg_stat_activity WHERE datname = %s)
                        FROM pg_stat_activity WHERE pid = %s AND state = 'active'""",
                        (name, admin_pid),
                    ).fetchone()
                    if row:
                        state = {"wait_type": row[0], "wait": row[1], "target_connections": row[2]}
                        if state not in waits:
                            waits.append(state)
                    if done.wait(0.2):
                        break
        except psycopg.Error as error:
            observer_errors.append(type(error).__name__)

    thread = Thread(target=observe, name="chat-db-drop-observer")
    thread.start()
    failure = None
    try:
        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
    except BaseException as error:
        failure = error
        raise
    finally:
        done.set()
        thread.join(timeout=3)
        if thread.is_alive():
            cleanup_error = RuntimeError("isolated database observer survived teardown")
            if failure is not None:
                raise BaseExceptionGroup("database cleanup and observer failed", [failure, cleanup_error])
            raise cleanup_error
        if failure is not None:
            failure.add_note(
                json.dumps(
                    {"phase": "isolated_database_drop", "waits": waits, "observer_errors": observer_errors},
                    sort_keys=True,
                )
            )


@pytest.fixture
def isolated_database(postgres_cluster):
    """Expose the actual fixture lifecycle for teardown failure regression tests."""

    @contextmanager
    def create():
        name = "chat_test_" + uuid4().hex
        with connect(postgres_cluster) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
            try:
                yield make_conninfo(postgres_cluster, dbname=name)
            finally:
                _drop_database(admin, postgres_cluster, name)

    return create


@pytest.fixture
def database(isolated_database):
    with isolated_database() as dsn:
        yield dsn


@pytest.fixture
def db(database):
    with connect(database) as connection:
        migrate(connection)
        yield connection


@pytest.fixture
def event_log():
    """The actor's first committed events after a cursor, as position, kind and message_id records."""

    def read(db, actor, after=0):
        return [
            {"position": int(frame["id"]), "kind": frame["event"], "message_id": frame["data"]["message_id"]}
            for frame in feed.events(db, actor, after)["events"]
        ]

    return read


def seed_actor(db, room, *, operator=False):
    principal = uuid4()
    db.execute(
        """
        INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness)
        VALUES (%s, %s, %s, %s, %s)
    """,
        (
            principal,
            "operator" if operator else "agent",
            sha256(principal.bytes).hexdigest(),
            None if operator else "synthetic-host",
            None if operator else "pi",
        ),
    )
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, room))
    if operator:
        return Actor(principal, None, None)
    session, instance = uuid4(), uuid4()
    db.execute(
        "INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label) VALUES (%s, %s, %s, %s)",
        (session, principal, str(uuid4()), "synthetic-session"),
    )
    db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (room, session))
    db.execute(
        "INSERT INTO agent_chat.instances(id, session_id, boot_id, token_hash) VALUES (%s, %s, %s, %s)",
        (instance, session, uuid4(), sha256(instance.bytes).hexdigest()),
    )
    return Actor(principal, session, instance)


@pytest.fixture
def actor_factory(db):
    return lambda room: seed_actor(db, room)


@pytest.fixture
def actors(db):
    room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'").fetchone()["id"]
    return room, seed_actor(db, room), seed_actor(db, room), seed_actor(db, room, operator=True)


@dataclass(frozen=True)
class Viewer:
    token: str = field(repr=False)
    principal: UUID


@pytest.fixture
def make_viewer(db: psycopg.Connection[dict[str, Any]]) -> Callable[..., Viewer]:
    def make(*rooms: UUID | str) -> Viewer:
        token, principal = secrets.token_hex(32), uuid4()
        db.execute(
            "INSERT INTO agent_chat.principals(id, kind, credential_hash) VALUES (%s, 'viewer', %s)",
            (principal, sha256(token.encode()).hexdigest()),
        )
        for room in rooms:
            db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, room))
        return Viewer(token, principal)

    return make


@dataclass(frozen=True)
class Producer:
    token: str = field(repr=False)
    principal: str
    host: str
    producer: str


@pytest.fixture
def make_producer(db):
    """A producer principal and, by default, its grant to the homelab room."""
    room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'").fetchone()["id"]

    def make(host="node-a", producer="validation-lease", *, grant=True):
        token, principal = secrets.token_hex(32), uuid4()
        db.execute(
            """INSERT INTO agent_chat.principals(id, kind, credential_hash, host, producer)
            VALUES (%s, 'producer', %s, %s, %s)""",
            (principal, sha256(token.encode()).hexdigest(), host, producer),
        )
        if grant:
            db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, room))
        return Producer(token, str(principal), host, producer)

    return make
