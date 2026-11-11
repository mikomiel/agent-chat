from __future__ import annotations

import secrets
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from http.cookies import SimpleCookie
from typing import Any
from uuid import uuid4

import pytest
from psycopg import Connection

from agent_chat import browser
from agent_chat.api import create_app
from agent_chat.models import ChatError, Publication
from agent_chat.publication import publish
from agent_chat.retention import prune

ORIGIN = "https://chat.test"


@pytest.fixture
def public_origin():
    return ORIGIN


def cookies(headers):
    result = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            result.load(value)
    return result


def challenge(http_api):
    status, body, headers = http_api("GET", "/v1/login", include_headers=True)
    assert status == 200
    login_cookie = cookies(headers)[browser.LOGIN_COOKIE]
    assert login_cookie["secure"] and login_cookie["httponly"] and login_cookie["samesite"] == "strict"
    assert login_cookie["path"] == "/" and login_cookie["domain"] == "" and login_cookie["max-age"] == "600"
    nonce = login_cookie.value
    return {"Origin": ORIGIN, "Cookie": f"{browser.LOGIN_COOKIE}={nonce}", "X-CSRF-Token": body["csrf_token"]}


def logged_in(http_api, credentials):
    status, body, headers = http_api(
        "POST", "/v1/login", {"token": credentials.operator}, headers=challenge(http_api), include_headers=True
    )
    assert status == 200
    cookie = cookies(headers)[browser.SESSION_COOKIE]
    return cookie, body, headers


def browser_headers(cookie, csrf):
    return {"Origin": ORIGIN, "Cookie": f"{browser.SESSION_COOKIE}={cookie.value}", "X-CSRF-Token": csrf}


def test_login_cookie_flags_hash_only_storage_and_bootstrap(http_api, credentials, db):
    cookie, body, headers = logged_in(http_api, credentials)
    assert cookie["secure"] and cookie["httponly"] and cookie["samesite"] == "strict"
    assert cookie["path"] == "/" and cookie["domain"] == "" and cookie["max-age"] == "28800"
    assert body["access"] == "operator" and body["expires_in"] == 28800
    assert cookie.value != credentials.operator
    assert credentials.operator not in str(body) and credentials.operator not in str(headers)
    assert cookie.value not in str(body)
    row = db.execute(
        "SELECT token_hash, expires_at - created_at AS lifetime FROM agent_chat.browser_sessions"
    ).fetchone()
    assert row["token_hash"] == sha256(cookie.value.encode()).hexdigest()
    assert 28799 <= row["lifetime"].total_seconds() <= 28801
    request_headers = browser_headers(cookie, body["csrf_token"])
    assert http_api("GET", "/v1/rooms", headers=request_headers)[0] == 200
    status, recovered = http_api("GET", "/v1/browser/session", headers=request_headers)
    assert status == 200 and recovered["csrf_token"] == body["csrf_token"]
    assert recovered["access"] == "operator"
    assert http_api("GET", "/v1/rooms", token=cookie.value)[0] == 401
    assert http_api("GET", "/v1/browser/session", token=credentials.operator)[0] == 401


def test_cookie_publication_requires_origin_and_csrf(http_api, credentials, db):
    cookie, body, _ = logged_in(http_api, credentials)
    headers = {**browser_headers(cookie, body["csrf_token"]), "Idempotency-Key": str(uuid4())}
    path = f"/v1/rooms/{credentials.room}/messages"
    message = {"kind": "message", "body": "operator message"}
    for altered in (
        {k: v for k, v in headers.items() if k != "Origin"},
        {**headers, "Origin": "https://hostile.test"},
        {k: v for k, v in headers.items() if k != "X-CSRF-Token"},
        {**headers, "X-CSRF-Token": "bad"},
    ):
        assert http_api("POST", path, message, headers=altered)[0] == 403
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0
    status, stored = http_api("POST", path, message, headers=headers)
    assert status == 200 and stored["sender"]["session_id"] is None
    assert http_api("POST", path, message, token=credentials.operator, headers=headers)[0] == 401
    assert http_api("GET", "/v1/rooms?token=synthetic", headers=headers)[0] == 422
    assert http_api("OPTIONS", path, headers={"Origin": "https://hostile.test"})[0] == 403


