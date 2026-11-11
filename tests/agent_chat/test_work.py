"""the per-instance work declaration and the roster activity/PR fields."""

from __future__ import annotations

import secrets
from hashlib import sha256
from typing import Any
from uuid import uuid4

import pytest

from agent_chat import feed, rooms
from agent_chat.models import LEASE_SECONDS, Publication
from agent_chat.publication import publish


def _instance(http_api: Any, credentials: Any, name: str) -> str:
    token = secrets.token_hex(32)
    status, _binding = http_api(
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
    return token


def _declare(http_api: Any, token: str, repositories: Any) -> tuple[int, dict[str, Any]]:
    return http_api("POST", "/v1/instance/work", {"repositories": repositories}, token)


def test_a_live_instance_declares_both_forges(http_api: Any, credentials: Any) -> None:
    token = _instance(http_api, credentials, "worker-declares")
    repositories = {"forgejo": ["owner/project"], "github": ["owner/project"]}
    status, body = _declare(http_api, token, repositories)
    assert status == 200 and body["repositories"] == repositories
    status, own = http_api("GET", "/v1/instance/status", token=token)
    assert status == 200 and own["repositories"] == repositories
    status, page = http_api("GET", f"/v1/rooms/{credentials.room}/participants?limit=100", token=token)
    assert status == 200
    row = next(item for item in page["participants"] if item["session_id"] == own["session_id"])
    assert row["repositories"] == repositories


def test_a_declaration_replaces_the_previous_one(http_api: Any, credentials: Any) -> None:
    token = _instance(http_api, credentials, "worker-replaces")
    assert _declare(http_api, token, {"forgejo": ["owner/project"]})[0] == 200
    status, body = _declare(http_api, token, {"github": ["owner/project"]})
    assert status == 200 and body["repositories"] == {"github": ["owner/project"]}
    status, own = http_api("GET", "/v1/instance/status", token=token)
    assert own["repositories"] == {"github": ["owner/project"]}


def test_an_empty_map_clears_the_declaration(http_api: Any, credentials: Any) -> None:
    token = _instance(http_api, credentials, "worker-clears")
    assert _declare(http_api, token, {"forgejo": ["owner/project"]})[0] == 200
    status, body = _declare(http_api, token, {})
    assert status == 200 and body["repositories"] == {}
    assert http_api("GET", "/v1/instance/status", token=token)[1]["repositories"] == {}


def test_a_new_instance_starts_empty(http_api: Any, credentials: Any) -> None:
    first = _instance(http_api, credentials, "worker-first")
    assert _declare(http_api, first, {"forgejo": ["owner/project"]})[0] == 200
    second = _instance(http_api, credentials, "worker-second")
    assert http_api("GET", "/v1/instance/status", token=second)[1]["repositories"] == {}


def test_an_offline_instance_reports_no_work(http_api: Any, db: Any, credentials: Any) -> None:
    token = _instance(http_api, credentials, "worker-offline")
    repositories = {"forgejo": ["owner/project"]}
    assert _declare(http_api, token, repositories)[0] == 200
    status, own = http_api("GET", "/v1/instance/status", token=token)
    assert status == 200 and own["repositories"] == repositories
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - make_interval(secs => %s)"
        " WHERE session_id = %s",
        (LEASE_SECONDS + 1, own["session_id"]),
    )
    status, page = http_api(
        "GET", f"/v1/rooms/{credentials.room}/participants?limit=100", token=credentials.operator
    )
    assert status == 200
    row = next(item for item in page["participants"] if item["session_id"] == own["session_id"])
    assert row["online"] is False
    assert row["repositories"] == {}


