"""Migration 002, the coordination kinds and the advisory lane. None of them may wake, admit or authorize."""

import secrets
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from pydantic import ValidationError

from agent_chat import storage
from agent_chat.models import COORDINATION_KINDS, ChatError, Publication
from agent_chat.publication import publish
from agent_chat.storage import connect, migrate


@pytest.fixture
def delivery_enabled():
    return True


def count(db, table, where="true"):
    return db.execute(f"SELECT count(*) AS n FROM agent_chat.{table} WHERE {where}").fetchone()["n"]  # noqa: S608


def test_002_migrates_a_database_that_holds_only_001_and_keeps_its_rows(database, monkeypatch):
    monkeypatch.setattr(storage, "MIGRATIONS", ("001_core.sql",))
    with connect(database) as client:
        migrate(client)
        homelab = client.execute("SELECT id FROM agent_chat.rooms").fetchone()
        assert homelab is not None
        room = homelab["id"]
        principal, thread, message = uuid4(), uuid4(), uuid4()
        client.execute(
            "INSERT INTO agent_chat.principals(id, kind, credential_hash) VALUES (%s, 'operator', %s)",
            (principal, sha256(b"synthetic").hexdigest()),
        )
        with client.transaction():
            client.execute(
                "INSERT INTO agent_chat.threads(id, room_id, root_message_id) VALUES (%s, %s, %s)",
                (thread, room, message),
            )
            client.execute(
                """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, kind, body)
                VALUES (%s, %s, %s, %s, 'message', 'written before 002')""",
                (message, room, thread, principal),
            )
        assert [row["version"] for row in client.execute("SELECT version FROM agent_chat.schema_migrations")] == [1]
        monkeypatch.undo()
        migrate(client)
        migrate(client)
        assert [row["version"] for row in client.execute("SELECT version FROM agent_chat.schema_migrations")] == [
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
        ]
        kept = client.execute(
            """SELECT m.body, t.ref_key, t.resolved_at FROM agent_chat.messages m
            JOIN agent_chat.threads t ON t.id = m.thread_id"""
        ).fetchone()
        assert kept == {"body": "written before 002", "ref_key": None, "resolved_at": None}
        client.execute(
            """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, kind, body)
            VALUES (%s, %s, %s, %s, 'heads_up', 'accepted by the widened kind check')""",
            (uuid4(), room, thread, principal),
        )


def test_a_second_migration_is_a_no_op_and_digest_drift_in_002_is_refused(db):
    before = db.execute("SELECT version, digest FROM agent_chat.schema_migrations ORDER BY version").fetchall()
    migrate(db)
    assert db.execute("SELECT version, digest FROM agent_chat.schema_migrations ORDER BY version").fetchall() == before
    assert [row["version"] for row in before] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    db.execute("UPDATE agent_chat.schema_migrations SET digest = 'changed' WHERE version = 2")
    with pytest.raises(ChatError, match="^SCHEMA_MISMATCH$"):
        migrate(db)


def test_readyz_requires_both_migration_versions(http_api, db):
    assert http_api("GET", "/readyz") == (200, {"status": "ready"})
    db.execute("DELETE FROM agent_chat.schema_migrations WHERE version = 2")
    status, body = http_api("GET", "/readyz")
    assert (status, body["error"]["code"]) == (503, "SCHEMA_MISMATCH")


@pytest.mark.parametrize(
    "columns",
    [
        {"kind": "producer", "host": None, "producer": "validation-lease"},
        {"kind": "producer", "host": "node-a", "producer": None},
        {"kind": "producer", "host": "Node-A", "producer": "validation-lease"},
        {"kind": "producer", "host": "node-a", "producer": "validation-lease", "harness": "pi"},
        {"kind": "agent", "host": "node-a", "producer": "validation-lease", "harness": "pi"},
        {"kind": "operator", "host": None, "producer": "validation-lease"},
        {"kind": "service", "host": None, "producer": None},
    ],
)
def test_only_a_well_formed_producer_row_is_accepted(db, columns):
    row = {"harness": None, **columns}
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """INSERT INTO agent_chat.principals(id, credential_hash, kind, host, harness, producer)
            VALUES (%(id)s, %(hash)s, %(kind)s, %(host)s, %(harness)s, %(producer)s)""",
            {"id": uuid4(), "hash": secrets.token_hex(32), **row},
        )
    assert count(db, "principals") == 0


