"""Direct 1:1 threads (migration 008): their reply limit, loop detector and separate wake allowance."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest

from agent_chat import deliveries, sessions, storage
from agent_chat.models import (
    DIRECT_REPLY_LIMIT,
    DIRECT_WAKE_LIMIT,
    LOOP_REPLIES,
    LOOP_WINDOW_SECONDS,
    REPLY_LIMIT,
    WAKE_LIMIT,
    ChatError,
    DeliveryClaim,
    DeliveryResult,
    Heartbeat,
    Publication,
)
from agent_chat.publication import publish
from agent_chat.retention import prune
from agent_chat.storage import connect, migrate
from tests.agent_chat.conftest import seed_actor


@pytest.fixture
def delivery_enabled():
    return True


def send(db, actor, room, kind="question", recipients=(), **fields):
    return publish(
        db, actor, room, uuid4(), Publication(kind=kind, body=f"synthetic {kind}", recipients=recipients, **fields)
    )


def reply(db, actor, room, parent, **fields):
    """A reply; without recipients it goes to the parent's sender."""
    return send(db, actor, room, "reply", reply_to=parent["id"], **fields)


def age(db, thread, seconds):
    """Move every message and loop stamp of the thread `seconds` into the past, as if that much time had passed."""
    db.execute(
        "UPDATE agent_chat.messages SET created_at = created_at - make_interval(secs => %s) WHERE thread_id = %s",
        (seconds, thread),
    )
    db.execute(
        """UPDATE agent_chat.threads SET loop_stamps = ARRAY(
               SELECT stamp - make_interval(secs => %s)
               FROM unnest(loop_stamps) WITH ORDINALITY AS item(stamp, position) ORDER BY position)
           WHERE id = %s""",
        (seconds, thread),
    )


def converse(db, room, pair, parent, count, spacing):
    """`count` agent replies alternating between `pair`, each to the previous message, `spacing` seconds apart."""
    message = parent
    for index in range(count):
        message = reply(db, pair[index % 2], room, message)
        age(db, parent["thread_id"], spacing)
    return message


def replies(db, thread):
    return db.execute("SELECT agent_replies FROM agent_chat.threads WHERE id = %s", (thread,)).fetchone()[
        "agent_replies"
    ]


def stamps(db, thread):
    row = db.execute("SELECT loop_stamps FROM agent_chat.threads WHERE id = %s", (thread,)).fetchone()
    return row["loop_stamps"]


def members(db, thread):
    row = db.execute("SELECT participants FROM agent_chat.threads WHERE id = %s", (thread,)).fetchone()
    return row["participants"]


def is_complete(db, thread):
    row = db.execute("SELECT participants_complete FROM agent_chat.threads WHERE id = %s", (thread,)).fetchone()
    return row["participants_complete"]


def written(db):
    """Everything a publication or an admission writes; a refusal must leave all of it unchanged."""
    return db.execute(
        """SELECT (SELECT count(*) FROM agent_chat.messages) AS messages,
                  (SELECT count(*) FROM agent_chat.recipients) AS recipients,
                  (SELECT count(*) FROM agent_chat.requests) AS requests,
                  (SELECT count(*) FROM agent_chat.events) AS events,
                  (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM agent_chat.threads t) AS threads,
                  (SELECT count(*) FROM agent_chat.delivery_batches) AS batches,
                  (SELECT count(*) FROM agent_chat.recipients WHERE delivery_batch_id IS NOT NULL) AS batched,
                  (SELECT count(*) FROM agent_chat.delivery_attempts) AS attempts"""
    ).fetchone()


def refused(db, code, call):
    before = written(db)
    with pytest.raises(ChatError, match=f"^{code}$"):
        call()
    assert written(db) == before


def ready(db, actor):
    sessions.heartbeat(db, actor, Heartbeat(native_state="idle", stopped=False, plan_mode=False))


def claim(db, actor, *messages):
    return deliveries.claim(db, actor, uuid4(), DeliveryClaim(messages=messages))


def hand(db, actor, message):
    grant = claim(db, actor, message)
    assert grant["dispatch"] is True
    deliveries.result(db, actor, grant["attempt"]["id"], DeliveryResult(outcome="handed"))
    return grant


