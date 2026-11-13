"""Producer authentication and room state: untrusted observation data, written only by a producer credential."""

import json
import secrets
from http.cookies import SimpleCookie
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.routing import APIRoute
from pydantic import ValidationError

from agent_chat import browser, feed
from agent_chat.api import create_app
from agent_chat.auth import authenticate
from agent_chat.models import StateEntry
from agent_chat.retention import prune

ORIGIN = "https://chat.test"
KEY = "validation-lease:node-a:c1"
OTHER_KEY = "validation-lease:node-a:leaf"
RESOURCE = "resource:node-a:ci-validation"


@pytest.fixture
def public_origin():
    return ORIGIN


def entry(key=KEY, value=None, ttl=90, ref=None):
    body = {"state_key": key, "value": {"scan": "ok"} if value is None else value, "ttl_seconds": ttl}
    if ref is not None:
        body["ref_key"] = ref
    return body


def post(http_api, room, producer, *entries):
    return http_api("POST", f"/v1/rooms/{room}/state", {"entries": list(entries)}, producer.token)


def read(http_api, room, token, query=""):
    return http_api("GET", f"/v1/rooms/{room}/state{query}", token=token)


def count(db, table, where="true"):
    return db.execute(f"SELECT count(*) AS n FROM agent_chat.{table} WHERE {where}").fetchone()["n"]  # noqa: S608


def state_events(db):
    return count(db, "events", "kind = 'state'")


def age(db, seconds):
    """Shift a row's three server timestamps back together, the way test_retention shifts message expiry."""
    db.execute(
        """UPDATE agent_chat.room_state SET changed_at = changed_at - make_interval(secs => %(s)s),
        observed_at = observed_at - make_interval(secs => %(s)s),
        expires_at = expires_at - make_interval(secs => %(s)s)""",
        {"s": seconds},
    )


def code(response):
    return response[0], response[1]["error"]["code"]


def login_headers(http_api):
    status, body, headers = http_api("GET", "/v1/login", include_headers=True)
    assert status == 200
    cookies = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            cookies.load(value)
    nonce = cookies[browser.LOGIN_COOKIE].value
    return {"Origin": ORIGIN, "Cookie": f"{browser.LOGIN_COOKIE}={nonce}", "X-CSRF-Token": body["csrf_token"]}