def test_login_itself_requires_origin_and_prelogin_csrf(http_api, credentials, db):
    headers = challenge(http_api)
    payload = {"token": credentials.operator}
    for altered in (
        {k: v for k, v in headers.items() if k != "Origin"},
        {**headers, "Origin": "null"},
        {k: v for k, v in headers.items() if k != "X-CSRF-Token"},
        {**headers, "X-CSRF-Token": "wrong"},
    ):
        assert http_api("POST", "/v1/login", payload, headers=altered)[0] == 403
    assert db.execute("SELECT count(*) AS n FROM agent_chat.browser_sessions").fetchone()["n"] == 0


@pytest.mark.parametrize("purpose", ["agent", "instance", "producer", "unknown"])
def test_login_rejects_nonbrowser_tokens(
    http_api: Any, credentials: Any, db: Connection[dict[str, Any]], make_producer: Any, purpose: str,
) -> None:
    token = (credentials.agent if purpose == "agent" else
             make_producer().token if purpose == "producer" else secrets.token_hex(32))
    if purpose == "instance":
        payload = {
            "native_session_id": "synthetic",
            "boot_id": str(uuid4()),
            "instance_token_hash": sha256(token.encode()).hexdigest(),
        }
        assert http_api("POST", "/v1/sessions", payload, credentials.agent)[0] == 200
    assert http_api("POST", "/v1/login", {"token": token}, headers=challenge(http_api))[0] == 401
    assert db.execute("SELECT count(*) AS n FROM agent_chat.browser_sessions").fetchone() == {"n": 0}
    assert db.execute("SELECT cardinality(failures) AS n FROM agent_chat.login_guard").fetchone() == {"n": 1}


def test_logout_revokes_server_binding_and_already_resolved_actor(http_api, credentials, db):
    cookie, body, _ = logged_in(http_api, credentials)
    actor = browser.authenticate_cookie(db, cookie.value)
    headers = browser_headers(cookie, body["csrf_token"])
    assert http_api("POST", "/v1/logout", {}, headers={**headers, "X-CSRF-Token": "bad"})[0] == 403
    status, _, returned = http_api("POST", "/v1/logout", {}, headers=headers, include_headers=True)
    assert status == 200 and cookies(returned)[browser.SESSION_COOKIE]["max-age"] == "0"
    assert http_api("GET", "/v1/rooms", headers=headers)[0] == 401
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        publish(db, actor, credentials.room, uuid4(), Publication(kind="message", body="late"))
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0


@pytest.mark.parametrize("invalidate", ["expire", "revoke"])
def test_browser_session_expiry_and_principal_revocation(http_api, credentials, db, invalidate):
    cookie, body, _ = logged_in(http_api, credentials)
    actor = browser.authenticate_cookie(db, cookie.value)
    if invalidate == "expire":
        db.execute("UPDATE agent_chat.browser_sessions SET expires_at = clock_timestamp() - interval '1 second'")
    else:
        db.execute("UPDATE agent_chat.principals SET revoked = true WHERE kind = 'operator'")
    assert http_api("GET", "/v1/rooms", headers=browser_headers(cookie, body["csrf_token"]))[0] == 401
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        publish(db, actor, credentials.room, uuid4(), Publication(kind="message", body="late"))


def test_login_rotates_existing_cookie_without_extending_old_session(http_api, credentials, db):
    old, old_body, _ = logged_in(http_api, credentials)
    headers = challenge(http_api)
    headers["Cookie"] += f"; {browser.SESSION_COOKIE}={old.value}"
    status, new_body, returned = http_api(
        "POST", "/v1/login", {"token": credentials.operator}, headers=headers, include_headers=True
    )
    assert status == 200
    new = cookies(returned)[browser.SESSION_COOKIE]
    assert new.value != old.value
    assert http_api("GET", "/v1/rooms", headers=browser_headers(old, old_body["csrf_token"]))[0] == 401
    assert http_api("GET", "/v1/rooms", headers=browser_headers(new, new_body["csrf_token"]))[0] == 200
    assert db.execute("SELECT count(*) AS n FROM agent_chat.browser_sessions").fetchone()["n"] == 1


def login_with(http_api, token, previous=None):
    headers = challenge(http_api)
    if previous is not None:
        headers["Cookie"] += f"; {browser.SESSION_COOKIE}={previous.value}"
    status, body, returned = http_api("POST", "/v1/login", {"token": token}, headers=headers, include_headers=True)
    assert status == 200
    return cookies(returned)[browser.SESSION_COOKIE], body