def allowance(db, attempt):
    return db.execute("SELECT allowance FROM agent_chat.delivery_attempts WHERE id = %s", (attempt["id"],)).fetchone()[
        "allowance"
    ]


def pending(db, actor):
    return deliveries.pending(db, actor)["messages"]


def expire(db, message):
    """Age the message and its events past retention, as test_retention does, so `prune` may collect it."""
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = %s",
        (message["id"],),
    )
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours' WHERE message_id = %s",
        (message["id"],),
    )


def collect(db):
    """Prune until nothing more is collectable: a pass removes the leaf tombstones, the next their parents."""
    while prune(db)["deleted"]:
        pass


def thread_class(db, thread):
    return deliveries.consultations(db, (thread,))[thread]


def database_at_007(client, monkeypatch):
    """A database one migration short of 008, with its room, three agent sessions and an operator."""
    with monkeypatch.context() as patch:
        patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:7])
        migrate(client)
    room_row = client.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'").fetchone()
    assert room_row is not None
    room = room_row["id"]
    return room, [seed_actor(client, room) for _ in range(3)], seed_actor(client, room, operator=True)


def test_the_limits_are_the_decided_numbers():
    assert (REPLY_LIMIT, WAKE_LIMIT, DIRECT_REPLY_LIMIT, DIRECT_WAKE_LIMIT) == (6, 20, 20, 60)
    assert (LOOP_REPLIES, LOOP_WINDOW_SECONDS) == (10, 120)


def test_008_upgrades_a_database_at_007_and_charges_earlier_admissions_to_other(database, monkeypatch):
    with connect(database) as client:
        room, (first, second, _), operator = database_at_007(client, monkeypatch)
        thread, root, note, batch = (uuid4() for _ in range(4))
        with client.transaction():
            client.execute(
                "INSERT INTO agent_chat.threads(id, room_id, root_message_id, agent_replies) VALUES (%s, %s, %s, 6)",
                (thread, room, root),
            )
            client.execute(
                """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, sender_session_id,
                       kind, body) VALUES (%s, %s, %s, %s, %s, 'question', 'written before 008')""",
                (root, room, thread, first.principal_id, first.session_id),
            )
            client.execute(
                "INSERT INTO agent_chat.recipients(message_id, session_id) VALUES (%s, %s)", (root, second.session_id)
            )
            client.execute(
                """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, kind, body)
                       VALUES (%s, %s, %s, %s, 'message', 'operator note before 008')""",
                (note, room, thread, operator.principal_id),
            )
        client.execute(
            "INSERT INTO agent_chat.delivery_batches VALUES (%s, %s, %s)", (batch, first.session_id, [root])
        )
        client.execute(
            """INSERT INTO agent_chat.delivery_attempts(id, batch_id, session_id, instance_id, request_key, ordinal,
                   admitted_at, expires_at, outcome, completed_at)
            VALUES (%s, %s, %s, %s, %s, 1, clock_timestamp(), clock_timestamp() + interval '30 seconds', 'handed',
                    clock_timestamp())""",
            (uuid4(), batch, first.session_id, first.instance_id, uuid4()),
        )
        migrate(client)
        migrate(client)
        assert client.execute("SELECT max(version) AS v FROM agent_chat.schema_migrations").fetchone() == {"v": 11}
        assert client.execute("SELECT allowance FROM agent_chat.delivery_attempts").fetchall() == [
            {"allowance": "other"}
        ]
        assert replies(client, thread) == 6
        # Its stored history names exactly two sessions, yet it is not direct: retention may already have removed a
        # third, so the thread keeps the lower limit, which its six replies have reached.
        assert thread_class(client, thread) == {"id": thread, "direct": False, "open": False}
        # Nothing is backfilled from the history, and the thread is marked incomplete.
        assert (is_complete(client, thread), members(client, thread), stamps(client, thread)) == (False, [], [])
        budget = deliveries.budget(client, first.session_id)
        assert (budget["used"], budget["remaining"]) == (1, WAKE_LIMIT - 1)
        assert (budget["direct"]["used"], budget["direct"]["remaining"]) == (0, DIRECT_WAKE_LIMIT)
        client.execute("UPDATE agent_chat.threads SET agent_replies = 20")
        with pytest.raises(psycopg.errors.CheckViolation):
            client.execute("UPDATE agent_chat.threads SET agent_replies = 21")
        with pytest.raises(psycopg.errors.CheckViolation):
            client.execute("UPDATE agent_chat.threads SET agent_replies = 0, loop_stamps = ARRAY[clock_timestamp()]")
        with pytest.raises(psycopg.errors.CheckViolation):
            client.execute("UPDATE agent_chat.delivery_attempts SET allowance = 'urgent'")


