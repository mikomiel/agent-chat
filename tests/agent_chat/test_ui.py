"""Real Chromium → isolated HTTPS → private PostgreSQL; synthetic credentials only."""

from __future__ import annotations

import json
import socket
import subprocess
import time
from threading import Thread
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
import uvicorn
from playwright.sync_api import Route, expect, sync_playwright
from psycopg import Connection, sql

from agent_chat import roles, sessions, state, threads
from agent_chat.api import create_app
from agent_chat.auth import authenticate
from agent_chat.models import Heartbeat, ProducerActor, Publication, RoomCreation, StateEntry, StateUpsert
from agent_chat.publication import publish
from agent_chat.receipts import acknowledge
from agent_chat.retention import prune
from agent_chat.rooms import create


@pytest.fixture(scope="module")
def chromium():
    # Missing pinned browser is a failing prerequisite, never an environmental skip.
    # Prepare with: uv run python -m playwright install chromium
    with sync_playwright() as driver:
        browser = driver.chromium.launch()
        try:
            yield browser
        finally:
            browser.close()


@pytest.fixture(scope="module")
def tls_cert(tmp_path_factory):
    directory = tmp_path_factory.mktemp("tls")
    cert, key = directory / "cert.pem", directory / "key.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(key), "-out", str(cert), "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1",
        ],
        check=True, capture_output=True, timeout=10,
    )
    return cert, key


@pytest.fixture
def app_options():
    # Override per test with @pytest.mark.parametrize("app_options", [{...}]).
    return {}


@pytest.fixture
def ui(database, db, credentials, tls_cert, chromium, app_options):
    cert, key = tls_cert
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        origin = f"https://127.0.0.1:{listener.getsockname()[1]}"
        server = uvicorn.Server(uvicorn.Config(
            create_app(database, enabled=True, public_origin=origin, **app_options),
            ssl_certfile=str(cert), ssl_keyfile=str(key),
            log_config=None, access_log=False, lifespan="off", ws="none", proxy_headers=False,
            timeout_graceful_shutdown=3,
        ))
        thread = Thread(target=server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline, "isolated HTTPS server did not start"
                time.sleep(0.01)
            # Only this disposable context trusts its test certificate. No host CA changes.
            with chromium.new_context(ignore_https_errors=True, service_workers="block") as context:
                context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin + "/")
                              else route.abort())
                page = context.new_page()
                page.set_default_timeout(5000)
                errors = []
                page.on("pageerror", lambda error: errors.append(type(error).__name__))
                page.goto(origin)
                expect(page.locator("#login")).to_be_visible()

                def login(token: str | None = None) -> None:
                    page.locator("#token").fill(token or credentials.operator)
                    page.get_by_role("button", name="Zaloguj", exact=True).click()
                    expect(page.locator("#viewer")).to_be_visible()
                    expect(page.locator("#notice")).to_contain_text("Migawka historii")

                yield SimpleNamespace(page=page, context=context, login=login, origin=origin, errors=errors)
                assert errors == [], "unexpected browser runtime error"
        finally:
            server.should_exit = True
            thread.join(timeout=8)
            assert not thread.is_alive(), "isolated HTTPS server survived teardown"


def stored(db, credentials, body):
    return publish(
        db, authenticate(db, credentials.operator), UUID(credentials.room), uuid4(),
        Publication(kind="message", body=body),
    )


def send(page, body=None):
    if body is not None:
        page.locator("#body").fill(body)
    page.get_by_role("button", name="Wyślij", exact=True).click()


def choose(page, session):
    page.get_by_role("button", name=f"Wybierz {session}", exact=True).click()


def hold_response(page, pattern, *, fetch=True, first=False, when=lambda request: True):
    """Capture matching requests as (route, response) until the test releases them.

    `fetch` lets the real service answer first, so the browser sees a response only on release;
    `first` and `when` leave other matching requests untouched.
    """
    held = []

    def transport(route):
        if not when(route.request) or (first and held):
            route.continue_()
        else:
            held.append((route, route.fetch() if fetch else None))

    page.route(pattern, transport)
    return held


def wait_held(page, held):
    deadline = time.monotonic() + 5
    while not held:
        assert time.monotonic() < deadline, "no request was held"
        page.wait_for_timeout(10)


def wait_flag(page, name):
    # Not page.wait_for_function: its string predicate is compiled inside the page, which the
    # application's CSP (script-src 'self', no unsafe-eval) refuses once the first check fails.
    # page.evaluate runs through the protocol and is not subject to the page CSP.
    deadline = time.monotonic() + 5
    while page.evaluate("(name) => window[name] !== true", name):
        assert time.monotonic() < deadline, f"window.{name} was never set"
        page.wait_for_timeout(10)


def release(entry):
    route, response = entry
    if response is None:
        route.continue_()
    else:
        route.fulfill(response=response)


def commit_then_lose(page, pattern, record=lambda request: None):
    """The first matching POST commits on the real service; the browser never sees its response."""
    seen = []

    def transport(route):
        if route.request.method != "POST":
            route.continue_()
            return
        record(route.request)
        seen.append(route)
        if len(seen) == 1:
            assert route.fetch().status == 200
            route.abort()
        else:
            route.continue_()

    page.route(pattern, transport)


def lose_first_publication(ui, body):
    calls = []
    commit_then_lose(
        ui.page, "**/v1/rooms/*/messages",
        lambda request: calls.append((request.headers["idempotency-key"], request.post_data_json,
                                      request.headers["x-csrf-token"])),
    )
    send(ui.page, body)
    expect(ui.page.locator("#write-status")).to_contain_text("Zapis niepotwierdzony")
    return calls


def count(db, table, where="true", params=()):
    return db.execute(f"SELECT count(*) AS n FROM agent_chat.{table} WHERE {where}", params).fetchone()["n"]  # noqa: S608


def test_https_login_text_rendering_cookies_csp_and_logout(ui, db, credentials):
    payload = '<img src="/exfil" onerror="window.compromised=true"><script>window.compromised=true</script>'
    stored(db, credentials, payload)
    requests = []
    ui.page.on("request", lambda request: requests.append((request.method, request.url)))
    ui.login()
    expect(ui.page.locator(".body")).to_have_text(payload)
    assert ui.page.locator("#messages img, #messages script").count() == 0
    assert ui.page.evaluate("window.compromised === undefined")
    assert ui.page.locator("#token").input_value() == ""
    assert ui.page.evaluate("localStorage.length + sessionStorage.length") == 0
    assert "agent-chat" not in ui.page.evaluate("document.cookie")
    cookies = ui.context.cookies()
    session = next(cookie for cookie in cookies if cookie["name"] == "__Host-agent-chat-session")
    assert session["secure"] and session["httpOnly"] and session["sameSite"] == "Strict"
    response = ui.context.request.get(ui.origin + "/")
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    # A real CSP violation, not a search for the policy in source.
    ui.page.evaluate("""() => {
        const s = document.createElement('script');
        s.textContent = 'window.inlineRan = true'; document.body.append(s);
    }""")
    assert ui.page.evaluate("window.inlineRan === undefined")
    assert not any("/exfil" in url or credentials.operator in url for _, url in requests)
    assert [(method, url.removeprefix(ui.origin)) for method, url in requests if method == "POST"] == [
        ("POST", "/v1/login")
    ]
    ui.page.get_by_role("button", name="Wyloguj", exact=True).click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    expect(ui.page.locator("#messages")).to_be_empty()
    ui.page.reload()
    expect(ui.page.locator("#login")).to_be_visible()
    assert ui.context.request.get(ui.origin + "/v1/browser/session").status == 401


def test_history_shows_the_newest_page_and_pages_back_in_commit_order(ui, db, credentials):
    for index in range(51):
        stored(db, credentials, f"page message {index:02}")
    ui.login()
    expect(ui.page.locator(".body")).to_have_text([f"page message {index:02}" for index in range(1, 51)])
    ui.page.locator("#more-messages").click()
    expect(ui.page.locator(".body")).to_have_text(["page message 00"])
    expect(ui.page.locator("#more-messages")).to_be_hidden()
    # A refresh returns to the newest page rather than keeping the older one.
    ui.page.locator("#refresh").click()
    expect(ui.page.locator(".body")).to_have_count(50)
    expect(ui.page.locator("#more-messages")).to_be_visible()


def test_history_offers_a_back_to_latest_control(ui, db, credentials):
    for index in range(51):
        stored(db, credentials, f"latest-page message {index:02}")
    ui.login()
    expect(ui.page.locator(".body")).to_have_count(50)
    expect(ui.page.locator("#latest")).to_be_hidden()
    ui.page.locator("#more-messages").click()
    expect(ui.page.locator(".body")).to_have_count(1)
    expect(ui.page.locator("#latest")).to_be_visible()
    ui.page.locator("#latest").click()
    expect(ui.page.locator(".body")).to_have_count(50)
    expect(ui.page.locator("#latest")).to_be_hidden()


def test_refresh_preserves_the_selected_room_and_the_draft(ui, db, credentials):
    operator = authenticate(db, credentials.operator)
    other = create(db, operator, RoomCreation(slug="second-room", label="Second room"))
    stored(db, credentials, "only in the first room")
    publish(db, operator, other["id"], uuid4(), Publication(kind="message", body="second room history"))
    ui.login()
    expect(ui.page.locator(".body")).to_have_text("only in the first room")
    ui.page.locator("#room").select_option(str(other["id"]))
    expect(ui.page.locator(".body")).to_have_text("second room history")
    ui.page.locator("#body").fill("draft survives refresh")
    # A refresh must not ask to discard the draft; accepting a stray prompt would lose it.
    ui.page.once("dialog", lambda dialog: dialog.accept())
    with ui.page.expect_response(
        lambda response: response.request.method == "GET"
        and response.url.endswith("/v1/browser/session")
    ):
        ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    assert ui.page.locator("#room").input_value() == str(other["id"])
    assert ui.page.locator("#body").input_value() == "draft survives refresh"
    expect(ui.page.locator(".body")).to_have_text("second room history")


def test_bfcache_restore_after_pagehide_reopens_a_room_without_claiming_a_draft(ui, db, credentials):
    stored(db, credentials, "visible after restore")
    ui.login()
    ui.page.locator("#body").fill("draft lost at pagehide")
    # pagehide locks the page and clears the draft; a persisted pageshow then restores the same document.
    ui.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))")
    expect(ui.page.locator("#login")).to_be_visible()
    ui.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))")
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    expect(ui.page.locator(".body")).to_have_text("visible after restore")
    assert ui.page.locator("#room").input_value() == credentials.room
    assert ui.page.locator("#body").input_value() == ""
    expect(ui.page.locator("#notice")).not_to_contain_text("Szkic pozostaje")


def test_refresh_with_a_revoked_room_requires_explicit_selection(ui, db, credentials):
    operator = authenticate(db, credentials.operator)
    create(db, operator, RoomCreation(slug="z-spare", label="Spare"))
    ui.login()
    ui.page.locator("#body").fill("draft survives the revoked room")
    db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s",
               (operator.principal_id, credentials.room))
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Wybrany pokój nie jest już dostępny")
    assert ui.page.locator("#room").input_value() == ""
    assert ui.page.locator("#body").input_value() == "draft survives the revoked room"
    expect(ui.page.locator("#messages")).to_be_empty()
    # A second refresh must take the preserving path too. Otherwise it prompts to
    # discard the draft and the initial-load path silently chooses the spare room.
    dialogs = []
    ui.page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Wybierz pokój")
    expect(ui.page.locator("#notice")).to_contain_text("Szkic pozostaje")
    assert ui.page.locator("#room").input_value() == ""
    assert ui.page.locator("#body").input_value() == "draft survives the revoked room"
    expect(ui.page.locator("#messages")).to_be_empty()
    assert dialogs == []


def test_refresh_after_scope_revocation_clears_the_snapshot(ui, db, credentials):
    stored(db, credentials, "private until revoked")
    ui.login()
    expect(ui.page.locator(".body")).to_have_text("private until revoked")
    # Removing access must clear previously rendered data on the next explicit refresh.
    actor = authenticate(db, credentials.operator)
    db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (actor.principal_id,))
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_have_text("Brak dostępnych pokoi. Możesz utworzyć pokój.")
    expect(ui.page.locator("#messages")).to_be_empty()


def test_late_old_room_response_cannot_render_in_new_room(ui, db, credentials):
    stored(db, credentials, "old-room-private-text")
    other = create(db, authenticate(db, credentials.operator), RoomCreation(slug="other", label="Other"))
    ui.login()
    old_data = ui.context.request.get(ui.origin + f"/v1/rooms/{credentials.room}/history").json()
    assert old_data["messages"][0]["body"] == "old-room-private-text"
    # Model a transport whose result cannot be canceled. Keep real fetch/JSON/DOM semantics;
    # prove the generation fence independently of the cancellation optimization.
    ui.page.evaluate("""(prefix) => {
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (!url.startsWith(prefix)) return original(url, options);
            const response = await original(url, {...options, signal: undefined});
            const json = response.json.bind(response);
            response.json = async () => {
                const data = await json(); window.oldResponseConsumed = true; return data;
            };
            return response;
        };
    }""", f"/v1/rooms/{credentials.room}/history?")
    # Start a refresh of the old room, then switch while its response is held at the browser boundary.
    held = hold_response(ui.page, f"**/v1/rooms/{credentials.room}/history?*", fetch=False)
    ui.page.locator("#room").dispatch_event("change")
    expect(ui.page.locator("#notice")).to_have_text("Odczyt pokoju…")
    wait_held(ui.page, held)
    ui.page.locator("#room").select_option(str(other["id"]))
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    # The canceled request may still finish outside this client's control.
    held[0][0].fulfill(status=200, content_type="application/json", body=json.dumps(old_data))
    wait_flag(ui.page, "oldResponseConsumed")
    expect(ui.page.locator("#messages")).to_be_empty()
    assert ui.page.locator("#room").input_value() == str(other["id"])


def test_network_logout_uncertainty_hides_data_and_allows_explicit_retry(ui, db, credentials):
    stored(db, credentials, "private before logout")
    ui.login()
    ui.page.route("**/v1/logout", lambda route: route.abort())
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#notice")).to_contain_text("Wylogowanie niepotwierdzone")
    expect(ui.page.locator("#messages")).to_be_empty()
    expect(ui.page.locator("#viewer")).to_be_hidden()
    assert ui.context.request.get(ui.origin + "/v1/browser/session").status == 200
    ui.page.unroute("**/v1/logout")
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")


def test_failed_login_does_not_retain_token_or_echo_upstream_text(ui):
    ui.page.locator("#token").fill("0" * 64)
    ui.page.get_by_role("button", name="Zaloguj", exact=True).click()
    expect(ui.page.locator("#login")).to_be_visible()
    expect(ui.page.locator("#viewer")).to_be_hidden()
    assert ui.page.locator("#token").input_value() == ""
    assert "0" * 64 not in ui.page.locator("body").inner_text()