def test_a_producer_token_is_refused_on_every_other_route(http_api, database, credentials, make_producer):
    producer = make_producer()
    thing = str(uuid4())
    key = {"Idempotency-Key": str(uuid4())}
    room = credentials.room
    heartbeat = {"native_state": "idle", "stopped": False, "plan_mode": False}
    registration = {"native_session_id": "x", "boot_id": thing, "instance_token_hash": "0" * 64}
    table = {
        ("POST", "/v1/login"): (
            "/v1/login", {"token": producer.token}, lambda: login_headers(http_api), None),
        ("GET", "/v1/browser/session"): ("/v1/browser/session", None, None, producer.token),
        ("POST", "/v1/logout"): ("/v1/logout", {}, None, producer.token),
        ("POST", "/v1/sessions"): ("/v1/sessions", registration, None, producer.token),
        ("POST", "/v1/instance/heartbeat"): ("/v1/instance/heartbeat", heartbeat, None, producer.token),
        ("POST", "/v1/instance/lane"): ("/v1/instance/lane", {"lane": None}, None, producer.token),
        ("POST", "/v1/instance/work"): (
            "/v1/instance/work", {"repositories": {"forgejo": ["owner/repo"]}}, None, producer.token),
        ("POST", "/v1/instance/end"): ("/v1/instance/end", {}, None, producer.token),
        ("GET", "/v1/instance/status"): ("/v1/instance/status", None, None, producer.token),
        ("GET", "/v1/instance/deliveries/pending"): ("/v1/instance/deliveries/pending", None, None, producer.token),
        ("GET", "/v1/instance/receipts"): ("/v1/instance/receipts", None, None, producer.token),
        ("POST", "/v1/instance/receipts/delivered"): (
            "/v1/instance/receipts/delivered", {"receipts": [thing]}, None, producer.token),
        ("POST", "/v1/instance/deliveries/claim"): (
            "/v1/instance/deliveries/claim", {"messages": [thing]}, key, producer.token),
        ("POST", "/v1/instance/deliveries/{attempt}/result"): (
            f"/v1/instance/deliveries/{thing}/result", {"outcome": "handed"}, None, producer.token),
        ("POST", "/v1/sessions/{session}/mute"): (f"/v1/sessions/{thing}/mute", {"muted": True}, None, producer.token),
        ("POST", "/v1/threads/{thread}/resolution"): (
            f"/v1/threads/{thing}/resolution", {"resolved": True}, None, producer.token),
        ("POST", "/v1/messages/{message}/ack"): (f"/v1/messages/{thing}/ack", {}, None, producer.token),
        ("POST", "/v1/messages/{message}/replies"): (
            f"/v1/messages/{thing}/replies", {"body": "x"}, key, producer.token),
        ("GET", "/v1/rooms"): ("/v1/rooms", None, None, producer.token),
        ("POST", "/v1/rooms"): ("/v1/rooms", {"slug": "walk", "label": "Walk"}, None, producer.token),
        ("POST", "/v1/rooms/{room}/memberships"): (
            f"/v1/rooms/{room}/memberships", {"session_id": thing}, None, producer.token),
        ("POST", "/v1/rooms/{room}/pm"): (
            f"/v1/rooms/{room}/pm", {"session_id": thing, "pm": True}, None, producer.token),
        ("POST", "/v1/rooms/{room}/roles"): (
            f"/v1/rooms/{room}/roles", {"role": "github_pm", "session_id": thing, "assigned": True}, None,
            producer.token),
        ("GET", "/v1/rooms/{room}/participants"): (f"/v1/rooms/{room}/participants", None, None, producer.token),
        ("GET", "/v1/rooms/{room}/history"): (f"/v1/rooms/{room}/history", None, None, producer.token),
        ("GET", "/v1/events"): ("/v1/events", None, None, producer.token),
        ("POST", "/v1/rooms/{room}/messages"): (
            f"/v1/rooms/{room}/messages", {"kind": "message", "body": "x"}, key, producer.token),
        ("GET", "/v1/rooms/{room}/state"): (f"/v1/rooms/{room}/state", None, None, producer.token),
    }
    # Static or credential-free routes: nothing they return depends on a credential.
    credential_free = {("GET", "/"), ("GET", "/ui/{asset}"), ("GET", "/healthz"), ("GET", "/readyz"),
                       ("GET", "/v1/login")}
    allowed = {("POST", "/v1/rooms/{room}/state")}
    routes = {
        (method, route.path)
        for route in create_app(database, enabled=True, public_origin=ORIGIN).routes
        if isinstance(route, APIRoute)
        for method in (route.methods or set()) - {"HEAD"}
    }
    # A route added later must be classified here, or this test fails.
    assert routes == set(table) | credential_free | allowed
    for method, path in sorted(table):
        target, payload, headers, token = table[method, path]
        headers = headers() if callable(headers) else headers
        status, body = http_api(method, target, payload, token, headers)
        assert (status, body["error"]["code"]) == (401, "UNAUTHENTICATED"), (method, path)
    assert post(http_api, credentials.room, producer, entry())[0] == 200


def test_only_a_producer_token_may_write_state(http_api, credentials, make_producer, db):
    make_producer()
    body = {"entries": [entry()]}
    path = f"/v1/rooms/{credentials.room}/state"
    for token in (credentials.operator, credentials.agent, secrets.token_hex(32), None):
        assert code(http_api("POST", path, body, token)) == (401, "UNAUTHENTICATED")
    # A browser cookie is no credential for this route, alone or beside a producer bearer token.
    status, login, headers = http_api(
        "POST", "/v1/login", {"token": credentials.operator}, headers=login_headers(http_api), include_headers=True
    )
    assert status == 200
    cookies = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            cookies.load(value)
    cookie = {
        "Origin": ORIGIN,
        "Cookie": f"{browser.SESSION_COOKIE}={cookies[browser.SESSION_COOKIE].value}",
        "X-CSRF-Token": login["csrf_token"],
    }
    assert code(http_api("POST", path, body, headers=cookie)) == (401, "UNAUTHENTICATED")
    assert count(db, "room_state") == 0 and state_events(db) == 0