def test_a_thread_that_existed_at_migration_stays_on_the_lower_limits_for_its_life(database, monkeypatch):
    """Retention may have removed what named a legacy thread's sessions, so 008 never calls such a thread direct."""
    with connect(database) as client:
        room, (first, second, third), operator = database_at_007(client, monkeypatch)
        thread, root, answer = (uuid4() for _ in range(3))
        with client.transaction():
            client.execute(
                "INSERT INTO agent_chat.threads(id, room_id, root_message_id, agent_replies) VALUES (%s, %s, %s, %s)",
                (thread, room, root, REPLY_LIMIT),
            )
            client.execute(
                """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, sender_session_id,
                       kind, body) VALUES (%s, %s, %s, %s, %s, 'question', 'to two sessions, before 008')""",
                (root, room, thread, first.principal_id, first.session_id),
            )
            for addressed in (second, third):
                client.execute(
                    "INSERT INTO agent_chat.recipients(message_id, session_id) VALUES (%s, %s)",
                    (root, addressed.session_id),
                )
            client.execute(
                """INSERT INTO agent_chat.messages(id, room_id, thread_id, sender_principal_id, sender_session_id,
                       reply_to, kind, body) VALUES (%s, %s, %s, %s, %s, %s, 'reply', 'answer written before 008')""",
                (answer, room, thread, second.principal_id, second.session_id, root),
            )
        # The root expires. The answer keeps it as a tombstone, and retention collects its recipient rows, and with
        # them the only trace of the third session.
        client.execute(
            "UPDATE agent_chat.messages SET body = NULL, expires_at = clock_timestamp() - interval '1 hour' "
            "WHERE id = %s",
            (root,),
        )
        client.execute("DELETE FROM agent_chat.recipients WHERE message_id = %s", (root,))
        migrate(client)
        # What is left names two sessions, the root's sender and the answer's, which a backfill would have called
        # direct. The six replies are the lower limit, so the thread is closed, and publication refuses the next one
        # without storing anything.
        assert thread_class(client, thread) == {"id": thread, "direct": False, "open": False}
        assert (is_complete(client, thread), members(client, thread)) == (False, [])
        refused(client, "CONSULTATION_LIMIT", lambda: reply(client, first, room, {"id": answer}))
        # Sessions that take part from now on are recorded, and the thread is still not direct.
        send(client, first, room, "status", thread_id=thread, recipients=(second.session_id,))
        send(client, second, room, "status", thread_id=thread)
        assert sorted(members(client, thread)) == sorted((first.session_id, second.session_id))
        assert thread_class(client, thread)["direct"] is False
        refused(client, "CONSULTATION_LIMIT", lambda: reply(client, first, room, {"id": answer}))
        # An operator reset reopens it for six more replies, not twenty.
        reset = send(client, operator, room, "message", thread_id=thread)
        last = converse(client, room, (second, first), reset, REPLY_LIMIT, spacing=15)
        refused(client, "CONSULTATION_LIMIT", lambda: reply(client, second, room, last))
        # A thread created after the migration is complete from its first message, and can be direct.
        fresh = send(client, first, room, recipients=(second.session_id,))["thread_id"]
        assert is_complete(client, fresh) is True
        assert thread_class(client, fresh)["direct"] is True


@pytest.mark.parametrize(("third", "limit"), [(False, DIRECT_REPLY_LIMIT), (True, REPLY_LIMIT)])
def test_a_direct_thread_takes_twenty_replies_and_a_three_session_thread_six(db, actors, actor_factory, third, limit):
    room, first, second, _ = actors
    recipients = (second.session_id, actor_factory(room).session_id) if third else (second.session_id,)
    root = send(db, first, room, recipients=recipients)
    # Fifteen seconds apart, so ten replies span more than the loop window.
    last = converse(db, room, (second, first), root, limit, spacing=15)
    assert replies(db, root["thread_id"]) == limit
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, first if limit % 2 else second, room, last))
    assert replies(db, root["thread_id"]) == limit


