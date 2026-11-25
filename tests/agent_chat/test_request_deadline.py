"""Issue #177: a claim never commits after the client has given the request up as uncertain.

These tests run under the production limits: none requests `expiry_margin`, so the service child keeps the lock
and statement limits of `agent_chat.storage.connect`. A test transaction holds a lock that the request waits on
and releases it at a chosen offset after the request was sent. The client side is modelled as the CLI's: one
3-second socket step, and a timed-out or 5xx POST counts as uncertain. A settle is outside the deadline, and one
test pins that. The tests at the end drive `agent_chat.storage.BoundedConnection` directly, with a fake clock on the
storage module.
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import closing, contextmanager, nullcontext
from hashlib import sha256
from http.client import HTTPConnection
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import psycopg
import pytest

from agent_chat import deliveries, storage
from agent_chat.auth import authenticate
from agent_chat.models import DELIVERY_MAX_AGE_SECONDS, ChatError, DeliveryClaim
from agent_chat.storage import connect

#: The CLI's per-socket-step timeout (`agent_chat/client.py`).
CLIENT_STEP = 3.0
#: The server's whole-request budget for a claim under the production limits: the 3 s lock limit of
#: `storage.connect` less the request margin. Spelled out here so the tests state the number they pin.
SERVER_BUDGET = 2.25
#: Seconds from the deadline beyond which a release has a fixed outcome: granted before, refused after.
FIXED_SIDE = 0.7

#: Seconds charged per round trip in the backlog test: a clean full batch (48 round trips) fits the deadline, the
#: same batch with 20 expiry receipts first does not.
BACKLOG_ROUND_TRIP = 0.04

CLOCK = "agent_chat.event_clock WHERE singleton FOR UPDATE"


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
            body = response.read()
        except TimeoutError:
            return None, time.monotonic() - sent[0]
        elapsed = time.monotonic() - sent[0]
        if response.status == 503:
            # Every refusal these tests expect is the deadline's, never another 503.
            assert json.loads(body)["error"]["code"] == "DATABASE_UNAVAILABLE", body
        return response.status, elapsed


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
    """#177: an attempt row exists if and only if the client got the grant within its step.

    A refusal may come after the client step: a statement already sent waits under the session limits. The client
    then reads a timeout (`None`), and nothing may have committed.
    """
    settled(db)
    if status == 200:
        assert elapsed < CLIENT_STEP, elapsed
        assert attempts(db) == 1
    else:
        assert status in (503, None), status
        assert attempts(db) == 0
        assert offered(service, token) == [message]


def test_claim_held_past_the_deadline_commits_nothing(process_api, credentials, target, send, db, database, lock_wait):
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    sent: list[float] = []
    with ThreadPoolExecutor(max_workers=1) as pool, hold_clock(database) as release:
        future = pool.submit(claim_request, process_api, token, message, sent)
        lock_wait(CLOCK)
        release_at(future, sent, SERVER_BUDGET + 0.5, release)
        status, elapsed = future.result()
    assert status != 200, (status, elapsed)
    assert_claim_property(db, process_api, token, message, status, elapsed)


@pytest.mark.parametrize(
    "offset",
    [SERVER_BUDGET - 1.0, SERVER_BUDGET - 0.05, SERVER_BUDGET + 0.05, 2.98, 3.2],
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
        assert status != 200, (status, elapsed)


def test_one_deadline_bounds_sequential_lock_waits(process_api, credentials, target, send, db, database, lock_wait):
    """Each wait alone is shorter than the per-lock limit; together they outlast the client step.

    The clock is released at 1.35 s and the grant at 3.5 s at the latest, or as soon as the request has ended
    (`release_at`), so a per-lock limit alone would let the grant wait end in a commit after the client gave up.
    """
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    sent: list[float] = []
    with (
        ThreadPoolExecutor(max_workers=1) as pool,
        hold_clock(database) as release_clock,
        hold_grant(database, credentials) as release_grant,
    ):
        future = pool.submit(claim_request, process_api, token, message, sent)
        lock_wait(CLOCK)
        release_at(future, sent, 0.6 * SERVER_BUDGET, release_clock)
        release_at(future, sent, CLIENT_STEP + 0.5, release_grant)
        status, elapsed = future.result()
    assert status != 200, (status, elapsed)
    assert_claim_property(db, process_api, token, message, status, elapsed)


def test_two_lock_waits_inside_one_statement_commit_nothing_after_the_deadline(
    process_api, credentials, target, send, db, database, lock_wait
):
    """The claim's last statement appends the receipt event. It waits for a SHARE lock on `events` to clear, and then,
    in its foreign-key check, for the message row. Each wait restarts `lock_timeout`, so no per-statement limit
    bounds the two together; the check before COMMIT does.
    """
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    sent: list[float] = []
    with (
        ThreadPoolExecutor(max_workers=1) as pool,
        held(database, "LOCK TABLE agent_chat.events IN SHARE MODE") as release_events,
        held(database, "SELECT 1 FROM agent_chat.messages WHERE id = %s FOR UPDATE", (message,)) as release_message,
    ):
        future = pool.submit(claim_request, process_api, token, message, sent)
        lock_wait("INSERT INTO agent_chat.events")
        release_at(future, sent, SERVER_BUDGET - 0.55, release_events)
        lock_wait("INSERT INTO agent_chat.events")  # the same statement, now in its foreign-key check
        release_at(future, sent, CLIENT_STEP + 0.5, release_message)
        status, elapsed = future.result()
    assert status != 200, (status, elapsed)
    assert_claim_property(db, process_api, token, message, status, elapsed)


def test_a_settle_is_not_held_to_the_claim_deadline(process_api, credentials, target, send, db, database, lock_wait):
    """A result whose lock is released after the claim deadline, inside the client step, still records the outcome.

    A late settle commits the outcome the worker reported, and the worker's `/end` then finds it settled; a refusal
    here would turn a handoff that happened into a terminal `uncertain` (#174).
    """
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    status, granted = process_api.request(
        "POST", "/v1/instance/deliveries/claim", {"messages": [message]}, token, {"Idempotency-Key": str(uuid4())}
    )
    assert status == 200
    attempt = granted["attempt"]["id"]
    sent: list[float] = []
    with ThreadPoolExecutor(max_workers=1) as pool, hold_clock(database) as release:
        future = pool.submit(settle_request, process_api, token, attempt, sent)
        lock_wait(CLOCK)
        release_at(future, sent, SERVER_BUDGET + 0.4, release)
        status, elapsed = future.result()
    settled(db)
    assert status == 200 and elapsed < CLIENT_STEP, (status, elapsed)
    assert db.execute("SELECT outcome FROM agent_chat.delivery_attempts").fetchone()["outcome"] == "handed"
    assert db.execute("SELECT handed_at FROM agent_chat.recipients").fetchone()["handed_at"] is not None


def test_authentication_waits_inside_the_deadline(process_api, credentials, target, send, db, database, lock_wait):
    """A lock on the principals holds the claim in authentication, before any transaction of the operation.

    It is released after the deadline but before the per-lock limit and the client step, so only the deadline, which
    authentication time counts toward, can refuse the claim.
    """
    token, binding = target
    message = question(process_api, credentials, send, binding)["id"]
    sent: list[float] = []
    with (
        ThreadPoolExecutor(max_workers=1) as pool,
        held(database, "LOCK TABLE agent_chat.principals IN ACCESS EXCLUSIVE MODE") as release,
    ):
        future = pool.submit(claim_request, process_api, token, message, sent)
        lock_wait("agent_chat.principals")
        release_at(future, sent, SERVER_BUDGET + 0.4, release)
        status, elapsed = future.result()
    assert status == 503, (status, elapsed)
    assert_claim_property(db, process_api, token, message, status, elapsed)


def charged(monkeypatch, bounded, cost):
    """Charge `cost` seconds of the storage module's clock for every round trip `bounded` makes from here on.

    psycopg runs each query and each BEGIN, SAVEPOINT, RELEASE and COMMIT through one `wait`, so a `wait` is one
    round trip. The clock stands still otherwise. Return that clock and a list that grows by one per round trip.
    """
    base = time.monotonic()
    skew = [0.0]
    trips: list[bool] = []
    real = psycopg.Connection.wait

    def wait(self, gen, *args, **kwargs):
        result = real(self, gen, *args, **kwargs)
        if self is bounded:
            skew[0] += cost
            trips.append(True)
        return result

    def clock():
        return base + skew[0]

    monkeypatch.setattr(psycopg.Connection, "wait", wait)
    monkeypatch.setattr(storage, "time", SimpleNamespace(monotonic=clock))
    return clock, trips


def test_entering_and_checking_the_deadline_sends_no_query(database, monkeypatch):
    """The budget comes from the limits the connection was given, and the check reads only the clock, so neither
    entering the deadline nor checking it sends a query.
    """
    with connect(database) as bounded:
        clock, trips = charged(monkeypatch, bounded, 0)
        with bounded.request_deadline(clock()):
            assert not storage.deadline_spent(bounded)
            assert trips == []


@pytest.mark.parametrize(
    "elapsed,spent", [(SERVER_BUDGET - 0.001, False), (SERVER_BUDGET, True)], ids=["just_before", "at_budget"]
)
def test_the_deadline_falls_at_the_pinned_budget(database, monkeypatch, elapsed, spent):
    """The deadline is the pinned 2.25 s after acceptance, on a clock the test sets: just before it the admission
    may still commit, and from it on the admission is refused.
    """
    now = [1000.0]
    monkeypatch.setattr(storage, "time", SimpleNamespace(monotonic=lambda: now[0]))
    with connect(database) as bounded, bounded.request_deadline(now[0]):
        now[0] += elapsed
        assert storage.deadline_spent(bounded) is spent


def full_batch(process_api, credentials, target, db, rooms=1):
    """Sixteen questions to `target`, spread over `rooms` rooms (the first is the credentials' room), offered at once.

    A claim authorizes each room of its batch separately, so a batch across more rooms costs more round trips.
    """
    token, binding = target
    spread = [credentials.room]
    operator = db.execute(
        "SELECT id FROM agent_chat.principals WHERE kind = 'operator' AND credential_hash = %s",
        (sha256(credentials.operator.encode()).hexdigest(),),
    ).fetchone()["id"]
    for _ in range(rooms - 1):
        room = uuid4()
        db.execute("INSERT INTO agent_chat.rooms VALUES (%s, %s, 'Batch')", (room, "batch-" + room.hex[:8]))
        for principal in (credentials.principal, operator):
            db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, room))
        db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (room, binding["session_id"]))
        spread.append(str(room))
    for index in range(16):
        status, _ = process_api.request(
            "POST",
            f"/v1/rooms/{spread[index % rooms]}/messages",
            {"kind": "question", "body": "synthetic coordination", "recipients": [binding["session_id"]]},
            credentials.operator,
            {"Idempotency-Key": str(uuid4())},
        )
        assert status == 200
    ids = tuple(UUID(message) for message in offered(process_api, token))
    assert len(ids) == 16
    return token, DeliveryClaim(messages=ids)


def test_the_deadline_adds_no_round_trip_to_a_full_batch_claim(
    process_api, credentials, target, db, database, monkeypatch, register
):
    """The deadline is read without a query and checked on the client, so a claim costs what it costs without it.

    Each claim goes to its own recipient, so both claim a full batch from the same starting state.
    """
    other = register(process_api, credentials, "second recipient")
    ready(process_api, other[0])
    counted = []
    for bounded_claim, recipient in ((True, target), (False, other)):
        token, request = full_batch(process_api, credentials, recipient, db)
        with connect(database) as bounded, monkeypatch.context() as patched:
            clock, trips = charged(patched, bounded, 0)
            if bounded_claim:
                with bounded.request_deadline(clock()):
                    granted = deliveries.claim(bounded, authenticate(bounded, token), uuid4(), request)
            else:
                granted = deliveries.claim(bounded, authenticate(bounded, token), uuid4(), request)
        assert len(granted["messages"]) == 16
        counted.append(len(trips))
    assert counted[0] == counted[1], counted


def test_a_claim_refused_at_its_deadline_keeps_its_expiry_work_and_the_next_claim_is_granted(
    process_api, credentials, target, send, db, database, monkeypatch
):
    """A backlog of 20 undelivered items past the age limit makes the claim expire them first, one receipt each.

    Both claims pay the same cost per round trip, chosen so that the clean batch (48 round trips, 1.92 s) fits the
    2.25 s deadline and the backlog's 20 receipts push only the first claim past it. The first admission is refused
    and records no attempt, but the expiry commits: it is true whenever it commits. The next claim of the same batch
    has no backlog left, so clearing it is what lets that claim fit.
    """
    token, binding = target
    for _ in range(20):
        question(process_api, credentials, send, binding)
    db.execute(
        "UPDATE agent_chat.recipients SET stored_at = stored_at - make_interval(secs => %s) WHERE session_id = %s",
        (DELIVERY_MAX_AGE_SECONDS + 60, binding["session_id"]),
    )
    _, request = full_batch(process_api, credentials, target, db)
    receipts_before = db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"]
    with connect(database) as bounded, monkeypatch.context() as patched:
        clock, _ = charged(patched, bounded, BACKLOG_ROUND_TRIP)
        with bounded.request_deadline(clock()), pytest.raises(ChatError) as refused:
            deliveries.claim(bounded, authenticate(bounded, token), uuid4(), request)
    assert refused.value.code == "DATABASE_UNAVAILABLE"
    assert attempts(db) == 0
    expired = db.execute(
        "SELECT count(*) AS n FROM agent_chat.recipients WHERE uncertainty_reason = 'expired_undelivered'"
    ).fetchone()["n"]
    assert expired == 20
    receipts = db.execute("SELECT count(*) AS n FROM agent_chat.events WHERE kind = 'receipt'").fetchone()["n"]
    assert receipts == receipts_before + 20
    with connect(database) as bounded, monkeypatch.context() as patched:
        clock, _ = charged(patched, bounded, BACKLOG_ROUND_TRIP)
        with bounded.request_deadline(clock()):
            granted = deliveries.claim(bounded, authenticate(bounded, token), uuid4(), request)
    assert granted["dispatch"] and len(granted["messages"]) == 16
    assert attempts(db) == 1


@pytest.mark.parametrize("held_row", [True, False], ids=["next_row_held", "next_row_free"])
def test_a_late_claim_runs_one_expiry_pass_and_keeps_it(
    process_api, credentials, target, send, db, database, monkeypatch, held_row
):
    """An expiry pass settles at most 100 items. With 101 due, the claim's pass settles the oldest 100 and never
    reaches the last. A refusal at the deadline asks nothing more of the database: when another transaction holds
    the last item, the refusal cannot wait on it and roll the 100 back; when nothing holds it, it stays unexpired,
    because no second pass runs.
    """
    token, binding = target
    backlog = [question(process_api, credentials, send, binding)["id"] for _ in range(101)]
    db.execute(
        "UPDATE agent_chat.recipients SET stored_at = stored_at - make_interval(secs => %s) WHERE session_id = %s",
        (DELIVERY_MAX_AGE_SECONDS + 120, binding["session_id"]),
    )
    # The youngest of the due items sorts last, past the pass's limit of 100.
    db.execute(
        "UPDATE agent_chat.recipients SET stored_at = clock_timestamp() - make_interval(secs => %s) "
        "WHERE message_id = %s AND session_id = %s",
        (DELIVERY_MAX_AGE_SECONDS + 60, backlog[-1], binding["session_id"]),
    )
    _, request = full_batch(process_api, credentials, target, db)
    hold = (
        held(
            database,
            "SELECT 1 FROM agent_chat.recipients WHERE message_id = %s AND session_id = %s FOR UPDATE",
            (backlog[-1], binding["session_id"]),
        )
        if held_row
        else nullcontext()
    )
    with (
        hold,
        connect(database) as bounded,
        monkeypatch.context() as patched,
    ):
        clock, _ = charged(patched, bounded, 0.05)
        with bounded.request_deadline(clock()), pytest.raises(ChatError) as refused:
            deliveries.claim(bounded, authenticate(bounded, token), uuid4(), request)
    assert refused.value.code == "DATABASE_UNAVAILABLE"
    assert attempts(db) == 0
    expired = db.execute(
        "SELECT count(*) AS n FROM agent_chat.recipients WHERE uncertainty_reason = 'expired_undelivered'"
    ).fetchone()["n"]
    assert expired == 100