def test_the_server_enforces_the_producer_namespace_for_the_whole_batch(http_api, credentials, make_producer, db):
    producer = make_producer()
    refused = [
        entry("validation-lease:node-b:c1"),
        entry("other-producer:node-a:c1"),
        entry(KEY, ref="resource:node-b:ci-validation"),
        entry(KEY, ref="resource:node-c:ci-validation"),
    ]
    for bad in refused:
        assert code(post(http_api, credentials.room, producer, entry(OTHER_KEY), bad)) == (403, "STATE_KEY_FORBIDDEN")
        assert count(db, "room_state") == 0 and state_events(db) == 0
    assert post(http_api, credentials.room, producer, entry(), entry(OTHER_KEY, ref=RESOURCE))[0] == 200
    assert count(db, "room_state") == 2


def test_validation_lease_namespace_has_only_three_keys_and_one_resource(
    http_api, credentials, make_producer, db
):
    producer = make_producer()
    invalid = [
        [entry("validation-lease:node-a:extra")],
        [entry(OTHER_KEY), entry("validation-lease:node-a:extra")],
        [entry(f"validation-lease:node-a:extra-{number}") for number in range(8)],
        [entry(KEY, ref="resource:node-a:another-resource")],
    ]
    for batch in invalid:
        assert code(post(http_api, credentials.room, producer, *batch)) == (403, "STATE_KEY_FORBIDDEN")
        assert count(db, "room_state") == 0 and state_events(db) == 0
        assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"] == 0
    # Both modern classes and the legacy class can replace their observations without allocating more keys.
    shared = "validation-lease:node-a:shared"
    assert post(http_api, credentials.room, producer, entry(KEY), entry(OTHER_KEY))[0] == 200
    assert post(http_api, credentials.room, producer, entry(shared, ref=RESOURCE))[0] == 200
    assert post(http_api, credentials.room, producer, entry(KEY), entry(OTHER_KEY))[0] == 200
    assert {row["state_key"] for row in db.execute("SELECT state_key FROM agent_chat.room_state")} == {
        KEY, OTHER_KEY, shared
    }


def test_a_producer_needs_a_room_grant(http_api, credentials, make_producer, db):
    producer = make_producer(grant=False)
    assert code(post(http_api, credentials.room, producer, entry())) == (403, "ROOM_FORBIDDEN")
    assert count(db, "room_state") == 0


def test_revocation_stops_writes_marks_rows_stale_and_spares_other_producers(
    http_api, credentials, make_producer, db
):
    first, second = make_producer(), make_producer("node-b")
    assert post(http_api, credentials.room, first, entry())[0] == 200
    assert post(http_api, credentials.room, second, entry("validation-lease:node-b:c1"))[0] == 200
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (first.principal,))
    assert code(post(http_api, credentials.room, first, entry())) == (401, "UNAUTHENTICATED")
    assert post(http_api, credentials.room, second, entry("validation-lease:node-b:c1"))[0] == 200
    status, page = read(http_api, credentials.room, credentials.operator)
    assert status == 200
    rows = {row["state_key"]: row for row in page["entries"]}
    revoked = rows[KEY]
    assert (revoked["stale"], revoked["stale_reason"]) == (True, "revoked")
    assert revoked["expires_in_seconds"] > 0, "revocation must apply whatever expires_at says"
    spared = rows["validation-lease:node-b:c1"]
    assert (spared["stale"], spared["stale_reason"]) == (False, None)


def test_two_credentials_for_one_producer_overlap_during_rotation(http_api, credentials, make_producer, db):
    old, new = make_producer(), make_producer()
    assert post(http_api, credentials.room, old, entry())[0] == 200
    assert state_events(db) == 1
    # The same value from the other credential is a change of authority: readers must refetch.
    assert post(http_api, credentials.room, new, entry())[1]["entries"][0]["changed"] is True
    assert state_events(db) == 2
    assert post(http_api, credentials.room, old, entry())[0] == 200
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (old.principal,))
    assert post(http_api, credentials.room, new, entry())[0] == 200
    assert read(http_api, credentials.room, credentials.operator)[1]["entries"][0]["stale"] is False