def test_a_well_formed_producer_row_is_accepted(db):
    db.execute(
        """INSERT INTO agent_chat.principals(id, credential_hash, kind, host, producer)
        VALUES (%s, %s, 'producer', 'node-a', 'validation-lease')""",
        (uuid4(), secrets.token_hex(32)),
    )
    assert count(db, "principals", "kind = 'producer'") == 1


def test_coordination_kinds_never_count_toward_the_reply_cap(db, actors, actor_factory):
    room, sender, target, _ = actors
    third = actor_factory(room)
    root = publish(db, sender, room, uuid4(), Publication(kind="message", body="root"))
    thread = root["thread_id"]
    for kind in COORDINATION_KINDS:
        for _ in range(7):
            publish(db, sender, room, uuid4(), Publication(kind=kind, body=f"{kind} note", thread_id=thread))
    assert count(db, "messages") == 1 + 7 * len(COORDINATION_KINDS)
    assert db.execute("SELECT agent_replies FROM agent_chat.threads").fetchone()["agent_replies"] == 0
    # A later question still counts, and still hits the existing cap; a coordination post at the cap is not refused.
    # Three sessions keep the thread from being direct, so the cap is six.
    publish(
        db,
        sender,
        room,
        uuid4(),
        Publication(
            kind="question", body="counted", thread_id=thread, recipients=(target.session_id, third.session_id)
        ),
    )
    for _ in range(5):
        publish(db, sender, room, uuid4(), Publication(kind="message", body="counted", thread_id=thread))
    with pytest.raises(ChatError, match="^CONSULTATION_LIMIT$"):
        publish(db, sender, room, uuid4(), Publication(kind="message", body="refused", thread_id=thread))
    publish(db, sender, room, uuid4(), Publication(kind="blocked_on", body="still allowed", thread_id=thread))
    assert db.execute("SELECT agent_replies FROM agent_chat.threads").fetchone()["agent_replies"] == 6


@pytest.mark.parametrize("kind", ["state", "text", "heads-up", ""])
def test_unknown_kinds_are_refused_and_nothing_is_stored(db, http_api, credentials, kind):
    with pytest.raises(ValidationError):
        Publication(kind=kind, body="x")
    status, body = http_api(
        "POST",
        f"/v1/rooms/{credentials.room}/messages",
        {"kind": kind, "body": "x"},
        credentials.operator,
        {"Idempotency-Key": str(uuid4())},
    )
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")
    assert count(db, "messages") == count(db, "threads") == 0


def ready(http_api, token):
    heartbeat = {"native_state": "idle", "stopped": False, "plan_mode": False}
    assert http_api("POST", "/v1/instance/heartbeat", heartbeat, token)[0] == 200