@pytest.mark.parametrize(
    ("first", "second"), [("operator", "viewer"), ("viewer", "operator"), ("viewer", "other_viewer")]
)
def test_login_as_another_principal_ends_the_presented_cookie(http_api, credentials, db, make_viewer, first, second):
    tokens = {
        "operator": credentials.operator,
        "viewer": make_viewer(credentials.room).token,
        "other_viewer": make_viewer(credentials.room).token,
    }
    unrelated, unrelated_body = login_with(http_api, credentials.operator)
    old, old_body = login_with(http_api, tokens[first])
    new, new_body = login_with(http_api, tokens[second], previous=old)
    assert new.value != old.value
    assert http_api("GET", "/v1/rooms", headers=browser_headers(old, old_body["csrf_token"]))[0] == 401
    assert http_api("GET", "/v1/rooms", headers=browser_headers(new, new_body["csrf_token"]))[0] == 200
    # Only the presented cookie ends; another browser's session of either principal is untouched.
    assert http_api("GET", "/v1/rooms", headers=browser_headers(unrelated, unrelated_body["csrf_token"]))[0] == 200
    assert db.execute("SELECT count(*) AS n FROM agent_chat.browser_sessions").fetchone()["n"] == 2


def test_a_failed_login_leaves_the_presented_cookie_of_another_principal_valid(http_api, credentials, make_viewer):
    viewer = make_viewer(credentials.room)
    old, old_body = login_with(http_api, viewer.token)
    headers = challenge(http_api)
    headers["Cookie"] += f"; {browser.SESSION_COOKIE}={old.value}"
    assert http_api("POST", "/v1/login", {"token": secrets.token_hex(32)}, headers=headers)[0] == 401
    assert http_api("GET", "/v1/rooms", headers=browser_headers(old, old_body["csrf_token"]))[0] == 200


def test_expired_browser_bindings_are_pruned_in_bounded_batches(http_api, credentials, db):
    live, body, _ = logged_in(http_api, credentials)
    for _ in range(2):
        browser.login(db, credentials.operator)
    db.execute(
        """
        UPDATE agent_chat.browser_sessions SET expires_at = clock_timestamp() - interval '1 second'
        WHERE token_hash <> %s
    """,
        (sha256(live.value.encode()).hexdigest(),),
    )
    prune(db, limit=1)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.browser_sessions").fetchone()["n"] == 2
    prune(db, limit=1)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.browser_sessions").fetchone()["n"] == 1
    assert http_api("GET", "/v1/rooms", headers=browser_headers(live, body["csrf_token"]))[0] == 200


def test_failed_login_limit_is_durable_and_serialized(http_api, credentials, db):
    headers = challenge(http_api)
    wrong = {"token": secrets.token_hex(32)}
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: http_api("POST", "/v1/login", wrong, headers=headers)[0], range(12)))
    assert sorted(results) == [401] * 10 + [429] * 2
    assert db.execute("SELECT cardinality(failures) AS n FROM agent_chat.login_guard").fetchone()["n"] == 10
    assert http_api("POST", "/v1/login", {"token": credentials.operator}, headers=headers)[0] == 429
    # Database-clock advance equivalent; no sleep and no clock mutation on the host.
    db.execute("UPDATE agent_chat.login_guard SET failures = ARRAY[clock_timestamp() - interval '61 seconds']")
    assert http_api("POST", "/v1/login", {"token": credentials.operator}, headers=headers)[0] == 200
    assert db.execute("SELECT cardinality(failures) AS n FROM agent_chat.login_guard").fetchone()["n"] == 0


@pytest.mark.parametrize(
    "origin",
    [
        "http://chat.test",
        "https://chat.test/",
        "https://user:pass@chat.test",
        "https://chat.test:bad",
        "https://chat.test:443",
    ],
)
def test_invalid_browser_origin_is_refused_before_activation(database, origin):
    with pytest.raises(ValueError):
        create_app(database, enabled=True, public_origin=origin)


def test_unknown_viewer_asset_uses_the_error_envelope(http_api):
    assert http_api("GET", "/ui/missing.js") == (404, {"error": {"code": "NOT_FOUND", "message": "NOT_FOUND"}})
