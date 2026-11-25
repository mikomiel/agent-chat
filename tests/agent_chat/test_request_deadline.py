"""Issue #177: a claim or settle never commits after the client has given the request up as uncertain.

These tests run under the production limits: none requests `expiry_margin`, so the service child keeps the lock
and statement limits of `agent_chat.storage.connect`. A test transaction holds a lock that the request waits on
and releases it at a chosen offset after the request was sent. The client side is modelled as the CLI's: one
3-second socket step, and a timed-out or 5xx POST counts as uncertain.
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import closing, contextmanager
from http.client import HTTPConnection
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

from agent_chat.storage import connect

#: The CLI's per-socket-step timeout (`agent_chat/client.py`).
CLIENT_STEP = 3.0
#: The server's whole-request budget for a claim or settle under the production limits: the 3 s lock limit of
#: `storage.connect` less the request margin. Spelled out here so the tests state the number they pin.
SERVER_BUDGET = 2.0
#: Seconds from the deadline beyond which a release has a fixed outcome: granted before, refused after.
FIXED_SIDE = 0.7

CLOCK = "agent_chat.event_clock WHERE singleton FOR UPDATE"
GRANT = "SELECT 1 FROM agent_chat.principal_rooms"


@pytest.fixture
def delivery_enabled():
    return True


def ready(service, token):
    status, _ = service.request(
        "POST", "/v1/instance/heartbeat", {"native_state": "idle", "stopped": False, "plan_mode": False}, token
    )
    assert status == 200


@pytest.fixture
def target(process_api, credentials, register):
    token, binding = register(process_api, credentials, "recipient")
    ready(process_api, token)
    return token, binding


def question(service, credentials, send, binding):
    return send(service, credentials, "synthetic coordination", kind="question", recipients=[binding["session_id"]])


def post(origin, path, payload, token, headers, sent):
    """One POST as the CLI makes it. Return (status or None when the 3 s step timed out, seconds since send)."""
    address = urlsplit(origin)
    assert address.hostname is not None and address.port is not None
    with closing(HTTPConnection(address.hostname, address.port, timeout=CLIENT_STEP)) as connection:
        connection.connect()
        sent.append(time.monotonic())
        connection.request(
            "POST",
            path,
            body=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token, **headers},
        )
        try:
            response = connection.getresponse()
            response.read()
        except TimeoutError:
            return None, time.monotonic() - sent[0]
        return response.status, time.monotonic() - sent[0]


def claim_request(service, token, message, sent):
    return post(
        service.origin,
        "/v1/instance/deliveries/claim",
        {"messages": [message]},
        token,
        {"Idempotency-Key": str(uuid4())},
        sent,
    )


def settle_request(service, token, attempt, sent):
    return post(
        service.origin,
        f"/v1/instance/deliveries/{attempt}/result",
        {"outcome": "handed", "reason": None},
        token,
        {},
        sent,
    )


@contextmanager
def held(database, query, params=()):
    """A separate transaction that holds a row lock until `release` is called or the block ends."""
    with connect(database) as holder:
        holder.execute("BEGIN")
        holder.execute(query, params)
        released = []

        def release():
            if not released:
                holder.execute("ROLLBACK")
                released.append(True)

        try:
            yield release
        finally:
            release()


def hold_clock(database):
    return held(database, "SELECT 1 FROM agent_chat.event_clock WHERE singleton FOR UPDATE")


def hold_grant(database, credentials):
    return held(
        database,
        "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE",
        (credentials.principal,),
    )


def release_at(future, sent, offset, release):
    """Release at `offset` seconds after the send, or as soon as the request has already ended."""
    wait([future], timeout=max(0.0, sent[0] + offset - time.monotonic()))
    release()


def settled(db, timeout=6):
    """Wait until no other backend of this database is inside a statement or a transaction."""
    deadline = time.monotonic() + timeout
    while True:
        db.execute("SELECT pg_stat_clear_snapshot()")
        busy = db.execute(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() "
            "AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND state <> 'idle'"
        ).fetchone()["n"]
        if busy == 0:
            return
        assert time.monotonic() < deadline, "a server backend did not finish"
        time.sleep(0.01)


def attempts(db):
    return db.execute("SELECT count(*) AS n FROM agent_chat.delivery_attempts").fetchone()["n"]


def offered(service, token):
    status, body = service.request("GET", "/v1/instance/deliveries/pending", token=token)
    assert status == 200
    return body["messages"]


def assert_claim_property(db, service, token, message, status, elapsed):
    """#177: an attempt row exists if and only if the client got the grant, and the client always got an answer."""
    settled(db)
    assert status is not None and elapsed < CLIENT_STEP, (status, elapsed)
    if status == 200:
        assert attempts(db) == 1
    else:
        assert status == 503, status
        assert attempts(db) == 0
        assert offered(service, token) == [message]