def test_an_ended_instance_reports_no_work(http_api: Any, credentials: Any) -> None:
    token = _instance(http_api, credentials, "worker-ended")
    assert _declare(http_api, token, {"forgejo": ["owner/project"]})[0] == 200
    status, own = http_api("GET", "/v1/instance/status", token=token)
    assert status == 200
    status, _body = http_api("POST", "/v1/instance/end", {}, token)
    assert status == 200
    status, page = http_api(
        "GET", f"/v1/rooms/{credentials.room}/participants?limit=100", token=credentials.operator
    )
    assert status == 200
    row = next(item for item in page["participants"] if item["session_id"] == own["session_id"])
    assert row["online"] is False
    assert row["repositories"] == {}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"repositories": None},
        {"repositories": {"gitlab": ["owner/repo"]}},
        {"repositories": {"forgejo": ["not-a-repository"]}},
        {"repositories": {"forgejo": ["owner/repo#1"]}},
        {"repositories": {"forgejo": ["owner/repo"] * 17}},
        {"repositories": {"forgejo": ["owner/repo"] * 16, "github": ["owner/repo"] * 17}},
    ],
    ids=["missing", "null", "unknown-forge", "no-slash", "ref-in-name", "17-in-one-forge", "33-total"],
)
def test_an_invalid_declaration_is_refused(http_api: Any, credentials: Any, payload: dict[str, Any]) -> None:
    token = _instance(http_api, credentials, "worker-invalid")
    status, body = http_api("POST", "/v1/instance/work", payload, token)
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")
    assert http_api("GET", "/v1/instance/status", token=token)[1]["repositories"] == {}


def test_registration_does_not_accept_work(http_api: Any, credentials: Any) -> None:
    token = secrets.token_hex(32)
    payload = {
        "native_session_id": "worker-at-registration",
        "boot_id": str(uuid4()),
        "instance_token_hash": sha256(token.encode()).hexdigest(),
        "repositories": {"forgejo": ["owner/project"]},
    }
    status, body = http_api("POST", "/v1/sessions", payload, credentials.agent)
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")


def test_roster_activity_and_announced_prs(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    root = feed.message_view(
        publish(
            db,
            first,
            room,
            uuid4(),
            Publication(kind="message", body="announce", ref_key="pr:owner/project#7"),
        )
    )
    publish(db, second, room, uuid4(), Publication(kind="message", body="join", thread_id=root["thread_id"]))
    publish(db, second, room, uuid4(), Publication(kind="message", body="unrelated"))

    page = rooms.participants(db, operator, room)
    rows = {row["session_id"]: row for row in page["participants"]}
    mine, theirs = rows[first.session_id], rows[second.session_id]
    assert mine["announced_prs"] == [
        {
            "ref_key": "pr:owner/project#7",
            "repository": "owner/project",
            "number": 7,
            "created_at": mine["announced_prs"][0]["created_at"],
        }
    ]
    assert theirs["announced_prs"] == []
    assert mine["messages_24h"] == 1 and theirs["messages_24h"] == 2
    assert mine["last_published_at"] is not None and theirs["last_published_at"] is not None
    assert set(mine) >= {"repositories", "last_published_at", "messages_24h", "announced_prs"}
    assert page["roles"]["pm"] is None


def test_a_reply_in_a_pr_thread_does_not_announce_it(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, second, operator = actors
    root = feed.message_view(
        publish(db, first, room, uuid4(), Publication(kind="message", body="announce", ref_key="pr:owner/repo#9"))
    )
    feed.message_view(
        publish(
            db, second, room, uuid4(), Publication(kind="message", body="reply", thread_id=root["thread_id"])
        )
    )
    rows = {row["session_id"]: row for row in rooms.participants(db, operator, room)["participants"]}
    assert rows[first.session_id]["announced_prs"][0]["number"] == 9
    assert rows[second.session_id]["announced_prs"] == []


def test_announced_prs_are_capped_at_twenty(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, _second, operator = actors
    for number in range(1, 22):
        feed.message_view(
            publish(
                db, first, room, uuid4(), Publication(kind="message", body="p", ref_key=f"pr:owner/repo#{number}")
            )
        )
    row = next(
        item
        for item in rooms.participants(db, operator, room)["participants"]
        if item["session_id"] == first.session_id
    )
    assert len(row["announced_prs"]) == 20
    assert row["announced_prs"][0]["number"] == 21