def test_a_reply_that_would_add_a_third_session_is_judged_by_the_lower_limit(db, actors, actor_factory):
    room, first, second, _ = actors
    third = actor_factory(room)
    root = send(db, first, room, recipients=(second.session_id,))
    last = converse(db, room, (second, first), root, 10, spacing=15)
    # The recipients of the message being published count: three sessions after it, so six applies and ten is over.
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last, recipients=(third.session_id,)))
    # The refusal stored nothing, so the thread is still direct and the default recipient keeps it so.
    reply(db, second, room, last)
    assert replies(db, root["thread_id"]) == 11


def test_a_third_session_joining_by_status_lowers_the_limit_at_once(db, actors, actor_factory):
    room, first, second, operator = actors
    third = actor_factory(room)
    root = send(db, first, room, recipients=(second.session_id,))
    last = converse(db, room, (second, first), root, 10, spacing=15)
    # Status is exempt from the counter and from refusal, yet its sender is a participant.
    send(db, third, room, "status", thread_id=root["thread_id"])
    assert replies(db, root["thread_id"]) == 10
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    # An operator resets the counter, but the thread stays at three sessions and keeps the limit of six.
    reset = send(db, operator, room, "message", thread_id=root["thread_id"])
    last = converse(db, room, (second, first), reset, REPLY_LIMIT, spacing=15)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))


def test_an_operator_resets_a_direct_thread_which_stays_direct(db, actors):
    room, first, second, operator = actors
    root = send(db, first, room, recipients=(second.session_id,))
    last = converse(db, room, (second, first), root, DIRECT_REPLY_LIMIT, spacing=15)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    # Operator status and coordination posts do not reset the counter.
    for kind in ("status", "heads_up"):
        send(db, operator, room, kind, thread_id=root["thread_id"])
        refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    send(db, operator, room, "message", thread_id=root["thread_id"])
    assert replies(db, root["thread_id"]) == 0
    # The operator message addresses no session, so nobody joins: the thread is still direct and again takes more
    # than six replies.
    converse(db, room, (second, first), last, REPLY_LIMIT + 1, spacing=15)
    assert replies(db, root["thread_id"]) == REPLY_LIMIT + 1


@pytest.mark.parametrize(("spacing", "tripped"), [(13, True), (14, False)])
def test_ten_direct_replies_within_the_window_refuse_the_eleventh(db, actors, spacing, tripped):
    room, first, second, _ = actors
    root = send(db, first, room, recipients=(second.session_id,))
    # 13 s apart, the ten replies span 117 s; 14 s apart, 126 s.
    last = converse(db, room, (second, first), root, LOOP_REPLIES, spacing=spacing)
    if tripped:
        refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    else:
        reply(db, second, room, last)
    assert replies(db, root["thread_id"]) == LOOP_REPLIES + (not tripped)


def test_a_thread_that_is_not_direct_is_closed_by_its_counter_not_the_detector(db, actors, actor_factory):
    room, first, second, _ = actors
    root = send(db, first, room, recipients=(second.session_id, actor_factory(room).session_id))
    # Replies in one instant: only the counter can refuse, and it does so at six, short of the ten the detector needs.
    last = converse(db, room, (second, first), root, REPLY_LIMIT, spacing=0)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    assert len(stamps(db, root["thread_id"])) == REPLY_LIMIT < LOOP_REPLIES


def test_a_tripped_detector_holds_until_an_operator_resets_it(db, actors):
    room, first, second, operator = actors
    root = send(db, first, room, recipients=(second.session_id,))
    last = converse(db, room, (second, first), root, LOOP_REPLIES, spacing=0)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    # The stamps do not expire: an hour later the same ten replies still refuse.
    age(db, root["thread_id"], 3600)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    # An operator status neither resets the thread nor adds a participant.
    send(db, operator, room, "status", thread_id=root["thread_id"])
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    send(db, operator, room, "message", thread_id=root["thread_id"])
    # Replies after the operator count from zero: ten more are accepted and the eleventh trips the detector again.
    last = converse(db, room, (second, first), last, LOOP_REPLIES, spacing=0)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    assert replies(db, root["thread_id"]) == LOOP_REPLIES