def test_claim_held_past_the_deadline_fails_cleanly_before_the_client_step(
    process_api, credentials, target, send, db, database, lock_wait
):
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    sent: list[float] = []
    with ThreadPoolExecutor(max_workers=1) as pool, hold_clock(database) as release:
        future = pool.submit(claim_request, process_api, token, message, sent)
        lock_wait(CLOCK)
        release_at(future, sent, SERVER_BUDGET + 0.7, release)
        status, elapsed = future.result()
    assert status == 503, (status, elapsed)
    assert_claim_property(db, process_api, token, message, status, elapsed)


@pytest.mark.parametrize(
    "offset",
    [SERVER_BUDGET - 1.0, SERVER_BUDGET - 0.05, SERVER_BUDGET + 0.05, SERVER_BUDGET + 0.7, 2.98, 3.2],
    ids=lambda offset: f"release_{offset:.2f}s",
)
def test_claim_lock_release_sweep_never_leaves_an_attempt_the_client_saw_as_uncertain(
    process_api, credentials, target, send, db, database, lock_wait, offset
):
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    sent: list[float] = []
    with ThreadPoolExecutor(max_workers=1) as pool, hold_clock(database) as release:
        future = pool.submit(claim_request, process_api, token, message, sent)
        lock_wait(CLOCK)
        release_at(future, sent, offset, release)
        status, elapsed = future.result()
    assert_claim_property(db, process_api, token, message, status, elapsed)
    # Far enough from the deadline the side is fixed: a grant still fits before it, and a later one is refused.
    # Near it, only the property above holds; the slack keeps a loaded runner from flipping a fixed side.
    if offset <= SERVER_BUDGET - FIXED_SIDE:
        assert status == 200, (status, elapsed)
    if offset >= SERVER_BUDGET + FIXED_SIDE:
        assert status == 503, (status, elapsed)


@pytest.mark.parametrize("route", ["claim", "settle"])
def test_one_deadline_bounds_sequential_lock_waits(
    process_api, credentials, target, send, db, database, lock_wait, route
):
    """Each wait alone is shorter than the per-lock limit; together they outlast the client step."""
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    attempt = None
    if route == "settle":
        status, granted = process_api.request(
            "POST", "/v1/instance/deliveries/claim", {"messages": [message]}, token, {"Idempotency-Key": str(uuid4())}
        )
        assert status == 200
        attempt = granted["attempt"]["id"]
    events_before = db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"]
    sent: list[float] = []
    with (
        ThreadPoolExecutor(max_workers=1) as pool,
        hold_clock(database) as release_clock,
        hold_grant(database, credentials) as release_grant,
    ):
        future = (
            pool.submit(claim_request, process_api, token, message, sent)
            if attempt is None
            else pool.submit(settle_request, process_api, token, attempt, sent)
        )
        lock_wait(CLOCK)
        release_at(future, sent, 0.6 * SERVER_BUDGET, release_clock)
        lock_wait(GRANT)
        release_at(future, sent, CLIENT_STEP + 0.5, release_grant)
        status, elapsed = future.result()
    settled(db)
    # The #177 property first, then the answer: refused, and inside the client step.
    if attempt is None:
        assert attempts(db) == 0, (status, elapsed)
        assert offered(process_api, token) == [message]
    else:
        # Settle's form of #177: an answer the client saw as uncertain left the attempt open and nothing handed.
        outcome = db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"]
        assert outcome is None, (status, elapsed)
        assert db.execute("SELECT handed_at FROM agent_chat.recipients").fetchone()["handed_at"] is None
        assert db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"] == events_before
    assert status == 503 and elapsed < CLIENT_STEP, (status, elapsed)


@pytest.mark.parametrize(
    "offset", [SERVER_BUDGET - 1.0, SERVER_BUDGET + 0.7, 3.2], ids=lambda offset: f"release_{offset:.2f}s"
)
def test_settle_lock_release_never_settles_what_the_client_saw_as_uncertain(
    process_api, credentials, target, send, db, database, lock_wait, offset
):
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    status, granted = process_api.request(
        "POST", "/v1/instance/deliveries/claim", {"messages": [message]}, token, {"Idempotency-Key": str(uuid4())}
    )
    assert status == 200
    attempt = granted["attempt"]["id"]
    events_before = db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"]
    sent: list[float] = []
    with ThreadPoolExecutor(max_workers=1) as pool, hold_clock(database) as release:
        future = pool.submit(settle_request, process_api, token, attempt, sent)
        lock_wait(CLOCK)
        release_at(future, sent, offset, release)
        status, elapsed = future.result()
    settled(db)
    assert status is not None and elapsed < CLIENT_STEP, (status, elapsed)
    row = db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()
    handed = db.execute("SELECT handed_at FROM agent_chat.recipients").fetchone()["handed_at"]
    if status == 200:
        assert row["outcome"] == "handed" and handed is not None
    else:
        assert status == 503, status
        assert row["outcome"] is None and handed is None
        assert db.execute("SELECT count(*) AS n FROM agent_chat.events").fetchone()["n"] == events_before
    if offset <= SERVER_BUDGET - FIXED_SIDE:
        assert status == 200, (status, elapsed)
    if offset >= SERVER_BUDGET + FIXED_SIDE:
        assert status == 503, (status, elapsed)
