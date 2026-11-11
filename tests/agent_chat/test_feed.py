import time
from concurrent.futures import ThreadPoolExecutor
from http.cookies import SimpleCookie
from uuid import UUID, uuid4

import pytest

from agent_chat import browser, feed, storage
from agent_chat.auth import authenticate
from agent_chat.models import Publication
from agent_chat.publication import publish
from agent_chat.retention import prune


@pytest.fixture
def public_origin():
    return "https://chat.test"


def test_two_clients_history_sse_reconnect_and_real_process_restart(process_api, credentials, register, send, event):
    first_token, _ = register(process_api, credentials, "first")
    second_token, _ = register(process_api, credentials, "second")
    with process_api.stream(token=second_token) as response:
        assert response.status == 200
        assert response.getheader("X-Accel-Buffering") == "no"
        first = send(process_api, credentials, "first", first_token)
        received = event(response)
        assert received["data"]["message"]["id"] == first["id"]
    missed = send(process_api, credentials, "missed while disconnected", first_token)
    before = process_api.restart()
    after = process_api.restart()
    assert before != after
    with process_api.stream(token=second_token, headers={"Last-Event-ID": received["id"]}) as response:
        restored = event(response)
        assert restored["data"]["message"]["id"] == missed["id"]
        assert int(restored["id"]) > int(received["id"])
    status, history = process_api.request("GET", f"/v1/rooms/{credentials.room}/history", token=second_token)
    assert status == 200 and [m["id"] for m in history["messages"]] == [first["id"], missed["id"]]


def test_history_pagination_thread_filter_and_retention_recovery(process_api, credentials, db, send):
    root = send(process_api, credentials, "root")
    reply = send(process_api, credentials, "reply", kind="reply", reply_to=root["id"])
    other = send(process_api, credentials, "other thread")
    path = f"/v1/rooms/{credentials.room}/history"
    status, page = process_api.request("GET", path + "?limit=1", token=credentials.operator)
    assert status == 200 and page["has_more"] and [m["id"] for m in page["messages"]] == [root["id"]]
    status, rest = process_api.request("GET", path + "?after=" + page["next_cursor"], token=credentials.operator)
    assert status == 200 and not rest["has_more"]
    assert [m["id"] for m in rest["messages"]] == [reply["id"], other["id"]]
    status, thread = process_api.request("GET", path + "?thread_id=" + root["thread_id"], token=credentials.operator)
    assert [m["id"] for m in thread["messages"]] == [root["id"], reply["id"]]
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second' WHERE id = %s",
        (root["id"],),
    )
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours' WHERE message_id = %s",
        (root["id"],),
    )
    prune(db)
    status, failure = process_api.request("GET", path + "?after=0", token=credentials.operator)
    assert status == 410 and failure["error"]["code"] == "CURSOR_EXPIRED"
    assert process_api.request("GET", "/v1/events?after=0", token=credentials.operator)[0] == 410
    status, recovery = process_api.request("GET", path, token=credentials.operator)
    assert status == 200 and [m["id"] for m in recovery["messages"]] == [reply["id"], other["id"]]
    assert int(recovery["retained_floor"]) > 0