def test_events_are_appended_only_on_change(http_api, credentials, make_producer, db):
    producer = make_producer()

    def upsert(**changes):
        return post(http_api, credentials.room, producer, entry(**changes))[1]["entries"][0]

    first = upsert(value={"a": 1, "b": 2})
    assert first["changed"] is True and state_events(db) == 1
    before = db.execute("SELECT changed_at, observed_at, expires_at FROM agent_chat.room_state").fetchone()
    # Same value, other key order, other TTL, while fresh: a silent refresh.
    again = upsert(value={"b": 2, "a": 1}, ttl=300)
    assert again["changed"] is False and state_events(db) == 1
    after = db.execute("SELECT changed_at, observed_at, expires_at FROM agent_chat.room_state").fetchone()
    assert after["changed_at"] == before["changed_at"]
    assert after["observed_at"] > before["observed_at"] and after["expires_at"] > before["expires_at"]
    assert upsert(value={"a": 1, "b": 3})["changed"] is True and state_events(db) == 2
    assert upsert(value={"a": 1, "b": 3}, ref=RESOURCE)["changed"] is True and state_events(db) == 3
    assert upsert(value={"a": 1, "b": 3}, ref=RESOURCE)["changed"] is False and state_events(db) == 3
    # Return from stale: the same value after expiry is news again.
    age(db, 1000)
    changed_before = db.execute("SELECT changed_at FROM agent_chat.room_state").fetchone()["changed_at"]
    assert upsert(value={"a": 1, "b": 3}, ref=RESOURCE)["changed"] is True and state_events(db) == 4
    assert db.execute("SELECT changed_at FROM agent_chat.room_state").fetchone()["changed_at"] > changed_before


def test_a_batch_is_stamped_by_the_server_clock_and_is_idempotent(http_api, credentials, make_producer, db):
    producer = make_producer()
    status, body = post(
        http_api, credentials.room, producer, entry(OTHER_KEY, {"x": 1}, ttl=3600), entry(KEY, {"y": 2}, ttl=30)
    )
    assert status == 200
    assert [row["state_key"] for row in body["entries"]] == sorted([KEY, OTHER_KEY])
    assert {row["observed_at"] for row in body["entries"]} == {body["entries"][0]["observed_at"]}
    rows = {row["state_key"]: row for row in db.execute("SELECT * FROM agent_chat.room_state").fetchall()}
    assert (rows[OTHER_KEY]["expires_at"] - rows[OTHER_KEY]["observed_at"]).total_seconds() == 3600
    assert (rows[KEY]["expires_at"] - rows[KEY]["observed_at"]).total_seconds() == 30
    assert state_events(db) == 2


BAD_ENTRIES = [
    entry(ttl=29),
    entry(ttl=3601),
    {**entry(), "ttl_seconds": "90"},
    {**entry(), "ttl_seconds": True},
    {**entry(), "value": [1]},
    {**entry(), "value": "text"},
    {**entry(), "value": None},
    {**entry(), "extra": 1},
    {**entry(), "producer": "validation-lease"},
    entry(key="Validation-Lease:node-a:c1"),
    entry(key="validation-lease:node-a"),
    entry(key="validation-lease:node-a:c1:more"),
    entry(ref="pr:owner/project#1"),
    entry(ref="resource:node-a"),
    entry(value={"k": "x" * 4088}),
    entry(value={"k": "\u0000"}),
]


@pytest.mark.parametrize("bad", BAD_ENTRIES)
def test_invalid_entries_are_refused_by_the_model_itself(bad):
    with pytest.raises(ValidationError):
        StateEntry(**bad)


@pytest.mark.parametrize("bad", BAD_ENTRIES)
def test_invalid_entries_are_refused_and_store_nothing(http_api, credentials, make_producer, db, bad):
    producer = make_producer()
    assert code(post(http_api, credentials.room, producer, entry(OTHER_KEY), bad)) == (422, "INVALID_REQUEST")
    assert count(db, "room_state") == 0 and state_events(db) == 0