def test_publication_records_each_session_a_message_adds_to_its_thread(db, actors, actor_factory):
    room, first, second, operator = actors
    third = actor_factory(room)
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    assert sorted(members(db, thread)) == sorted((first.session_id, second.session_id))
    assert is_complete(db, thread) is True
    reply(db, second, room, root)
    assert len(members(db, thread)) == 2
    # An operator sender is no session and adds none; the session it addresses joins.
    send(db, operator, room, "status", thread_id=thread, recipients=(third.session_id,))
    assert sorted(members(db, thread)) == sorted((first.session_id, second.session_id, third.session_id))


def test_each_counted_reply_is_stamped_and_an_operator_message_clears_the_stamps(db, actors):
    room, first, second, operator = actors
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    assert stamps(db, thread) == []
    converse(db, room, (second, first), root, 3, spacing=0)
    # A status is exempt from the counter, so it leaves no stamp.
    send(db, first, room, "status", thread_id=thread)
    log = stamps(db, thread)
    assert len(log) == replies(db, thread) == 3
    assert log == sorted(log)
    send(db, operator, room, "status", thread_id=thread)
    assert stamps(db, thread) == log
    send(db, operator, room, "message", thread_id=thread)
    assert (stamps(db, thread), replies(db, thread)) == ([], 0)


@pytest.mark.parametrize(
    ("offsets", "tripped"),
    [
        pytest.param([], False, id="no stamps"),
        pytest.param([0] * (LOOP_REPLIES - 1), False, id="one short of the count"),
        pytest.param([0] * LOOP_REPLIES, True, id="the count in one instant"),
        pytest.param([0] * (LOOP_REPLIES - 1) + [LOOP_WINDOW_SECONDS], True, id="exactly the window"),
        pytest.param([0] * (LOOP_REPLIES - 1) + [LOOP_WINDOW_SECONDS + 1], False, id="a second over the window"),
        pytest.param([300 * n for n in range(5)] + [2000 + n for n in range(LOOP_REPLIES)], True, id="a late burst"),
        pytest.param([0] * 5 + [1000] * 5, False, id="a slow reply inside the run"),
        pytest.param([30 * n for n in range(LOOP_REPLIES - 1)] + [-3600], True, id="a clock stepped back trips"),
    ],
)
def test_the_loop_detector_judges_any_run_of_consecutive_stamps(db, offsets, tripped):
    base = datetime(2026, 1, 1, tzinfo=UTC)
    row = db.execute(
        "SELECT agent_chat.thread_loop_tripped(%s::timestamptz[], %s, %s) AS tripped",
        ([base + timedelta(seconds=offset) for offset in offsets], LOOP_REPLIES, LOOP_WINDOW_SECONDS),
    ).fetchone()
    assert row == {"tripped": tripped}


@pytest.mark.parametrize(
    ("complete", "participants", "joining", "direct"),
    [
        (True, "", "", False),
        (True, "a", "", False),
        (True, "ab", "", True),
        (True, "a", "b", True),
        (True, "", "ab", True),
        (True, "ab", "ba", True),
        (True, "a", "a", False),
        (True, "ab", "c", False),
        (True, "abc", "", False),
        (False, "ab", "", False),
        (False, "a", "b", False),
        (False, "", "ab", False),
    ],
)
def test_a_thread_is_direct_with_exactly_two_distinct_sessions_when_its_participants_are_complete(
    db, complete, participants, joining, direct
):
    session = {name: uuid4() for name in "abc"}
    row = db.execute(
        "SELECT agent_chat.thread_direct(%s, %s::uuid[], %s::uuid[]) AS direct",
        (complete, [session[name] for name in participants], [session[name] for name in joining]),
    ).fetchone()
    assert row == {"direct": direct}


def test_retention_keeps_a_threads_participants(db, actors, actor_factory):
    room, first, second, _ = actors
    third = actor_factory(room)
    root = send(db, first, room, recipients=(second.session_id, third.session_id))
    thread = root["thread_id"]
    answer = reply(db, second, room, root)
    # The expired root stays as a tombstone, because the answer replies to it, but its recipient rows go.
    expire(db, root)
    collect(db)
    assert db.execute(
        "SELECT count(*) AS n FROM agent_chat.recipients WHERE session_id = %s", (third.session_id,)
    ).fetchone() == {"n": 0}
    # The third session left no trace in any message, and the thread has still had three sessions.
    assert thread_class(db, thread)["direct"] is False
    last = converse(db, room, (first, second), answer, REPLY_LIMIT - 1, spacing=15)
    assert replies(db, thread) == REPLY_LIMIT
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))