def test_history_before_pages_newest_messages_in_commit_order(process_api, credentials, db, send):
    root = send(process_api, credentials, "m0")
    ids = [root["id"]]
    ids += [send(process_api, credentials, f"m{n}", kind="reply", reply_to=root["id"])["id"] for n in range(1, 5)]
    other = send(process_api, credentials, "another thread")["id"]
    path = f"/v1/rooms/{credentials.room}/history"
    latest = "before=9223372036854775807"

    def read(query):
        status, page = process_api.request("GET", f"{path}?{query}", token=credentials.operator)
        assert status == 200
        return page

    newest = read(f"{latest}&limit=2")
    assert [m["id"] for m in newest["messages"]] == [ids[4], other] and newest["has_more"]
    middle = read(f"before={newest['next_cursor']}&limit=2")
    assert [m["id"] for m in middle["messages"]] == ids[2:4] and middle["has_more"]
    oldest = read(f"before={middle['next_cursor']}&limit=2")
    assert [m["id"] for m in oldest["messages"]] == ids[:2] and not oldest["has_more"]
    # Every response names the clock itself, which the forward cursor of a partial page does not.
    clock = str(db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"])
    first_forward = read("limit=1")
    assert first_forward["has_more"] and first_forward["next_cursor"] != clock
    assert newest["position"] == middle["position"] == oldest["position"] == first_forward["position"] == clock
    # An exhausted backward page continues before its own oldest row, never the forward head: a caller paging
    # with `before=next_cursor` must reach the end of the history instead of re-reading the newest page.
    assert oldest["next_cursor"] != clock
    assert read(f"before={oldest['next_cursor']}&limit=2")["messages"] == []
    thread = read(f"{latest}&limit=2&thread_id={root['thread_id']}")
    assert [m["id"] for m in thread["messages"]] == ids[3:5] and thread["has_more"]
    # Both directions at once are ambiguous, even when each cursor alone is valid.
    status, _ = process_api.request("GET", f"{path}?after=0&{latest}", token=credentials.operator)
    assert status == 422
    # A cursor at or below the retained floor has no messages left, rather than an error.
    assert read("before=0")["messages"] == []


@pytest.mark.parametrize(
    "change,code",
    [
        ("principal", "UNAUTHENTICATED"),
        ("grant", "ROOM_SCOPE_CHANGED"),
        ("membership", "ROOM_SCOPE_CHANGED"),
        ("instance", "STALE_INSTANCE"),
    ],
)
def test_open_stream_rechecks_authority(process_api, credentials, db, change, code, register, event):
    token, binding = register(process_api, credentials, "listener")
    with process_api.stream(token=token) as response:
        assert response.status == 200
        if change == "principal":
            db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (credentials.principal,))
        elif change == "grant":
            db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (credentials.principal,))
        elif change == "membership":
            db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (binding["session_id"],))
        else:
            db.execute(
                "UPDATE agent_chat.instances SET ended_at = clock_timestamp() WHERE id = %s", (binding["instance_id"],)
            )
        notice = event(response)
        assert notice == {"event": "control", "data": {"error": {"code": code}}}
        assert response.read() == b""


