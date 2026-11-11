"""Migration 006 and the volume quotas on registration and publication. Refusals are hard and leave no rows."""

import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from uuid import UUID, uuid4

import pytest

from agent_chat import sessions, storage
from agent_chat.models import (
    MAX_LIVE_INSTANCES_PER_PRINCIPAL,
    MAX_MESSAGES_PER_SESSION_HOUR,
    MAX_REGISTRATIONS_PER_PRINCIPAL_HOUR,
    Actor,
    ChatError,
    Publication,
    Registration,
)
from agent_chat.publication import publish
from agent_chat.storage import connect, migrate

# The brief's numbers, repeated on purpose: a silent change of a quota must fail here, not pass by following it.
LIVE, HOURLY, MESSAGES = 32, 120, 120


def agent_principal(db) -> Actor:
    room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'").fetchone()["id"]
    principal = uuid4()
    db.execute(
        """INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness)
        VALUES (%s, 'agent', %s, 'h', 'pi')""",
        (principal, secrets.token_hex(32)),
    )
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (principal, room))
    return Actor(principal, None, None)


def register(db, actor: Actor, native: str | None = None) -> dict:
    return sessions.register(
        db,
        actor,
        Registration(
            native_session_id=native or str(uuid4()), boot_id=uuid4(), instance_token_hash=secrets.token_hex(32)
        ),
    )


def count_instances(db, principal: UUID) -> int:
    return db.execute(
        "SELECT count(*) AS n FROM agent_chat.instances i JOIN agent_chat.sessions s ON s.id = i.session_id "
        "WHERE s.principal_id = %s",
        (principal,),
    ).fetchone()["n"]


def test_the_quota_constants_are_the_documented_numbers():
    assert (MAX_LIVE_INSTANCES_PER_PRINCIPAL, MAX_REGISTRATIONS_PER_PRINCIPAL_HOUR, MAX_MESSAGES_PER_SESSION_HOUR) == (
        LIVE,
        HOURLY,
        MESSAGES,
    )


def test_006_upgrades_a_database_at_005_and_indexes_both_count_queries(database, monkeypatch):
    with connect(database) as client:
        with monkeypatch.context() as patch:
            patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:5])
            migrate(client)
        actor = agent_principal(client)
        session, instance = uuid4(), uuid4()
        client.execute(
            "INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label) VALUES (%s, %s, 'n', 'l')",
            (session, actor.principal_id),
        )
        client.execute(
            "INSERT INTO agent_chat.instances(id, session_id, boot_id, token_hash) VALUES (%s, %s, %s, %s)",
            (instance, session, uuid4(), secrets.token_hex(32)),
        )
        # A principal that already registered the whole hourly cap before the
        # upgrade. 006 stamps these rows with the migration clock, which would
        # count every one against the first rolling hour and refuse the next
        # registration; 009 must move them out of the window.
        client.execute(
            "INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label) VALUES (%s, %s, 'old', 'l')",
            (uuid4(), actor.principal_id),
        )
        old_row = client.execute(
            "SELECT id FROM agent_chat.sessions WHERE principal_id = %s AND native_session_id = 'old'",
            (actor.principal_id,),
        ).fetchone()
        assert old_row is not None
        old_session = old_row["id"]
        for _ in range(HOURLY):
            client.execute(
                "INSERT INTO agent_chat.instances(id, session_id, boot_id, token_hash, ended_at) "
                "VALUES (%s, %s, %s, %s, clock_timestamp())",
                (uuid4(), old_session, uuid4(), secrets.token_hex(32)),
            )
        migrate(client)
        migrate(client)
        assert client.execute("SELECT created_at IS NOT NULL AS ok FROM agent_chat.instances").fetchone() == {
            "ok": True
        }
        assert client.execute("SELECT max(version) AS v FROM agent_chat.schema_migrations").fetchone() == {"v": 11}
        # The upgrade leaves the principal its hourly headroom instead of
        # refusing it with REGISTRATION_LIMIT for an hour.
        registered = register(client, actor)
        assert registered["instance_id"] is not None
        indexes = {
            row["indexname"]: row["indexdef"]
            for row in client.execute("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'agent_chat'")
        }
        assert "(sender_session_id, created_at)" in indexes["messages_sender_window"]
        assert "(created_at)" in indexes["instances_created"]


