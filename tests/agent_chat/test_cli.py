import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
from contextlib import contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from uuid import UUID, uuid4, uuid5

import pytest

from agent_chat.instance_file import prepare_instance, read_instance
from agent_chat.models import ROLE_FILTER_STAMPS, ChatError


@pytest.fixture
def cli(tmp_path, process_api, credentials):
    directory = tmp_path / "binding"
    directory.mkdir(mode=0o700)
    boot = uuid4()
    binding = prepare_instance(directory, "cli-native", boot, server_origin=process_api.origin)
    status, registered = process_api.request(
        "POST",
        "/v1/sessions",
        {
            "native_session_id": binding.native_session_id,
            "boot_id": str(boot),
            "instance_token_hash": sha256(binding.token.encode()).hexdigest(),
        },
        credentials.agent,
    )
    assert status == 200
    path = directory / f"{boot}.json"

    def run(*args, body=b"", environment=None):
        env = {"PATH": os.defpath, "LANG": "C.UTF-8", "AGENT_CHAT_INSTANCE_FILE": str(path), **(environment or {})}
        result = subprocess.run(
            [str(Path(sys.executable).with_name("agent-chat")), *args],
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=tmp_path,
            env=env,
            timeout=25,
        )
        assert binding.token.encode() not in result.stdout + result.stderr
        assert not result.stderr, "CLI emitted unexpected diagnostics"
        return result.returncode, json.loads(result.stdout)

    return SimpleNamespace(run=run, path=path, binding=binding, registered=registered)


def test_all_commands_use_authenticated_binding_and_stdin(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    status = cli.run("status")
    assert status[0] == 0 and status[1]["result"]["session_id"] == cli.registered["session_id"]
    assert cli.run("who")[1]["result"]["participants"]
    key = str(uuid4())
    body = "Zażółć gęślą jaźń\n<script>not executable</script>".encode()
    args = ("send", "--kind", "question", "--to", target["session_id"], "--key", key)
    result = cli.run(*args, body=body)
    assert result[0] == 0 and result[1]["idempotency_key"] == key
    message = result[1]["result"]
    assert message["body"] == body.decode() and message["sender"]["session_id"] == cli.registered["session_id"]
    assert cli.run(*args, body=body) == result
    assert cli.run(*args, body=b"changed")[1]["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert cli.run("history", "--thread", message["thread_id"])[1]["result"]["messages"][0]["id"] == message["id"]
    # A message addressed to the CLI instance permits its explicit ack and reply.
    code, incoming = process_api.request(
        "POST",
        f"/v1/rooms/{credentials.room}/messages",
        {"kind": "question", "body": "incoming", "recipients": [cli.registered["session_id"]]},
        target_token,
        {"Idempotency-Key": str(uuid4())},
    )
    assert code == 200
    assert cli.run("history")[0] == 0
    assert (
        db.execute(
            "SELECT acknowledged_at FROM agent_chat.recipients WHERE message_id = %s", (incoming["id"],)
        ).fetchone()["acknowledged_at"]
        is None
    )
    acknowledged = cli.run("ack", incoming["id"])
    assert acknowledged[0] == 0 and acknowledged[1]["result"]["acknowledged_at"]
    reply = cli.run("reply", incoming["id"], "--key", str(uuid4()), body=b"reply from stdin")
    assert reply[0] == 0 and reply[1]["result"]["recipients"] == [target["session_id"]]
    assert reply[1]["result"]["thread_id"] == incoming["thread_id"]
    assert cli.run("mute")[1]["result"]["muted"] is True
    assert cli.run("unmute")[1]["result"]["muted"] is False
    own = cli.run("status")[1]["result"]
    assert own["stopped"] and own["plan_mode"] and own["wake_budget"] is None


def test_who_online_sends_the_filter_and_default_lists_lapsed_sessions(cli, process_api, credentials, register, db):
    _, lapsed = register(process_api, credentials, "lapsed")
    db.execute(
        "UPDATE agent_chat.instances SET heartbeat_at = clock_timestamp() - interval '91 seconds'"
        " WHERE session_id = %s",
        (lapsed["session_id"],),
    )
    everyone = {row["session_id"] for row in cli.run("who")[1]["result"]["participants"]}
    assert everyone == {cli.registered["session_id"], lapsed["session_id"]}
    online = cli.run("who", "--online")
    assert online[0] == 0
    assert [row["session_id"] for row in online[1]["result"]["participants"]] == [cli.registered["session_id"]]


def test_reply_room_is_the_same_scope_used_for_aliases(cli, process_api, credentials, db):
    root = cli.run("send", "--key", str(uuid4()), body=b"homelab root")[1]["result"]
    status, room = process_api.request(
        "POST", "/v1/rooms", {"slug": "private", "label": "Private"}, credentials.operator
    )
    assert status == 200
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (credentials.principal, room["id"]))
    db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (room["id"], cli.registered["session_id"]))
    assert cli.run("who", "--room", "private")[0] == 0
    result = cli.run(
        "reply",
        root["id"],
        "--room",
        "private",
        "--to",
        "pi@synthetic-host",
        "--key",
        str(uuid4()),
        body=b"wrong room",
    )
    assert result[0] != 0
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 1