@pytest.mark.parametrize(
    "raw",
    [
        b'{"entries": []}',
        b'{"entries": ['
        + b",".join(json.dumps(entry(f"validation-lease:node-a:k{i}")).encode() for i in range(9))
        + b"]}",
        b'{"entries": [' + json.dumps(entry()).encode() + b"," + json.dumps(entry()).encode() + b"]}",
        b'{"entries": [{"state_key": "validation-lease:node-a:c1", "value": {"a": NaN}, "ttl_seconds": 90}]}',
        b'{"entries": [{"state_key": "validation-lease:node-a:c1", "value": {"a": Infinity}, "ttl_seconds": 90}]}',
        b'{"entries": [' + json.dumps(entry()).encode() + b'], "extra": 1}',
        b"{}",
    ],
)
def test_malformed_batches_are_refused(http_api, credentials, make_producer, db, raw):
    producer = make_producer()
    path = f"/v1/rooms/{credentials.room}/state"
    assert code(http_api("POST", path, token=producer.token, raw=raw)) == (422, "INVALID_REQUEST")
    assert count(db, "room_state") == 0 and state_events(db) == 0


def test_a_numeric_value_that_grows_in_jsonb_is_a_refusal_not_a_server_error(
    http_api, credentials, make_producer, db
):
    producer = make_producer()
    # 1e308 is six bytes in JSON and 309 digits in the jsonb text the database measures.
    value = {f"k{i}": 1e308 for i in range(20)}
    assert code(post(http_api, credentials.room, producer, entry(value=value))) == (422, "INVALID_REQUEST")
    assert count(db, "room_state") == 0 and state_events(db) == 0
    assert db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"] == 0


def test_the_size_limit_matches_the_database_measure_at_the_boundary(http_api, credentials, make_producer, db):
    producer = make_producer()
    assert post(http_api, credentials.room, producer, entry(value={"k": "x" * 4087}))[0] == 200
    assert db.execute("SELECT octet_length(value::text) AS n FROM agent_chat.room_state").fetchone()["n"] == 4096
    # Multi-byte text counts in bytes, not characters.
    wide = {"k": "é" * 1000 + "x" * 2087}
    assert post(http_api, credentials.room, producer, entry(OTHER_KEY, wide))[0] == 200
    sizes = db.execute("SELECT octet_length(value::text) AS n FROM agent_chat.room_state").fetchall()
    assert sorted(row["n"] for row in sizes) == [4096, 4096]
    over = {"k": "é" * 1000 + "x" * 2088}
    assert code(post(http_api, credentials.room, producer, entry(OTHER_KEY, over))) == (422, "INVALID_REQUEST")
    nested = {"a": [1, 2.5, None, True, {"b": "ü"}], "c": {"d": {"e": []}}, "f": ""}
    assert post(http_api, credentials.room, producer, entry("validation-lease:node-a:shared", nested))[0] == 200
    stored = db.execute(
        "SELECT octet_length(value::text) AS n FROM agent_chat.room_state WHERE state_key = %s",
        ("validation-lease:node-a:shared",),
    ).fetchone()["n"]
    assert stored == len(json.dumps(nested, ensure_ascii=False, separators=(", ", ": ")).encode())


def test_reads_compute_staleness_age_and_remaining_life_on_the_server_clock(
    http_api, credentials, make_producer, db, register
):
    producer = make_producer()
    assert post(http_api, credentials.room, producer, entry(value={"scan": "ok"}, ref=RESOURCE))[0] == 200
    status, page = read(http_api, credentials.room, credentials.operator)
    assert status == 200 and page["next_key"] is None and page["server_time"]
    [fresh] = page["entries"]
    assert fresh["producer"] == {"host": "node-a", "producer": "validation-lease"}
    assert set(fresh) == {
        "state_key", "ref_key", "value", "producer", "changed_at", "observed_at", "expires_at",
        "expires_in_seconds", "age_seconds", "stale", "stale_reason",
    }
    assert (fresh["stale"], fresh["stale_reason"], fresh["value"], fresh["ref_key"]) == (
        False, None, {"scan": "ok"}, RESOURCE)
    assert 85 <= fresh["expires_in_seconds"] <= 90 and fresh["age_seconds"] <= 5
    age(db, 100)
    [expired] = read(http_api, credentials.room, credentials.operator)[1]["entries"]
    assert (expired["stale"], expired["stale_reason"], expired["expires_in_seconds"]) == (True, "expired", 0)
    assert 100 <= expired["age_seconds"] <= 105
    # A member instance reads too; a producer never does; an outsider is refused.
    token, _ = register(SimpleNamespace(request=http_api), credentials, "reader")
    assert read(http_api, credentials.room, token)[0] == 200
    producer_read = read(http_api, credentials.room, producer.token)
    assert code(producer_read) == (401, "UNAUTHENTICATED")
    assert code(read(http_api, str(uuid4()), credentials.operator)) == (403, "ROOM_FORBIDDEN")