def test_sse_has_no_uncommitted_events_or_database_connection_while_suspended(process_api, credentials, db, event):
    actor = authenticate(db, credentials.operator)
    with process_api.stream(token=credentials.operator) as response, ThreadPoolExecutor(max_workers=1) as pool:
        assert response.readline() == b": connected\n"
        assert response.readline() == b"\n"
        assert (
            db.execute("""SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND state LIKE 'idle in transaction%'
            """).fetchone()["n"]
            == 0
        )
        with db.transaction():
            stored = publish(
                db, actor, UUID(credentials.room), uuid4(), Publication(kind="message", body="held commit")
            )
            pending = pool.submit(event, response)
            deadline = time.monotonic() + 2.5
            while True:
                db.execute("SELECT pg_stat_clear_snapshot()")
                if db.execute(
                    "SELECT count(*) AS n FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                ).fetchone()["n"]:
                    break
                if time.monotonic() > deadline:
                    pytest.fail("SSE reader did not wait for the commit-order clock")
                time.sleep(0.01)
            assert not pending.done()
        assert pending.result(timeout=5)["data"]["message"]["id"] == str(stored["id"])


@pytest.mark.parametrize(
    "query",
    [
        "after=-1",
        "after=9223372036854775808",
        "after=1.1",
        "after=",
        "after=1&after=2",
        "token=hidden",
        "limit=101",
        "unknown=x",
        "before=-1",
        "before=",
        "before=9223372036854775808",
        "before=1&before=2",
    ],
)
def test_history_query_refusals(process_api, credentials, query):
    assert (
        process_api.request("GET", f"/v1/rooms/{credentials.room}/history?{query}", token=credentials.operator)[0]
        == 422
    )


def test_sse_validates_both_cursors_and_prefers_header(process_api, credentials, send, event):
    first = send(process_api, credentials, "first")
    second = send(process_api, credentials, "second")
    _, history = process_api.request("GET", f"/v1/rooms/{credentials.room}/history", token=credentials.operator)
    cursor = history["messages"][0]["cursor"]
    assert first["id"] == history["messages"][0]["id"]
    assert (
        process_api.request(
            "GET", "/v1/events?after=bad", token=credentials.operator, headers={"Last-Event-ID": cursor}
        )[0]
        == 422
    )
    assert (
        process_api.request("GET", "/v1/events?after=0", token=credentials.operator, headers={"Last-Event-ID": "bad"})[
            0
        ]
        == 422
    )
    assert process_api.request("GET", "/v1/events?after=9999", token=credentials.operator)[0] == 422
    with process_api.stream("/v1/events?after=0", credentials.operator, {"Last-Event-ID": cursor}) as response:
        assert event(response)["data"]["message"]["id"] == second["id"]


def test_room_creation_membership_scope_and_participants(process_api, credentials, db, register):
    token, binding = register(process_api, credentials, "visible")
    payload = {"slug": "project", "label": "Project"}
    assert process_api.request("POST", "/v1/rooms", payload, token)[0] == 403
    status, room = process_api.request("POST", "/v1/rooms", payload, credentials.operator)
    assert status == 200
    assert process_api.request("POST", "/v1/rooms", payload, credentials.operator) == (200, room)
    assert process_api.request("POST", "/v1/rooms", {**payload, "label": "different"}, credentials.operator)[0] == 409
    membership = {"session_id": binding["session_id"]}
    path = f"/v1/rooms/{room['id']}"
    assert process_api.request("POST", path + "/memberships", membership, credentials.operator)[0] == 422
    assert process_api.request("GET", path + "/history", token=token)[0] == 403
    # Credential owner grant is independent of room membership; HTTP cannot widen it.
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (credentials.principal, room["id"]))
    assert process_api.request("GET", path + "/history", token=token)[0] == 403
    assert process_api.request("POST", path + "/memberships", membership, credentials.operator)[0] == 200
    assert process_api.request("POST", path + "/memberships", membership, token)[0] == 403
    status, members = process_api.request("GET", path + "/participants", token=token)
    assert status == 200 and len(members["participants"]) == 1
    participant = members["participants"][0]
    assert participant["session_id"] == binding["session_id"] and participant["online"]
    assert participant["host"] == "synthetic-host" and participant["harness"] == "pi"
    assert "token_hash" not in participant and "boot_id" not in participant
    db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
    _, offline = process_api.request("GET", path + "/participants", token=credentials.operator)
    assert not offline["participants"][0]["online"] and offline["participants"][0]["native_state"] == "unknown"


def _beat(process_api, token):
    state = {"native_state": "idle", "stopped": False, "plan_mode": False}
    assert process_api.request("POST", "/v1/instance/heartbeat", state, token)[0] == 200


def test_lapsed_rows_report_stopped_and_online_filter_pages_by_session(process_api, credentials, db, register):
    path = f"/v1/rooms/{credentials.room}/participants"
    sessions = {name: register(process_api, credentials, name) for name in ("live-a", "live-b", "lapsed", "ended")}
    for token, _ in sessions.values():
        _beat(process_api, token)
    lapsed_id = sessions["lapsed"][1]["session_id"]
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'"
        " WHERE session_id = %s",
        (lapsed_id,),
    )
    assert process_api.request("POST", "/v1/instance/end", {}, sessions["ended"][0])[0] == 200
    live = {sessions[name][1]["session_id"] for name in ("live-a", "live-b")}

    _, everyone = process_api.request("GET", path, token=credentials.operator)
    rows = {row["session_id"]: row for row in everyone["participants"]}
    assert set(rows) == live | {lapsed_id, sessions["ended"][1]["session_id"]}
    assert all(not rows[sid]["stopped"] and not rows[sid]["plan_mode"] and rows[sid]["online"] for sid in live)
    # The last beat said running; a lapsed lease can never resume, so the roster must not repeat it.
    stale = rows[lapsed_id]
    assert not stale["online"] and stale["stopped"] is True and stale["plan_mode"] is True
    assert stale["native_state"] == "unknown"
    assert stale["heartbeat_at"] is not None and stale["instance_id"] == sessions["lapsed"][1]["instance_id"]
    gone = rows[sessions["ended"][1]["session_id"]]
    assert gone["instance_id"] is None and gone["stopped"] is True and gone["plan_mode"] is True

    # Filtered pages: one row per page, still ordered by session id, nothing skipped or repeated.
    found, after, pages = [], None, 0
    while True:
        query = "?online=true&limit=1" + ("&after_session=" + after if after else "")
        status, page = process_api.request("GET", path + query, token=credentials.operator)
        assert status == 200
        pages += 1
        found.extend(member["session_id"] for member in page["participants"])
        assert all(member["online"] for member in page["participants"])
        after = page["next_session_id"]
        if after is None:
            break
    assert pages == 2 and found == sorted(live)
    assert process_api.request("GET", path + "?online=false", token=credentials.operator)[1] == everyone
    assert process_api.request("GET", path + "?online=maybe", token=credentials.operator)[0] == 422