def test_login_failures_are_told_apart_from_a_missing_session(ui):
    # A plain first load has no session; that is neither an expired session nor a refused token.
    expect(ui.page.locator("#notice")).to_have_text("Brak aktywnej sesji. Zaloguj się tokenem operatora lub podglądu.")
    ui.page.locator("#token").fill("0" * 64)
    ui.page.get_by_role("button", name="Zaloguj", exact=True).click()
    expect(ui.page.locator("#notice")).to_have_text(
        "Logowanie odrzucone. Sprawdź token i spróbuj ponownie.")
    ui.page.route("**/v1/login", lambda route: route.fulfill(
        status=429, content_type="application/json", body='{"error":{"code":"LOGIN_RATE_LIMITED"}}',
    ) if route.request.method == "POST" else route.continue_())
    ui.page.locator("#token").fill("0" * 64)
    ui.page.get_by_role("button", name="Zaloguj", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zbyt wiele")
    expect(ui.page.locator("#login")).to_be_visible()


def test_participants_and_explicit_ack_are_not_native_handoff(ui, db, credentials, actors):
    room, first, second, _operator = actors
    first_message = publish(db, authenticate(db, credentials.operator), room, uuid4(), Publication(
        kind="question", body="explicitly acknowledged", recipients=[first.session_id],
    ))
    second_message = publish(db, authenticate(db, credentials.operator), room, uuid4(), Publication(
        kind="question", body="unprocessed", recipients=[second.session_id],
    ))
    acknowledge(db, first, first_message["id"])
    ui.login()
    expect(ui.page.locator("#participants > li")).to_have_count(2)
    expect(ui.page.locator("#participants")).to_contain_text("pi · synthetic-host")
    expect(ui.page.locator("#participants")).to_contain_text("Plan Mode: true")
    cards = ui.page.locator("#messages > li")
    expect(cards.nth(0)).to_contain_text("przekazanie: —")
    assert "ACK: —" not in cards.nth(0).inner_text()
    expect(cards.nth(1)).to_contain_text("ACK: —")
    assert db.execute(
        "SELECT acknowledged_at FROM agent_chat.recipients WHERE message_id = %s", (second_message["id"],)
    ).fetchone()["acknowledged_at"] is None


def test_native_titles_rename_without_retargeting_and_render_as_text(ui, db, actors):
    room, first, second, _ = actors
    title = '<img src=x onerror="alert(1)"> Repair queue'
    fields = {"native_state": "idle", "stopped": False, "plan_mode": False}
    for actor in (first, second):
        sessions.heartbeat(db, actor, Heartbeat(**fields, title=title))
    publish(db, first, room, uuid4(), Publication(kind="message", body="Title regression"))
    ui.login()
    expect(ui.page.locator("#participants .session-title").filter(has_text=title)).to_have_count(2)
    expect(ui.page.locator("#messages .sender-name")).to_have_text(title)
    expect(ui.page.locator("#messages .sender-identity")).to_contain_text(str(first.session_id)[:8])
    expect(ui.page.locator("#participants img, #messages img")).to_have_count(0)
    choose(ui.page, first.session_id)
    ui.page.locator("#body").fill("Draft stays addressed to the same UUID")
    sessions.heartbeat(db, first, Heartbeat(**fields, title="Renamed session"))
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#messages .sender-name")).to_have_text("Renamed session")
    expect(ui.page.locator("#targets")).to_contain_text("Renamed session")
    expect(ui.page.locator("#targets")).to_contain_text(str(first.session_id))
    expect(ui.page.locator("#body")).to_have_value("Draft stays addressed to the same UUID")
    sessions.heartbeat(db, first, Heartbeat(**fields, title=None))
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#messages .sender-name")).to_contain_text("pi · synthetic-host")


@pytest.mark.parametrize("viewport", [{"width": 1280, "height": 720}, {"width": 390, "height": 844}])
def test_viewer_readonly_titles_uuid_receipts_and_layout(
    ui: Any, db: Connection[dict[str, Any]], actors: Any, actor_factory: Any, make_viewer: Any,
    viewport: dict[str, int],
) -> None:
    room, first, second, operator = actors
    participants = [first, second] + [actor_factory(room) for _ in range(18)]
    titles = [
        None, "Duplicate title", "Duplicate title", '<img src=x onerror="window.viewerInjected=true">', "🧪" * 128,
    ]
    for actor, title in zip(participants, titles):
        sessions.heartbeat(db, actor, Heartbeat(native_state="idle", stopped=False, plan_mode=False, title=title))
    messages = [publish(db, actor, room, uuid4(), Publication(
        kind="question", body=f"synthetic viewer message {index}", recipients=(participants[-1].session_id,),
    )) for index, actor in enumerate(participants[:5])]
    acknowledge(db, participants[-1], messages[0]["id"])
    other = create(db, operator, RoomCreation(slug="z-approved", label="Other approved room"))["id"]
    publish(db, operator, other, uuid4(), Publication(kind="message", body="other approved content"))
    viewer = make_viewer(room, other)
    tables = ("messages", "recipients", "events", "sessions", "instances", "memberships", "delivery_attempts")
    query = sql.SQL("SELECT to_jsonb(t) AS row FROM agent_chat.{} t ORDER BY to_jsonb(t)::text")
    before = {table: db.execute(query.format(sql.Identifier(table))).fetchall() for table in tables}
    ui.page.set_viewport_size(viewport)
    requests = []
    ui.page.on("request", lambda request: requests.append((request.method, request.url)))
    ui.login(viewer.token)
    expect(ui.page.locator("#viewer")).to_have_attribute("data-access", "viewer")
    expect(ui.page.locator("#read-only-indicator")).to_be_visible()
    expect(ui.page.locator("#read-only-indicator")).to_contain_text("tylko odczyt")
    expect(ui.page.locator("#composer")).to_be_hidden()
    expect(ui.page.locator("#room-admin")).to_be_hidden()
    assert ui.page.locator("#draft-fields, #room-fields, #membership-fields").evaluate_all(
        "fields => fields.every(field => field.disabled)"
    )
    assert ui.page.locator(".reply, .mute-session, .pm-session, .resolve-thread, .choose-target").evaluate_all(
        "buttons => buttons.length > 0 && buttons.every(button => button.disabled)"
    )
    # Only the read-only filters accept input; none sends anything.
    assert ui.page.locator("#viewer input:enabled, #viewer textarea:enabled").evaluate_all(
        "fields => fields.map(field => field.id).sort()"
    ) == ["roster-filter", "sessions-filter", "thread"]
    if viewport["width"] == 390:
        expect(ui.page.locator("#participants-details")).not_to_have_attribute("open", "")
        ui.page.locator("#participants-details > summary").click()
    expect(ui.page.locator("#participants > li")).to_have_count(20)
    for actor, title in zip(participants, titles):
        item = ui.page.locator(f'#participants > li[data-session-id="{actor.session_id}"]')
        expected_identity = f"pi · synthetic-host · {str(actor.session_id)[:8]}"
        expect(item.locator(".session-title")).to_have_text(title or expected_identity)
        expect(item.locator(".participant-id")).to_have_text(str(actor.session_id))
        expect(item.locator(".participant-identity")).to_have_text(expected_identity)
        expect(item.locator(".participant-label")).to_have_text("synthetic-session")
    for actor, title, message in zip(participants, titles, messages):
        item = ui.page.locator(f'#messages > li[data-message-id="{message["id"]}"]')
        identity = f"pi · synthetic-host · {str(actor.session_id)[:8]}"
        expect(item.locator(".sender-name")).to_have_text(title or identity)
        # An untitled session is already named by its identity; only a titled one repeats it.
        expect(item.locator(".sender-identity")).to_have_count(1 if title else 0)
        if title:
            expect(item.locator(".sender-identity")).to_have_text(identity)
        expect(item.locator(".body")).to_have_text(message["body"])
        expect(item.locator(".receipt-summary")).to_contain_text("ACK: tak" if message == messages[0] else "ACK: —")
        item.locator(".message-evidence > summary").click()
        expect(item.locator(".evidence-receipts")).to_be_visible()
        expect(item.locator(".evidence-grid")).to_contain_text(str(actor.session_id))
    assert ui.page.locator("#participants img, #messages img").count() == 0
    assert ui.page.evaluate("window.viewerInjected === undefined")
    assert ui.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    for selector in ("#refresh", "#room", "#apply-thread", "#all-history", ".show-thread"):
        control = ui.page.locator(selector).first
        expect(control).to_be_enabled()
        control.scroll_into_view_if_needed()
        box = control.bounding_box()
        assert box is not None and box["width"] > 0 and box["height"] > 0
        assert box["x"] >= 0 and box["x"] + box["width"] <= viewport["width"] + 1
    ui.page.locator(".show-thread").first.click()
    expect(ui.page.locator("#messages > li")).to_have_count(1)
    expect(ui.page.locator(".resolve-thread")).to_be_disabled()
    ui.page.locator("#all-history").click()
    expect(ui.page.locator("#messages > li")).to_have_count(5)
    ui.page.locator("#room").select_option(str(other))
    expect(ui.page.locator(".body")).to_have_text("other approved content")
    ui.page.locator("#room").select_option(str(room))
    expect(ui.page.locator("#messages > li")).to_have_count(5)
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#viewer")).to_have_attribute("data-access", "viewer")
    expect(ui.page.locator("#read-only-indicator")).to_be_visible()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    ui.page.locator("#live-toggle").click()
    for table, rows in before.items():
        assert db.execute(query.format(sql.Identifier(table))).fetchall() == rows
    assert [url.removeprefix(ui.origin) for method, url in requests if method == "POST"] == ["/v1/login"]
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#login")).to_be_visible()
    expect(ui.page.locator("#read-only-indicator")).to_be_hidden()
    assert ui.page.locator("#viewer").get_attribute("data-access") is None


@pytest.mark.parametrize("access", [None, "admin", "instance", "", True])
@pytest.mark.parametrize("phase", ["login", "bootstrap"])
def test_browser_fails_closed_for_missing_or_unknown_access(
    ui: Any, db: Connection[dict[str, Any]], credentials: Any, access: Any, phase: str,
) -> None:
    stored(db, credentials, "must remain unread")
    reads = []
    ui.page.on("request", lambda request: reads.append(request.url) if "/v1/rooms" in request.url else None)

    def invalid(route: Route) -> None:
        response = route.fetch()
        data = response.json()
        if access is None:
            data.pop("access", None)
        else:
            data["access"] = access
        route.fulfill(response=response, json=data)

    if phase == "bootstrap":
        ui.page.route("**/v1/browser/session", invalid)
    else:
        ui.page.route("**/v1/login", lambda route: invalid(route)
                      if route.request.method == "POST" else route.continue_())
    ui.page.locator("#token").fill(credentials.operator)
    ui.page.get_by_role("button", name="Zaloguj", exact=True).click()
    expect(ui.page.locator("#login")).to_be_visible()
    expect(ui.page.locator("#viewer")).to_be_hidden()
    expect(ui.page.locator("#composer")).to_be_hidden()
    assert ui.page.locator("#viewer").get_attribute("data-access") is None
    assert reads == []


def test_history_title_is_readable_when_sender_is_not_in_participant_snapshot(ui, db, actors):
    room, first, _, _ = actors
    sessions.heartbeat(db, first, Heartbeat(
        native_state="idle", stopped=False, plan_mode=False, title="Previous contributor",
    ))
    publish(db, first, room, uuid4(), Publication(kind="message", body="Retained history"))
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s", (first.session_id,))
    ui.login()
    expect(ui.page.locator("#messages .sender-name")).to_have_text("Previous contributor")
    expect(ui.page.locator("#messages .sender-identity")).to_contain_text(str(first.session_id)[:8])


def test_session_labels_are_isolated_from_the_flags_beside_them(ui, db, actors):
    _room, first, _second, _operator = actors
    spoof = "x‮ eldi⁩"  # A stored label may predate the registration check.
    db.execute("UPDATE agent_chat.sessions SET native_session_id = %s, label = %s WHERE id = %s",
               (spoof, f"pi@synthetic-host/{spoof}", first.session_id))
    ui.login()
    entry = ui.page.locator("#participants > li").filter(has_text=str(first.session_id))
    assert entry.evaluate("""item => [...item.querySelectorAll('bdi')].map(node => node.textContent)""") == [
        f"pi · synthetic-host · {str(first.session_id)[:8]}", f"pi@synthetic-host/{spoof}",
    ]
    # The state flags are plain text outside every isolate, so a control cannot reorder them.
    assert entry.evaluate("""item => [...item.childNodes].filter(node => node.nodeName === '#text')
        .map(node => node.textContent).join('')""").count("‮") == 0
    choose(ui.page, first.session_id)
    assert ui.page.locator("#targets bdi").all_text_contents() == [
        f"pi · synthetic-host · {str(first.session_id)[:8]}",
    ]


def test_only_allowlisted_assets_are_served_and_errors_keep_security_headers(ui):
    font = ui.context.request.get(ui.origin + "/ui/Manrope-Variable.ttf")
    assert font.status == 200 and font.headers["content-type"].startswith("font/ttf")
    i18n = ui.context.request.get(ui.origin + "/ui/i18n.js")
    assert i18n.status == 200 and i18n.headers["content-type"].startswith("text/javascript")
    for path in ("/ui/", "/ui/001_core.sql", "/ui/browser.py", "/ui/index.html", "/ui/chat.js/extra"):
        response = ui.context.request.get(ui.origin + path)
        assert response.status == 404
        assert response.headers["cache-control"] == "no-store"
        assert "default-src 'none'" in response.headers["content-security-policy"]
    response = ui.context.request.get(ui.origin + "/ui/chat.js?token=synthetic")
    assert response.status == 422
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_browser_rejects_missing_csrf_and_a_foreign_origin_on_logout(ui):
    ui.login()
    status = ui.page.evaluate("""async () => (await fetch('/v1/logout', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
    })).status""")
    assert status == 403
    # SameSite=Strict keeps a genuinely cross-site page from sending the cookie, so only a request that
    # carries the cookie and a valid CSRF token can reach the Origin check on its own.
    csrf = ui.context.request.get(ui.origin + "/v1/browser/session").json()["csrf_token"]

    def logout(origin):
        return ui.context.request.post(ui.origin + "/v1/logout", data="{}", headers={
            "Origin": origin, "X-CSRF-Token": csrf, "Content-Type": "application/json",
        }).status

    assert [logout("https://other.test"), logout("null")] == [403, 403]
    assert ui.context.request.get(ui.origin + "/v1/browser/session").status == 200
    assert logout(ui.origin) == 200  # Control: the same request is valid once only its Origin is right.
    assert ui.context.request.get(ui.origin + "/v1/browser/session").status == 401


def test_operator_question_pins_exact_offline_session_without_ack_or_wake(ui, db, credentials, actors):
    _room, first, second, _operator = actors
    db.execute("UPDATE agent_chat.instances SET heartbeat_at = now() - interval '100 seconds'")
    ui.login()
    choose(ui.page, first.session_id)
    ui.page.locator("#kind").select_option("question")
    send(ui.page, "Pytanie do konkretnej sesji")
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    row = db.execute("SELECT * FROM agent_chat.messages").fetchone()
    assert row["sender_principal_id"] == authenticate(db, credentials.operator).principal_id
    assert row["sender_session_id"] is None and row["kind"] == "question"
    recipients = db.execute("SELECT * FROM agent_chat.recipients").fetchall()
    assert len(recipients) == 1 and recipients[0]["session_id"] == first.session_id != second.session_id
    assert recipients[0]["acknowledged_at"] is None and recipients[0]["handed_at"] is None
    expect(ui.page.locator("#pending")).to_be_hidden()
    assert ui.page.locator("#body").input_value() == ""


@pytest.mark.parametrize("fault", ["drop", "body", "room_id", "recipients", "sender", "thread_id", "json"])
def test_committed_write_fault_retries_same_frozen_request_without_duplicate(ui, db, credentials, actors, fault):
    _room, first, _second, _operator = actors
    ui.login()
    choose(ui.page, first.session_id)
    ui.page.locator("#kind").select_option("consultation")
    ui.page.locator("#body").fill("immutable consultation")
    calls = []

    def transport(route):
        calls.append((route.request.headers["idempotency-key"], route.request.post_data_json))
        if len(calls) != 1:
            route.continue_()
            return
        response = route.fetch()  # The real service commits before the client loses/corrupts its receipt.
        assert response.status == 200
        if fault == "drop":
            route.abort()
        elif fault == "json":
            route.fulfill(response=response, body="{")
        else:
            receipt = response.json()
            receipt[fault] = {
                "body": "wrong body", "room_id": str(uuid4()), "recipients": [],
                "sender": {"principal_id": str(uuid4()), "session_id": None}, "thread_id": None,
            }[fault]
            route.fulfill(response=response, json=receipt)

    ui.page.route("**/v1/rooms/*/messages", transport)
    send(ui.page)
    expect(ui.page.locator("#write-status")).to_contain_text("Zapis niepotwierdzony")
    assert len(calls) == 1
    assert count(db, "messages") == 1
    expect(ui.page.locator("#body")).to_be_disabled()
    expect(ui.page.locator("#room")).to_be_disabled()
    expect(ui.page.locator("#refresh")).to_be_disabled()
    # A changed DOM field must not change the already captured request.
    ui.page.locator("#body").evaluate("node => { node.value = 'must not replace immutable body'; }")
    ui.page.locator("#retry-write").click()
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    assert db.execute("SELECT body FROM agent_chat.messages").fetchall() == [{"body": "immutable consultation"}]
    assert len(calls) == 2 and calls[0] == calls[1]
    assert count(db, "requests") == 1
    assert ui.page.locator("#body").input_value() == ""
    assert ui.page.evaluate("localStorage.length + sessionStorage.length") == 0


@pytest.mark.parametrize("readback", ["abort", 403])
def test_confirmed_publication_with_failed_readback_is_not_reported_as_a_read_failure(ui, db, readback):
    ui.login()
    if readback == "abort":
        ui.page.route("**/history?*", lambda route: route.abort())
    else:
        ui.page.route("**/history?*", lambda route: route.fulfill(
            status=403, content_type="application/json", body='{"error":{"code":"ROOM_FORBIDDEN"}}'))
    send(ui.page, "committed before the read-back")
    notice = ui.page.locator("#notice")
    # The write is reported first, and the failed read is added to that report instead of replacing it.
    expect(notice).to_contain_text("Zapisano")
    expect(notice).to_contain_text("Nie udało się odczytać danych" if readback == "abort" else "Sesja wygasła")
    rows = db.execute("SELECT id FROM agent_chat.messages").fetchall()
    assert len(rows) == 1 and str(rows[0]["id"]) in notice.inner_text()
    if readback == "abort":
        expect(notice).to_contain_text("nie wysyłaj wiadomości ponownie")
    expect(ui.page.locator("#pending")).to_be_hidden()
    assert ui.page.locator("#body").input_value() == ""
    assert count(db, "messages") == 1


def test_refusal_after_lost_commit_does_not_erase_uncertainty(ui, db, credentials):
    ui.login()
    calls = lose_first_publication(ui, "committed before refusal")
    actor = authenticate(db, credentials.operator)
    db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (actor.principal_id,))
    ui.page.locator("#retry-write").click()
    expect(ui.page.locator("#write-status")).to_contain_text("Brak dostępu")
    expect(ui.page.locator("#viewer")).to_be_hidden()
    expect(ui.page.locator("#pending")).to_be_visible()
    db.execute("INSERT INTO agent_chat.principal_rooms(principal_id, room_id) VALUES (%s, %s)",
               (actor.principal_id, credentials.room))
    ui.page.locator("#retry-write").click()
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    expect(ui.page.locator("#viewer")).to_be_visible()
    assert len(calls) == 3 and calls[0] == calls[1] == calls[2]
    assert count(db, "messages") == 1


def test_rotated_cookie_does_not_rebind_an_uncertain_publication(ui, db, credentials):
    ui.login()
    calls = lose_first_publication(ui, "belongs to the original browser binding")
    challenge = ui.context.request.get(ui.origin + "/v1/login").json()
    response = ui.context.request.post(ui.origin + "/v1/login", data={"token": credentials.operator}, headers={
        "Origin": ui.origin, "X-CSRF-Token": challenge["csrf_token"],
    })
    assert response.status == 200  # Same operator, a new cookie binding (as in another tab).
    ui.page.locator("#retry-write").click()
    expect(ui.page.locator("#write-status")).to_contain_text("Brak dostępu")
    assert calls[0] == calls[1] and calls[0][2] != response.json()["csrf_token"]
    assert count(db, "messages") == 1
    expect(ui.page.locator("#pending")).to_be_visible()