def test_reads_page_by_key_and_filter_by_ref_key(http_api, credentials, make_producer):
    producer = make_producer()
    keys = [f"validation-lease:node-a:{name}" for name in ("c1", "leaf", "shared")]
    assert post(
        http_api, credentials.room, producer,
        entry(keys[0], ref=RESOURCE), entry(keys[1]), entry(keys[2], ref=RESOURCE),
    )[0] == 200
    status, first = read(http_api, credentials.room, credentials.operator, "?limit=2")
    assert [row["state_key"] for row in first["entries"]] == keys[:2] and first["next_key"] == keys[1]
    last = read(http_api, credentials.room, credentials.operator, f"?limit=2&after_key={keys[1]}")[1]
    assert [row["state_key"] for row in last["entries"]] == keys[2:] and last["next_key"] is None
    keyed = read(http_api, credentials.room, credentials.operator, f"?ref_key={RESOURCE}")[1]
    assert [row["state_key"] for row in keyed["entries"]] == [keys[0], keys[2]]
    for query in ("?limit=0", "?limit=101", "?ref_key=free", "?after_key=BAD", "?extra=1", "?limit=1&limit=2"):
        assert read(http_api, credentials.room, credentials.operator, query)[0] == 422, query


def test_a_state_event_invalidates_without_carrying_the_value(process_api, credentials, make_producer, db, event):
    producer = make_producer()
    path = f"/v1/rooms/{credentials.room}/state"
    with process_api.stream(token=credentials.operator) as response:
        status, _ = process_api.request(
            "POST", path, {"entries": [entry(value={"secret": "marker"}, ref=RESOURCE)]}, producer.token
        )
        assert status == 200
        frame = event(response)
    assert frame["event"] == "state"
    assert frame["data"] == {"room_id": credentials.room, "state_key": KEY, "ref_key": RESOURCE}
    assert "marker" not in json.dumps(frame)
    # Once the row is pruned the event still replays, with nothing to report for the ref_key.
    db.execute("DELETE FROM agent_chat.room_state")
    operator = authenticate(db, credentials.operator)
    [replayed] = feed.events(db, operator, 0)["events"]
    assert replayed["event"] == "state"
    assert replayed["data"] == {"room_id": UUID(credentials.room), "state_key": KEY, "ref_key": None}


def test_prune_deletes_old_expired_rows_in_bounded_batches_and_keeps_its_counts(
    http_api, credentials, make_producer, db
):
    producer = make_producer(producer="state-test")
    keys = [f"state-test:node-a:k{i}" for i in range(4)]
    assert post(http_api, credentials.room, producer, *(entry(key) for key in keys))[0] == 200
    long_ago, recent = keys[:2], keys[2]
    db.execute(
        """UPDATE agent_chat.room_state SET changed_at = changed_at - interval '722 hours',
        observed_at = observed_at - interval '722 hours', expires_at = expires_at - interval '722 hours'
        WHERE state_key = ANY(%s)""",
        (long_ago,),
    )
    db.execute(
        """UPDATE agent_chat.room_state SET changed_at = changed_at - interval '100 hours',
        observed_at = observed_at - interval '100 hours', expires_at = expires_at - interval '100 hours'
        WHERE state_key = %s""",
        (recent,),
    )
    assert prune(db, limit=1) == {
        "events": 0,
        "redacted": 0,
        "deleted": 0,
        "ended_instances": 0,
        "memberships": 0,
        "expired_undelivered": 0,
        "reservations": 0,
        "delivery_batches": 0,
        "browser_sessions": 0,
        "room_state": 1,
    }
    assert count(db, "room_state") == 3
    prune(db, limit=1)
    assert count(db, "room_state") == 2
    prune(db, limit=1)
    remaining = {row["state_key"] for row in db.execute("SELECT state_key FROM agent_chat.room_state").fetchall()}
    assert remaining == {recent, keys[3]}