def test_retention_keeps_a_tripped_detector(db, actors):
    room, first, second, operator = actors
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    converse(db, room, (second, first), root, LOOP_REPLIES, spacing=0)
    # An exempt message keeps the thread alive while everything counted expires and is collected.
    keeper = send(db, first, room, "status", thread_id=thread)
    for row in db.execute("SELECT id FROM agent_chat.messages WHERE id <> %s", (keeper["id"],)).fetchall():
        expire(db, row)
    collect(db)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages WHERE thread_id = %s", (thread,)).fetchone() == {
        "n": 2
    }
    assert replies(db, thread) == LOOP_REPLIES
    # The ten replies are gone, and the trip is not.
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, keeper))
    send(db, operator, room, "message", thread_id=thread)
    reply(db, second, room, keeper)
    assert replies(db, thread) == 1


def test_an_operator_reset_follows_publication_order_not_timestamps(db, actors):
    room, first, second, operator = actors
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    last = converse(db, room, (second, first), root, LOOP_REPLIES, spacing=0)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    reset = send(db, operator, room, "message", thread_id=thread)
    # A wall clock that stepped back: the reset is stamped an hour before the replies it follows.
    db.execute(
        "UPDATE agent_chat.messages SET created_at = created_at - interval '1 hour' WHERE id = %s", (reset["id"],)
    )
    reply(db, second, room, last)
    assert replies(db, thread) == 1


def test_replies_after_a_reset_count_whatever_their_timestamps(db, actors):
    room, first, second, operator = actors
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    send(db, operator, room, "message", thread_id=thread)
    last = converse(db, room, (second, first), root, LOOP_REPLIES, spacing=0)
    # A wall clock that stepped back after the reset: the ten replies now look older than it.
    db.execute(
        "UPDATE agent_chat.messages SET created_at = created_at - interval '1 hour' "
        "WHERE thread_id = %s AND kind = 'reply'",
        (thread,),
    )
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))


def test_an_operator_message_to_a_third_session_makes_a_direct_thread_indirect(db, actors, actor_factory):
    room, first, second, operator = actors
    third = actor_factory(room)
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    last = converse(db, room, (second, first), root, 8, spacing=15)
    assert thread_class(db, thread)["direct"] is True
    # An operator sender adds no participant, but the sessions it addresses join, so the class changes at once.
    send(db, operator, room, "status", thread_id=thread, recipients=(third.session_id,))
    assert thread_class(db, thread)["direct"] is False
    # A status resets nothing, so the eight replies are over the limit of six.
    assert replies(db, thread) == 8
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    send(db, operator, room, "message", thread_id=thread, recipients=(third.session_id,))
    assert replies(db, thread) == 0
    last = converse(db, room, (second, first), last, REPLY_LIMIT, spacing=15)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))


def test_replies_before_a_thread_became_direct_count_toward_its_detector(db, actors):
    room, first, second, _ = actors
    # One session so far, so the thread takes the lower limit.
    root = send(db, first, room, "status")
    thread = root["thread_id"]
    assert thread_class(db, thread)["direct"] is False
    for _ in range(REPLY_LIMIT):
        send(db, first, room, "message", thread_id=thread)
    refused(db, "CONSULTATION_LIMIT", lambda: send(db, first, room, "message", thread_id=thread))
    # A question to a second session makes it direct, and the six earlier replies stay in the detector's window.
    question = send(db, first, room, "question", thread_id=thread, recipients=(second.session_id,))
    assert thread_class(db, thread)["direct"] is True
    last = converse(db, room, (second, first), question, LOOP_REPLIES - REPLY_LIMIT - 1, spacing=0)
    assert replies(db, thread) == LOOP_REPLIES
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, first, room, last))