def test_reply_pins_parent_thread_and_shows_explicit_sender_recipient(ui, db, actors):
    room, first, _second, _operator = actors
    parent = publish(db, first, room, uuid4(), Publication(kind="question", body="native question"))
    ui.login()
    # The label no longer carries the identifier, so the message is selected by
    # its own row instead of by a UUID in the button text.
    ui.page.locator(f'li[data-message-id="{parent["id"]}"]').get_by_role(
        "button", name="Odpowiedz", exact=True).click()
    expect(ui.page.locator("#targets")).to_contain_text(str(first.session_id))
    expect(ui.page.locator("#reply-target")).to_contain_text(str(parent["thread_id"]))
    ui.page.locator("#clear-targets").click()
    send(ui.page, "operator reply")
    expect(ui.page.locator("#notice")).to_have_text("Wybierz konkretnego odbiorcę.")
    choose(ui.page, first.session_id)
    send(ui.page)
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    reply = db.execute("SELECT * FROM agent_chat.messages WHERE kind = 'reply'").fetchone()
    assert reply["reply_to"] == parent["id"] and reply["thread_id"] == parent["thread_id"]
    assert reply["body"] == "operator reply" and reply["sender_session_id"] is None
    assert db.execute("SELECT session_id, acknowledged_at FROM agent_chat.recipients").fetchall() == [
        {"session_id": first.session_id, "acknowledged_at": None}
    ]


def test_utf8_limit_and_missing_address_refuse_before_post(ui, db):
    ui.login()
    send(ui.page, "ą" * 8193)
    expect(ui.page.locator("#notice")).to_contain_text("16384 bajtów")
    ui.page.locator("#kind").select_option("question")
    send(ui.page, "valid body")
    expect(ui.page.locator("#notice")).to_have_text("Wybierz konkretnego odbiorcę.")
    assert count(db, "messages") == 0
    expect(ui.page.locator("#pending")).to_be_hidden()


def test_draft_and_uncertain_attempt_require_explicit_discard(ui, db):
    ui.login()
    ui.page.locator("#body").fill("keep my draft")
    ui.page.once("dialog", lambda dialog: dialog.dismiss())
    ui.page.locator("#refresh").click()
    assert ui.page.locator("#body").input_value() == "keep my draft"
    ui.page.route("**/v1/rooms/*/messages", lambda route: route.abort())
    send(ui.page)
    expect(ui.page.locator("#write-status")).to_contain_text("Zapis niepotwierdzony")
    ui.page.once("dialog", lambda dialog: dialog.dismiss())
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#pending")).to_be_visible()
    ui.page.once("dialog", lambda dialog: dialog.accept())
    ui.page.locator("#abandon-write").click()
    expect(ui.page.locator("#pending")).to_be_hidden()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    assert ui.page.locator("#body").input_value() == ""
    assert count(db, "messages") == 0


def test_failed_read_keeps_the_draft_and_the_room_and_recovers_in_place(ui, db, credentials, actors):
    _room, first, _second, _operator = actors
    message = stored(db, credentials, "history before the failure")
    ui.login()
    rooms_before = ui.page.locator("#room option").all_text_contents()
    choose(ui.page, first.session_id)
    ui.page.locator("#body").fill("draft that must survive a read failure")
    dialogs = []
    ui.page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
    ui.page.route("**/history?*thread_id=*", lambda route: route.abort())
    ui.page.locator("#thread").fill(str(message["thread_id"]))
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#notice")).to_contain_text("Nie udało się odczytać danych")
    expect(ui.page.locator("#messages")).to_be_empty()
    # Nothing the operator typed or chose, and nothing needed to retry, is discarded.
    assert ui.page.locator("#body").input_value() == "draft that must survive a read failure"
    expect(ui.page.locator("#targets")).to_contain_text(str(first.session_id))
    assert ui.page.locator("#room option").all_text_contents() == rooms_before
    assert ui.page.locator("#room").input_value() == credentials.room
    # The view is stale, so the draft cannot be sent until it is re-read.
    expect(ui.page.get_by_role("button", name="Wyślij", exact=True)).to_be_disabled()
    ui.page.unroute("**/history?*thread_id=*")
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    expect(ui.page.locator(".body")).to_have_text("history before the failure")
    assert dialogs == []  # Re-reading discards nothing, so it asks nothing.
    assert ui.page.locator("#body").input_value() == "draft that must survive a read failure"
    send(ui.page)
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    assert db.execute("SELECT session_id FROM agent_chat.recipients").fetchall() == [{"session_id": first.session_id}]
    assert db.execute("SELECT body FROM agent_chat.messages ORDER BY created_at DESC").fetchone() == {
        "body": "draft that must survive a read failure"}


def test_recipient_selection_survives_pagination_and_has_a_sixteen_session_cap(ui, db, credentials, actor_factory):
    with db.transaction():
        sessions = sorted(actor_factory(UUID(credentials.room)).session_id for _ in range(51))
    ui.login()
    buttons = ui.page.locator(".choose-target")
    expect(buttons).to_have_count(50)
    for index in range(17):
        buttons.nth(index).click()
    expect(ui.page.locator("#targets > li")).to_have_count(16)
    expect(ui.page.locator("#notice")).to_have_text("Można wybrać najwyżej 16 sesji.")
    ui.page.locator("#clear-targets").click()
    choose(ui.page, sessions[0])
    ui.page.locator("#more-participants").click()
    expect(buttons).to_have_count(1)
    choose(ui.page, sessions[-1])
    expect(ui.page.locator("#targets > li")).to_have_count(2)
    ui.page.locator("#kind").select_option("question")
    send(ui.page, "two exact sessions across pages")
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    assert db.execute("SELECT session_id FROM agent_chat.recipients ORDER BY session_id").fetchall() == [
        {"session_id": sessions[0]}, {"session_id": sessions[-1]},
    ]


def test_composer_controls_stay_visible_with_many_recipients(ui, db, credentials, actor_factory):
    with db.transaction():
        sessions = sorted(actor_factory(UUID(credentials.room)).session_id for _ in range(16))
    ui.page.set_viewport_size({"width": 1280, "height": 720})
    ui.login()
    send_button = ui.page.get_by_role("button", name="Wyślij", exact=True)
    viewport = ui.page.viewport_size
    assert viewport is not None
    for session in sessions[:4]:
        choose(ui.page, session)
    expect(ui.page.locator("#targets > li")).to_have_count(4)
    expect(send_button).to_be_visible()
    box = send_button.bounding_box()
    assert box is not None and box["y"] + box["height"] <= viewport["height"]
    messages_box = ui.page.locator("#messages").bounding_box()
    assert messages_box is not None and messages_box["height"] > 100
    for session in sessions[4:]:
        choose(ui.page, session)
    expect(ui.page.locator("#targets > li")).to_have_count(16)
    assert ui.page.locator("#targets").evaluate("el => el.scrollHeight > el.clientHeight")
    box = send_button.bounding_box()
    assert box is not None and box["y"] + box["height"] <= viewport["height"]
    messages_box = ui.page.locator("#messages").bounding_box()
    assert messages_box is not None and messages_box["height"] > 80
    send(ui.page, "visible with sixteen recipients")
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    assert count(db, "recipients") == 16


def test_mobile_collapses_participants_and_scrolls_the_document(ui, db, credentials, actor_factory):
    with db.transaction():
        for _ in range(20):
            actor_factory(UUID(credentials.room))
    for index in range(60):
        stored(db, credentials, f"mobile message {index:02}")
    ui.page.set_viewport_size({"width": 390, "height": 844})
    ui.page.reload()
    ui.login()
    details = ui.page.locator("#participants-details")
    assert details.evaluate("el => el.open") is False
    expect(ui.page.locator("#participants")).to_be_hidden()
    timeline_top = ui.page.evaluate(
        "document.querySelector('#messages').getBoundingClientRect().top + window.scrollY"
    )
    assert timeline_top < 900, timeline_top
    expect(ui.page.get_by_role("button", name="Wyślij", exact=True)).to_be_visible()
    before = ui.page.evaluate("window.scrollY")
    assert before > 0
    ui.page.locator("#more-messages").click()
    expect(ui.page.locator(".body")).to_have_count(10)
    ui.page.wait_for_timeout(50)
    after = ui.page.evaluate("window.scrollY")
    assert after < before
    assert after <= timeline_top + 200


def test_live_refresh_keeps_open_evidence_focus_and_scroll(ui, db, credentials):
    for index in range(30):
        stored(db, credentials, f"evidence message {index:02}")
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    messages = ui.page.locator("#messages")
    messages.evaluate("el => el.scrollTop = 0")
    evidence = ui.page.locator(".message-evidence").first
    summary = evidence.locator("summary")
    summary.click()
    expect(evidence).to_have_attribute("open", "")
    summary.focus()
    messages.evaluate("el => el.scrollTop = 120")
    reading_position = messages.evaluate("el => el.scrollTop")
    stored(db, credentials, "arrives while the evidence is open")
    expect(ui.page.locator(".body")).to_have_count(31)
    expect(evidence).to_have_attribute("open", "")
    expect(summary).to_be_focused()
    assert messages.evaluate("el => el.scrollTop") == reading_position
    # A message action is disabled by busy(), but must not be disabled (or blurred) by a live read.
    reply = ui.page.locator(".reply").first
    reply.focus()
    expect(reply).to_be_focused()
    stored(db, credentials, "arrives while a reply action is focused")
    expect(ui.page.locator(".body")).to_have_count(32)
    expect(reply).to_be_focused()
    expect(reply).to_be_enabled()
    expect(evidence).to_have_attribute("open", "")


def test_live_refresh_anchors_the_visible_message_after_page_eviction(ui, db, credentials):
    messages = [stored(db, credentials, f"anchored message {index:02}") for index in range(50)]
    target = messages[25]
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    target_row = ui.page.locator(f'#messages > li[data-message-id="{target["id"]}"]')
    target_row.evaluate("""el => {
        const list = document.getElementById('messages');
        list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - 10;
    }""")
    before = target_row.bounding_box()
    assert before is not None
    stored(db, credentials, "newest replaces the oldest page entry")
    expect(ui.page.locator(".body").last).to_have_text("newest replaces the oldest page entry")
    expect(ui.page.locator(".body")).to_have_count(50)
    expect(ui.page.locator(f'#messages > li[data-message-id="{messages[0]["id"]}"]')).to_have_count(0)
    after = target_row.bounding_box()
    assert after is not None
    assert abs(after["y"] - before["y"]) < 1


def test_live_refresh_falls_back_to_the_nearest_survivor_after_a_multi_eviction(ui, db, credentials):
    messages = [stored(db, credentials, f"multi-eviction message {index:02}") for index in range(50)]
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    vanished = ui.page.locator(f'#messages > li[data-message-id="{messages[5]["id"]}"]')
    # Rows are flat and the list has a thin top padding, so the first survivor can sit no lower than the
    # content edge: put the anchor there. A sliver of the row above stays in view and must not become the anchor.
    vanished.evaluate("""el => {
        const list = document.getElementById('messages');
        const edge = parseFloat(getComputedStyle(list).paddingTop);
        list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - edge;
    }""")
    survivor = ui.page.locator(f'#messages > li[data-message-id="{messages[6]["id"]}"]')
    before = vanished.bounding_box()
    assert before is not None
    for index in range(6):
        stored(db, credentials, f"burst replacement {index}")
    expect(ui.page.locator(".body").last).to_have_text("burst replacement 5")
    expect(ui.page.locator(".body")).to_have_count(50)
    expect(vanished).to_have_count(0)
    after = survivor.bounding_box()
    assert after is not None
    assert abs(after["y"] - before["y"]) < 2


def test_live_refresh_anchors_the_visible_message_on_a_narrow_viewport(ui, db, credentials):
    messages = [stored(db, credentials, f"narrow anchored message {index:02}") for index in range(50)]
    target = messages[25]
    ui.page.set_viewport_size({"width": 390, "height": 844})
    ui.page.reload()
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    target_row = ui.page.locator(f'#messages > li[data-message-id="{target["id"]}"]')
    target_row.evaluate("""el => {
        el.scrollIntoView({block: 'start'});
        window.scrollBy(0, -10);
    }""")
    before = target_row.bounding_box()
    assert before is not None
    stored(db, credentials, "narrow newest replaces the oldest page entry")
    expect(ui.page.locator(".body").last).to_have_text("narrow newest replaces the oldest page entry")
    expect(ui.page.locator(".body")).to_have_count(50)
    after = target_row.bounding_box()
    assert after is not None
    assert abs(after["y"] - before["y"]) < 1


def test_late_write_confirmation_cannot_repopulate_logged_out_page(ui, db):
    ui.login()
    # Cancellation is best effort. Force the already submitted response to arrive after logout.
    ui.page.evaluate("""() => {
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (!url.endsWith('/messages')) return original(url, options);
            const response = await original(url, {...options, signal: undefined});
            const json = response.json.bind(response);
            response.json = async () => {
                const data = await json(); window.oldWriteConsumed = true; return data;
            };
            return response;
        };
    }""")
    held = hold_response(ui.page, "**/v1/rooms/*/messages")
    send(ui.page, "committed despite logout")
    wait_held(ui.page, held)
    ui.page.once("dialog", lambda dialog: dialog.accept())
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    release(held[0])
    wait_flag(ui.page, "oldWriteConsumed")
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    expect(ui.page.locator("#viewer")).to_be_hidden()
    expect(ui.page.locator("#pending")).to_be_hidden()
    assert ui.page.locator("#body").input_value() == ""
    assert db.execute("SELECT body FROM agent_chat.messages").fetchall() == [{"body": "committed despite logout"}]


def test_thread_filter_paginates_without_changing_draft_or_implicitly_replying(ui, db, credentials, actors):
    room, first, _second, _operator = actors
    actor = authenticate(db, credentials.operator)
    with db.transaction():
        parent = stored(db, credentials, "thread root")
        for index in range(50):
            publish(db, actor, room, uuid4(), Publication(kind="reply", body=f"thread reply {index:02}",
                                                       reply_to=parent["id"]))
        stored(db, credentials, "another thread")
    ui.login()
    choose(ui.page, first.session_id)
    ui.page.locator("#body").fill("new root, not an implicit reply")
    ui.page.get_by_role("button", name="Wątek", exact=True).first.click()
    expect(ui.page.locator("#notice")).to_contain_text("Filtr nie zmienia")
    expect(ui.page.locator(".body")).to_have_text([f"thread reply {index:02}" for index in range(50)])
    ui.page.locator("#more-messages").click()
    expect(ui.page.locator(".body")).to_have_text(["thread root"])
    assert ui.page.locator("#body").input_value() == "new root, not an implicit reply"
    expect(ui.page.locator("#targets")).to_contain_text(str(first.session_id))
    ui.page.locator("#thread").fill("not-a-uuid")
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#notice")).to_contain_text("poprawny UUID")
    expect(ui.page.locator(".body")).to_have_text(["thread root"])
    send(ui.page)
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    new = db.execute("SELECT thread_id, reply_to FROM agent_chat.messages WHERE body = %s",
                     ("new root, not an implicit reply",)).fetchone()
    assert new["thread_id"] != parent["thread_id"] and new["reply_to"] is None


def test_thread_filter_cannot_select_another_room_and_resets_on_room_change(ui, db, credentials):
    stored(db, credentials, "home text")
    actor = authenticate(db, credentials.operator)
    other = create(db, actor, RoomCreation(slug="other", label="Other"))
    message = publish(db, actor, other["id"], uuid4(), Publication(kind="message", body="other room text"))
    ui.login()
    ui.page.locator("#thread").fill(str(message["thread_id"]))
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#notice")).to_contain_text("Filtr nie zmienia")
    expect(ui.page.locator("#messages")).to_be_empty()
    ui.page.locator("#all-history").click()
    expect(ui.page.locator(".body")).to_have_text("home text")
    ui.page.locator("#thread").fill(str(message["thread_id"]))
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#messages")).to_be_empty()
    ui.page.locator("#room").select_option(str(other["id"]))
    expect(ui.page.locator(".body")).to_have_text("other room text")
    assert ui.page.locator("#thread").input_value() == ""


def test_late_unfiltered_page_cannot_replace_filtered_history(ui, db, credentials):
    with db.transaction():
        messages = [stored(db, credentials, f"root {index}") for index in range(51)]
    ui.login()
    ui.page.evaluate("""() => {
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (!url.includes('/history?') || url.includes('thread_id=')) return original(url, options);
            const response = await original(url, {...options, signal: undefined});
            const json = response.json.bind(response);
            response.json = async () => {
                const data = await json(); window.oldPageConsumed = true; return data;
            };
            return response;
        };
    }""")
    held = hold_response(ui.page, "**/history?*", when=lambda request: "thread_id=" not in request.url)
    ui.page.locator("#more-messages").click()
    wait_held(ui.page, held)
    ui.page.locator("#thread").fill(str(messages[0]["thread_id"]))
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator(".body")).to_have_text("root 0")
    release(held[0])
    wait_flag(ui.page, "oldPageConsumed")
    expect(ui.page.locator(".body")).to_have_text("root 0")
    expect(ui.page.locator("#more-messages")).to_be_hidden()


def test_mute_unmute_preserves_native_stop_plan_lease_and_draft(ui, db, actors):
    _room, first, second, _operator = actors
    before = db.execute("SELECT stopped, plan_mode, heartbeat_at FROM agent_chat.instances WHERE id = %s",
                        (first.instance_id,)).fetchone()
    assert before["stopped"] and before["plan_mode"]
    ui.login()
    ui.page.locator("#body").fill("unsent draft")
    for label, expected in (("Wycisz", True), ("Cofnij wyciszenie", False)):
        ui.page.get_by_role("button", name=f"{label} {first.session_id}", exact=True).click()
        expect(ui.page.locator("#notice")).to_contain_text(f"Potwierdzono zapis mute={str(expected).lower()}")
        assert db.execute("SELECT muted FROM agent_chat.sessions WHERE id = %s",
                          (first.session_id,)).fetchone()["muted"] is expected
        assert db.execute("SELECT stopped, plan_mode, heartbeat_at FROM agent_chat.instances WHERE id = %s",
                          (first.instance_id,)).fetchone() == before
        assert ui.page.locator("#body").input_value() == "unsent draft"
    assert not db.execute(
        "SELECT muted FROM agent_chat.sessions WHERE id = %s", (second.session_id,)
    ).fetchone()["muted"]
    assert count(db, "events", "kind = 'control'") == 2