def test_010_keeps_genuine_recent_registrations_and_their_quota(database, monkeypatch):
    """the backfill must move only the rows migration 006 stamped.

    A genuine registration made after 006 keeps its real created_at and keeps
    counting against the hourly quota, so exhausting the cap still refuses the
    next registration after the upgrade.
    """
    with connect(database) as client:
        with monkeypatch.context() as patch:
            patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:6])
            migrate(client)
        actor = agent_principal(client)
        session = uuid4()
        client.execute(
            "INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label) "
            "VALUES (%s, %s, 'n', 'l')",
            (session, actor.principal_id),
        )
        for _ in range(HOURLY):
            client.execute(
                "INSERT INTO agent_chat.instances(id, session_id, boot_id, token_hash, ended_at) "
                "VALUES (%s, %s, %s, %s, clock_timestamp())",
                (uuid4(), session, uuid4(), secrets.token_hex(32)),
            )
        before = {
            row["id"]: row["created_at"]
            for row in client.execute(
                "SELECT id, created_at FROM agent_chat.instances WHERE session_id = %s",
                (session,),
            )
        }
        migrate(client)
        after = {
            row["id"]: row["created_at"]
            for row in client.execute(
                "SELECT id, created_at FROM agent_chat.instances WHERE session_id = %s",
                (session,),
            )
        }
        assert after == before
        with pytest.raises(ChatError, match="^REGISTRATION_LIMIT$"):
            register(client, actor)


def test_live_instance_cap_admits_the_cap_and_refuses_the_next_without_rows(db):
    actor = agent_principal(db)
    other = agent_principal(db)
    for _ in range(LIVE):
        register(db, actor)
    before = count_instances(db, actor.principal_id)
    with pytest.raises(ChatError, match="^INSTANCE_LIMIT$"):
        register(db, actor)
    assert count_instances(db, actor.principal_id) == before == LIVE
    assert (
        db.execute(
            "SELECT count(*) AS n FROM agent_chat.sessions WHERE principal_id = %s", (actor.principal_id,)
        ).fetchone()["n"]
        == LIVE
    )
    register(db, other)  # the cap is per principal


def wait_for_advisory_waiter(db, timeout=2):
    deadline = time.monotonic() + timeout
    while True:
        waiting = db.execute(
            """SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())"""
        ).fetchone()["n"]
        if waiting:
            return
        assert time.monotonic() < deadline, "no registration waited on the per-principal advisory lock"
        time.sleep(0.01)


def test_concurrent_registrations_at_the_cap_admit_exactly_one(database, db, lock_wait):
    actor = agent_principal(db)
    for _ in range(LIVE - 1):
        register(db, actor)

    def contender():
        with connect(database) as client:
            try:
                register(client, actor)
            except ChatError as error:
                return str(error)
            return "registered"

    with ThreadPoolExecutor(max_workers=2) as pool:
        with db.transaction():
            # Registration reads this room grant after it takes the advisory lock, so the first contender holds the
            # lock while it waits here. A second contender can only wait on the advisory lock itself.
            db.execute(
                "SELECT 1 FROM agent_chat.principal_rooms WHERE principal_id = %s FOR UPDATE", (actor.principal_id,)
            )
            first = pool.submit(contender)
            lock_wait("FOR SHARE OF pr")
            second = pool.submit(contender)
            wait_for_advisory_waiter(db)
        outcomes = sorted(call.result(timeout=8) for call in (first, second))
    assert outcomes == ["INSTANCE_LIMIT", "registered"]
    assert count_instances(db, actor.principal_id) == LIVE


def test_live_instance_cap_ignores_ended_and_lapsed_instances(db):
    actor = agent_principal(db)
    for _ in range(LIVE):
        register(db, actor)
    db.execute(
        """UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE id IN
        (SELECT i.id FROM agent_chat.instances i ORDER BY i.id LIMIT 1)"""
    )
    register(db, actor)
    with pytest.raises(ChatError, match="^INSTANCE_LIMIT$"):
        register(db, actor)
    # An instance whose heartbeat is older than the lease is not live either.
    db.execute(
        """UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds' WHERE id IN
        (SELECT i.id FROM agent_chat.instances i WHERE ended_at IS NULL ORDER BY i.id LIMIT 1)"""
    )
    register(db, actor)


def test_a_replayed_registration_at_the_cap_is_not_refused(db):
    actor = agent_principal(db)
    request = Registration(native_session_id="replayed", boot_id=uuid4(), instance_token_hash=secrets.token_hex(32))
    first = sessions.register(db, actor, request)
    for _ in range(LIVE - 1):
        register(db, actor)
    assert sessions.register(db, actor, request) == first
    with pytest.raises(ChatError, match="^INSTANCE_LIMIT$"):
        register(db, actor)


