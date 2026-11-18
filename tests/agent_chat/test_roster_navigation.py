"""The agent-oriented roster: activity order, filters, last_seen_at, recent_refs and field projection."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from agent_chat import rooms, sessions
from agent_chat.models import ChatError, Publication, RoomCreation
from agent_chat.publication import publish

# Pinned literally: the default response must stay what it was before the roster gained these parameters.
DEFAULT_ENVELOPE = ["participants", "next_session_id", "roles", "pm"]
DEFAULT_ROW = [
    "session_id", "label", "title", "host", "harness", "native_session_id", "muted", "instance_id", "heartbeat_at",
    "online", "native_state", "stopped", "plan_mode", "lane", "lane_since", "lane_age_seconds", "repositories",
    "last_published_at", "messages_24h", "announced_prs",
]
NEW_ROW_KEYS = {"last_seen_at", "recent_refs"}
PR = "pr:owner/project#7"


def _clock(db: Any) -> datetime:
    return db.execute("SELECT clock_timestamp() AS now").fetchone()["now"]


def _say(db: Any, actor: Any, room: Any, key: str | None = None, *, at: datetime | None = None, **fields: Any) -> Any:
    """Publish one message; `at` pins its creation time, so an ordering test never depends on insertion timing."""
    message = publish(db, actor, room, uuid4(), Publication(kind="message", body="synthetic", ref_key=key, **fields))
    if at is not None:
        db.execute("UPDATE agent_chat.messages SET created_at = %s WHERE id = %s", (at, message["id"]))
    return message


def _beat(db: Any, actor: Any, at: datetime) -> None:
    db.execute("UPDATE agent_chat.instances SET heartbeat_at = %s WHERE id = %s", (at, actor.instance_id))


def _profile(db: Any, actor: Any, *, harness: str | None = None, host: str | None = None,
             label: str | None = None, title: str | None = None) -> None:
    db.execute(
        "UPDATE agent_chat.principals SET harness = COALESCE(%s, harness), host = COALESCE(%s, host) WHERE id = %s",
        (harness, host, actor.principal_id),
    )
    db.execute(
        "UPDATE agent_chat.sessions SET label = COALESCE(%s, label), title = COALESCE(%s, title) WHERE id = %s",
        (label, title, actor.session_id),
    )


def _second_room(db: Any, operator: Any, *members: Any) -> Any:
    other = rooms.create(db, operator, RoomCreation(slug="other", label="Other"))["id"]
    for member in members:
        db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (member.principal_id, other))
        db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (other, member.session_id))
    return other


def _ids(page: dict[str, Any]) -> list[Any]:
    return [row["session_id"] for row in page["participants"]]


def test_the_default_roster_is_exactly_what_it_was(db: Any, actors: Any) -> None:
    room, first, second, operator = actors
    _say(db, first, room, PR)
    for page in (
        rooms.participants(db, operator, room),
        rooms.participants(db, operator, room, sort="session"),
        rooms.participants(db, operator, room, sort="session", fields=None),
    ):
        assert list(page) == DEFAULT_ENVELOPE
        assert len(page["participants"]) == 2
        assert all(list(row) == DEFAULT_ROW for row in page["participants"])
        assert sorted(_ids(page)) == _ids(page) == sorted([first.session_id, second.session_id])


def test_the_default_roster_over_http_is_exactly_what_it_was(
    http_api: Any, db: Any, credentials: Any, actors: Any
) -> None:
    for query in ("", "?sort=session", "?online=false&limit=100"):
        status, body = http_api("GET", f"/v1/rooms/{credentials.room}/participants{query}", token=credentials.operator)
        assert status == 200
        assert list(body) == DEFAULT_ENVELOPE
        assert body["participants"] and all(list(row) == DEFAULT_ROW for row in body["participants"])


def test_every_default_key_is_a_projectable_field(db: Any, actors: Any) -> None:
    room, first, _second, operator = actors
    _say(db, first, room, PR)
    assert set(DEFAULT_ROW) | NEW_ROW_KEYS == set(rooms.ROSTER_FIELDS)
    default = rooms.participants(db, operator, room)["participants"]
    projected = rooms.participants(db, operator, room, fields=",".join(DEFAULT_ROW))["participants"]
    assert projected == default


def test_new_row_keys_appear_only_when_named(db: Any, actors: Any) -> None:
    room, first, _second, operator = actors
    _say(db, first, room, PR)
    for query in ({}, {"sort": "activity"}, {"fields": ",".join(DEFAULT_ROW)}):
        page = rooms.participants(db, operator, room, **query)
        assert all(not NEW_ROW_KEYS & set(row) for row in page["participants"]), query
    seen = rooms.participants(db, operator, room, fields="last_seen_at")["participants"]
    assert all(list(row) == ["last_seen_at"] and row["last_seen_at"] is not None for row in seen)
    refs = rooms.participants(db, operator, room, fields="recent_refs")["participants"]
    assert all(list(row) == ["recent_refs"] for row in refs)
    assert sorted(len(row["recent_refs"]) for row in refs) == [0, 1]
    both = rooms.participants(db, operator, room, fields="recent_refs,last_seen_at,label")["participants"]
    assert all(list(row) == ["recent_refs", "last_seen_at", "label"] for row in both)


@pytest.mark.parametrize("name,values", [("harness", ("claude", "codex", "pi")), ("host", ("alpha", "beta", "gamma"))])
def test_an_exact_filter_applies_before_paging(
    db: Any, actors: Any, actor_factory: Any, name: str, values: tuple[str, str, str]
) -> None:
    room, first, second, operator = actors
    third = actor_factory(room)
    # The match is the session with the highest id, so a filter applied after paging would return another one.
    ordered = sorted((first, second, third), key=lambda actor: actor.session_id)
    for actor, value in zip(ordered, values, strict=True):
        _profile(db, actor, **{name: value})
    match = ordered[-1]
    for limit in (1, 2, 100):
        page = rooms.participants(db, operator, room, limit=limit, **{name: values[-1]})
        assert _ids(page) == [match.session_id] and page["next_session_id"] is None
    assert _ids(rooms.participants(db, operator, room, **{name: values[-1].upper()})) == []
    assert _ids(rooms.participants(db, operator, room, **{name: "nowhere"})) == []
    # It also pages by session id: the next page continues among the matches only.
    for actor in ordered:
        _profile(db, actor, **{name: values[0]})
    page = rooms.participants(db, operator, room, limit=2, **{name: values[0]})
    assert _ids(page) == [actor.session_id for actor in ordered[:2]]
    rest = rooms.participants(db, operator, room, after=page["next_session_id"], **{name: values[0]})
    assert _ids(rest) == [ordered[2].session_id]


def test_the_repository_filter_matches_a_live_declaration_on_either_forge(
    db: Any, actors: Any, actor_factory: Any
) -> None:
    room, forgejo, github, operator = actors
    other, offline = actor_factory(room), actor_factory(room)
    now = _clock(db)
    for actor, work in (
        (forgejo, {"forgejo": ["owner/project"]}),
        (github, {"github": ["owner/project", "owner/more"]}),
        (other, {"forgejo": ["owner/other"], "github": ["third/project"]}),
        (offline, {"forgejo": ["owner/project"]}),
    ):
        db.execute("UPDATE agent_chat.instances SET repositories = %s WHERE id = %s", (Jsonb(work), actor.instance_id))
    _beat(db, offline, now - timedelta(seconds=1000))
    assert set(_ids(rooms.participants(db, operator, room, repository="owner/project"))) == {
        forgejo.session_id, github.session_id,
    }
    assert _ids(rooms.participants(db, operator, room, repository="owner/other")) == [other.session_id]
    assert _ids(rooms.participants(db, operator, room, repository="third/project")) == [other.session_id]
    assert _ids(rooms.participants(db, operator, room, repository="owner/missing")) == []
    # The offline row reports no work, so it must not match a filter it cannot show.
    everyone = rooms.participants(db, operator, room)["participants"]
    assert next(row for row in everyone if row["session_id"] == offline.session_id)["repositories"] == {}
    # The filter runs before paging: one row per page, only matches, and a continuation.
    page = rooms.participants(db, operator, room, repository="owner/project", limit=1)
    assert len(page["participants"]) == 1 and page["next_session_id"] == _ids(page)[0]


def test_the_ref_filter_keeps_sessions_that_published_into_the_thread(
    db: Any, actors: Any, actor_factory: Any
) -> None:
    room, root_sender, replier, operator = actors
    expired, redacted, elsewhere, silent = (actor_factory(room) for _ in range(4))
    root = _say(db, root_sender, room, PR)
    _say(db, replier, room, thread_id=root["thread_id"])
    gone = _say(db, expired, room, PR)
    db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second' WHERE id = %s",
               (gone["id"],))
    tombstone = _say(db, redacted, room, PR)
    db.execute("UPDATE agent_chat.messages SET body = NULL WHERE id = %s", (tombstone["id"],))
    _say(db, elsewhere, room, "pr:owner/project#8")
    assert set(_ids(rooms.participants(db, operator, room, ref=PR))) == {root_sender.session_id, replier.session_id}
    assert set(_ids(rooms.participants(db, operator, room, ref="pr:owner/project#8"))) == {elsewhere.session_id}
    assert _ids(rooms.participants(db, operator, room, ref="pr:owner/project#9")) == []
    assert silent.session_id not in _ids(rooms.participants(db, operator, room, ref=PR))


def test_ref_filter_recent_refs_and_last_seen_read_this_room_only(db: Any, actors: Any) -> None:
    room, first, second, operator = actors
    other = _second_room(db, operator, first, second)
    now = _clock(db)
    _beat(db, first, now - timedelta(seconds=30))
    _say(db, first, room, "pr:owner/home#1", at=now - timedelta(seconds=20))
    _say(db, first, other, "pr:owner/away#9", at=now - timedelta(seconds=2))
    _say(db, second, other, "pr:owner/away#9", at=now - timedelta(seconds=3))
    # The same key names a different thread in each room: a publication in the other room is not a publication here.
    assert _ids(rooms.participants(db, operator, room, ref="pr:owner/away#9")) == []
    assert _ids(rooms.participants(db, operator, room, ref="pr:owner/home#1")) == [first.session_id]
    assert set(_ids(rooms.participants(db, operator, other, ref="pr:owner/away#9"))) == {
        first.session_id, second.session_id,
    }
    assert _ids(rooms.participants(db, operator, other, ref="pr:owner/home#1")) == []
    for where, expected in ((room, ["pr:owner/home#1"]), (other, ["pr:owner/away#9"])):
        rows = {
            row["session_id"]: row
            for row in rooms.participants(db, operator, where, fields="session_id,recent_refs")["participants"]
        }
        assert [entry["ref_key"] for entry in rows[first.session_id]["recent_refs"]] == expected
    # `last_seen_at` is the room's publication or the heartbeat, never a publication in another room.
    row = next(
        row
        for row in rooms.participants(db, operator, room, fields="session_id,last_seen_at")["participants"]
        if row["session_id"] == first.session_id
    )
    assert row["last_seen_at"] == now - timedelta(seconds=20)


def test_q_is_a_case_insensitive_literal_substring_of_label_or_title(
    db: Any, actors: Any, actor_factory: Any
) -> None:
    room, by_title, by_label, operator = actors
    special, plain = actor_factory(room), actor_factory(room)
    _profile(db, by_title, label="agent-one", title="Reviewing a Privilege escalation")
    _profile(db, by_label, label="Alpha-Worker", title="Unrelated work")
    _profile(db, special, label="100%_done\\", title="x")
    _profile(db, plain, label="plain", title="plain")

    def found(text: str) -> set[Any]:
        return set(_ids(rooms.participants(db, operator, room, q=text)))

    assert found("privilege") == {by_title.session_id}
    assert found("PRIVILEGE ESC") == {by_title.session_id}
    assert found("alpha-worker") == {by_label.session_id}
    assert found("WORKER") == {by_label.session_id}
    assert found("work") == {by_label.session_id}
    assert found("agent-one") == {by_title.session_id}
    # The text is data, not a pattern: wildcards match themselves only, and a trailing backslash is harmless.
    assert found("%") == {special.session_id}
    assert found("_") == {special.session_id}
    assert found("\\") == {special.session_id}
    assert found("100%_done\\") == {special.session_id}
    assert found("a_b") == set() and found("p%e") == set()
    # A session with no title is still found by its label.
    db.execute("UPDATE agent_chat.sessions SET title = NULL WHERE id = %s", (plain.session_id,))
    assert found("PLAIN") == {plain.session_id}


def test_the_activity_order_is_live_first_then_last_seen_then_last_published_then_session_id(
    db: Any, actors: Any, actor_factory: Any
) -> None:
    room, live_recent_beat, live_old_beat, operator = actors
    live_old_post, offline_recent_post, published, quiet_a, quiet_b, offline_old = (
        actor_factory(room) for _ in range(6)
    )
    now = _clock(db)
    tie = now - timedelta(seconds=300)
    _beat(db, live_recent_beat, now - timedelta(seconds=5))
    _beat(db, live_old_beat, now - timedelta(seconds=40))
    # Publish first: a publication needs a live lease, and the heartbeats below lapse some of them.
    _say(db, live_old_post, room, at=now - timedelta(seconds=2))
    _say(db, offline_recent_post, room, at=now - timedelta(seconds=1))
    _say(db, published, room, at=tie)
    # A publication counts as being seen: this session's heartbeat is old, but it posted two seconds ago.
    _beat(db, live_old_post, now - timedelta(seconds=20))
    # Offline sessions rank below every live one, however recently they posted.
    _beat(db, offline_recent_post, now - timedelta(seconds=1000))
    # Same last_seen_at (`tie`): the one with a publication goes first, then session id.
    _beat(db, published, now - timedelta(seconds=600))
    _beat(db, quiet_a, tie)
    _beat(db, quiet_b, tie)
    _beat(db, offline_old, now - timedelta(seconds=500))
    expected = [
        live_old_post.session_id, live_recent_beat.session_id, live_old_beat.session_id,
        offline_recent_post.session_id,
        published.session_id,
        *sorted([quiet_a.session_id, quiet_b.session_id]),
        offline_old.session_id,
    ]
    page = rooms.participants(db, operator, room, sort="activity")
    assert _ids(page) == expected
    assert page["next_session_id"] is None
    assert [row["online"] for row in page["participants"]] == [True] * 3 + [False] * 5
    # The filters apply first: `online` leaves the live three, in the same order.
    assert _ids(rooms.participants(db, operator, room, sort="activity", online=True)) == expected[:3]
    # The default order is untouched by the new one.
    assert _ids(rooms.participants(db, operator, room)) == sorted(expected)


def test_the_activity_order_is_one_page_and_refuses_a_session_cursor(
    db: Any, actors: Any, actor_factory: Any
) -> None:
    room, first, _second, operator = actors
    actor_factory(room), actor_factory(room)
    page = rooms.participants(db, operator, room, sort="activity", limit=3)
    assert len(page["participants"]) == 3 and page["next_session_id"] is None
    assert len(rooms.participants(db, operator, room, sort="activity", limit=100)["participants"]) == 4
    for query in (
        {"sort": "activity", "after": first.session_id},
        {"sort": "newest"},
        {"sort": ""},
        {"sort": "Activity"},
        {"sort": "activity", "limit": 0},
        {"sort": "activity", "limit": 101},
    ):
        with pytest.raises(ChatError, match="^INVALID_REQUEST$"):
            rooms.participants(db, operator, room, **query)
    # A session cursor is still valid in the default order.
    assert rooms.participants(db, operator, room, sort="session", after=first.session_id)["participants"] is not None


def test_last_seen_at_is_the_later_of_the_heartbeat_and_a_publication_in_the_room(db: Any, actors: Any) -> None:
    room, first, second, operator = actors
    now = _clock(db)
    _beat(db, first, now - timedelta(seconds=50))
    _say(db, first, room, at=now - timedelta(seconds=10))
    _beat(db, second, now - timedelta(seconds=15))
    _say(db, second, room, at=now - timedelta(seconds=45))
    rows = {
        row["session_id"]: row["last_seen_at"]
        for row in rooms.participants(db, operator, room, fields="session_id,last_seen_at")["participants"]
    }
    assert rows == {first.session_id: now - timedelta(seconds=10), second.session_id: now - timedelta(seconds=15)}


def test_an_ended_session_keeps_a_last_seen_at(db: Any, actors: Any) -> None:
    room, first, second, operator = actors
    last_beat = _clock(db) - timedelta(seconds=77)
    _beat(db, first, last_beat)
    sessions.end(db, first)
    page = rooms.participants(db, operator, room, fields="session_id,online,heartbeat_at,last_seen_at")
    rows = {row["session_id"]: row for row in page["participants"]}
    ended = rows[first.session_id]
    # The row itself says nothing of the beat, which is the gap this field fills.
    assert ended["online"] is False and ended["heartbeat_at"] is None
    assert ended["last_seen_at"] == last_beat
    assert rows[second.session_id]["online"] is True
    # The activity order ranks it among the offline sessions, by that time.
    assert _ids(rooms.participants(db, operator, room, sort="activity")) == [second.session_id, first.session_id]


def test_recent_refs_lists_up_to_five_distinct_keys_newest_first(db: Any, actors: Any) -> None:
    room, first, second, operator = actors
    now = _clock(db).replace(microsecond=123000)
    lane = "lane:project::0123456789ab-0123"
    keys = [f"pr:owner/project#{number}" for number in range(1, 8)]
    for number, key in enumerate(keys, start=1):
        _say(db, first, room, key, at=now - timedelta(seconds=800 - 100 * number))
    # A key is listed once, at the time of the session's latest message in it.
    _say(db, first, room, keys[1], at=now - timedelta(seconds=50))
    _say(db, first, room, lane, at=now - timedelta(seconds=60))
    # A message in no keyed thread, and another session's message in a keyed one, add nothing.
    _say(db, first, room, at=now - timedelta(seconds=1))
    _say(db, second, room, keys[0], at=now - timedelta(seconds=2))
    # An expired message and a redacted one, which `history` shows no more than the ref filter does, add nothing
    # however recent they are.
    expired = _say(db, first, room, "pr:owner/project#8", at=now - timedelta(seconds=3))
    db.execute("UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 second' WHERE id = %s",
               (expired["id"],))
    redacted = _say(db, first, room, "pr:owner/project#9", at=now - timedelta(seconds=3))
    db.execute("UPDATE agent_chat.messages SET body = NULL WHERE id = %s", (redacted["id"],))
    page = rooms.participants(db, operator, room, fields="session_id,recent_refs")
    rows = {row["session_id"]: row["recent_refs"] for row in page["participants"]}
    assert [(entry["ref_key"], datetime.fromisoformat(entry["last_at"])) for entry in rows[first.session_id]] == [
        (key, now - timedelta(seconds=age))
        for key, age in (
            (keys[1], 50), (lane, 60), (keys[6], 100), (keys[5], 200), (keys[4], 300),
        )
    ]
    assert all(set(entry) == {"ref_key", "last_at"} for entry in rows[first.session_id])
    assert [entry["ref_key"] for entry in rows[second.session_id]] == [keys[0]]
    # The ref filter and recent_refs agree on what counts.
    assert set(_ids(rooms.participants(db, operator, room, ref=keys[0]))) == {first.session_id, second.session_id}
    assert _ids(rooms.participants(db, operator, room, ref="pr:owner/project#8")) == []
    assert _ids(rooms.participants(db, operator, room, ref="pr:owner/project#9")) == []


def test_fields_returns_only_the_named_keys_in_the_order_given(db: Any, actors: Any) -> None:
    room, _first, _second, operator = actors
    page = rooms.participants(db, operator, room, fields="title,session_id,online")
    assert list(page) == DEFAULT_ENVELOPE
    assert [list(row) for row in page["participants"]] == [["title", "session_id", "online"]] * 2
    # A repeated name is one key.
    assert [list(row) for row in rooms.participants(db, operator, room, fields="label,label")["participants"]] == [
        ["label"]
    ] * 2


@pytest.mark.parametrize(
    "fields",
    ["", ",", "label,", ",label", "label,,title", "nope", "label,nope", "Label", "label, title", " label",
     "label\n", "recent-refs", "last_seen", "announced_refs", "roles", "pm", "next_session_id"],
)
def test_fields_refuses_anything_that_is_not_a_row_key(db: Any, actors: Any, fields: str) -> None:
    room, _first, _second, operator = actors
    with pytest.raises(ChatError, match="^INVALID_REQUEST$"):
        rooms.participants(db, operator, room, fields=fields)


def test_projection_leaves_the_continuation_and_the_offline_blanking_alone(
    db: Any, actors: Any, actor_factory: Any
) -> None:
    room, first, second, operator = actors
    third = actor_factory(room)
    default = rooms.participants(db, operator, room, limit=1)
    narrow = rooms.participants(db, operator, room, limit=1, fields="label")
    assert narrow["participants"] == [{"label": default["participants"][0]["label"]}]
    assert narrow["next_session_id"] == default["next_session_id"] == _ids(default)[0]
    rest = rooms.participants(db, operator, room, after=narrow["next_session_id"], fields="session_id")
    assert [row["session_id"] for row in rest["participants"]] == sorted([first.session_id, second.session_id,
                                                                          third.session_id])[1:]
    # An offline row still reports no work and an unknown native state, even when only those keys are asked for.
    db.execute("UPDATE agent_chat.instances SET repositories = %s WHERE id = %s",
               (Jsonb({"forgejo": ["owner/project"]}), third.instance_id))
    _beat(db, third, _clock(db) - timedelta(seconds=1000))
    rows = rooms.participants(db, operator, room, fields="session_id,repositories,native_state,stopped,plan_mode")
    offline = next(row for row in rows["participants"] if row["session_id"] == third.session_id)
    assert offline == {
        "session_id": third.session_id, "repositories": {}, "native_state": "unknown", "stopped": True,
        "plan_mode": True,
    }


def test_the_new_parameters_work_together_over_http(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    room, first, _second, _operator = actors
    _profile(db, first, harness="claude", host="alpha", title="Reviewing the roster")
    _say(db, first, room, PR)
    query = urlencode({
        "online": "true", "sort": "activity", "limit": 5, "harness": "claude", "host": "alpha", "ref": PR,
        "q": "ROSTER", "fields": "session_id,title,harness,last_seen_at,recent_refs",
    })
    status, body = http_api("GET", f"/v1/rooms/{credentials.room}/participants?{query}", token=credentials.operator)
    assert status == 200
    assert body["next_session_id"] is None and list(body) == DEFAULT_ENVELOPE
    assert [list(row) for row in body["participants"]] == [
        ["session_id", "title", "harness", "last_seen_at", "recent_refs"]
    ]
    row = body["participants"][0]
    assert row["session_id"] == str(first.session_id) and row["harness"] == "claude"
    assert row["last_seen_at"] and [entry["ref_key"] for entry in row["recent_refs"]] == [PR]


@pytest.mark.parametrize(
    "query",
    [
        {"sort": "newest"},
        {"sort": "activity", "after_session": "00000000-0000-4000-8000-0000000000aa"},
        {"fields": "nope"},
        {"fields": ""},
        {"fields": "label,"},
        {"repository": "not-a-repository"},
        {"repository": "owner/repo#1"},
        {"ref": "not-a-ref"},
        {"ref": "pr:owner/repo"},
        {"q": ""},
        {"q": "\x00"},
        {"q": "a\x00b"},
        {"q": "tab\there"},
        {"q": "line\nbreak"},
        {"q": "x" * 129},
        {"harness": ""},
        {"harness": "\x00"},
        {"host": "\x1f"},
        {"host": "h" * 129},
    ],
    ids=lambda query: "-".join(f"{key}={str(value)[:12]!r}" for key, value in query.items()),
)
def test_an_invalid_roster_parameter_is_refused_not_a_server_error(
    http_api: Any, credentials: Any, actors: Any, query: dict[str, str]
) -> None:
    status, body = http_api(
        "GET", f"/v1/rooms/{credentials.room}/participants?{urlencode(query)}", token=credentials.operator
    )
    assert (status, body["error"]["code"]) == (422, "INVALID_REQUEST")


def test_a_text_filter_that_matches_nothing_is_an_empty_roster_not_an_error(
    http_api: Any, credentials: Any, actors: Any
) -> None:
    for query in ({"harness": "gemini"}, {"host": "nowhere"}, {"q": "%"}, {"q": "\\"}, {"q": "x" * 128}):
        status, body = http_api(
            "GET", f"/v1/rooms/{credentials.room}/participants?{urlencode(query)}", token=credentials.operator
        )
        assert (status, body["participants"], body["next_session_id"]) == (200, [], None), query


def test_a_roster_read_still_needs_the_room(http_api: Any, db: Any, credentials: Any, actors: Any) -> None:
    status, body = http_api(
        "GET",
        f"/v1/rooms/{uuid4()}/participants?{urlencode({'sort': 'activity', 'fields': 'label,recent_refs'})}",
        token=credentials.operator,
    )
    assert status == 403 and body["error"]["code"] == "ROOM_FORBIDDEN"