@pytest.mark.parametrize("fault", ["drop", "session", "value", "json"])
def test_uncertain_mute_requires_fresh_read_not_an_automatic_toggle(ui, db, actors, fault):
    _room, first, _second, _operator = actors
    ui.login()
    calls = []

    def transport(route):
        calls.append(route.request.post_data_json)
        if len(calls) > 1:
            route.continue_()
            return
        response = route.fetch()
        assert response.status == 200
        if fault == "drop":
            route.abort()
        elif fault == "json":
            route.fulfill(response=response, body="{")
        else:
            value = response.json()
            if fault == "session":
                value["session_id"] = str(uuid4())
            else:
                value["muted"] = False
            route.fulfill(response=response, json=value)

    ui.page.route("**/v1/sessions/*/mute", transport)
    ui.page.get_by_role("button", name=f"Wycisz {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zmiana mute niepotwierdzona")
    expect(ui.page.locator("#participants")).to_be_empty()
    assert calls == [{"muted": True}]
    assert db.execute("SELECT muted FROM agent_chat.sessions WHERE id = %s", (first.session_id,)).fetchone()["muted"]
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    assert calls == [{"muted": True}]
    ui.page.get_by_role("button", name=f"Cofnij wyciszenie {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Potwierdzono zapis mute=false")
    assert calls == [{"muted": True}, {"muted": False}]


def test_confirmed_mute_and_failed_readback_are_not_reported_as_a_lost_write(ui, db, actors):
    _room, first, _second, _operator = actors
    ui.login()
    ui.page.route("**/participants?*", lambda route: route.abort())
    ui.page.get_by_role("button", name=f"Wycisz {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zapis mute potwierdzony, ale odczyt stanu niedostępny")
    expect(ui.page.locator("#participants")).to_be_empty()
    assert db.execute("SELECT muted FROM agent_chat.sessions WHERE id = %s", (first.session_id,)).fetchone()["muted"]


def test_global_mute_refuses_partial_room_authority(ui, db, actors):
    _room, first, _second, other_operator = actors
    hidden = create(db, other_operator, RoomCreation(slug="hidden", label="Hidden"))
    db.execute("INSERT INTO agent_chat.principal_rooms(principal_id, room_id) VALUES (%s, %s)",
               (first.principal_id, hidden["id"]))
    db.execute("INSERT INTO agent_chat.memberships(session_id, room_id) VALUES (%s, %s)",
               (first.session_id, hidden["id"]))
    ui.login()
    ui.page.get_by_role("button", name=f"Wycisz {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zmiana mute niepotwierdzona")
    assert not db.execute(
        "SELECT muted FROM agent_chat.sessions WHERE id = %s", (first.session_id,)
    ).fetchone()["muted"]
    assert count(db, "events", "kind = 'control'") == 0


def _roster_row(page, session):
    return page.locator("#participants > li").filter(has_text=str(session))


def _pm_rows(db):
    return db.execute("SELECT session_id FROM agent_chat.room_roles WHERE role = 'pm'").fetchall()