def test_pending_omits_and_claim_refuses_a_message_in_a_tripped_thread(db, actors):
    room, first, second, operator = actors
    ready(db, first)
    ready(db, second)
    root = send(db, first, room, recipients=(second.session_id,))
    # Nine replies, the last from `second` to `first`: not yet tripped, so that reply is a candidate.
    ninth = converse(db, room, (second, first), root, LOOP_REPLIES - 1, spacing=0)
    assert pending(db, first) == [ninth["id"]]
    # The tenth, from `first` to `second`, trips the detector: its own wake is refused.
    tenth = reply(db, first, room, ninth)
    assert pending(db, second) == []
    refused(db, "CONSULTATION_LIMIT", lambda: claim(db, second, tenth["id"]))
    send(db, operator, room, "message", thread_id=root["thread_id"])
    assert pending(db, second) == [tenth["id"]]
    assert allowance(db, hand(db, second, tenth["id"])["attempt"]) == "direct"


def test_a_direct_reply_count_at_the_limit_is_refused_at_claim(db, actors):
    room, first, second, _ = actors
    ready(db, second)
    root = send(db, first, room, recipients=(second.session_id,))
    db.execute("UPDATE agent_chat.threads SET agent_replies = %s", (DIRECT_REPLY_LIMIT - 1,))
    assert pending(db, second) == [root["id"]]
    db.execute("UPDATE agent_chat.threads SET agent_replies = %s", (DIRECT_REPLY_LIMIT,))
    assert pending(db, second) == []
    refused(db, "CONSULTATION_LIMIT", lambda: claim(db, second, root["id"]))


def test_a_thread_that_is_not_complete_takes_the_lower_limits_at_publication_pending_and_claim(db, actors):
    room, first, second, _ = actors
    ready(db, first)
    ready(db, second)
    root = send(db, first, room, recipients=(second.session_id,))
    thread = root["thread_id"]
    assert (is_complete(db, thread), thread_class(db, thread)["direct"]) == (True, True)
    # The row state migration 008 leaves on a thread that existed before it. Both sessions are recorded, so the flag
    # alone decides.
    db.execute("UPDATE agent_chat.threads SET participants_complete = false WHERE id = %s", (thread,))
    assert thread_class(db, thread) == {"id": thread, "direct": False, "open": True}
    # Its wake is charged to the allowance of threads that are not direct.
    assert allowance(db, hand(db, second, root["id"])["attempt"]) == "other"
    last = converse(db, room, (second, first), root, REPLY_LIMIT, spacing=15)
    refused(db, "CONSULTATION_LIMIT", lambda: reply(db, second, room, last))
    # `last` is addressed to `second`: pending omits it and claim refuses it, at six replies instead of twenty.
    assert pending(db, second) == []
    refused(db, "CONSULTATION_LIMIT", lambda: claim(db, second, last["id"]))


@pytest.mark.parametrize("exhausted", ["direct", "other"])
def test_one_exhausted_allowance_neither_refuses_nor_starves_the_other(db, actors, exhausted):
    room, partner, target, operator = actors
    ready(db, target)

    def question(kind):
        # A fresh root each time: from the partner it is direct (two sessions), from the operator it is not.
        return send(db, partner if kind == "direct" else operator, room, recipients=(target.session_id,))["id"]

    limit, other = (DIRECT_WAKE_LIMIT, "other") if exhausted == "direct" else (WAKE_LIMIT, "direct")
    for _ in range(limit):
        assert allowance(db, hand(db, target, question(exhausted))["attempt"]) == exhausted
    # More waiting candidates of the spent class than one pending batch holds, all ahead of the open one.
    waiting = [question(exhausted) for _ in range(17)]
    admitted = question(other)
    assert pending(db, target) == [admitted]
    refused(db, "WAKE_LIMIT", lambda: claim(db, target, waiting[0]))
    grant = hand(db, target, admitted)
    assert allowance(db, grant["attempt"]) == other
    budget = deliveries.budget(db, target.session_id)
    spent, open_ = (budget["direct"], budget) if exhausted == "direct" else (budget, budget["direct"])
    assert (spent["used"], spent["remaining"]) == (limit, 0)
    assert (open_["used"], open_["remaining"]) == (1, open_["limit"] - 1)
    assert spent["next_release_at"] is not None
    # Admissions leave the rolling hour per allowance.
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET admitted_at = admitted_at - interval '3601 seconds' "
        "WHERE allowance = %s",
        (exhausted,),
    )
    budget = deliveries.budget(db, target.session_id)
    spent, open_ = (budget["direct"], budget) if exhausted == "direct" else (budget, budget["direct"])
    assert (spent["used"], spent["remaining"], spent["next_release_at"]) == (0, limit, None)
    assert open_["used"] == 1
    assert pending(db, target) == waiting[:16]