def test_hourly_registration_cap_counts_ended_instances_and_rolls_over(db):
    actor = agent_principal(db)
    for _ in range(HOURLY):
        register(db, actor)
        db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE ended_at IS NULL")
    with pytest.raises(ChatError, match="^REGISTRATION_LIMIT$"):
        register(db, actor)
    assert count_instances(db, actor.principal_id) == HOURLY
    register(db, agent_principal(db))  # another principal is unaffected
    # One registration ages out of the rolling hour, so exactly one more fits.
    db.execute(
        """UPDATE agent_chat.instances SET created_at = clock_timestamp() - interval '3601 seconds' WHERE id IN
        (SELECT i.id FROM agent_chat.instances i JOIN agent_chat.sessions s ON s.id = i.session_id
         WHERE s.principal_id = %s ORDER BY i.id LIMIT 1)""",
        (actor.principal_id,),
    )
    register(db, actor)
    db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE ended_at IS NULL")
    with pytest.raises(ChatError, match="^REGISTRATION_LIMIT$"):
        register(db, actor)


def test_registration_refusals_use_429_and_fixed_codes_over_http(http_api, credentials, db):
    actor = Actor(UUID(credentials.principal), None, None)
    for _ in range(LIVE):
        register(db, actor)
    payload = {
        "native_session_id": "over",
        "boot_id": str(uuid4()),
        "instance_token_hash": secrets.token_hex(32),
    }
    status, body = http_api("POST", "/v1/sessions", payload, credentials.agent)
    assert (status, body["error"]["code"]) == (429, "INSTANCE_LIMIT")
    assert "over" not in str(body)
    db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp()")
    for _ in range(HOURLY - LIVE):
        register(db, actor)
        db.execute("UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE ended_at IS NULL")
    status, body = http_api("POST", "/v1/sessions", payload, credentials.agent)
    assert (status, body["error"]["code"]) == (429, "REGISTRATION_LIMIT")


def post(db, actor, room, kind="message", key=None):
    return publish(db, actor, room, key or uuid4(), Publication(kind=kind, body=f"synthetic {uuid4()}"))


def messages_of(db, session) -> int:
    return db.execute(
        "SELECT count(*) AS n FROM agent_chat.messages WHERE sender_session_id = %s", (session,)
    ).fetchone()["n"]


def totals(db) -> tuple[int, int]:
    row = db.execute(
        "SELECT (SELECT count(*) FROM agent_chat.messages) AS m, (SELECT count(*) FROM agent_chat.events) AS e"
    ).fetchone()
    return row["m"], row["e"]


def test_publication_cap_admits_the_cap_and_refuses_the_next_without_rows(db, actors):
    room, first, second, operator = actors
    key, request = uuid4(), Publication(kind="message", body="replayed")
    stored = publish(db, first, room, key, request)
    for _ in range(MESSAGES - 1):
        post(db, first, room)
    before = totals(db)
    with pytest.raises(ChatError, match="^PUBLICATION_LIMIT$"):
        post(db, first, room)
    with pytest.raises(ChatError, match="^PUBLICATION_LIMIT$"):
        post(db, first, room, kind="status")
    assert totals(db) == before
    assert messages_of(db, first.session_id) == MESSAGES
    # An idempotent replay returns the stored message instead of counting or refusing.
    assert publish(db, first, room, key, request)["id"] == stored["id"]
    # The cap is per session and exempts operator publication.
    post(db, second, room)
    for _ in range(MESSAGES + 1):
        post(db, operator, room)


def test_publication_cap_is_a_rolling_hour(db, actors):
    room, first, _, _ = actors
    for _ in range(MESSAGES):
        post(db, first, room)
    with pytest.raises(ChatError, match="^PUBLICATION_LIMIT$"):
        post(db, first, room)
    db.execute(
        """UPDATE agent_chat.messages SET created_at = clock_timestamp() - interval '3601 seconds' WHERE id IN
        (SELECT id FROM agent_chat.messages WHERE sender_session_id = %s ORDER BY created_at LIMIT 1)""",
        (first.session_id,),
    )
    post(db, first, room)
    with pytest.raises(ChatError, match="^PUBLICATION_LIMIT$"):
        post(db, first, room)


def test_publication_refusal_uses_429_over_http(http_api, credentials, db):
    token = secrets.token_hex(32)
    registration = {
        "native_session_id": "pub",
        "boot_id": str(uuid4()),
        "instance_token_hash": sha256(token.encode()).hexdigest(),
    }
    status, binding = http_api("POST", "/v1/sessions", registration, credentials.agent)
    assert status == 200
    actor = Actor(UUID(credentials.principal), UUID(binding["session_id"]), UUID(binding["instance_id"]))
    for _ in range(MESSAGES):
        post(db, actor, UUID(credentials.room))
    status, body = http_api(
        "POST",
        f"/v1/rooms/{credentials.room}/messages",
        {"kind": "message", "body": "over"},
        token,
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert (status, body["error"]["code"]) == (429, "PUBLICATION_LIMIT")
    assert "over" not in str(body)
