import asyncio
import json

import pytest

from agent_chat.http_boundary import RequestBoundary


@pytest.mark.parametrize("disconnect", [False, True])
def test_incomplete_request_never_reaches_application(disconnect):
    async def exercise():
        events = asyncio.Queue()
        events.put_nowait({"type": "http.request", "body": b'{"partial":', "more_body": True})
        if disconnect:
            events.put_nowait({"type": "http.disconnect"})
        sent = []

        async def unexpected_app(_scope, _receive, _send):
            pytest.fail("incomplete request reached mutation handler")

        async def send(message):
            sent.append(message)

        async with asyncio.timeout(8):
            await RequestBoundary(unexpected_app)(
                {"type": "http", "headers": [], "method": "POST", "path": "/v1/sessions", "query_string": b""},
                events.get,
                send,
            )
        if disconnect:
            assert sent == []
        else:
            assert sent[0]["status"] == 408
            assert json.loads(sent[1]["body"])["error"]["code"] == "REQUEST_TIMEOUT"

    asyncio.run(exercise())


ORIGIN = "https://chat.test"
ROOM = "/v1/rooms/00000000-0000-4000-8000-000000000001"


def cross(*, method="GET", path="/v1/events", query=b"", headers=(), body=b""):
    """Drive one request through the real boundary; report the response and whether the application saw it."""
    sent = []
    reached = []

    async def application(_scope, _receive, send):
        reached.append(True)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": query,
        "headers": [(name.encode(), value.encode()) for name, value in headers],
    }
    asyncio.run(RequestBoundary(application, ORIGIN)(scope, receive, send))
    code = json.loads(sent[1]["body"])["error"]["code"] if sent[0]["status"] != 200 else None
    return sent[0]["status"], code, bool(reached)


def refused(response, status, code):
    assert response == (status, code, False)


def test_boundary_passes_a_clean_request_so_the_refusals_below_can_fail():
    assert cross() == (200, None, True)
    assert cross(query=b"after=1") == (200, None, True)


def test_get_with_a_body_is_refused_before_the_application():
    refused(cross(body=b"{}"), 422, "INVALID_REQUEST")
    refused(cross(method="HEAD", body=b"x"), 422, "INVALID_REQUEST")


@pytest.mark.parametrize("name", ["cookie", "authorization", "last-event-id"])
def test_a_duplicated_credential_or_cursor_header_is_refused(name):
    refused(cross(headers=[(name, "a"), (name, "b")]), 401, "UNAUTHENTICATED")
    assert cross(headers=[(name, "a")])[2] is True


def test_query_string_is_bounded_in_bytes_and_in_fields():
    exact = b"after=" + b"1" * (4096 - len(b"after="))
    assert cross(query=exact) == (200, None, True)
    refused(cross(query=exact + b"1"), 422, "INVALID_REQUEST")
    four = b"after=1&before=2&limit=3&thread_id=4"
    assert cross(path=ROOM + "/history", query=four) == (200, None, True)
    refused(cross(path=ROOM + "/history", query=four + b"&extra=5"), 422, "INVALID_REQUEST")


@pytest.mark.parametrize(
    "path,query,allowed",
    [
        ("/v1/events", b"after=1", True),
        ("/v1/events", b"after=1&limit=5", False),
        ("/v1/events", b"after=1&after=2", False),
        (ROOM + "/participants", b"after_session=00000000-0000-4000-8000-000000000002&limit=5", True),
        (ROOM + "/participants", b"online=true&limit=5", True),
        (ROOM + "/participants", b"online=true&online=false", False),
        (ROOM + "/history", b"online=true", False),
        (ROOM + "/participants", b"after=1", False),
        (ROOM + "/participants", b"limit=1&limit=2", False),
        (ROOM + "/participants", b"thread_id=1", False),
        (ROOM + "/history", b"after_session=1", False),
    ],
)
def test_each_route_accepts_only_its_own_query_names(path, query, allowed):
    response = cross(path=path, query=query)
    assert response == ((200, None, True) if allowed else (422, "INVALID_REQUEST", False))


def test_a_query_string_is_refused_on_a_mutation():
    refused(
        cross(method="POST", path="/v1/events", query=b"after=1", headers=[("origin", ORIGIN)]), 422, "INVALID_REQUEST"
    )