@pytest.mark.parametrize("kind", COORDINATION_KINDS)
def test_an_addressed_coordination_message_is_never_pending_claimed_or_charged(
    http_api, credentials, db, send, register, kind
):
    service = SimpleNamespace(request=http_api)
    token, binding = register(service, credentials, "recipient")
    ready(http_api, token)
    note = send(service, credentials, "heads up", kind=kind, recipients=[binding["session_id"]])

    def pending():
        status, body = http_api("GET", "/v1/instance/deliveries/pending", token=token)
        assert status == 200
        return body["messages"]

    def status():
        return http_api("GET", "/v1/instance/status", token=token)[1]

    assert pending() == []
    refusal = http_api(
        "POST",
        "/v1/instance/deliveries/claim",
        {"messages": [note["id"]]},
        token,
        {"Idempotency-Key": str(uuid4())},
    )
    assert (refusal[0], refusal[1]["error"]["code"]) == (409, "DELIVERY_INELIGIBLE")
    assert count(db, "delivery_attempts") == count(db, "delivery_batches") == 0
    assert status()["wake_budget"]["used"] == 0
    # The pull surface still shows it: the instance pending count includes it until it is acknowledged.
    assert status()["pending"] == 1
    # Negative control: the same setup with a question IS pending.
    question = send(service, credentials, "please answer", kind="question", recipients=[binding["session_id"]])
    assert pending() == [question["id"]]
    assert status()["pending"] == 2
    assert http_api("POST", f"/v1/messages/{note['id']}/ack", {}, token)[0] == 200
    assert status()["pending"] == 1 and pending() == [question["id"]]


def registration_with(lane=None, native="synthetic-session"):
    token = secrets.token_hex(32)
    body = {
        "native_session_id": native,
        "boot_id": str(uuid4()),
        "instance_token_hash": sha256(token.encode()).hexdigest(),
    }
    return ({**body, "lane": lane} if lane is not None else body), token


LANE = "owner/project::de3b47545dc0-de56e9b4bbbe6341"


def test_registration_stores_the_lane_and_leaves_the_binding_shape_alone(http_api, credentials, db):
    request, token = registration_with(LANE)
    status, binding = http_api("POST", "/v1/sessions", request, credentials.agent)
    assert status == 200 and set(binding) == {"session_id", "instance_id", "room_id", "host", "harness"}
    row = db.execute("SELECT lane, lane_since FROM agent_chat.instances").fetchone()
    assert row["lane"] == LANE and row["lane_since"] is not None
    plain, _ = registration_with(native="other")
    assert http_api("POST", "/v1/sessions", plain, credentials.agent)[0] == 200
    assert count(db, "instances", "lane IS NULL AND lane_since IS NULL") == 1
    status, own = http_api("GET", "/v1/instance/status", token=token)
    assert (own["lane"], own["lane_age_seconds"] is not None) == (LANE, True)


def test_a_registration_replay_keeps_the_lane_the_instance_was_created_with(http_api, credentials, db):
    request, _ = registration_with(LANE)
    assert http_api("POST", "/v1/sessions", request, credentials.agent)[0] == 200
    since = db.execute("SELECT lane_since FROM agent_chat.instances").fetchone()["lane_since"]
    for replayed in ("owner/project::another-lane", None):
        body = {**request, "lane": replayed} if replayed else {k: v for k, v in request.items() if k != "lane"}
        assert http_api("POST", "/v1/sessions", body, credentials.agent)[0] == 200
        assert db.execute("SELECT lane, lane_since FROM agent_chat.instances").fetchone() == {
            "lane": LANE,
            "lane_since": since,
        }


def test_the_lane_endpoint_sets_keeps_moves_and_clears(http_api, credentials, db, register):
    token, _ = register(SimpleNamespace(request=http_api), credentials, "lane-owner")

    def declare(lane):
        return http_api("POST", "/v1/instance/lane", {"lane": lane}, token)

    def stored():
        return db.execute("SELECT lane, lane_since FROM agent_chat.instances").fetchone()

    status, first = declare(LANE)
    assert status == 200 and first["lane"] == LANE and first["lane_age_seconds"] == 0
    since = stored()["lane_since"]
    db.execute("UPDATE agent_chat.instances SET lane_since = lane_since - interval '5 minutes'")
    aged = stored()["lane_since"]
    assert aged < since
    assert declare(LANE)[0] == 200 and stored()["lane_since"] == aged
    status, moved = declare("owner/project::another-lane")
    assert status == 200 and stored()["lane_since"] > aged and moved["lane_age_seconds"] == 0
    assert declare(None)[0] == 200 and stored() == {"lane": None, "lane_since": None}
    assert declare(None)[0] == 200 and stored() == {"lane": None, "lane_since": None}