def test_a_pending_direct_item_moves_to_other_when_a_third_session_joins(db, actors, actor_factory):
    room, partner, target, operator = actors
    third = actor_factory(room)
    ready(db, target)
    for _ in range(WAKE_LIMIT):
        hand(db, target, send(db, operator, room, recipients=(target.session_id,))["id"])
    direct = send(db, partner, room, recipients=(target.session_id,))
    assert pending(db, target) == [direct["id"]]
    send(db, third, room, "status", thread_id=direct["thread_id"])
    assert pending(db, target) == []
    refused(db, "WAKE_LIMIT", lambda: claim(db, target, direct["id"]))
    db.execute("UPDATE agent_chat.delivery_attempts SET admitted_at = admitted_at - interval '3601 seconds'")
    assert allowance(db, hand(db, target, direct["id"])["attempt"]) == "other"


def test_a_new_batch_never_mixes_allowances_and_a_mixed_claim_is_charged_to_other(db, actors):
    room, partner, target, operator = actors
    ready(db, target)
    direct = send(db, partner, room, recipients=(target.session_id,))["id"]
    indirect = send(db, operator, room, recipients=(target.session_id,))["id"]
    later = send(db, partner, room, recipients=(target.session_id,))["id"]
    assert pending(db, target) == [direct, later]
    grant = claim(db, target, direct, indirect)
    assert allowance(db, grant["attempt"]) == "other"
    deliveries.result(db, target, grant["attempt"]["id"], DeliveryResult(outcome="handed"))
    assert allowance(db, hand(db, target, later)["attempt"]) == "direct"


def test_a_retry_batch_is_recharged_by_its_current_class_and_never_blocks_the_other(db, actors, actor_factory):
    room, partner, target, operator = actors
    third = actor_factory(room)
    ready(db, target)
    direct = send(db, partner, room, recipients=(target.session_id,))
    grant = claim(db, target, direct["id"])
    assert allowance(db, grant["attempt"]) == "direct"
    deliveries.result(db, target, grant["attempt"]["id"], DeliveryResult(outcome="deferred", reason="busy"))
    db.execute("UPDATE agent_chat.delivery_attempts SET completed_at = completed_at - interval '1 minute'")
    # The thread gains a third session before the retry, so the retry is charged to `other`.
    send(db, third, room, "status", thread_id=direct["thread_id"])
    assert deliveries.pending(db, target) == {
        "session_id": target.session_id,
        "instance_id": target.instance_id,
        "messages": [direct["id"]],
        "sizes": {str(direct["id"]): len("synthetic question")},
        "retry": True,
    }
    for _ in range(WAKE_LIMIT):
        hand(db, target, send(db, operator, room, recipients=(target.session_id,))["id"])
    # `other` is spent. The retry batch comes first by position but must not hold back a direct candidate.
    fresh = send(db, partner, room, recipients=(target.session_id,))["id"]
    assert pending(db, target) == [fresh]
    refused(db, "WAKE_LIMIT", lambda: claim(db, target, direct["id"]))
    db.execute(
        "UPDATE agent_chat.delivery_attempts SET admitted_at = admitted_at - interval '3601 seconds' "
        "WHERE allowance = 'other'"
    )
    retry = claim(db, target, direct["id"])
    assert (retry["attempt"]["ordinal"], allowance(db, retry["attempt"])) == (2, "other")


def test_status_reports_both_allowances_and_reply_limits(http_api, credentials, register):
    token, _ = register(SimpleNamespace(request=http_api), credentials, "budget-reader")
    status, state = http_api("GET", "/v1/instance/status", None, token)
    assert status == 200
    assert state["wake_budget"] == {
        "limit": WAKE_LIMIT,
        "used": 0,
        "remaining": WAKE_LIMIT,
        "next_release_at": None,
        "reply_limit": REPLY_LIMIT,
        "direct": {
            "limit": DIRECT_WAKE_LIMIT,
            "used": 0,
            "remaining": DIRECT_WAKE_LIMIT,
            "next_release_at": None,
            "reply_limit": DIRECT_REPLY_LIMIT,
        },
    }