@pytest.mark.parametrize("how", ["ended", "lapsed"])
def test_dead_instance_token_is_refused_by_every_room_read(process_api, credentials, db, register, how):
    token, binding = register(process_api, credentials, "dead")
    _beat(process_api, token)
    room = f"/v1/rooms/{credentials.room}"
    reads = ["/v1/rooms", room + "/participants", room + "/history", room + "/state", "/v1/instance/status"]
    assert all(process_api.request("GET", path, token=token)[0] == 200 for path in reads)
    if how == "ended":
        assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200
    else:
        db.execute("UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'")
    for path in reads:
        status, body = process_api.request("GET", path, token=token)
        assert (status, body["error"]["code"]) == (409, "STALE_INSTANCE"), path
    with process_api.stream(token=token) as response:
        assert response.status == 409 and b"STALE_INSTANCE" in response.read()
    # The token still authenticates, so a repeated end is the one answer left (and it is idempotent).
    assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200
    assert process_api.request("POST", "/v1/instance/end", {}, token)[0] == 200


def test_event_batch_holds_grants_until_read_transaction_finishes(db, database, credentials):
    actor = authenticate(db, credentials.operator)

    def revoke():
        with storage.connect(database) as other:
            return other.execute(
                "DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (actor.principal_id,)
            ).rowcount

    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.transaction():
            feed.events(db, actor, 0)
            pending = pool.submit(revoke)
            deadline = time.monotonic() + 2
            while True:
                assert not pending.done(), "grant revocation overtook the authorized read transaction"
                db.execute("SELECT pg_stat_clear_snapshot()")
                waiting = db.execute(
                    "SELECT count(*) AS n FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                ).fetchone()["n"]
                if waiting:
                    break
                if time.monotonic() > deadline:
                    pytest.fail("grant revocation did not reach its row lock")
                time.sleep(0.01)
        assert pending.result(timeout=5) == 1


def test_expired_message_event_has_no_body(process_api, credentials, db, send, event):
    message = send(process_api, credentials, "expired body must not escape")
    db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second'")
    with process_api.stream(token=credentials.operator) as response:
        frame = event(response)
        assert frame["data"]["message_id"] == message["id"] and frame["data"]["message"] is None
        assert "expired body" not in str(frame)


def test_added_room_closes_stream_for_history_resynchronization(process_api, credentials, event):
    with process_api.stream(token=credentials.operator) as response:
        assert response.status == 200
        assert (
            process_api.request("POST", "/v1/rooms", {"slug": "added", "label": "Added"}, credentials.operator)[0]
            == 200
        )
        assert event(response)["data"]["error"]["code"] == "ROOM_SCOPE_CHANGED"
        assert response.read() == b""


def test_browser_cookie_stream_closes_on_logout(process_api, credentials, event):
    _, bootstrap, headers = process_api.request("GET", "/v1/login", include_headers=True)
    jar = SimpleCookie()
    for key, value in headers:
        if key.lower() == "set-cookie":
            jar.load(value)
    login_headers = {
        "Origin": "https://chat.test",
        "Cookie": f"{browser.LOGIN_COOKIE}={jar[browser.LOGIN_COOKIE].value}",
        "X-CSRF-Token": bootstrap["csrf_token"],
    }
    status, session, headers = process_api.request(
        "POST", "/v1/login", {"token": credentials.operator}, headers=login_headers, include_headers=True
    )
    assert status == 200
    for key, value in headers:
        if key.lower() == "set-cookie":
            jar.load(value)
    cookie_headers = {
        "Origin": "https://chat.test",
        "Cookie": f"{browser.SESSION_COOKIE}={jar[browser.SESSION_COOKIE].value}",
        "X-CSRF-Token": session["csrf_token"],
    }
    with process_api.stream(headers=cookie_headers) as response:
        assert response.status == 200
        assert process_api.request("POST", "/v1/logout", {}, headers=cookie_headers)[0] == 200
        assert event(response)["data"]["error"]["code"] == "UNAUTHENTICATED"
        assert response.read() == b""


def test_database_failure_after_headers_is_sanitized_control(process_api, credentials, db, event):
    with process_api.stream(token=credentials.operator) as response:
        assert response.status == 200
        db.execute("ALTER TABLE agent_chat.events RENAME TO deliberately_unavailable_events")
        assert event(response) == {"event": "control", "data": {"error": {"code": "DATABASE_UNAVAILABLE"}}}
        assert response.read() == b""
    assert process_api.request("GET", "/healthz")[0] == 200


def test_sse_batches_preserve_every_id_and_escape_content(process_api, credentials, send, event):
    ids = []
    body = "line one\nevent: control\nid: forged\n<script>untrusted</script>"
    for index in range(19):
        ids.append(send(process_api, credentials, body if index == 0 else str(index))["id"])
    with process_api.stream(token=credentials.operator) as response:
        frames = [event(response) for _ in ids]
    assert [frame["data"]["message"]["id"] for frame in frames] == ids
    assert len({frame["id"] for frame in frames}) == len(ids)
    assert frames[0]["data"]["message"]["body"] == body
    assert all(frame["event"] == "message" for frame in frames)


def test_catch_up_pages_stream_without_waiting_for_the_poll_interval(process_api, credentials, send, event):
    ids = [send(process_api, credentials, f"backlog {n}")["id"] for n in range(40)]
    # A poll interval far beyond the five-second read timeout: only back-to-back pages can deliver 40 events.
    process_api.restart(stream_poll=30)
    with process_api.stream(token=credentials.operator) as response:
        frames = [event(response) for _ in ids]
    assert [frame["data"]["message"]["id"] for frame in frames] == ids


def test_participant_pages_and_repeated_join_do_not_duplicate(process_api, credentials, register):
    bindings = [register(process_api, credentials, f"session-{n}")[1] for n in range(3)]
    path = f"/v1/rooms/{credentials.room}/participants"
    found = []
    after = None
    for _ in bindings:
        query = "?limit=1" + ("&after_session=" + after if after else "")
        status, page = process_api.request("GET", path + query, token=credentials.operator)
        assert status == 200
        found.extend(member["session_id"] for member in page["participants"])
        after = page["next_session_id"]
    assert after is None and set(found) == {binding["session_id"] for binding in bindings}
    for _ in range(2):
        assert (
            process_api.request(
                "POST", f"/v1/rooms/{credentials.room}/memberships", {"session_id": found[0]}, credentials.operator
            )[0]
            == 200
        )
    assert len(process_api.request("GET", path, token=credentials.operator)[1]["participants"]) == 3


def test_inaccessible_room_not_in_history_or_stream(process_api, credentials, register, send, event):
    token, _ = register(process_api, credentials, "restricted")
    _, private = process_api.request(
        "POST", "/v1/rooms", {"slug": "private", "label": "Private"}, credentials.operator
    )
    assert (
        process_api.request(
            "POST",
            f"/v1/rooms/{private['id']}/messages",
            {"kind": "message", "body": "private"},
            credentials.operator,
            {"Idempotency-Key": str(uuid4())},
        )[0]
        == 200
    )
    public = send(process_api, credentials, "public")
    assert process_api.request("GET", f"/v1/rooms/{private['id']}/history", token=token)[0] == 403
    with process_api.stream(token=token) as response:
        assert event(response)["data"]["message"]["id"] == public["id"]