@pytest.mark.parametrize(
    "lane", ["", "no-separator", "a::", "::b", "a::b_c", "a b::c", "a" * 80 + "::" + "b" * 39, "a/b::c\n", 7]
)
def test_a_malformed_lane_is_refused(http_api, credentials, db, register, lane):
    token, _ = register(SimpleNamespace(request=http_api), credentials, "lane-owner")
    assert http_api("POST", "/v1/instance/lane", {"lane": lane}, token)[0] == 422
    assert http_api("POST", "/v1/sessions", {**registration_with()[0], "lane": lane}, credentials.agent)[0] == 422
    assert count(db, "instances", "lane IS NOT NULL") == 0


def test_the_lane_field_is_required_and_only_an_agent_instance_may_declare_one(http_api, credentials, register):
    token, _ = register(SimpleNamespace(request=http_api), credentials, "lane-owner")
    assert http_api("POST", "/v1/instance/lane", {}, token)[0] == 422
    assert http_api("POST", "/v1/instance/lane", {"lane": LANE}, credentials.operator)[0] == 403
    assert http_api("POST", "/v1/instance/lane", {"lane": LANE}, credentials.agent)[0] == 401
    assert http_api("POST", "/v1/instance/lane", {"lane": LANE})[0] == 401


def test_participants_and_status_show_the_lane_with_a_server_side_age(http_api, credentials, db, register):
    service = SimpleNamespace(request=http_api)
    token, binding = register(service, credentials, "with-lane")
    _, idle = register(service, credentials, "without-lane")
    assert http_api("POST", "/v1/instance/lane", {"lane": LANE}, token)[0] == 200
    db.execute("UPDATE agent_chat.instances SET lane_since = lane_since - interval '7 minutes' WHERE lane IS NOT NULL")
    status, page = http_api("GET", f"/v1/rooms/{credentials.room}/participants", token=credentials.operator)
    by_session = {row["session_id"]: row for row in page["participants"]}
    assert status == 200
    assert by_session[binding["session_id"]]["lane"] == LANE
    assert 420 <= by_session[binding["session_id"]]["lane_age_seconds"] < 480
    quiet = by_session[idle["session_id"]]
    assert quiet["lane"] is None and quiet["lane_age_seconds"] is None
    own = http_api("GET", "/v1/instance/status", token=token)[1]
    assert own["lane"] == LANE and 420 <= own["lane_age_seconds"] < 480


def test_two_sessions_in_one_lane_stay_independent(http_api, credentials, db, send, register):
    service = SimpleNamespace(request=http_api)
    first_token, first = register(service, credentials, "first")
    second_token, second = register(service, credentials, "second")
    for token in (first_token, second_token):
        ready(http_api, token)
        assert http_api("POST", "/v1/instance/lane", {"lane": LANE}, token)[0] == 200
    note = send(service, credentials, "for the first", kind="question", recipients=[first["session_id"]])
    pending = {
        name: http_api("GET", "/v1/instance/deliveries/pending", token=token)[1]["messages"]
        for name, token in (("first", first_token), ("second", second_token))
    }
    assert pending == {"first": [note["id"]], "second": []}
    claim = {"messages": [note["id"]]}
    refused = http_api("POST", "/v1/instance/deliveries/claim", claim, second_token, {"Idempotency-Key": str(uuid4())})
    assert refused[0] == 404
    admitted = http_api("POST", "/v1/instance/deliveries/claim", claim, first_token, {"Idempotency-Key": str(uuid4())})
    assert admitted[0] == 200
    recipients = db.execute("SELECT session_id FROM agent_chat.recipients").fetchall()
    assert [str(row["session_id"]) for row in recipients] == [first["session_id"]]