def test_the_operator_sets_moves_and_clears_the_pm_mark_from_the_roster(ui, db, actors):
    _room, first, second, _operator = actors
    ui.login()
    expect(ui.page.locator("#pm-mark")).to_have_text("Znacznik PM: brak.")
    expect(ui.page.locator(".pm-badge")).to_have_count(0)
    events = count(db, "events")
    ui.page.locator("#body").fill("unsent draft")
    ui.page.get_by_role("button", name=f"Ustaw PM {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text(f"Potwierdzono zapis: znacznik PM ma {first.session_id}")
    expect(ui.page.locator(".pm-badge")).to_have_count(1)
    expect(_roster_row(ui.page, first.session_id).locator(".pm-badge")).to_have_text("PM")
    expect(ui.page.locator("#pm-mark")).to_contain_text(str(first.session_id))
    expect(ui.page.locator("#pm-mark")).to_contain_text("Znacznik nie nadaje uprawnień.")
    assert _pm_rows(db) == [{"session_id": first.session_id}]
    # A second holder replaces the first in one call, and the roster then shows exactly one badge.
    ui.page.get_by_role("button", name=f"Ustaw PM {second.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text(f"Potwierdzono zapis: znacznik PM ma {second.session_id}")
    expect(ui.page.locator(".pm-badge")).to_have_count(1)
    expect(_roster_row(ui.page, second.session_id).locator(".pm-badge")).to_have_text("PM")
    expect(_roster_row(ui.page, first.session_id).locator(".pm-badge")).to_have_count(0)
    assert _pm_rows(db) == [{"session_id": second.session_id}]
    ui.page.get_by_role("button", name=f"Zdejmij PM {second.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text(f"Potwierdzono zapis: znacznik PM zdjęty z {second.session_id}")
    expect(ui.page.locator(".pm-badge")).to_have_count(0)
    expect(ui.page.locator("#pm-mark")).to_have_text("Znacznik PM: brak.")
    assert _pm_rows(db) == []
    # Set and clear are not events, and neither touches the operator's draft.
    assert count(db, "events") == events
    assert ui.page.locator("#body").input_value() == "unsent draft"


def test_a_masked_not_found_refusal_clears_the_scope(ui, db, actors, credentials):
    room, first, _second, _operator = actors
    operator = authenticate(db, credentials.operator)
    publish(db, first, room, uuid4(), Publication(kind="message", body="inside", ref_key=RESOURCE))
    ui.login()
    ui.page.locator("#thread").fill(RESOURCE)
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#thread-header")).to_contain_text(RESOURCE)
    db.execute(
        "DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s",
        (operator.principal_id, room),
    )
    with ui.page.expect_response(
        lambda response: "/resolution" in response.url and response.request.method == "POST"
    ) as response:
        ui.page.get_by_role("button", name="Oznacz jako rozwiązany", exact=True).click()
    assert response.value.status == 404
    expect(ui.page.locator("#notice")).to_contain_text("NOT_FOUND")
    expect(ui.page.locator("#notice")).to_contain_text("Nie znaleziono")
    expect(ui.page.locator("#messages")).to_be_empty()
    expect(ui.page.locator("#participants")).to_be_empty()


def test_a_room_conflict_clears_the_scope(ui, db, credentials, actors):
    operator = authenticate(db, credentials.operator)
    room = UUID(credentials.room)
    _, first, _, _ = actors
    publish(db, first, room, uuid4(), Publication(kind="message", body="before revocation"))
    ui.login()
    expect(ui.page.locator("#messages > li")).not_to_have_count(0)
    db.execute(
        "DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s",
        (operator.principal_id, room),
    )
    ui.page.locator("#room-admin summary").click()
    ui.page.locator("#room-slug").fill("homelab")
    ui.page.locator("#room-label").fill("Homelab")
    with ui.page.expect_response(
        lambda response: response.url.endswith("/v1/rooms") and response.request.method == "POST"
    ) as response:
        ui.page.locator("#create-room").get_by_role("button").click()
    assert response.value.status == 409
    expect(ui.page.locator("#notice")).to_contain_text("ROOM_CONFLICT")
    expect(ui.page.locator("#messages")).to_be_empty()
    expect(ui.page.locator("#participants")).to_be_empty()


def test_a_viewer_sees_the_pm_mark_and_is_offered_no_control(ui, db, actors, make_viewer):
    room, first, _second, operator = actors
    roles.assign(db, operator, room, "pm", first.session_id)
    viewer = make_viewer(room)
    ui.login(viewer.token)
    expect(ui.page.locator("#viewer")).to_have_attribute("data-access", "viewer")
    expect(ui.page.locator(".pm-badge")).to_have_count(1)
    expect(_roster_row(ui.page, first.session_id).locator(".pm-badge")).to_have_text("PM")
    expect(ui.page.locator("#pm-mark")).to_contain_text(str(first.session_id))
    assert ui.page.locator(".pm-session").evaluate_all(
        "buttons => buttons.length > 0 && buttons.every(button => button.disabled && button.hidden)"
    )
    assert _pm_rows(db) == [{"session_id": first.session_id}]


def test_a_refused_set_is_reported_unconfirmed_and_stores_nothing(ui, db, actors):
    room, first, _second, _operator = actors
    ui.login()
    # The roster still lists the session when the operator clicks, but the service no longer sees it as a member.
    db.execute("DELETE FROM agent_chat.memberships WHERE session_id = %s AND room_id = %s", (first.session_id, room))
    ui.page.get_by_role("button", name=f"Ustaw PM {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zmiana znacznika PM niepotwierdzona")
    expect(ui.page.locator("#notice")).to_contain_text("INVALID_RECIPIENT")
    expect(ui.page.locator("#notice")).to_contain_text("nie jest już dostępny")
    # A membership-derived refusal clears the scope-sensitive snapshot.
    expect(ui.page.locator("#participants")).to_be_empty()
    expect(ui.page.locator("#pm-mark")).to_be_hidden()
    assert _pm_rows(db) == []
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    expect(_roster_row(ui.page, first.session_id)).to_have_count(0)
    expect(ui.page.locator("#pm-mark")).to_have_text("Znacznik PM: brak.")


def test_the_pm_line_names_a_holder_that_sits_on_another_roster_page(ui, db, credentials, actor_factory):
    room = UUID(credentials.room)
    with db.transaction():
        holder = max(actor_factory(room).session_id for _ in range(51))
    roles.assign(db, authenticate(db, credentials.operator), room, "pm", holder)
    ui.login()
    expect(ui.page.locator(".choose-target")).to_have_count(50)
    expect(ui.page.locator(".pm-badge")).to_have_count(0)
    expect(ui.page.locator("#pm-mark")).to_contain_text(str(holder))
    expect(ui.page.locator("#pm-mark")).to_contain_text("sesja z innej strony listy")
    ui.page.locator("#more-participants").click()
    expect(ui.page.locator(".pm-badge")).to_have_count(1)
    expect(_roster_row(ui.page, holder).locator(".pm-badge")).to_have_text("PM")
    expect(ui.page.locator("#pm-mark")).not_to_contain_text("sesja z innej strony listy")


def test_pending_mute_blocks_other_writes_and_late_receipt_cannot_restore_logout(ui, db, actors):
    _room, first, _second, _operator = actors
    ui.login()
    ui.page.evaluate("""() => {
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (!url.endsWith('/mute')) return original(url, options);
            const response = await original(url, {...options, signal: undefined});
            const json = response.json.bind(response);
            response.json = async () => {
                const data = await json(); window.oldMuteConsumed = true; return data;
            };
            return response;
        };
    }""")
    held = hold_response(ui.page, "**/v1/sessions/*/mute")
    posts = []
    ui.page.route("**/v1/rooms/*/messages", lambda route: (posts.append(route.request.post_data_json), route.abort()))
    ui.page.get_by_role("button", name=f"Wycisz {first.session_id}", exact=True).click()
    wait_held(ui.page, held)
    expect(ui.page.locator("#body")).to_be_disabled()
    expect(ui.page.locator("#thread")).to_be_disabled()
    expect(ui.page.locator("#room")).to_be_disabled()
    ui.page.evaluate("""() => {
        document.querySelector('#body').value = 'must not be sent';
        document.querySelector('#composer').dispatchEvent(new Event('submit', {cancelable: true}));
    }""")
    # The submit handler is synchronous: a publication would have shown its attempt by now.
    expect(ui.page.locator("#pending")).to_be_hidden()
    ui.page.on("dialog", lambda dialog: dialog.accept())
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    release(held[0])
    wait_flag(ui.page, "oldMuteConsumed")
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    expect(ui.page.locator("#viewer")).to_be_hidden()
    assert posts == []
    assert db.execute("SELECT muted FROM agent_chat.sessions WHERE id = %s", (first.session_id,)).fetchone()["muted"]


def test_mute_completes_the_selected_thread_read_when_it_cancels_an_older_fetch(ui, db, credentials, actors):
    _room, first, _second, _operator = actors
    message = stored(db, credentials, "filtered history must still load")
    ui.login()
    held = hold_response(ui.page, "**/history?*thread_id=*", fetch=False, first=True)
    ui.page.locator("#thread").fill(str(message["thread_id"]))
    ui.page.locator("#apply-thread").click()
    wait_held(ui.page, held)
    ui.page.get_by_role("button", name=f"Wycisz {first.session_id}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Potwierdzono zapis mute=true")
    held[0][0].abort()
    expect(ui.page.locator(".body")).to_have_text("filtered history must still load")
    assert ui.page.locator("#thread").input_value() == str(message["thread_id"])


def test_unknown_mute_state_does_not_offer_an_inferred_unmute(ui, actors):
    def transport(route):
        response = route.fetch()
        data = response.json()
        for participant in data["participants"]:
            participant["muted"] = "unknown"
        route.fulfill(response=response, json=data)

    ui.page.route("**/participants?*", transport)
    ui.login()
    expect(ui.page.locator("#participants > li")).to_have_count(2)
    expect(ui.page.locator("#participants")).to_contain_text("mute: unknown")
    expect(ui.page.locator(".participant-sub").first).to_contain_text("mute: unknown")
    expect(ui.page.locator(".mute-session")).to_have_count(0)


def test_late_participant_page_cannot_overwrite_post_mute_readback(ui, db, credentials, actor_factory):
    with db.transaction():
        sessions = sorted(actor_factory(UUID(credentials.room)).session_id for _ in range(51))
    ui.login()
    ui.page.evaluate("""() => {
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (!url.includes('after_session=')) return original(url, options);
            const response = await original(url, {...options, signal: undefined});
            const json = response.json.bind(response);
            response.json = async () => {
                const data = await json(); window.oldParticipantsConsumed = true; return data;
            };
            return response;
        };
    }""")
    held = hold_response(ui.page, "**/participants?*after_session=*")
    ui.page.locator("#more-participants").click()
    wait_held(ui.page, held)
    ui.page.get_by_role("button", name=f"Wycisz {sessions[0]}", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Potwierdzono zapis mute=true")
    release(held[0])
    wait_flag(ui.page, "oldParticipantsConsumed")
    expect(ui.page.locator("#participants > li")).to_have_count(50)
    expect(ui.page.get_by_role("button", name=f"Cofnij wyciszenie {sessions[0]}", exact=True)).to_be_visible()


def test_room_creation_and_membership_require_preexisting_credential_scope(ui, db, credentials, actors):
    _room, first, _second, _operator = actors
    ui.login()
    ui.page.locator("#body").fill("preserved draft")
    ui.page.locator("#room-admin > summary").click()
    ui.page.locator("#room-slug").fill("z-room")
    ui.page.locator("#room-label").fill("Synthetic room")
    ui.page.get_by_role("button", name="Utwórz pokój", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Pokój zapisany")
    created = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'z-room'").fetchone()["id"]
    assert ui.page.locator("#body").input_value() == "preserved draft"
    assert count(db, "principal_rooms", "room_id = %s", (created,)) == 1
    ui.page.once("dialog", lambda dialog: dialog.accept())
    ui.page.locator("#room").select_option(str(created))
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    ui.page.locator("#member-session").fill(str(first.session_id))
    ui.page.get_by_role("button", name="Dodaj sesję", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zmiana członkostwa niepotwierdzona")
    assert count(db, "memberships", "room_id = %s", (created,)) == 0
    assert count(db, "principal_rooms", "room_id = %s", (created,)) == 1
    # Fixture-only credential provisioning, never a browser operation.
    db.execute("INSERT INTO agent_chat.principal_rooms(principal_id, room_id) VALUES (%s, %s)",
               (first.principal_id, created))
    ui.page.once("dialog", lambda dialog: dialog.accept())
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    ui.page.locator("#room").select_option(str(created))
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    ui.page.locator("#member-session").fill(str(first.session_id))
    ui.page.get_by_role("button", name="Dodaj sesję", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Członkostwo zapisane")
    expect(ui.page.locator("#participants > li")).to_have_count(1)
    expect(ui.page.locator("#participants")).to_contain_text(str(first.session_id))
    assert count(db, "memberships", "room_id = %s", (created,)) == 1


def test_lost_room_creation_confirmation_requires_readback_not_retry(ui, db):
    ui.login()
    ui.page.locator("#room-admin > summary").click()
    calls = []
    commit_then_lose(ui.page, "**/v1/rooms", lambda request: calls.append(request.post_data_json))
    ui.page.locator("#room-slug").fill("z-recovered")
    ui.page.locator("#room-label").fill("Recovered")
    ui.page.get_by_role("button", name="Utwórz pokój", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Zmiana pokoju niepotwierdzona")
    expect(ui.page.get_by_role("button", name="Utwórz pokój", exact=True)).to_be_disabled()
    ui.page.once("dialog", lambda dialog: dialog.accept())
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    expect(ui.page.locator("#room option").filter(has_text="z-recovered")).to_have_count(1)
    assert calls == [{"slug": "z-recovered", "label": "Recovered"}]
    assert count(db, "rooms", "slug = 'z-recovered'") == 1


def test_failed_room_list_after_a_good_session_still_offers_refresh_and_logout(ui):
    ui.login()
    ui.page.route("**/v1/rooms", lambda route: route.abort())
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Nie udało się odczytać danych")
    expect(ui.page.locator("#logout")).to_be_visible()
    expect(ui.page.locator("#refresh")).to_be_visible()
    ui.page.unroute("**/v1/rooms")
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")


def test_live_stream_updates_text_and_receipts_without_ack_or_draft_loss(ui, db, credentials, actors):
    room, first, _second, _operator = actors
    stored(db, credentials, "initial")
    ui.login()
    ui.page.locator("#body").fill("unsent live draft")
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    message = publish(
        db, authenticate(db, credentials.operator), room, uuid4(),
        Publication(kind="question", body="<script>not executed</script>", recipients=(first.session_id,)),
    )
    expect(ui.page.locator(".body")).to_have_text(["initial", "<script>not executed</script>"])
    assert ui.page.locator("#messages script").count() == 0
    assert ui.page.locator("#body").input_value() == "unsent live draft"
    assert db.execute("SELECT acknowledged_at FROM agent_chat.recipients WHERE message_id = %s",
                      (message["id"],)).fetchone()["acknowledged_at"] is None
    acknowledge(db, first, message["id"])
    row = ui.page.locator("#messages > li").filter(has_text="<script>not executed</script>")
    expect(row).not_to_contain_text("ACK: —")
    expect(row).to_contain_text("przekazanie: —")
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")


def test_live_starts_at_the_event_clock_instead_of_replaying_the_history_backlog(ui, db, credentials):
    with db.transaction():
        for index in range(51):
            stored(db, credentials, f"backlog {index:02}")
    ui.login()
    urls = []
    ui.page.on("request", lambda request: urls.append(request.url) if "/v1/events?" in request.url else None)
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    position = db.execute("SELECT position FROM agent_chat.event_clock").fetchone()["position"]
    assert [url.removeprefix(ui.origin) for url in urls] == [f"/v1/events?after={position}"]
    expect(ui.page.locator("#live-count")).to_be_empty()  # No backlog frame was replayed.


BLANKING_PROBE = """() => {
    window.blanked = [];
    const watch = (selector, options, empty) => new MutationObserver(() => {
        if (empty(document.querySelector(selector))) window.blanked.push(selector);
    }).observe(document.querySelector(selector), options);
    watch('#messages', {childList: true}, node => node.children.length === 0);
    watch('#participants', {childList: true}, node => node.children.length === 0);
    watch('#draft-fields', {attributes: true, attributeFilter: ['disabled']}, node => node.disabled);
}"""


@pytest.mark.parametrize("app_options", [{"stream_lifetime": 1.0, "stream_poll": 0.1}])
def test_stream_rotation_reconnects_without_blanking_the_view_or_the_draft(ui, db, credentials, app_options):
    stored(db, credentials, "visible across rotations")
    ui.login()
    ui.page.locator("#body").fill("draft typed before rotation")
    urls = []
    ui.page.on("request", lambda request: urls.append(request.url) if "/v1/events?" in request.url else None)
    ui.page.evaluate(BLANKING_PROBE)
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    deadline = time.monotonic() + 20
    while len(urls) < 3:  # Two rotations, each revalidating scope before the next stream opens.
        assert time.monotonic() < deadline, f"stream never rotated: {urls}"
        ui.page.wait_for_timeout(50)
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(ui.page.locator(".body")).to_have_text("visible across rotations")
    assert ui.page.locator("#body").input_value() == "draft typed before rotation"
    assert ui.page.evaluate("window.blanked") == []


def test_typing_during_a_live_refresh_is_not_dropped(ui, db, credentials):
    stored(db, credentials, "initial")
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    held = hold_response(ui.page, "**/history?*", first=True)
    stored(db, credentials, "arrives during the refresh")
    wait_held(ui.page, held)
    # The refresh blocks navigation and sending, never the fields the operator is typing into.
    expect(ui.page.locator("#refresh")).to_be_disabled()
    expect(ui.page.get_by_role("button", name="Wyślij", exact=True)).to_be_disabled()
    expect(ui.page.locator("#body")).to_be_enabled()
    ui.page.locator("#body").press_sequentially("typed while refreshing")
    release(held[0])
    expect(ui.page.locator(".body")).to_have_text(["initial", "arrives during the refresh"])
    assert ui.page.locator("#body").input_value() == "typed while refreshing"
    expect(ui.page.get_by_role("button", name="Wyślij", exact=True)).to_be_enabled()


def test_live_reconnect_deduplicates_frames_and_uses_last_cursor(ui, db, credentials):
    stored(db, credentials, "before connection")
    ui.login()
    message = stored(db, credentials, "committed before first stream")
    position = db.execute("SELECT position FROM agent_chat.events WHERE message_id = %s",
                          (message["id"],)).fetchone()["position"]
    frame = f"id: {position}\nevent: message\ndata: " + json.dumps({"room_id": credentials.room}) + "\n\n"
    requests = []

    def transport(route):
        requests.append(route.request.url)
        if len(requests) == 1:
            route.fulfill(status=200, content_type="text/event-stream", body=frame + frame)
        else:
            route.continue_()

    ui.page.route("**/v1/events?*", transport)
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-count")).to_contain_text(f"Odebrane zdarzenia: 1 · kursor: {position}")
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(ui.page.locator(".body")).to_have_text(["before connection", "committed before first stream"])
    deadline = time.monotonic() + 5
    while len(requests) < 2:
        assert time.monotonic() < deadline
        ui.page.wait_for_timeout(10)
    assert requests[1].endswith(f"after={position}")
    # The toggle remembers only the live-events choice; no token, draft or scope reaches browser storage.
    assert ui.page.evaluate("Object.fromEntries(Object.entries(localStorage))") == {"agent-chat.live": "1"}
    assert ui.page.evaluate("sessionStorage.length") == 0


def test_live_revocation_hides_history_and_stops_reconnecting(ui, db, credentials):
    stored(db, credentials, "private until revoked")
    operator = authenticate(db, credentials.operator)
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (operator.principal_id,))
    expect(ui.page.locator("#login")).to_be_visible()
    expect(ui.page.locator("#messages")).to_be_empty()
    expect(ui.page.locator("#viewer")).to_be_hidden()
    expect(ui.page.locator("#live-toggle")).to_be_hidden()


def test_live_http_expired_cursor_resynchronizes_retained_history(ui, db, credentials):
    ui.login()
    urls = []
    ui.page.on("request", lambda request: urls.append(request.url) if "/v1/events?" in request.url else None)
    held = hold_response(ui.page, "**/v1/events?*", fetch=False, first=True)
    ui.page.locator("#live-toggle").click()
    wait_held(ui.page, held)
    expired = stored(db, credentials, "expired body")
    db.execute("""UPDATE agent_chat.messages SET created_at = clock_timestamp() - interval '31 days',
                  expires_at = clock_timestamp() - interval '1 day' WHERE id = %s""", (expired["id"],))
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '31 days' WHERE message_id = %s",
        (expired["id"],),
    )
    prune(db)
    floor = db.execute(
        "SELECT retained_floor FROM agent_chat.event_clock WHERE singleton"
    ).fetchone()["retained_floor"]
    assert floor > 0
    stored(db, credentials, "retained body")
    held[0][0].continue_()
    expect(ui.page.locator(".body")).to_have_text("retained body")
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    assert any(url.endswith(f"after={floor}") for url in urls[1:])


def test_live_scope_error_with_inherited_event_id_loads_older_new_scope(ui, db, credentials, actors):
    _room, _first, _second, other_operator = actors
    other = create(db, other_operator, RoomCreation(slug="z-old-room", label="Previously hidden"))
    publish(db, other_operator, other["id"], uuid4(), Publication(kind="message", body="older newly granted history"))
    stored(db, credentials, "home history")
    operator = authenticate(db, credentials.operator)
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    stored(db, credentials, "establish last event id")
    expect(ui.page.locator("#live-count")).to_contain_text("Odebrane zdarzenia: 1")
    expect(ui.page.locator(".body")).to_have_text(["home history", "establish last event id"])
    expect(ui.page.locator("#body")).to_be_enabled()
    db.execute("INSERT INTO agent_chat.principal_rooms(principal_id, room_id) VALUES (%s, %s)",
               (operator.principal_id, other["id"]))
    expect(ui.page.locator("#room option").filter(has_text="z-old-room")).to_have_count(1)
    ui.page.locator("#room").select_option(str(other["id"]))
    expect(ui.page.locator(".body")).to_have_text("older newly granted history")
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")


def test_vanished_room_keeps_the_draft_and_never_selects_another_room(ui, db, credentials):
    operator = authenticate(db, credentials.operator)
    spare = create(db, operator, RoomCreation(slug="z-spare", label="Spare"))
    stored(db, credentials, "home history")
    ui.login()
    ui.page.locator("#body").fill("draft written for the room that disappears")
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s AND room_id = %s",
               (operator.principal_id, credentials.room))
    expect(ui.page.locator("#notice")).to_contain_text("Wybrany pokój nie jest już dostępny")
    expect(ui.page.locator("#live-status")).to_contain_text("Nie wybrano pokoju")
    assert ui.page.locator("#room").input_value() == ""
    expect(ui.page.locator("#messages")).to_be_empty()
    assert ui.page.locator("#body").input_value() == "draft written for the room that disappears"
    expect(ui.page.get_by_role("button", name="Wyślij", exact=True)).to_be_disabled()
    # Choosing a room is the operator's call, and it still asks before discarding that draft.
    dialogs = []
    ui.page.once("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
    ui.page.locator("#room").select_option(str(spare["id"]))
    assert len(dialogs) == 1 and ui.page.locator("#room").input_value() == ""
    assert ui.page.locator("#body").input_value() == "draft written for the room that disappears"


def test_operator_with_no_rooms_can_create_one_without_widening_other_credentials(ui, db, credentials):
    operator = authenticate(db, credentials.operator)
    db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (operator.principal_id,))
    ui.page.locator("#token").fill(credentials.operator)
    ui.page.get_by_role("button", name="Zaloguj", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Brak dostępnych pokoi")
    ui.page.locator("#room-admin > summary").click()
    ui.page.locator("#room-slug").fill("first-room")
    ui.page.locator("#room-label").fill("First room")
    ui.page.get_by_role("button", name="Utwórz pokój", exact=True).click()
    expect(ui.page.locator("#notice")).to_contain_text("Pokój zapisany")
    room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'first-room'").fetchone()["id"]
    ui.page.locator("#room").select_option(str(room))
    expect(ui.page.locator("#composer")).to_be_visible()
    assert db.execute("SELECT principal_id FROM agent_chat.principal_rooms WHERE room_id = %s",
                      (room,)).fetchall() == [{"principal_id": operator.principal_id}]


def test_live_scope_resync_does_not_abort_or_discard_an_outstanding_publication(ui, db, credentials):
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    held = hold_response(ui.page, "**/v1/rooms/*/messages")
    send(ui.page, "one committed publication across resync")
    expect(ui.page.locator("#live-count")).to_contain_text("Odebrane zdarzenia: 1")
    assert len(held) == 1 and held[0][1].status == 200
    create(db, authenticate(db, credentials.operator), RoomCreation(slug="z-resync", label="New grant"))
    try:
        expect(ui.page.locator("#live-status")).to_contain_text("Wymagana resynchronizacja")
        expect(ui.page.locator("#pending")).to_be_visible()
        expect(ui.page.locator("#write-status")).to_have_text("Wysyłanie…")
    finally:
        release(held[0])
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")
    expect(ui.page.locator("#pending")).to_be_hidden()
    assert count(db, "messages") == 1
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(ui.page.locator(".body")).to_have_text("one committed publication across resync")
    expect(ui.page.locator("#live-count")).to_contain_text("Odebrane zdarzenia: 1")


def test_live_binding_rotation_is_not_adopted_even_for_the_same_operator(ui, credentials):
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    challenge = ui.context.request.get(ui.origin + "/v1/login").json()
    response = ui.context.request.post(ui.origin + "/v1/login", data={"token": credentials.operator}, headers={
        "Origin": ui.origin, "X-CSRF-Token": challenge["csrf_token"],
    })
    assert response.status == 200
    expect(ui.page.locator("#login")).to_be_visible()
    expect(ui.page.locator("#notice")).to_contain_text("nie przyjmujemy innego powiązania")
    expect(ui.page.locator("#viewer")).to_be_hidden()


def test_malformed_live_frame_stops_instead_of_interpreting_content(ui, db, credentials):
    stored(db, credentials, "valid snapshot")
    ui.login()
    ui.page.route("**/v1/events?*", lambda route: route.fulfill(
        status=200, content_type="text/event-stream", body="id: 999\nevent: message\ndata: {bad\n\n",
    ))
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Niepoprawna ramka")
    expect(ui.page.locator("#messages")).to_be_empty()
    expect(ui.page.locator("#live-toggle")).to_have_text("Włącz zdarzenia na żywo")


def test_late_live_event_cannot_restore_a_logged_out_view(ui, credentials):
    ui.login()
    ui.page.evaluate("""() => {
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
            constructor(url) { super(url); window.previousSource = this; }
        };
    }""")
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    ui.page.locator("#logout").click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    ui.page.evaluate("""(room) => previousSource.dispatchEvent(new MessageEvent('message', {
        lastEventId: '999', data: JSON.stringify({room_id: room})
    }))""", credentials.room)
    expect(ui.page.locator("#live-count")).to_be_empty()
    expect(ui.page.locator("#viewer")).to_be_hidden()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")


def test_language_selector_translates_static_and_dynamic_ui(ui, credentials):
    page = ui.page
    assert page.locator("html").get_attribute("lang") == "pl"
    expect(page.locator("#login-title")).to_have_text("Rozmowy agentów")
    with page.expect_navigation():
        page.select_option("#language", "en")
    expect(page.locator("#login-title")).to_have_text("Agent conversations")
    assert page.evaluate("localStorage.getItem('agent-chat.language')") == "en"
    page.reload()
    expect(page.locator("#login-title")).to_have_text("Agent conversations")
    page.locator("#token").fill(credentials.operator)
    page.get_by_role("button", name="Log in", exact=True).click()
    expect(page.locator("#viewer")).to_be_visible()
    expect(page.locator("#tab-chat")).to_have_text("Conversations")
    expect(page.locator("#tab-sessions")).to_have_text("Sessions")
    expect(page.locator("#kind option[value=message]")).to_have_text("Message")
    expect(page.locator("#body")).to_have_attribute(
        "placeholder", "Write a message: up to 16 KiB, no secrets or transcripts"
    )
    expect(page.locator("#kind optgroup").first).to_have_attribute("label", "Information")
    expect(page.locator("#notice")).to_contain_text("History snapshot")
    expect(page.locator("#send")).to_be_enabled()
    page.locator("#body").fill("synthetic english body")
    page.get_by_role("button", name="Send", exact=True).click()
    expect(page.locator("#notice")).to_contain_text("Stored")
    expect(page.locator("#notice")).to_contain_text("not confirmation of a wake or ACK")


def test_language_selection_works_when_storage_is_blocked(ui):
    page = ui.page
    page.add_init_script("""
        Storage.prototype.getItem = () => { throw new Error('blocked'); };
        Storage.prototype.setItem = () => { throw new Error('blocked'); };
    """)
    page.reload()
    expect(page.locator("#login-title")).to_have_text("Rozmowy agentów")
    with page.expect_navigation():
        page.select_option("#language", "en")
    expect(page.locator("#login-title")).to_have_text("Agent conversations")
    assert page.url.endswith("#lang=en")


def test_language_switch_can_be_cancelled_with_a_draft(ui, credentials):
    ui.login()
    page = ui.page
    page.locator("#body").fill("synthetic unsaved draft")
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.select_option("#language", "en")
    assert page.locator("#language").input_value() == "pl"
    assert "#lang=" not in page.url
    assert page.evaluate("localStorage.getItem('agent-chat.language')") is None
    expect(page.locator("#tab-chat")).to_have_text("Rozmowy")


def test_viewer_routes_do_not_exist_without_public_origin(http_api):
    for path in ("/", "/ui/chat.js", "/ui/chat.css", "/ui/Manrope-Variable.ttf"):
        assert http_api("GET", path)[0] == 404


RESOURCE = "resource:node-a:ci-validation"
LEASE = {
    "schema": "agent-chat.validation-lease.v1", "source": "validation-lease-status.v1", "mode": "classed",
    "scan": "ok", "slots": [
        {"slot": 1, "state": "held", "lane": "owner/project::abc123", "branch": "task/x", "profile": "c1"},
        {"slot": 2, "state": "free"},
        {"slot": 3, "state": "stuck"},
        {"slot": 4, "state": "something-new"},
    ],
    "waiters": [{"waiting_since": "2026-10-14T10:00:00Z", "lane": "owner/project::def456", "branch": "task/y"}],
}


def seed_state(db, room, producer, key, value, *, ttl=90, ref=None):
    entry = StateEntry(state_key=key, value=value, ttl_seconds=ttl, ref_key=ref)
    return state.upsert(
        db, ProducerActor(UUID(producer.principal), producer.host, producer.producer), UUID(room),
        StateUpsert(entries=(entry,)),
    )


def shift_state(db, key, seconds):
    db.execute(
        """UPDATE agent_chat.room_state SET changed_at = changed_at - make_interval(secs => %(s)s),
        observed_at = observed_at - make_interval(secs => %(s)s),
        expires_at = expires_at - make_interval(secs => %(s)s) WHERE state_key = %(key)s""",
        {"s": seconds, "key": key},
    )


def test_kinds_ref_keys_and_the_operator_label_render_as_text(ui, db, credentials, actors):
    room, first, _second, operator = actors
    payload = '<img src="/exfil" onerror="window.compromised=true">'
    publish(db, first, room, uuid4(), Publication(kind="intent", body=payload, ref_key=RESOURCE))
    publish(db, operator, room, uuid4(), Publication(kind="decision_needed", body="operator note", ref_key=RESOURCE))
    publish(db, first, room, uuid4(), Publication(kind="blocked_on", body="plain agent note"))
    ui.login()
    cards = ui.page.locator("#messages > li")
    expect(cards).to_have_count(3)
    intent, decision, blocked = cards.nth(0), cards.nth(1), cards.nth(2)
    expect(intent.locator(".kind-intent")).to_have_text("Zamiar")
    expect(decision.locator(".kind-decision_needed")).to_have_text("Potrzebna decyzja")
    expect(blocked.locator(".kind-blocked_on")).to_have_text("Zablokowany przez")
    expect(intent.locator(".thread-key")).to_have_text(RESOURCE)
    expect(decision.locator(".operator-label")).to_have_text("operator")
    assert intent.locator(".operator-label").count() == 0 and blocked.locator(".operator-label").count() == 0
    assert blocked.locator(".thread-key").count() == 0
    expect(intent.locator(".body")).to_have_text(payload)
    assert ui.page.locator("#messages img").count() == 0
    assert ui.page.evaluate("window.compromised === undefined")


def is_message_post(ui, room):
    messages_url = f"{ui.origin}/v1/rooms/{room}/messages"

    def matches(response):
        return response.request.method == "POST" and response.url == messages_url

    return matches


def test_the_ref_key_input_is_validated_and_closed_to_questions_and_replies(ui, db, credentials, actors):
    room, first, _second, _operator = actors
    parent = publish(db, first, room, uuid4(), Publication(kind="message", body="a parent"))
    ui.login()
    bodies = []
    ui.page.on("request", lambda request: bodies.append(request.post_data_json)
               if request.method == "POST" and request.url.endswith("/messages") else None)
    ui.page.locator("#kind").select_option("question")
    expect(ui.page.locator("#ref-key")).to_be_disabled()
    ui.page.locator("#kind").select_option("heads_up")
    expect(ui.page.locator("#ref-key")).to_be_enabled()
    ui.page.locator("#ref-key").fill("free text")
    send(ui.page, "uses a malformed key")
    expect(ui.page.locator("#notice")).to_contain_text("Niepoprawny klucz")
    assert bodies == [] and count(db, "messages") == 1
    ui.page.locator("#ref-key").fill("pr:owner/project#4638")
    with ui.page.expect_response(is_message_post(ui, room)) as keyed_response:
        send(ui.page)
    assert keyed_response.value.status == 200
    keyed_id = keyed_response.value.json()["id"]
    expect(ui.page.locator("#notice")).to_contain_text(f"Zapisano {keyed_id}")
    assert bodies[0]["ref_key"] == "pr:owner/project#4638" and bodies[0]["kind"] == "heads_up"
    assert db.execute("SELECT ref_key FROM agent_chat.threads WHERE ref_key IS NOT NULL").fetchone()["ref_key"] == (
        "pr:owner/project#4638")
    expect(ui.page.locator("#ref-key")).to_have_value("")
    # A plain message sends no ref_key field at all, and a pinned reply closes the input.
    with ui.page.expect_response(is_message_post(ui, room)) as plain_response:
        send(ui.page, "no key")
    response = plain_response.value
    assert response.status == 200
    receipt = response.json()
    assert receipt["id"] not in {keyed_id, str(parent["id"])}
    expect(ui.page.locator("#notice")).to_contain_text(f"Zapisano {receipt['id']}")
    assert "ref_key" not in response.request.post_data_json
    ui.page.locator(f'li[data-message-id="{parent["id"]}"]').get_by_role(
        "button", name="Odpowiedz", exact=True).click()
    expect(ui.page.locator("#ref-key")).to_be_disabled()


def test_switching_a_populated_key_to_question_clears_it_and_allows_sending(ui, db, credentials, actors):
    room, first, _second, _operator = actors
    ui.login()
    ui.page.locator("#ref-key").fill("pr:owner/project#4638")
    ui.page.locator("#kind").select_option("question")
    expect(ui.page.locator("#ref-key")).to_have_value("")
    expect(ui.page.locator("#notice")).to_contain_text("Usunięto klucz wątku")
    choose(ui.page, first.session_id)
    bodies = []
    ui.page.on("request", lambda request: bodies.append(request.post_data_json)
               if request.method == "POST" and request.url.endswith("/messages") else None)
    with ui.page.expect_response(is_message_post(ui, room)) as question_response:
        send(ui.page, "question after clearing the key")
    assert question_response.value.status == 200
    assert bodies and bodies[0]["kind"] == "question" and "ref_key" not in bodies[0]
    expect(ui.page.locator("#notice")).to_contain_text("Zapisano")


def test_filtering_by_ref_key_shows_a_header_and_a_serialized_resolve_button(ui, db, credentials, actors):
    room, first, _second, _operator = actors
    keyed = publish(db, first, room, uuid4(), Publication(kind="status", body="inside", ref_key=RESOURCE))
    publish(db, first, room, uuid4(), Publication(kind="message", body="outside"))
    ui.login()
    expect(ui.page.locator(".body")).to_have_count(2)
    ui.page.locator("#thread").fill(RESOURCE)
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator(".body")).to_have_text(["inside"])
    expect(ui.page.locator("#thread-header")).to_contain_text(RESOURCE)
    expect(ui.page.locator("#thread-header")).to_contain_text("otwarty")
    held = hold_response(ui.page, "**/v1/threads/*/resolution", first=True)
    button = ui.page.get_by_role("button", name="Oznacz jako rozwiązany", exact=True)
    button.click()
    wait_held(ui.page, held)
    expect(button).to_be_disabled()
    expect(ui.page.locator("#thread")).to_be_disabled()
    assert len(held) == 1
    release(held[0])
    expect(ui.page.locator("#notice")).to_contain_text("Potwierdzono zapis")
    expect(ui.page.locator("#thread-header")).to_contain_text("rozwiązany")
    expect(ui.page.locator("#messages > li").first).to_contain_text("rozwiązany")
    assert db.execute("SELECT resolved_at FROM agent_chat.threads WHERE ref_key = %s", (RESOURCE,)).fetchone()[
        "resolved_at"] is not None
    assert count(db, "events", "kind = 'thread'") == 1
    ui.page.get_by_role("button", name="Otwórz ponownie", exact=True).click()
    expect(ui.page.locator("#thread-header")).to_contain_text("otwarty")
    assert count(db, "events", "kind = 'thread'") == 2
    # The same list answers to the thread's UUID, with the same header.
    ui.page.locator("#thread").fill(str(keyed["thread_id"]))
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#thread-header")).to_contain_text(RESOURCE)
    ui.page.locator("#thread").fill("pr:owner/project#9")
    ui.page.locator("#apply-thread").click()
    expect(ui.page.locator("#thread-header")).to_contain_text("Brak wiadomości")


def test_a_participant_shows_its_advisory_lane_and_age_and_others_show_nothing(ui, db, actors):
    _room, first, second, _operator = actors
    db.execute(
        "UPDATE agent_chat.instances SET lane = %s, lane_since = clock_timestamp() - interval '7 minutes' "
        "WHERE id = %s",
        ("owner/project::abc123-def456", first.instance_id),
    )
    ui.login()
    entry = ui.page.locator("#participants > li").filter(has_text=str(first.session_id))
    expect(entry).to_contain_text("lane: owner/project::abc123-def456")
    expect(entry).to_contain_text("zadeklarowany 7 min temu")
    expect(entry).to_contain_text("deklaracja, nie uprawnienie")
    # Name, lane chip, selector label and the lane line in the details; both lane copies are isolated.
    assert entry.locator("bdi").count() == 4
    expect(entry.locator("bdi", has_text="owner/project::abc123-def456")).to_have_count(2)
    quiet = ui.page.locator("#participants > li").filter(has_text=str(second.session_id))
    assert "lane:" not in quiet.inner_text() and quiet.locator("bdi").count() == 2


def test_the_state_card_renders_observations_as_text_and_never_as_free_or_known_when_stale(
    ui, db, credentials, make_producer
):
    producer, gone, other = make_producer(), make_producer("node-b"), make_producer("node-a", "other-tool")
    html = {"note": '<img src="/exfil" onerror="window.compromised=true"><script>window.compromised=true</script>'}
    seed_state(db, credentials.room, producer, "validation-lease:node-a:c1", LEASE, ref=RESOURCE)
    seed_state(db, credentials.room, producer, "validation-lease:node-a:leaf",
               {"schema": "agent-chat.validation-lease.v1", "scan": "unknown", "reason": "lease_status_failed"},
               ref=RESOURCE)
    seed_state(db, credentials.room, producer, "validation-lease:node-a:shared", LEASE, ref=RESOURCE)
    shift_state(db, "validation-lease:node-a:shared", 500)
    seed_state(db, credentials.room, other, "other-tool:node-a:html", html)
    seed_state(db, credentials.room, gone, "validation-lease:node-b:c1", LEASE)
    db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (gone.principal,))
    ui.login()
    card = ui.page.locator("#room-state")
    expect(card).to_contain_text("Czat nie przydziela, nie porządkuje ani nie zwalnia blokad.")
    expect(card).to_contain_text("Stan zasobów (obserwacja)")
    group = card.locator("#state-groups > div").filter(has_text=RESOURCE)
    expect(group).to_contain_text("Slot 1: zajęty (owner/project::abc123, task/x, c1) od")
    expect(group).to_contain_text("Slot 2: wolny")
    expect(group).to_contain_text("Slot 3: zablokowany (stuck)")
    expect(group).to_contain_text("Slot 4: nieznany")
    # Times read in the browser's local format; the exact server value stays in the tooltip.
    local = ui.page.evaluate(
        "new Intl.DateTimeFormat('pl-PL', {dateStyle: 'short', timeStyle: 'short'})"
        ".format(new Date('2026-10-14T10:00:00Z'))"
    )
    expect(group).to_contain_text(f"Oczekuje: owner/project::def456, task/y od {local}")
    assert "2026-10-14T10:00:00Z" not in group.inner_text()
    expect(group.locator("p[title='od: 2026-10-14T10:00:00Z']")).to_have_count(1)
    # The held slot's age is the entry's own change time, also a tooltip; the stale entry offers none.
    expect(group.locator("p[title^='od: ']")).to_have_count(2)
    expect(group).to_contain_text("nieznany (lease_status_failed)")
    expect(group).to_contain_text("nieznany, ostatnio widziany 5")
    expect(card).to_contain_text("nieznany (producent odwołany)")
    expect(card.locator("pre")).to_contain_text("<script>window.compromised=true</script>")
    assert card.locator("img, script").count() == 0
    assert ui.page.evaluate("window.compromised === undefined")
    assert group.locator("li", has_text="validation-lease:node-a:shared").inner_text().count("zajęty") == 0
    group.get_by_role("button", name=f"Pokaż wątek {RESOURCE}", exact=True).click()
    expect(ui.page.locator("#thread-scope")).to_have_text(f"Wątek: {RESOURCE}")


def test_state_and_thread_events_refresh_the_view_without_rendering_their_bodies(
    ui, db, credentials, actors, make_producer
):
    room, first, _second, operator = actors
    producer = make_producer()
    root = publish(db, first, room, uuid4(), Publication(kind="intent", body="keyed", ref_key=RESOURCE))
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    seed_state(db, credentials.room, producer, "validation-lease:node-a:c1", LEASE, ref=RESOURCE)
    expect(ui.page.locator("#room-state")).to_contain_text("Slot 2: wolny")
    changed = {**LEASE, "slots": [{"slot": 7, "state": "free"}]}
    seed_state(db, credentials.room, producer, "validation-lease:node-a:c1", changed, ref=RESOURCE)
    expect(ui.page.locator("#room-state")).to_contain_text("Slot 7: wolny")
    assert "Slot 2" not in ui.page.locator("#room-state").inner_text()
    threads.resolve(db, operator, root["thread_id"], True)
    expect(ui.page.locator("#messages > li").first).to_contain_text("rozwiązany")


def test_the_state_card_asks_the_server_again_once_when_the_soonest_entry_lapses(ui, db, credentials, make_producer):
    producer = make_producer()
    seed_state(db, credentials.room, producer, "validation-lease:node-a:c1", LEASE, ttl=30)
    shift_state(db, "validation-lease:node-a:c1", 28)
    reads = []
    ui.page.on("request", lambda request: reads.append(request.url)
               if request.url.split("?")[0].endswith("/state") else None)
    ui.login()
    expect(ui.page.locator("#room-state")).to_contain_text("Slot 2: wolny")
    expect(ui.page.locator("#room-state")).to_contain_text("nieznany, ostatnio widziany", timeout=8000)
    assert "Slot 2" not in ui.page.locator("#room-state").inner_text()
    ui.page.wait_for_timeout(1500)
    assert len(reads) == 2, "one read with the snapshot, one when the entry lapsed, and none for a stale entry"


def test_the_csp_is_restrictive_and_the_viewer_stays_free_of_inline_code(ui):
    expected = (
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    for path in ("/", "/ui/chat.js", "/ui/chat.css", "/ui/Manrope-Variable.ttf"):
        response = ui.context.request.get(ui.origin + path)
        assert response.status == 200 and response.headers["content-security-policy"] == expected
    html = ui.context.request.get(ui.origin + "/").text()
    assert "<script>" not in html and " style=" not in html and " onclick=" not in html


def _static_index_html() -> str:
    """The shipped document, read from the package rather than over HTTP."""
    from importlib.resources import files

    return files("agent_chat").joinpath("web", "index.html").read_text(encoding="utf-8")


def test_the_composer_offers_every_kind_grouped_by_intent():
    """Grouping must not drop a kind: the select is the only way to choose one.

    The server accepts eight kinds and the composer maps each to a different
    obligation — a question or consultation needs a recipient and refuses a
    thread key. Regrouping for readability therefore edits a closed set, and a
    mistyped or omitted option would silently remove a kind from the UI while
    every server-side test still passed.
    """
    from html.parser import HTMLParser

    class Kinds(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_kind = False
            self.group: str | None = None
            self.options: list[str | None] = []
            self.groups: dict[str | None, list[str | None]] = {}

        def handle_starttag(self, tag, attrs):
            attributes = dict(attrs)
            if tag == "select" and attributes.get("id") == "kind":
                self.in_kind = True
            elif self.in_kind and tag == "optgroup":
                self.group = attributes.get("label")
                self.groups[self.group] = []
            elif self.in_kind and tag == "option":
                self.options.append(attributes.get("value"))
                if self.group is not None:
                    self.groups[self.group].append(attributes.get("value"))

        def handle_endtag(self, tag):
            if tag == "select":
                self.in_kind = False
            elif tag == "optgroup":
                self.group = None

    parser = Kinds()
    parser.feed(_static_index_html())
    assert parser.options == [
        "message", "status", "heads_up", "intent",
        "question", "consultation",
        "blocked_on", "decision_needed",
    ]
    # The two kinds that require a recipient say so in their group label, so the
    # obligation is visible before a send is refused for having no target.
    assert parser.groups["Pytanie — wymaga odbiorcy"] == ["question", "consultation"]


def test_participants_keep_their_caveats_behind_a_disclosure():
    """The list stays scannable; the caveats stay one click away.

    Four lines of prose above the participant list is the first thing a new
    session reads and the last thing it needs before choosing a recipient.
    They live in the app bar's help popover, which is closed by default.
    """
    html = _static_index_html()
    disclosure = html.index('<details id="help" class="popover">')
    caveat = html.index("Plan Mode, stop i wyciszenie")
    listing = html.index('<ul id="participants"')
    assert disclosure < caveat < listing
    assert 'class="panel-help"' not in html


def test_the_login_card_is_reachable_on_a_short_desktop_viewport(ui):
    """A taller login card must not push its own controls out of reach.

    Above the 820px breakpoint the body is one viewport tall with `overflow:
    hidden`, so the login region is the only thing that can scroll. Playwright's
    `click` scrolls its target into view automatically, which would hide exactly
    this defect, so the scroll is driven by a real wheel event over the region
    and the geometry is asserted directly.
    """
    ui.page.set_viewport_size({"width": 1280, "height": 600})
    ui.page.reload()
    expect(ui.page.get_by_role("button", name="Zaloguj", exact=True)).to_be_visible()
    # The region is the scroll container. Before the fix it computed to
    # `visible`, so a card taller than the window was clipped with no way to
    # scroll it back into view.
    assert ui.page.evaluate(
        "getComputedStyle(document.querySelector('#login-view')).overflowY"
    ) == "auto"
    ui.page.mouse.move(640, 300)
    for _ in range(8):
        ui.page.mouse.wheel(0, 400)
    ui.page.wait_for_timeout(100)
    assert ui.page.evaluate(
        """() => {
            const box = document.querySelector('#login button').getBoundingClientRect();
            return box.top >= 0 && box.bottom <= window.innerHeight;
        }"""
    ) is True


# Readability. The pinned contract stays: every roster row keeps one `.participant-id`, `.participant-label`,
# `.session-title` and `.participant-identity`, and every control keeps its exact-UUID accessible name. These tests pin
# the geometry that the operator's "very hard to read" report turned on.


def _box(page, selector):
    box = page.locator(selector).first.bounding_box()
    assert box is not None, selector
    return box


def _reachable(page, selector):
    """The control's centre lies inside the viewport and is what a pointer would hit there."""
    return page.locator(selector).first.evaluate(
        """el => {
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
            const hit = document.elementFromPoint(x, y);
            return hit === el || el.contains(hit);
        }"""
    )


def test_a_roster_row_is_compact_and_its_controls_keep_the_exact_uuid_as_their_name(
    ui, db, credentials, actors, actor_factory
):
    room, first, _second, _operator = actors
    sessions.heartbeat(db, first, Heartbeat(native_state="idle", stopped=False, plan_mode=False, title="Repair queue"))
    with db.transaction():
        for _ in range(4):
            actor_factory(room)
    ui.page.set_viewport_size({"width": 1440, "height": 900})
    ui.login()
    row = _roster_row(ui.page, first.session_id)
    box = row.bounding_box()
    assert box is not None and box["height"] <= 150, box  # 330 px before: the full UUID sat in every control
    for label in ("Wybierz", "Wycisz", "Ustaw PM"):
        button = ui.page.get_by_role("button", name=f"{label} {first.session_id}", exact=True)
        assert button.inner_text() == label
    tops = row.locator(".participant-actions button").evaluate_all(
        "buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top))"
    )
    assert len(tops) == 3 and len(set(tops)) == 1, tops
    # The exact selector and the raw flags are one disclosure away, never gone.
    expect(row.locator(".participant-id")).to_be_hidden()
    expect(row.locator(".participant-label")).to_be_hidden()
    row.locator("summary").click()
    expect(row.locator(".participant-id")).to_have_text(str(first.session_id))
    expect(row.locator(".participant-label")).to_have_text("synthetic-session")
    expect(row.locator(".participant-flags")).to_contain_text("Plan Mode: false")


def test_roster_chips_flag_only_the_states_that_need_attention(ui, db, actors):
    _room, first, second, _operator = actors
    sessions.heartbeat(db, second, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    ui.login()
    flagged = _roster_row(ui.page, first.session_id).locator(".participant-sub")
    expect(flagged).to_contain_text("stop")
    expect(flagged).to_contain_text("Plan Mode")
    expect(flagged).not_to_contain_text("mute")
    # A calm row has no attention line at all; its state is the word beside the name.
    calm = _roster_row(ui.page, second.session_id)
    expect(calm.locator(".participant-sub")).to_have_count(0)
    expect(calm.locator(".native-state")).to_have_text("idle")
    expect(_roster_row(ui.page, first.session_id).locator(".participant-flags")).to_contain_text("Plan Mode: true")


def test_a_row_disclosure_stays_open_across_a_roster_reload(ui, db, actors):
    _room, first, second, _operator = actors
    ui.login()
    row = _roster_row(ui.page, first.session_id)
    row.locator("summary").click()
    expect(row.locator(".participant-id")).to_be_visible()
    ui.page.locator("#participants > li").evaluate_all("items => items.forEach(item => { item.dataset.old = '1'; })")
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#participants > li[data-old]")).to_have_count(0)  # the roster was rebuilt
    expect(_roster_row(ui.page, first.session_id).locator(".participant-id")).to_be_visible()
    expect(_roster_row(ui.page, second.session_id).locator(".participant-id")).to_be_hidden()


def test_the_pm_line_is_short_with_the_times_behind_a_disclosure(ui, db, actors):
    room, first, _second, operator = actors
    roles.assign(db, operator, room, "pm", first.session_id)
    ui.page.set_viewport_size({"width": 1440, "height": 900})
    ui.login()
    line = ui.page.locator("#pm-mark")
    box = line.bounding_box()
    assert box is not None and box["height"] <= 64, box  # about 110 px of running text before
    expect(line).to_contain_text("Znacznik nie nadaje uprawnień.")
    expect(line.locator(".pm-mark-times")).to_be_hidden()
    line.locator("summary").click()
    expect(line.locator(".pm-mark-times")).to_contain_text(str(first.session_id))
    expect(line.locator(".pm-mark-times")).to_contain_text("wygasa")
    # Local times in the text, the three exact server values in the tooltip: the ones the page was served, not any
    # timestamp that merely looks like one. The refresh renders from the response read here, and the disclosure
    # stays open across it.
    with ui.page.expect_response(lambda r: "/participants?" in r.url and r.request.method == "GET") as read:
        ui.page.locator("#refresh").click()
    served = read.value.json()["pm"]
    expect(line.locator(".pm-mark-times")).to_have_attribute(
        "title",
        f"ustawiony: {served['set_at']} · ostatnia aktywność: {served['last_activity_at']} · "
        f"wygasa: {served['expires_at']}",
    )


def _seed_a_tall_state_panel(db, credentials, make_producer):
    producer, other = make_producer(), make_producer("node-a", "other-tool")
    for name in ("c1", "leaf", "shared"):
        seed_state(db, credentials.room, producer, f"validation-lease:node-a:{name}", LEASE, ref=RESOURCE)
    for index in range(3):
        seed_state(db, credentials.room, other, f"other-tool:node-a:n{index}", {"note": "observation " * 6})


@pytest.mark.parametrize("viewport", [
    {"width": 1180, "height": 800}, {"width": 1024, "height": 768}, {"width": 821, "height": 700},
])
def test_the_state_panel_stays_in_the_side_column_and_never_squeezes_the_timeline(
    ui, db, credentials, make_producer, viewport
):
    _seed_a_tall_state_panel(db, credentials, make_producer)
    ui.page.set_viewport_size(viewport)
    ui.login()
    panel = ui.page.locator("#room-state")
    assert panel.evaluate("el => el.open") is True  # beside the conversation, so it opens by default
    expect(ui.page.locator("#state-groups")).to_be_visible()
    # A tall panel is capped and scrolls inside itself; the timeline and Send keep the screen.
    side = _box(ui.page, ".details")
    assert side["height"] <= min(240, viewport["height"] * 0.34) + 1, side
    assert ui.page.locator(".details").evaluate("el => el.scrollHeight > el.clientHeight")
    assert _box(ui.page, "#messages")["height"] >= 200, _box(ui.page, "#messages")
    assert _reachable(ui.page, "#send")


@pytest.mark.parametrize("viewport", [{"width": 820, "height": 800}, {"width": 600, "height": 800}])
def test_the_state_panel_collapses_on_a_narrow_window_and_reopens_when_it_widens(
    ui, db, credentials, make_producer, viewport
):
    _seed_a_tall_state_panel(db, credentials, make_producer)
    ui.page.set_viewport_size(viewport)
    ui.login()
    panel = ui.page.locator("#room-state")
    assert panel.evaluate("el => el.open") is False
    expect(ui.page.locator("#state-groups")).to_be_hidden()
    assert _reachable(ui.page, "#send")
    panel.locator(":scope > summary").click()
    expect(ui.page.locator("#state-groups")).to_be_visible()
    expect(panel).to_contain_text("Slot 2: wolny")
    panel.locator(":scope > summary").click()  # Closed again, so only the widening can open it.
    expect(ui.page.locator("#state-groups")).to_be_hidden()
    ui.page.set_viewport_size({"width": 1280, "height": 720})
    # Beside the conversation again, so it opens by default. The media-query change arrives on the next frame.
    expect(panel).to_have_js_property("open", True)


def test_the_conversation_header_shares_one_row_on_a_wide_window(ui):
    ui.page.set_viewport_size({"width": 1280, "height": 720})
    ui.login()
    heading, filtering = _box(ui.page, ".conversation-heading"), _box(ui.page, "#thread-filter")
    assert abs(heading["y"] - filtering["y"]) < 40, (heading, filtering)
    assert _box(ui.page, ".conversation-header")["height"] <= 90
    assert _box(ui.page, "#messages")["height"] >= 270, _box(ui.page, "#messages")


# Redesign v2: the remembered live choice, the roster order and filter, and the flatter timeline.

LIVE_KEY = "agent-chat.live"


def _live_choice(page):
    return page.evaluate("key => window.localStorage.getItem(key)", LIVE_KEY)


def test_the_live_choice_is_remembered_in_this_browser_and_resumes_after_a_reload(ui, db, credentials):
    stored(db, credentials, "initial")
    ui.login()
    assert _live_choice(ui.page) is None  # nothing is stored until the operator chooses
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    assert _live_choice(ui.page) == "1"
    # A manual refresh and a reload both re-read the room, then resume through the same revalidated start.
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    ui.page.reload()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(ui.page.locator("#live-toggle")).to_have_text("Wyłącz zdarzenia na żywo")
    stored(db, credentials, "arrives after the reload")
    expect(ui.page.locator(".body")).to_have_text(["initial", "arrives after the reload"])
    # Only the toggle clears the choice.
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")
    assert _live_choice(ui.page) is None
    ui.page.reload()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")  # a resume had its chance and did not run
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")
    expect(ui.page.locator("#live-toggle")).to_have_text("Włącz zdarzenia na żywo")


def test_logout_and_a_failing_stream_never_change_the_remembered_live_choice(ui, db, credentials):
    stored(db, credentials, "initial")
    streams = []
    ui.page.on("request", lambda request: streams.append(request.url) if "/v1/events?" in request.url else None)
    ui.login()
    ui.page.route("**/v1/events?*", lambda route: route.abort())
    ui.page.locator("#live-toggle").click()
    deadline = time.monotonic() + 15
    while len(streams) < 2:  # the stream failed and the client is already retrying
        assert time.monotonic() < deadline, streams
        ui.page.wait_for_timeout(50)
    assert _live_choice(ui.page) == "1"
    ui.page.unroute("**/v1/events?*")
    ui.page.get_by_role("button", name="Wyloguj", exact=True).click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")
    assert _live_choice(ui.page) == "1"
    # The choice belongs to the browser and the scope to the session: the next login resumes without a click.
    ui.login()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(ui.page.locator("#live-toggle")).to_have_text("Wyłącz zdarzenia na żywo")


def test_live_still_works_for_this_view_when_browser_storage_is_unusable(ui, db, credentials):
    stored(db, credentials, "initial")
    # A window that refuses storage, as a private or locked-down browser does: reaching it throws.
    ui.context.add_init_script(
        "Object.defineProperty(window, 'localStorage', "
        "{get() { throw new DOMException('blocked', 'SecurityError'); }})"
    )
    ui.page.reload()
    expect(ui.page.locator("#login")).to_be_visible()
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    stored(db, credentials, "arrives live")
    expect(ui.page.locator(".body")).to_have_text(["initial", "arrives live"])
    # Nothing could be stored, but the page still holds the choice: a manual refresh and a new login are not a reload.
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    ui.page.get_by_role("button", name="Wyloguj", exact=True).click()
    expect(ui.page.locator("#notice")).to_have_text("Wylogowano.")
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")
    ui.login()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(ui.page.locator("#live-toggle")).to_have_text("Wyłącz zdarzenia na żywo")
    # Only a reload forgets it: nothing was remembered, so the next load starts with live off. Neither the read nor
    # the write threw.
    ui.page.reload()
    expect(ui.page.locator("#notice")).to_contain_text("Migawka historii")
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")


def test_a_second_tab_changes_the_live_choice_only_at_its_next_load(ui, db, credentials):
    stored(db, credentials, "initial")
    ui.login()
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    other = ui.context.new_page()  # the same browser: shared cookies and shared storage
    other.set_default_timeout(5000)
    other.on("pageerror", lambda error: ui.errors.append(type(error).__name__))
    other.goto(ui.origin)
    expect(other.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")  # it loaded the stored choice
    # The first tab turns live off: that changes what is stored, not what the second tab has loaded.
    ui.page.locator("#live-toggle").click()
    expect(ui.page.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")
    assert _live_choice(ui.page) is None
    other.locator("#refresh").click()
    expect(other.locator("#live-status")).to_contain_text("Połączenie zdarzeń aktywne")
    expect(other.locator("#live-toggle")).to_have_text("Wyłącz zdarzenia na żywo")
    # The second tab adopts the change at its next load.
    other.reload()
    expect(other.locator("#notice")).to_contain_text("Migawka historii")
    expect(other.locator("#live-status")).to_have_text("Zdarzenia na żywo wyłączone.")
    other.close()


def test_the_roster_lists_online_sessions_first_and_counts_them(ui, db, actors, actor_factory):
    room, first, second, _operator = actors
    with db.transaction():
        third = actor_factory(room)
    ui.login()
    rows = ui.page.locator("#participants > li")
    served = rows.evaluate_all("rows => rows.map(row => row.dataset.sessionId)")
    assert sorted(served) == sorted(str(actor.session_id) for actor in (first, second, third))
    expect(ui.page.locator("#roster-count")).to_have_text("3 online · 3")
    # The page is the whole room, so the counts stand bare: no scope words and no tooltip about the page.
    assert ui.page.locator("#roster-count").get_attribute("title") is None
    # The server pages the roster by session id. The session it lists first lapses; the page puts it last.
    lapsed = served[0]
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = now() - interval '100 seconds' WHERE session_id = %s",
        (lapsed,),
    )
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#roster-count")).to_have_text("2 online · 3")
    assert rows.evaluate_all("rows => rows.map(row => row.dataset.sessionId)") == [*served[1:], lapsed]
    assert rows.evaluate_all("rows => rows.map(row => row.dataset.online)") == ["true", "true", "false"]
    # Each group is announced once, by its first row, with its own count.
    assert rows.evaluate_all("rows => rows.map(row => [row.dataset.group ?? null, row.dataset.count ?? null])") == [
        ["Online", "2"], [None, None], ["Offline", "1"],
    ]


def test_the_roster_filter_narrows_the_loaded_rows_without_a_request_or_a_recipient(ui, db, actors):
    _room, first, second, _operator = actors
    sessions.heartbeat(db, first, Heartbeat(native_state="idle", stopped=False, plan_mode=False, title="Repair queue"))
    ui.login()
    requests = []
    ui.page.on("request", lambda request: requests.append(request.url) if "/v1/" in request.url else None)
    visible = ui.page.locator("#participants > li:not([hidden])")
    expect(visible).to_have_count(2)
    ui.page.locator("#roster-filter").fill("REPAIR")  # by title, whatever the case
    expect(visible).to_have_count(1)
    expect(visible).to_have_attribute("data-session-id", str(first.session_id))
    ui.page.locator("#roster-filter").fill(str(second.session_id)[:8])  # by the identity the untitled row shows
    expect(visible).to_have_count(1)
    expect(visible).to_have_attribute("data-session-id", str(second.session_id))
    ui.page.locator("#roster-filter").fill("no such session")
    expect(visible).to_have_count(0)
    expect(ui.page.locator("#roster-count")).to_have_text("2 online · 2")  # the loaded page's count, not the filter's
    ui.page.locator("#roster-filter").fill("")
    expect(visible).to_have_count(2)
    # Narrowing only hides rows: nothing was requested and nobody became a recipient.
    assert requests == []
    expect(ui.page.locator("#targets > li")).to_have_count(0)


def test_a_filtered_roster_keeps_one_heading_for_each_group_that_still_shows_a_row(ui, db, actors, actor_factory):
    room, first, second, _operator = actors
    with db.transaction():
        third, fourth = actor_factory(room), actor_factory(room)
    by_id = {str(actor.session_id): actor for actor in (first, second, third, fourth)}
    ui.login()
    rows = ui.page.locator("#participants > li")
    served = rows.evaluate_all("rows => rows.map(row => row.dataset.sessionId)")  # the server's order, all online
    assert sorted(served) == sorted(by_id)
    # Two sessions lapse, so the page lists two online rows and then two offline rows. The filter below hides the
    # first row of each group and keeps the second: each heading has to follow the row that is still shown.
    hidden_online, shown_online, hidden_offline, shown_offline = served[1], served[3], served[0], served[2]
    for session, title in ((hidden_online, "Idle desk"), (shown_online, "Repair queue"),
                           (hidden_offline, "Idle desk"), (shown_offline, "Repair queue")):
        sessions.heartbeat(db, by_id[session], Heartbeat(native_state="idle", stopped=False, plan_mode=False,
                                                         title=title))
    for session in (hidden_offline, shown_offline):
        db.execute(
            "UPDATE agent_chat.instances SET heartbeat_at = now() - interval '100 seconds' WHERE session_id = %s",
            (session,),
        )
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#roster-count")).to_have_text("2 online · 4")
    assert rows.evaluate_all("rows => rows.map(row => row.dataset.sessionId)") == [
        hidden_online, shown_online, hidden_offline, shown_offline,
    ]
    # The heading and its count come from the row's data; what is drawn is the CSS content built from them.
    headings = """rows => rows.filter(row => !row.hidden).map(row => {
        const drawn = getComputedStyle(row, '::before').content;
        return [row.dataset.sessionId, row.dataset.group ?? null, row.dataset.count ?? null,
                ['none', 'normal'].includes(drawn) ? null : drawn.replace(/^"|"$/g, '')];
    })"""
    owners = "rows => rows.filter(row => row.dataset.group !== undefined).map(row => row.dataset.sessionId)"
    whole = [
        [hidden_online, "Online", "2", "Online · 2"], [shown_online, None, None, None],
        [hidden_offline, "Offline", "2", "Offline · 2"], [shown_offline, None, None, None],
    ]
    assert rows.evaluate_all(headings) == whole
    ui.page.locator("#roster-filter").fill("repair")
    expect(ui.page.locator("#participants > li:not([hidden])")).to_have_count(2)
    # One heading for each group that still shows a row, drawn on that row, with the group's size on the loaded page.
    filtered = [[shown_online, "Online", "2", "Online · 2"], [shown_offline, "Offline", "2", "Offline · 2"]]
    assert rows.evaluate_all(headings) == filtered
    assert rows.evaluate_all(owners) == [shown_online, shown_offline]
    expect(ui.page.locator("#roster-count")).to_have_text("2 online · 4")
    # A roster rebuild keeps both the filter and the headings in step. Wait for the rebuilt rows, not for the old
    # ones to go: the roster is empty while the participants are fetched, and an empty roster has no old row either.
    rows.evaluate_all("items => items.forEach(item => { item.dataset.old = '1'; })")
    ui.page.locator("#refresh").click()
    expect(ui.page.locator("#participants > li:not([data-old])")).to_have_count(4)  # a hidden row counts too
    assert rows.evaluate_all(headings) == filtered
    assert rows.evaluate_all(owners) == [shown_online, shown_offline]
    # Clearing the filter gives the headings back to the first row of each group.
    ui.page.locator("#roster-filter").fill("")
    expect(ui.page.locator("#participants > li:not([hidden])")).to_have_count(4)
    assert rows.evaluate_all(headings) == whole
    assert rows.evaluate_all(owners) == [hidden_online, hidden_offline]


def test_the_roster_counts_name_the_loaded_page_when_the_room_has_a_next_page(ui, db, credentials, actor_factory):
    # 51 participants make two pages by session id, 50 rows and then 1. Only the session last by id is online, so the
    # first page holds no online row and the one online session sits on the next page. A count that claimed the room
    # would read "0 online" while a session is online; these counts say that they describe the loaded page.
    with db.transaction():
        sessions = sorted(actor_factory(UUID(credentials.room)).session_id for _ in range(51))
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = now() - interval '100 seconds' WHERE session_id = ANY(%s)",
        (sessions[:-1],),
    )
    ui.login()
    count = ui.page.locator("#roster-count")
    rows = ui.page.locator("#participants > li")
    note = "Liczby dotyczą załadowanej strony uczestników, nie całego pokoju."
    headings = """rows => rows.filter(row => row.dataset.group !== undefined).map(row => {
        const drawn = getComputedStyle(row, '::before').content;
        return [row.dataset.group, row.dataset.count, drawn.replace(/^"|"$/g, '')];
    })"""
    expect(rows).to_have_count(50)
    expect(count).to_have_text("na stronie: 0 online · 50")
    expect(count).to_have_attribute("title", note)
    assert rows.evaluate_all(headings) == [["Offline", "50 na stronie", "Offline · 50 na stronie"]]
    # Narrowing hides rows and changes no count.
    ui.page.locator("#roster-filter").fill("no such session")
    expect(ui.page.locator("#participants > li:not([hidden])")).to_have_count(0)
    expect(count).to_have_text("na stronie: 0 online · 50")
    ui.page.locator("#roster-filter").fill("")
    expect(ui.page.locator("#participants > li:not([hidden])")).to_have_count(50)
    assert rows.evaluate_all(headings) == [["Offline", "50 na stronie", "Offline · 50 na stronie"]]
    # The next page replaces the rows. Its counts describe that page, and they still do not claim the room.
    rows.evaluate_all("items => items.forEach(item => { item.dataset.old = '1'; })")
    ui.page.locator("#more-participants").click()
    expect(ui.page.locator("#participants > li:not([data-old])")).to_have_count(1)
    expect(count).to_have_text("na stronie: 1 online · 1")
    expect(count).to_have_attribute("title", note)
    assert rows.evaluate_all(headings) == [["Online", "1 na stronie", "Online · 1 na stronie"]]
    expect(ui.page.locator("#more-participants")).to_be_hidden()


def test_plain_messages_and_replies_carry_no_kind_badge_but_every_other_kind_does(ui, db, actors):
    room, first, _second, _operator = actors
    parent = publish(db, first, room, uuid4(), Publication(kind="message", body="a plain note"))
    publish(db, first, room, uuid4(), Publication(kind="reply", body="a plain answer", reply_to=parent["id"]))
    publish(db, first, room, uuid4(), Publication(kind="status", body="progress"))
    publish(db, first, room, uuid4(), Publication(kind="question", body="who owns this?"))
    ui.login()
    cards = ui.page.locator("#messages > li")
    expect(cards).to_have_count(4)
    # "Odpowiedź na …" already marks a reply and a plain message needs no label: neither carries a badge.
    expect(cards.nth(0).locator(".kind-badge")).to_have_count(0)
    expect(cards.nth(1).locator(".kind-badge")).to_have_count(0)
    expect(cards.nth(1).locator(".reply-context")).to_contain_text("Odpowiedź na")
    expect(cards.nth(2).locator(".kind-badge")).to_have_text("Status")
    expect(cards.nth(3).locator(".kind-badge")).to_have_text("Pytanie")


def test_the_recipient_row_stays_visible_and_says_what_no_recipient_means(ui, db, actors):
    _room, first, _second, _operator = actors
    ui.login()
    expect(ui.page.locator("#target-row")).to_be_visible()
    targets = ui.page.locator("#targets")

    def placeholder():
        return targets.evaluate("el => getComputedStyle(el, '::before').content")

    assert "Bez odbiorcy" in placeholder() and "nie budzi sesji" in placeholder()
    expect(ui.page.locator("#clear-targets")).to_be_hidden()
    choose(ui.page, first.session_id)
    expect(targets.locator("li")).to_have_count(1)
    assert "Bez odbiorcy" not in placeholder()
    expect(ui.page.locator("#clear-targets")).to_be_visible()
    ui.page.locator("#clear-targets").click()
    expect(targets.locator("li")).to_have_count(0)
    assert "Bez odbiorcy" in placeholder()


def test_the_help_and_room_admin_popovers_open_over_the_timeline_without_moving_it(ui):
    ui.page.set_viewport_size({"width": 1440, "height": 900})
    ui.login()
    resting = _box(ui.page, "#messages")
    help_panel, body = ui.page.locator("#help"), ui.page.locator("#help .help-body")
    assert help_panel.evaluate("el => el.open") is False  # the caveats are one click away, not above the roster
    expect(body).to_be_hidden()
    help_panel.locator(":scope > summary").click()
    expect(body).to_contain_text("Plan Mode, stop i wyciszenie")
    assert _box(ui.page, "#messages") == resting  # a floating panel, not a row that pushes the conversation down
    help_panel.locator(":scope > summary").click()
    expect(body).to_be_hidden()
    # Room management is operator-only and keeps its full name as the tooltip of the short label.
    admin = ui.page.locator("#room-admin")
    expect(admin.locator(":scope > summary")).to_have_text("Pokoje")
    expect(admin.locator(":scope > summary")).to_have_attribute("title", "Zarządzanie pokojami")
    admin.locator(":scope > summary").click()
    expect(ui.page.locator("#room-slug")).to_be_visible()
    assert _box(ui.page, "#messages") == resting


def test_message_times_read_in_the_local_format_and_keep_the_exact_value(ui, db, credentials):
    stored(db, credentials, "timed")
    ui.login()
    # The exact value is the one the server sent, not whatever the page derived from it.
    with ui.page.expect_response(lambda r: "/history?" in r.url and r.request.method == "GET") as read:
        ui.page.locator("#refresh").click()
    exact = read.value.json()["messages"][0]["created_at"]
    stamp = ui.page.locator("#messages > li .timestamp")
    expect(stamp).to_have_attribute("datetime", exact)
    expect(stamp).to_have_attribute("title", exact)  # the tooltip the README promises
    local = ui.page.evaluate(
        "iso => new Intl.DateTimeFormat('pl-PL', {dateStyle: 'short', timeStyle: 'short'}).format(new Date(iso))",
        exact,
    )
    expect(stamp).to_have_text(local)
    assert exact not in stamp.inner_text()
    ui.page.locator("#messages > li .message-evidence > summary").click()
    expect(ui.page.locator("#messages > li .evidence-grid")).to_contain_text(exact)


def _sessions_row(page, session):
    return page.locator(f'#sessions-table tbody tr[data-session-id="{session}"]')


def test_the_sessions_view_does_not_turn_unknown_native_state_into_idle(ui, db, actors, actor_factory):
    room, unknown, idle, _ = actors
    busy = actor_factory(room)
    db.execute(
        "UPDATE agent_chat.instances SET native_state = 'unknown' WHERE session_id = %s", (unknown.session_id,)
    )
    db.execute("UPDATE agent_chat.instances SET native_state = 'idle' WHERE session_id = %s", (idle.session_id,))
    db.execute("UPDATE agent_chat.instances SET native_state = 'busy' WHERE session_id = %s", (busy.session_id,))
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    unknown_row = _sessions_row(ui.page, unknown.session_id)
    expect(unknown_row).to_contain_text("online, stan nieznany")
    expect(unknown_row).not_to_contain_text("bezczynna")
    expect(_sessions_row(ui.page, idle.session_id)).to_contain_text("online, bezczynna")
    expect(_sessions_row(ui.page, busy.session_id)).to_contain_text("online, pracuje")


def test_the_sessions_view_shows_work_roles_activity_and_announced_prs(ui, db, actors):
    room, first, second, operator = actors
    db.execute(
        "UPDATE agent_chat.instances SET repositories = %s::jsonb WHERE session_id = %s",
        (json.dumps({"forgejo": ["owner/project"], "github": ["owner/project"]}), first.session_id),
    )
    roles.assign(db, operator, room, "pm", first.session_id)
    roles.assign(db, operator, room, "delivery_manager", second.session_id)
    publish(
        db, first, room, uuid4(), Publication(kind="message", body="announce", ref_key="pr:owner/project#7")
    )
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    expect(ui.page.locator("#chat-view")).to_be_hidden()
    row = _sessions_row(ui.page, first.session_id)
    expect(row).to_contain_text("owner/project")
    expect(row).to_contain_text("owner/project")
    expect(row).to_contain_text("Forgejo PM")
    expect(row).to_contain_text("owner/project#7")
    expect(row).to_contain_text("1 w 24 h")
    expect(_sessions_row(ui.page, second.session_id)).to_contain_text("Delivery manager")
    ui.page.get_by_role("button", name="Rozmowy", exact=True).click()
    expect(ui.page.locator("#chat-view")).to_be_visible()
    expect(ui.page.locator("#sessions-view")).to_be_hidden()


def test_the_operator_assigns_a_role_from_the_sessions_view(ui, db, actors):
    room, first, _second, _operator = actors
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    row = _sessions_row(ui.page, first.session_id)
    row.locator("details.role-controls summary").click()
    with ui.page.expect_response(
        lambda response: f"/v1/rooms/{room}/roles" in response.url and response.request.method == "POST"
    ) as response:
        row.get_by_role("button", name="Nadaj GitHub PM", exact=True).click()
    assert response.value.ok
    expect(
        _sessions_row(ui.page, first.session_id).locator(".role-badge").filter(has_text="GitHub PM")
    ).to_have_count(1)
    rows = db.execute("SELECT session_id FROM agent_chat.room_roles WHERE role = 'github_pm'").fetchall()
    assert rows == [{"session_id": first.session_id}]


def test_a_role_conflict_shows_the_safe_code_and_explanation(ui, db, actors):
    room, first, _second, operator = actors
    roles.assign(db, operator, room, "pm", first.session_id)
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    row = _sessions_row(ui.page, first.session_id)
    row.locator("details.role-controls summary").click()
    with ui.page.expect_response(
        lambda response: "/roles" in response.url and response.request.method == "POST"
    ) as response:
        row.get_by_role("button", name="Nadaj GitHub PM", exact=True).click()
    assert response.value.status == 409
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    expect(ui.page.locator("#notice")).to_contain_text("ROLE_CONFLICT")
    expect(ui.page.locator("#notice")).to_contain_text("inną rolę")
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()
    assert roles.current(db, room, "github_pm") is None


def test_a_viewer_sees_no_role_controls(ui, db, actors, make_viewer):
    room, _first, _second, _operator = actors
    viewer = make_viewer(room)
    ui.login(viewer.token)
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    expect(ui.page.locator("#sessions-table button.role-session")).to_have_count(0)


def test_the_sessions_filter_is_client_side(ui, actors):
    _room, first, second, _operator = actors
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    ui.page.locator("#sessions-filter").fill(str(first.session_id)[:8])
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()
    expect(_sessions_row(ui.page, second.session_id)).to_be_hidden()


def test_the_sessions_view_loads_the_next_bounded_page(ui, db, actors, actor_factory):
    room, first, second, _ = actors
    extra = [actor_factory(room) for _ in range(99)]
    last = max([first, second, *extra], key=lambda actor: actor.session_id)
    marker = "pagination-marker"
    db.execute("UPDATE agent_chat.sessions SET title = %s WHERE id = %s", (marker, last.session_id))
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")
    expect(_sessions_row(ui.page, last.session_id)).to_have_count(0)
    ui.page.get_by_role("button", name="Kolejne sesje", exact=True).click()
    expect(ui.page.locator("#more-sessions")).to_be_hidden()
    expect(_sessions_row(ui.page, last.session_id)).to_have_count(1)
    ui.page.locator("#sessions-filter").fill(marker)
    expect(_sessions_row(ui.page, last.session_id)).to_be_visible()


def test_a_stale_sessions_page_cannot_replace_the_current_snapshot(ui, db, actors, actor_factory):
    room, first, second, _ = actors
    extra = [actor_factory(room) for _ in range(199)]
    last = max([first, second, *extra], key=lambda actor: actor.session_id)
    marker = "pagination-stale-marker"
    db.execute("UPDATE agent_chat.sessions SET title = %s WHERE id = %s", (marker, last.session_id))
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")
    more = ui.page.get_by_role("button", name="Kolejne sesje", exact=True)
    more.click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 200 sesji")

    held = []
    holding = [True]

    def transport(route):
        if holding[0] and "after_session=" in route.request.url:
            holding[0] = False
            held.append((route, route.fetch()))
            return
        route.continue_()

    ui.page.route("**/v1/rooms/*/participants?*", transport)
    more.click()
    wait_held(ui.page, held)
    ui.page.get_by_role("button", name="Rozmowy", exact=True).click()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")

    release(held[0])
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")
    expect(ui.page.locator("#sessions-table tbody tr[data-session-id]")).to_have_count(100)
    expect(_sessions_row(ui.page, last.session_id)).to_have_count(0)
    expect(more).to_be_visible()

    more.click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 200 sesji")
    more.click()
    expect(_sessions_row(ui.page, last.session_id)).to_have_count(1)


def test_a_stale_sessions_page_failure_does_not_clear_the_current_snapshot(ui, db, actors, actor_factory):
    room, first, second, _ = actors
    extra = [actor_factory(room) for _ in range(199)]
    last = max([first, second, *extra], key=lambda actor: actor.session_id)
    ui.login()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")
    more = ui.page.get_by_role("button", name="Kolejne sesje", exact=True)
    more.click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 200 sesji")

    held = []
    holding = [True]

    def transport(route):
        if holding[0] and "after_session=" in route.request.url:
            holding[0] = False
            held.append((route, route.fetch()))
            return
        route.continue_()

    ui.page.route("**/v1/rooms/*/participants?*", transport)
    more.click()
    wait_held(ui.page, held)
    ui.page.get_by_role("button", name="Rozmowy", exact=True).click()
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")

    route, _response = held[0]
    route.fulfill(
        status=500,
        content_type="application/json",
        body='{"error":{"code":"SERVICE_UNAVAILABLE","message":"SERVICE_UNAVAILABLE"}}',
    )
    expect(ui.page.locator("#viewer")).to_be_visible()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 100 sesji")
    expect(ui.page.locator("#sessions-table tbody tr[data-session-id]")).to_have_count(100)
    expect(_sessions_row(ui.page, last.session_id)).to_have_count(0)

    more.click()
    expect(ui.page.locator("#sessions-note")).to_contain_text("Wczytano 200 sesji")


def test_the_sessions_view_fills_after_a_live_refresh_that_held_it(ui, actors):
    _room, first, _second, _operator = actors
    ui.login()
    held = hold_response(ui.page, "**/v1/browser/session", first=True)
    ui.page.locator("#live-toggle").click()
    wait_held(ui.page, held)
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    # The first visit is deferred while the refresh owns the read; the table fills once it settles.
    expect(ui.page.locator("#sessions-table tbody tr[data-session-id]")).to_have_count(0)
    release(held[0])
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()


def test_the_sessions_view_fills_after_a_transient_live_refresh_failure(ui, actors):
    _room, first, _second, _operator = actors
    ui.login()
    held = []
    def transport(route):
        if held:
            route.continue_()
        else:
            held.append(route)
    ui.page.route("**/v1/browser/session", transport)
    ui.page.locator("#live-toggle").click()
    deadline = time.monotonic() + 5
    while not held:
        assert time.monotonic() < deadline, "no live refresh request was held"
        ui.page.wait_for_timeout(10)
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    held[0].fulfill(status=500, body="{}", content_type="application/json")
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()


def test_the_sessions_view_fills_after_live_events_are_disabled_while_held(ui, actors):
    _room, first, _second, _operator = actors
    ui.login()
    held = hold_response(ui.page, "**/v1/browser/session", first=True)
    ui.page.locator("#live-toggle").click()
    wait_held(ui.page, held)
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    # Disabling aborts the held read; the deferred sessions request must outlive that cancellation.
    ui.page.locator("#live-toggle").click()
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()


def test_a_stale_sessions_response_cannot_paint_after_scope_invalidation(ui, actors):
    _room, first, _second, _operator = actors
    ui.login()
    events = []

    def hold_events(route):
        events.append(route)

    # Keep the stream pending so the session reads finish first; the scope-change frame is released on demand.
    ui.page.route("**/v1/events*", hold_events)
    ui.page.locator("#live-toggle").click()
    deadline = time.monotonic() + 5
    while not events:
        assert time.monotonic() < deadline, "the live refresh never opened the event stream"
        ui.page.wait_for_timeout(10)
    held = hold_response(ui.page, "**/v1/rooms/*/participants?limit=100")
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    wait_held(ui.page, held)
    events[0].fulfill(
        status=200,
        content_type="text/event-stream",
        body='data: {"error":{"code":"ROOM_SCOPE_CHANGED"}}\n\n',
    )
    expect(ui.page.locator("#live-status")).to_contain_text("Wymagana resynchronizacja")
    # Releasing the stale read must not repaint; its settlement starts the deferred fresh read.
    release(held[0])
    deadline = time.monotonic() + 5
    while len(held) < 2:
        assert time.monotonic() < deadline, "the scope invalidation did not request a fresh sessions read"
        ui.page.wait_for_timeout(10)
    assert ui.page.locator("#sessions-table tbody tr[data-session-id]").count() == 0
    release(held[1])
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()


@pytest.mark.parametrize("status", [500, 429])
def test_a_failing_sessions_read_does_not_retry_without_an_explicit_refresh(ui, actors, status):
    _room, first, _second, _operator = actors
    ui.login()
    calls = []

    def failing(route):
        calls.append(route.request.url)
        route.fulfill(status=status, body="{}", content_type="application/json")

    pattern = "**/v1/rooms/*/participants?limit=100"
    ui.page.route(pattern, failing)
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    deadline = time.monotonic() + 5
    while not calls:
        assert time.monotonic() < deadline, "the sessions read was never attempted"
        ui.page.wait_for_timeout(10)
    expected = "Zbyt wiele żądań" if status == 429 else "Nie udało się odczytać danych"
    expect(ui.page.locator("#notice")).to_contain_text(expected)
    count = len(calls)
    ui.page.wait_for_timeout(1000)
    assert len(calls) == count, "a failed read retried itself"
    ui.page.unroute(pattern)
    ui.page.locator("#refresh").click()
    expect(_sessions_row(ui.page, first.session_id)).to_be_visible()


def test_the_conversation_position_survives_the_sessions_tab(ui, db, credentials, actors):
    for index in range(40):
        stored(db, credentials, f"position message {index}")
    ui.login()
    ui.page.locator("#messages").evaluate("(node) => { node.scrollTop = 80; }")
    position = ui.page.locator("#messages").evaluate("(node) => node.scrollTop")
    assert position > 0
    ui.page.get_by_role("button", name="Sesje", exact=True).click()
    ui.page.get_by_role("button", name="Rozmowy", exact=True).click()
    assert ui.page.locator("#messages").evaluate("(node) => node.scrollTop") == position


def test_the_mobile_document_position_survives_the_sessions_tab(ui, db, credentials, actors):
    for index in range(60):
        stored(db, credentials, f"mobile position message {index:02}")
    ui.page.set_viewport_size({"width": 390, "height": 844})
    ui.page.reload()
    ui.login()
    ui.page.evaluate("window.scrollTo(0, 900)")
    position = ui.page.evaluate("window.scrollY")
    assert position > 0
    # Dispatch the click: a normal click first scrolls the tab into view and would move the document.
    ui.page.locator("#tab-sessions").evaluate("el => el.click()")
    expect(ui.page.locator("#sessions-view")).to_be_visible()
    # The short view really does clamp the document; otherwise the restore below would prove nothing.
    assert ui.page.evaluate("window.scrollY") < position
    ui.page.locator("#tab-chat").evaluate("el => el.click()")
    expect(ui.page.locator("#chat-view")).to_be_visible()
    assert ui.page.evaluate("window.scrollY") == position