def _private_room(process_api, credentials, db, *sessions):
    status, room = process_api.request(
        "POST", "/v1/rooms", {"slug": "private", "label": "Private"}, credentials.operator
    )
    assert status == 200
    db.execute("INSERT INTO agent_chat.principal_rooms VALUES (%s, %s)", (credentials.principal, room["id"]))
    for session in sessions:
        db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (room["id"], session))
    return room["id"]


def _question(process_api, token, room, recipient):
    status, message = process_api.request(
        "POST",
        f"/v1/rooms/{room}/messages",
        {"kind": "question", "body": "incoming", "recipients": [recipient]},
        token,
        {"Idempotency-Key": str(uuid4())},
    )
    assert status == 200
    return message


def _message_count(db):
    return db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"]


def test_one_step_reply_derives_room_and_key_and_publishes_once(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    own = cli.registered["session_id"]
    room = _private_room(process_api, credentials, db, own, target["session_id"])
    incoming = _question(process_api, target_token, room, own)
    before = _message_count(db)
    first = cli.run("reply", incoming["id"], body=b"one step")
    assert first[0] == 0, first
    reply = first[1]["result"]
    assert reply["room_id"] == room and reply["thread_id"] == incoming["thread_id"]
    assert reply["sender"]["session_id"] == own and reply["recipients"] == [target["session_id"]]
    # The retry identity is pinned: a changed namespace or input would let a retry publish twice.
    namespace = UUID("231e60c5-f032-4827-bd6f-848f18ac6ef7")
    assert first[1]["idempotency_key"] == str(uuid5(namespace, f"{own}:{incoming['id']}"))
    assert _message_count(db) == before + 1
    # A lost response is recovered by repeating the same command.
    assert cli.run("reply", incoming["id"], body=b"one step") == first
    assert _message_count(db) == before + 1


def _receipts_requested(db, message):
    row = db.execute("SELECT receipts_requested FROM agent_chat.messages WHERE id = %s", (message,)).fetchone()
    return row["receipts_requested"]


def test_receipts_flag_is_stored_on_send_and_both_reply_forms(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    own = cli.registered["session_id"]
    to = ("--to", target["session_id"])
    plain = cli.run("send", *to, "--key", str(uuid4()), body=b"plain")
    opted = cli.run("send", *to, "--key", str(uuid4()), "--receipts", body=b"opted")
    assert plain[0] == opted[0] == 0
    assert _receipts_requested(db, plain[1]["result"]["id"]) is False
    assert _receipts_requested(db, opted[1]["result"]["id"]) is True
    incoming = _question(process_api, target_token, credentials.room, own)
    one_step = cli.run("reply", incoming["id"], "--receipts", body=b"one step")
    explicit = cli.run("reply", incoming["id"], "--key", str(uuid4()), "--receipts", body=b"explicit")
    assert one_step[0] == explicit[0] == 0, (one_step, explicit)
    assert _receipts_requested(db, one_step[1]["result"]["id"]) is True
    assert _receipts_requested(db, explicit[1]["result"]["id"]) is True


def test_the_receipts_field_is_sent_only_when_asked():
    from agent_chat.cli import _payload
    from agent_chat.models import Publication, Reply

    # A server older than migration 007 refuses an unknown field, so the default request must not carry it.
    assert "receipts" not in _payload(Publication(kind="message", body="x"))
    assert "receipts" not in _payload(Reply(body="x"))
    assert _payload(Publication(kind="message", body="x", receipts=True))["receipts"] is True
    assert _payload(Reply(body="x", receipts=True))["receipts"] is True


def test_explicitly_empty_room_is_refused_not_defaulted(cli, db):
    before = _message_count(db)
    code, output = cli.run("send", "--room", "", "--key", str(uuid4()), body=b"not to homelab")
    assert code == 1 and output["error"]["code"] == "ROOM_FORBIDDEN"
    assert _message_count(db) == before
    # Omitting --room still publishes to homelab.
    assert cli.run("send", "--key", str(uuid4()), body=b"to homelab")[0] == 0
    assert _message_count(db) == before + 1


def test_one_step_reply_with_another_body_names_the_explicit_key_form(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    own = cli.registered["session_id"]
    room = _private_room(process_api, credentials, db, own, target["session_id"])
    incoming = _question(process_api, target_token, room, own)
    assert cli.run("reply", incoming["id"], body=b"first")[0] == 0
    before = _message_count(db)
    code, output = cli.run("reply", incoming["id"], body=b"second")
    assert code == 1 and output["error"]["code"] == "IDEMPOTENCY_CONFLICT" and "--key" in output["error"]["hint"]
    assert _message_count(db) == before
    # The explicit form is the way to send a further reply.
    further = cli.run("reply", incoming["id"], "--room", "private", "--key", str(uuid4()), body=b"second")
    assert further[0] == 0 and _message_count(db) == before + 1


def test_one_step_reply_accepts_session_uuid_recipients_only(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    own = cli.registered["session_id"]
    room = _private_room(process_api, credentials, db, own, target["session_id"])
    incoming = _question(process_api, target_token, room, own)
    before = _message_count(db)
    assert cli.run("reply", incoming["id"], "--to", "pi@synthetic-host", body=b"alias")[1]["error"] == {
        "code": "INVALID_RECIPIENT"
    }
    assert _message_count(db) == before
    named = cli.run("reply", incoming["id"], "--to", target["session_id"], body=b"uuid")
    assert named[0] == 0 and named[1]["result"]["recipients"] == [target["session_id"]]


def test_one_step_reply_refuses_a_message_outside_the_session_scope(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    room = _private_room(process_api, credentials, db, target["session_id"])
    hidden = process_api.request(
        "POST",
        f"/v1/rooms/{room}/messages",
        {"kind": "message", "body": "not for the cli"},
        target_token,
        {"Idempotency-Key": str(uuid4())},
    )[1]
    before = _message_count(db)
    code, output = cli.run("reply", hidden["id"], body=b"intrusion")
    assert code != 0 and "error" in output
    assert _message_count(db) == before


def test_reply_with_a_room_but_no_key_is_invalid_and_publishes_nothing(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    own = cli.registered["session_id"]
    room = _private_room(process_api, credentials, db, own, target["session_id"])
    incoming = _question(process_api, target_token, room, own)
    before = _message_count(db)
    assert cli.run("reply", incoming["id"], "--room", "private", body=b"no key") == (
        2,
        {
            "error": {
                "code": "INVALID_ARGUMENTS",
                "hint": (
                    "reply without --key derives the room from the message: drop --room, or pass --key with --room"
                ),
            }
        },
    )
    assert _message_count(db) == before


def test_explicit_key_reply_keeps_the_homelab_default_room(cli, process_api, credentials, register, db):
    target_token, target = register(process_api, credentials, "target")
    own = cli.registered["session_id"]
    incoming = _question(process_api, target_token, credentials.room, own)
    key = str(uuid4())
    first = cli.run("reply", incoming["id"], "--key", key, body=b"legacy")
    assert first[0] == 0 and first[1]["idempotency_key"] == key
    assert first[1]["result"]["thread_id"] == incoming["thread_id"]
    assert cli.run("reply", incoming["id"], "--key", key, body=b"legacy") == first
    assert cli.run("reply", incoming["id"], "--key", key, body=b"changed")[1]["error"] == {
        "code": "IDEMPOTENCY_CONFLICT"
    }


def test_ambiguous_alias_lists_candidates_without_sending(cli, process_api, credentials, register, db):
    _, target = register(process_api, credentials, "target")
    result = cli.run("send", "--to", "pi@synthetic-host", "--key", str(uuid4()), body=b"not broadcast")
    assert result[0] == 3 and result[1]["error"]["code"] == "AMBIGUOUS_RECIPIENT"
    assert {row["session_id"] for row in result[1]["error"]["candidates"]} == {
        target["session_id"],
        cli.registered["session_id"],
    }
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0
    exact = cli.run("send", "--to", "pi@synthetic-host/target", "--key", str(uuid4()), body=b"exact")
    assert exact[0] == 0 and exact[1]["result"]["recipients"] == [target["session_id"]]


def test_alias_resolution_reads_second_page(cli, credentials, db):
    # The CLI's session is also a candidate. Populate >100 real rows, not a fake resolver.
    for index in range(101):
        session = UUID(int=index + 1)
        db.execute(
            "INSERT INTO agent_chat.sessions(id, principal_id, native_session_id, label) VALUES (%s, %s, %s, %s)",
            (session, credentials.principal, f"page-{index}", "page candidate"),
        )
        db.execute("INSERT INTO agent_chat.memberships VALUES (%s, %s)", (credentials.room, session))
    result = cli.run("send", "--to", "page candidate", "--key", str(uuid4()), body=b"not sent")
    assert result[0] == 3 and len(result[1]["error"]["candidates"]) == 101
    who = cli.run("who", "--limit", "1")
    after = who[1]["result"]["next_session_id"]
    assert (
        after
        and cli.run("who", "--limit", "1", "--after-session", after)[1]["result"]["participants"][0]["session_id"]
        != after
    )


_NO_PM_HINT = "no live pm mark in this room; address a session by UUID or label"
_ONE_STEP_PM_HINT = "--to pm needs a room: pass --key and --room, or the holder's session UUID"


def _set_pm(process_api, credentials, session, *, pm=True):
    status, result = process_api.request(
        "POST", f"/v1/rooms/{credentials.room}/pm", {"session_id": session, "pm": pm}, credentials.operator
    )
    assert status == 200, result
    return result["pm"]


def test_who_reports_the_pm_mark_beside_any_roster_page(cli, process_api, credentials, register):
    _, holder = register(process_api, credentials, "pm-holder")
    assert cli.run("who")[1]["result"]["pm"] is None
    _set_pm(process_api, credentials, holder["session_id"])
    code, output = cli.run("who", "--limit", "1")
    assert code == 0
    block = output["result"]["pm"]
    assert block["session_id"] == holder["session_id"]
    assert set(block) == {"session_id", "set_at", "last_activity_at", "expires_at"}
    _set_pm(process_api, credentials, holder["session_id"], pm=False)
    assert cli.run("who")[1]["result"]["pm"] is None


def test_to_pm_names_the_live_holder_and_nothing_else(cli, process_api, credentials, register, db):
    _, holder = register(process_api, credentials, "pm-holder")
    _, bystander = register(process_api, credentials, "bystander")
    send = ("send", "--kind", "question", "--to", "pm", "--key")
    refused = cli.run(*send, str(uuid4()), body=b"nobody holds the mark")
    assert refused[0] == 2 and refused[1]["error"] == {"code": "INVALID_RECIPIENT", "hint": _NO_PM_HINT}
    assert _message_count(db) == 0
    _set_pm(process_api, credentials, holder["session_id"])
    # The roster's mark decides, so a session that carries the label "pm" is not the PM and cannot capture the alias.
    db.execute("UPDATE agent_chat.sessions SET label = 'pm' WHERE id = %s", (bystander["session_id"],))
    sent = cli.run(*send, str(uuid4()), body=b"to the PM")
    assert sent[0] == 0, sent
    assert sent[1]["result"]["recipients"] == [holder["session_id"]]
    # The alias and the holder's UUID are one recipient.
    both = cli.run(
        "send", "--kind", "question", "--to", "pm", "--to", holder["session_id"], "--key", str(uuid4()), body=b"once"
    )
    assert both[1]["result"]["recipients"] == [holder["session_id"]]
    # A lapsed mark reads as none: the alias is refused, never answered with a stale holder.
    db.execute(
        "UPDATE agent_chat.room_roles SET last_activity_at = clock_timestamp() - interval '49 hours' "
        "WHERE role = 'pm'"
    )
    lapsed = cli.run(*send, str(uuid4()), body=b"the mark lapsed")
    assert lapsed[0] == 2 and lapsed[1]["error"] == {"code": "INVALID_RECIPIENT", "hint": _NO_PM_HINT}
    assert _message_count(db) == 2


def test_a_one_step_reply_cannot_resolve_pm_but_a_keyed_reply_can(cli, process_api, credentials, register, db):
    asker_token, _ = register(process_api, credentials, "asker")
    _, holder = register(process_api, credentials, "pm-holder")
    incoming = _question(process_api, asker_token, credentials.room, cli.registered["session_id"])
    _set_pm(process_api, credentials, holder["session_id"])
    before = _message_count(db)
    one_step = cli.run("reply", incoming["id"], "--to", "pm", body=b"no room to resolve the alias in")
    assert one_step[0] == 2 and one_step[1]["error"] == {"code": "INVALID_RECIPIENT", "hint": _ONE_STEP_PM_HINT}
    assert _message_count(db) == before
    keyed = cli.run(
        "reply", incoming["id"], "--room", credentials.room, "--key", str(uuid4()), "--to", "pm", body=b"keyed"
    )
    assert keyed[0] == 0, keyed
    assert keyed[1]["result"]["recipients"] == [holder["session_id"]]


def test_history_from_pm_keeps_only_what_the_service_stamped(cli, process_api, credentials, register, send):
    holder_token, holder = register(process_api, credentials, "pm-holder")
    ordinary = cli.run("send", "--key", str(uuid4()), body=b"from an ordinary session")[1]["result"]
    _set_pm(process_api, credentials, holder["session_id"])
    stamped = send(process_api, credentials, "from the PM", holder_token)
    code, output = cli.run("history", "--from", "pm")
    assert code == 0
    assert [message["id"] for message in output["result"]["messages"]] == [stamped["id"]]
    assert output["result"]["messages"][0]["sender"]["role"] == "pm"
    everything = {message["id"]: message for message in cli.run("history")[1]["result"]["messages"]}
    assert set(everything) == {ordinary["id"], stamped["id"]}
    assert "role" not in everything[ordinary["id"]]["sender"]


def test_help_states_that_the_pm_mark_grants_no_authority(tmp_path):
    executable = str(Path(sys.executable).with_name("agent-chat"))
    for command in ("history", "send"):
        result = subprocess.run(
            [executable, command, "--help"],
            capture_output=True,
            text=True,
            timeout=25,
            cwd=tmp_path,
            env={"PATH": os.defpath, "LANG": "C.UTF-8"},
        )
        assert result.returncode == 0 and "grants no authority" in " ".join(result.stdout.split()), command


@pytest.mark.parametrize(
    "args,body,code",
    [
        (("send",), b"text", "INVALID_ARGUMENTS"),
        (("send", "--key", str(uuid4()), "--sender", "operator"), b"text", "INVALID_ARGUMENTS"),
        # A role is never the sender's to claim, and the CLI has no operation that sets the mark.
        (("send", "--key", str(uuid4()), "--from", "pm"), b"text", "INVALID_ARGUMENTS"),
        (("pm", "--set"), b"", "INVALID_ARGUMENTS"),
        (("send", "--key", str(uuid4())), b"", "INVALID_REQUEST"),
        (("send", "--key", str(uuid4())), b"x" * 16385, "BODY_TOO_LARGE"),
        (("send", "--key", str(uuid4())), b"\xff", "INVALID_BODY"),
        (("send", "--key", str(uuid4())), b"embedded\x00nul", "INVALID_REQUEST"),
        (("history", "--after", "-1"), b"", "INVALID_CURSOR"),
        (("who", "--limit", "101"), b"", "INVALID_ARGUMENTS"),
    ],
)
def test_invalid_input_has_no_publication(cli, db, args, body, code):
    result = cli.run(*args, body=body)
    assert result[0] != 0 and result[1]["error"]["code"] == code
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0


_HINT_KEY = str(uuid4())
_HINT_MESSAGE = str(uuid4())
_HINT_REF = "resource:host:name"


@pytest.mark.parametrize(
    "args,hint",
    [
        (
            ("send", "--key", _HINT_KEY, "--kind", "question", "the body as an argument"),
            "unrecognized arguments; message bodies go on stdin, not on the command line; "
            "see `agent-chat send --help`",
        ),
        (
            ("send", "--key", "not-a-uuid"),
            "--key: expected a UUID (generate one with python3 -c 'import uuid; print(uuid.uuid4())'); "
            "see `agent-chat send --help`",
        ),
        (
            ("reply", _HINT_MESSAGE, "--key", _HINT_KEY, "--kind", "message"),
            "unrecognized arguments; message bodies go on stdin, not on the command line; "
            "see `agent-chat reply --help`",
        ),
        (
            ("send", "--key", _HINT_KEY, "--kind", "reply"),
            "--kind: must be one of message, status, question, consultation, heads_up, blocked_on, "
            "decision_needed, intent; see `agent-chat send --help`",
        ),
        (("send",), "missing required arguments: --key; see `agent-chat send --help`"),
        (("who", "--limit", "many"), "--limit: expected an integer; see `agent-chat who --help`"),
        (("history", "--from", "admin"),
         f"--from: must be one of {', '.join(ROLE_FILTER_STAMPS)}; "
         "see `agent-chat history --help`"),
        (("send", "--key", _HINT_KEY, "--to"), "--to: expected a value; see `agent-chat send --help`"),
        (
            ("who", "--online=yes"),
            "--online takes no value; pass --online on its own; see `agent-chat who --help`",
        ),
        (
            ("send", "--key", _HINT_KEY, "--receipts=yes"),
            "--receipts takes no value; pass --receipts on its own; see `agent-chat send --help`",
        ),
        (
            ("reply", _HINT_MESSAGE, "--room", "private"),
            "reply without --key derives the room from the message: drop --room, or pass --key with --room",
        ),
        (("who", "--limit", "101"), "--limit must be 1 to 100"),
        (("history", "--ref", _HINT_REF, "--thread", _HINT_KEY), "--thread and --ref are mutually exclusive"),
        (
            ("send", "--key", _HINT_KEY, "--ref", _HINT_REF, "--thread", _HINT_KEY),
            "--thread and --ref are mutually exclusive",
        ),
        (("lane",), "pass exactly one of a lane reference and --clear"),
        (("lane", "--clear", "owner/project::0123456789ab-0123"), "pass exactly one of a lane reference and --clear"),
        (
            ("send", "--key", _HINT_KEY, "--ref", "free text"),
            "--ref must be pr:OWNER/REPO#N, lane:<lane-ref> or resource:<host>:<name>",
        ),
        (
            (
                "produce", "validation-lease", "--credential-file", "/nonexistent/credential.json",
                "--lease-script", "/nonexistent/lease.py", "--lock-file", "relative.lock",
            ),
            "--lock-file must be an absolute path",
        ),
    ],
)
def test_invalid_arguments_name_the_argument_and_rule_in_a_hint(cli, db, args, hint):
    code, output = cli.run(*args, body=b"text")
    assert code == 2 and output["error"] == {"code": "INVALID_ARGUMENTS", "hint": hint}
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0


def test_invalid_arguments_hint_never_echoes_supplied_values(cli):
    secret, positional = "SENTINEL-SECRET-123", "SENTINEL-SECRET-456"
    for args in (
        ("send", "--key", secret, positional),
        ("send", "--key", str(uuid4()), "--kind", secret),
        ("send", "--key", str(uuid4()), "--ref", secret),
        ("send", "--key", str(uuid4()), positional),
        ("who", "--limit", secret),
        ("history", "--from", secret),
        ("who", f"--online={secret}"),
        ("send", "--key", str(uuid4()), f"--receipts={secret}"),
        ("reply", positional),
        (secret, positional),
        ("produce", "validation-lease", "--credential-file", "/x", "--lease-script", "/x", "--lock-file", secret),
    ):
        code, output = cli.run(*args, body=positional.encode())
        assert code == 2 and output["error"]["code"] == "INVALID_ARGUMENTS" and output["error"]["hint"], args
        assert "SENTINEL" not in json.dumps(output), args


def test_revoked_stale_and_unsafe_bindings_refuse_without_renewal(cli, process_api, db):
    before = db.execute("SELECT heartbeat_at FROM agent_chat.instances").fetchone()["heartbeat_at"]
    assert cli.run("status")[0] == 0
    assert db.execute("SELECT heartbeat_at FROM agent_chat.instances").fetchone()["heartbeat_at"] == before
    cli.path.chmod(0o644)
    assert cli.run("status")[1]["error"]["code"] == "BINDING_FILE_UNSAFE"
    cli.path.chmod(0o600)
    process_api.request("POST", "/v1/instance/end", {}, cli.binding.token)
    assert cli.run("status")[1]["error"]["code"] == "STALE_INSTANCE"
    db.execute("UPDATE agent_chat.principals SET revoked = true")
    assert cli.run("status")[1]["error"]["code"] == "UNAUTHENTICATED"


def test_cli_with_a_removed_record_refuses_without_discovering_another(cli):
    cli.path.unlink()
    assert cli.run("status") == (1, {"error": {"code": "BINDING_FILE_UNSAFE"}})


def test_cli_never_rebinds_an_ended_process(cli, process_api, credentials, register):
    saved = cli.path.read_bytes()
    process_api.request("POST", "/v1/instance/end", {}, cli.binding.token)
    token, replacement = register(process_api, credentials, "cli-native")
    assert replacement["session_id"] == cli.registered["session_id"]
    assert replacement["instance_id"] != cli.registered["instance_id"]
    assert cli.run("mute")[1]["error"]["code"] == "STALE_INSTANCE"
    assert process_api.request("GET", "/v1/instance/status", token=token)[1]["muted"] is False
    assert cli.path.read_bytes() == saved


def test_stdin_has_a_real_deadline_and_no_send_before_eof(cli, db, tmp_path):
    # Lower the real signal deadline in the child so this exercises the same
    # whole-command alarm without spending the production 20 seconds.
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import agent_chat.cli as cli; "
            "cli.CLI_REQUEST_SECONDS = 0.25; "
            "raise SystemExit(cli.main())",
            "send", "--key", str(uuid4()),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=tmp_path,
        env={"PATH": os.defpath, "AGENT_CHAT_INSTANCE_FILE": str(cli.path)},
    )
    try:
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        process.stdin.write(b"unfinished body")
        process.stdin.flush()
        process.wait(timeout=10)
        assert json.loads(process.stdout.read())["error"]["code"] == "CLI_INTERRUPTED"
        assert not process.stderr.read()
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0


def test_instance_origin_is_pinned_and_old_record_not_adopted(tmp_path):
    boot = uuid4()
    original = prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    path = tmp_path / f"{boot}.json"
    assert read_instance(path) == original
    with pytest.raises(ChatError, match="BINDING_FILE_CONFLICT"):
        prepare_instance(tmp_path, "native", boot, server_origin="https://other.test")
    data = json.loads(path.read_text())
    del data["server_origin"]
    path.write_text(json.dumps(data))
    with pytest.raises(ChatError, match="BINDING_FILE_INVALID"):
        read_instance(path)


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost",
        "http://example.test",
        "https://user:password@example.test",
        "https://example.test/?token=x",
        "https://example.test#x",
        "https://example.test:0",
        "https://example.test:65536",
        " https://example.test",
        "https://example.test\n",
    ],
)
def test_origin_refusal_before_file_creation(tmp_path, origin):
    with pytest.raises(ChatError, match="INVALID_ORIGIN"):
        prepare_instance(tmp_path, "native", uuid4(), server_origin=origin)
    assert list(tmp_path.iterdir()) == []


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        pass


@contextmanager
def protocol_server(handler, tls=None):
    class QuietServer(HTTPServer):
        def handle_error(self, request, client_address):
            pass  # Disconnects are intentional; never echo a request or authorization header.

    with QuietServer(("127.0.0.1", 0), handler) as server:
        if tls is not None:
            server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            yield f"{'https' if tls else 'http'}://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join(timeout=5)
            assert not thread.is_alive()


@pytest.fixture
def transport_cli(tmp_path):
    def run(origin, args=("status",), body=b"", environment=None):
        directory = tmp_path / uuid4().hex
        directory.mkdir(mode=0o700)
        boot = uuid4()
        binding = prepare_instance(directory, "transport-native", boot, server_origin=origin)
        process = subprocess.run(
            [sys.executable, "-m", "agent_chat.cli", *args],
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=tmp_path,
            env={
                "PATH": os.defpath,
                "LANG": "C.UTF-8",
                "AGENT_CHAT_INSTANCE_FILE": str(directory / f"{boot}.json"),
                **(environment or {}),
            },
            timeout=25,
        )
        assert binding.token.encode() not in process.stdout + process.stderr
        assert not process.stderr
        assert b"\x1b" not in process.stdout
        return process.returncode, json.loads(process.stdout)

    return run


def test_redirect_is_not_followed_and_proxy_environment_is_ignored(transport_cli):
    visited = []

    class Target(QuietHandler):
        def do_GET(self):
            visited.append(True)
            self.send_error(500)

    with protocol_server(Target) as target:

        class Redirect(QuietHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", target)
                self.end_headers()

        with protocol_server(Redirect) as origin:
            code, error = transport_cli(
                origin, environment={"HTTP_PROXY": target, "http_proxy": target, "ALL_PROXY": target}
            )
            assert code == 1 and error["error"]["code"] == "REDIRECT_REFUSED"
    assert visited == []


def test_lost_post_response_is_uncertain_not_retried(transport_cli):
    attempts = []

    class Drop(QuietHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            attempts.append(self.headers.get("Idempotency-Key"))
            self.connection.shutdown(socket.SHUT_RDWR)

    with protocol_server(Drop) as origin:
        key = str(uuid4())
        code, error = transport_cli(origin, ("send", "--room", str(uuid4()), "--key", key), b"synthetic")
        assert code == 4 and error == {"error": {"code": "REQUEST_UNCERTAIN"}, "idempotency_key": key}
    assert attempts == [key]


@pytest.mark.parametrize("status", [200, 401])
def test_error_and_success_output_do_not_echo_token_or_terminal_controls(transport_cli, status):
    class Echo(QuietHandler):
        def do_GET(self):
            token = self.headers["Authorization"].removeprefix("Bearer ")
            body = json.dumps(
                {"echo": token.upper(), "body": "\x1b[2Jmalicious", "error": {"code": token.upper(), "message": token}}
            ).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with protocol_server(Echo) as origin:
        code, result = transport_cli(origin)
    if status == 200:
        assert code == 0 and result["result"]["echo"] == "[REDACTED]"
    else:
        assert code == 1 and result == {"error": {"code": "HTTP_REFUSED"}}


def test_lost_committed_response_recovers_same_message(cli, process_api, credentials, db, tmp_path):
    attempts = []

    class CommitThenDrop(QuietHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            status, result = process_api.request(
                "POST",
                self.path,
                body,
                self.headers["Authorization"].removeprefix("Bearer "),
                {"Idempotency-Key": self.headers["Idempotency-Key"]},
            )
            assert status == 200
            attempts.append(result["id"])
            if len(attempts) == 1:
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with protocol_server(CommitThenDrop) as origin:
        directory = tmp_path / "lost-response"
        directory.mkdir(mode=0o700)
        boot = uuid4()
        binding = prepare_instance(directory, "proxy-native", boot, server_origin=origin)
        status, registered = process_api.request(
            "POST",
            "/v1/sessions",
            {
                "native_session_id": binding.native_session_id,
                "boot_id": str(boot),
                "instance_token_hash": sha256(binding.token.encode()).hexdigest(),
            },
            credentials.agent,
        )
        assert status == 200
        environment = {"AGENT_CHAT_INSTANCE_FILE": str(directory / f"{boot}.json")}
        key = str(uuid4())
        args = ("send", "--room", credentials.room, "--key", key)
        first = cli.run(*args, body=b"persist once", environment=environment)
        assert first == (4, {"error": {"code": "REQUEST_UNCERTAIN"}, "idempotency_key": key})
        assert len(attempts) == 1
        second = cli.run(*args, body=b"persist once", environment=environment)
        assert second[0] == 0 and second[1]["result"]["sender"]["session_id"] == registered["session_id"]
        assert attempts == [second[1]["result"]["id"]] * 2
        assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 1


@pytest.mark.parametrize("mode", ["redirect", "malformed", "truncated", "too_large"])
def test_unexpected_post_responses_are_uncertain_without_body_echo(transport_cli, mode):
    calls = []

    class Invalid(QuietHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            calls.append(True)
            self.send_response(307 if mode == "redirect" else 200)
            self.send_header("Location", "https://must-not-contact.invalid")
            self.send_header("Content-Type", "application/json")
            if mode == "truncated":
                self.send_header("Content-Length", "200")
            self.end_headers()
            if mode == "too_large":
                self.wfile.write(b" " * (16 * 1024 * 1024 + 1))
            else:
                self.wfile.write(b"not JSON" if mode == "malformed" else b"{}")

    with protocol_server(Invalid) as origin:
        code, result = transport_cli(origin, ("send", "--room", str(uuid4()), "--key", str(uuid4())), b"synthetic")
    assert code == 4 and result["error"]["code"] == "REQUEST_UNCERTAIN"
    assert calls == [True]


def test_a_repeated_pm_alias_reads_the_roster_once(transport_cli):
    room = str(uuid4())
    holders = [str(uuid4()), str(uuid4())]
    reads: list[str] = []
    posts: list[dict] = []

    class Roster(QuietHandler):
        def _answer(self, result):
            payload = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            reads.append(self.path)
            # A second lookup would meet another holder, so a repeat shows as a second recipient as well.
            holder = holders[min(len(reads), len(holders)) - 1]
            mark = {
                "session_id": holder,
                "set_at": "2026-11-06T09:00:00Z",
                "last_activity_at": "2026-11-06T09:00:00Z",
                "expires_at": "2026-11-08T09:00:00Z",
            }
            self._answer({"participants": [], "next_session_id": None, "pm": mark})

        def do_POST(self):
            posts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self._answer({"id": str(uuid4())})

    send = ("send", "--room", room, "--kind", "question", "--to", "pm", "--to", "pm", "--key", str(uuid4()))
    with protocol_server(Roster) as origin:
        code, result = transport_cli(origin, send, b"to the PM, named twice")
    assert code == 0, result
    assert reads == [f"/v1/rooms/{room}/participants?limit=1"]
    assert [post["recipients"] for post in posts] == [[holders[0]]]


@pytest.fixture(scope="module")
def local_certificate(tmp_path_factory):
    openssl = shutil.which("openssl")
    assert openssl is not None, "UNAVAILABLE: openssl required for real TLS client tests"
    directory = tmp_path_factory.mktemp("chat-tls")
    key, cert = directory / "key.pem", directory / "cert.pem"
    subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=synthetic.invalid",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=20,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return context, cert


def test_tls_verifies_peer_and_never_enables_keylog(transport_cli, local_certificate, tmp_path):
    context, cert = local_certificate
    accepted = []

    class Healthy(QuietHandler):
        def do_GET(self):
            accepted.append(True)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"synthetic":true}')

    with protocol_server(Healthy, context) as origin:
        assert transport_cli(origin)[1]["error"]["code"] == "TRANSPORT_UNAVAILABLE"
        log = tmp_path / "must-not-exist.log"
        code, result = transport_cli(origin, environment={"SSL_CERT_FILE": str(cert), "SSLKEYLOGFILE": str(log)})
        assert code == 0 and result["result"]["synthetic"] is True
        assert not log.exists()
        wrong_name = origin.replace("127.0.0.1", "localhost")
        assert (
            transport_cli(wrong_name, environment={"SSL_CERT_FILE": str(cert)})[1]["error"]["code"]
            == "TRANSPORT_UNAVAILABLE"
        )
    assert accepted == [True]
