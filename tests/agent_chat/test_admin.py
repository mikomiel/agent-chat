"""The admin entry point: configuration, the systemd credential, and `serve`, `migrate` and `prune`."""

from __future__ import annotations

import io
import json
import logging
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from contextlib import closing
from hashlib import sha256
from http.client import HTTPConnection
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4, uuid5

import pytest
import uvicorn
from psycopg import Connection

from agent_chat import admin, browser, retention, storage
from agent_chat.auth import authenticate
from agent_chat.models import ChatError, Publication
from agent_chat.publication import publish
from agent_chat.storage import connect

# Synthetic DSN with recognisable markers and no credential field; output checks look for the markers.
SECRET_DSN = "host=/nonexistent dbname=chat user=sentinel-dsn-user application_name=sentinel-dsn-marker"


@pytest.fixture
def workdir(tmp_path):
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    return tmp_path


def write_config(workdir, **overrides):
    config = {"bind_host": "127.0.0.1", "port": 8443, **overrides}
    path = workdir / "config.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return str(path)


def write_dsn(workdir, dsn, name="agent-chat-dsn"):
    (workdir / "credentials" / name).write_text(dsn + "\n", encoding="utf-8")
    return {"CREDENTIALS_DIRECTORY": str(workdir / "credentials")}


def run(argv, *, environ=None, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    code = admin.main(argv, stdin=io.StringIO(stdin), stdout=out, stderr=err, environ=environ or {})
    return code, out.getvalue(), err.getvalue()


@pytest.fixture
def no_listener(monkeypatch):
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    return calls


@pytest.mark.parametrize(
    "overrides",
    [
        {"unexpected": 1},
        {"port": 80},
        {"port": 65536},
        {"port": "8443"},
        {"port": True},
        {"enabled": "yes"},
        {"bind_host": ""},
        {"public_origin": "http://chat.example.test"},
        {"public_origin": "https://chat.example.test/path"},
        {"public_origin": "https://chat.example.test:443"},
        {"dsn_credential": "../dsn"},
        {"dsn_credential": "sub/dsn"},
        {"dsn_credential": ".hidden"},
        {"dsn_credential": ""},
    ],
)
def test_invalid_configuration_is_a_coded_usage_failure(workdir, no_listener, overrides):
    code, out, err = run(["serve", "--config", write_config(workdir, **overrides)])
    assert (code, out, err) == (2, "", "agent-chat-admin: CONFIG_INVALID\n")
    assert no_listener == []


def test_configuration_failures_do_not_echo_input(workdir):
    path = workdir / "config.json"
    path.write_text('{"bind_host": "127.0.0.1", "port": 8443, "password": "hunter2-marker"}', encoding="utf-8")
    code, out, err = run(["migrate", "--config", str(path)])
    assert (code, out, err) == (2, "", "agent-chat-admin: CONFIG_INVALID\n")
    path.write_text("not json hunter2-marker", encoding="utf-8")
    assert run(["migrate", "--config", str(path)]) == (2, "", "agent-chat-admin: CONFIG_INVALID\n")
    path.write_text("[]", encoding="utf-8")
    assert run(["migrate", "--config", str(path)]) == (2, "", "agent-chat-admin: CONFIG_INVALID\n")


def test_missing_configuration_file_is_coded(workdir):
    assert run(["serve", "--config", str(workdir / "absent.json")]) == (
        2,
        "",
        "agent-chat-admin: CONFIG_UNREADABLE\n",
    )


@pytest.mark.parametrize(
    "argv", [[], ["serve"], ["bogus", "--config", "x"], ["serve", "--config", "x", "--secret-flag"]]
)
def test_usage_failures_are_coded_and_echo_nothing(argv):
    code, out, err = run(argv)
    assert (code, out) == (2, "")
    assert err == "agent-chat-admin: USAGE (see --help)\n"


def test_help_exits_zero(capsys):
    code = admin.main(["--help"])
    assert code == 0
    assert "serve" in capsys.readouterr().out


def test_serve_disabled_is_inert_and_never_reads_the_dsn(workdir, no_listener):
    # CREDENTIALS_DIRECTORY is absent: a read attempt would fail with a different code.
    default = write_config(workdir)
    assert run(["serve", "--config", default]) == (0, "", "agent-chat-admin: DISABLED\n")
    explicit = write_config(workdir, enabled=False, delivery_enabled=True, public_origin="https://chat.example.test")
    assert run(["serve", "--config", explicit]) == (0, "", "agent-chat-admin: DISABLED\n")
    assert no_listener == []


def test_serve_enabled_without_credentials_directory_is_coded(workdir, no_listener):
    code, out, err = run(["serve", "--config", write_config(workdir, enabled=True)])
    assert (code, out, err) == (2, "", "agent-chat-admin: CREDENTIALS_DIRECTORY_MISSING\n")
    assert no_listener == []


def test_serve_enabled_without_credential_file_is_coded(workdir, no_listener):
    environ = {"CREDENTIALS_DIRECTORY": str(workdir / "credentials")}
    code, out, err = run(["serve", "--config", write_config(workdir, enabled=True)], environ=environ)
    assert (code, out, err) == (2, "", "agent-chat-admin: DSN_CREDENTIAL_UNREADABLE\n")
    assert no_listener == []


def test_empty_credential_file_is_rejected(workdir, no_listener):
    (workdir / "credentials" / "agent-chat-dsn").write_text("\n", encoding="utf-8")
    environ = {"CREDENTIALS_DIRECTORY": str(workdir / "credentials")}
    code, _, err = run(["serve", "--config", write_config(workdir, enabled=True)], environ=environ)
    assert (code, err) == (2, "agent-chat-admin: DSN_CREDENTIAL_UNREADABLE\n")


def test_dsn_is_read_only_from_the_credential_file(workdir, no_listener):
    # A DSN in the environment or argv is never consulted.
    environ = {"DATABASE_URL": SECRET_DSN, "DSN": SECRET_DSN, "AGENT_CHAT_DSN": SECRET_DSN}
    code, out, err = run(["serve", "--config", write_config(workdir, enabled=True)], environ=environ)
    assert code == 2 and SECRET_DSN not in out + err and "sentinel-dsn" not in out + err
    assert no_listener == []


def test_serve_enabled_starts_one_uvicorn_listener_with_the_pinned_options(workdir, no_listener, monkeypatch):
    created = []
    real = admin.create_app

    def spy(dsn, **options):
        created.append((dsn, options))
        return real(dsn, **options)

    monkeypatch.setattr(admin, "create_app", spy)
    environ = write_dsn(workdir, SECRET_DSN)
    config = write_config(
        workdir, enabled=True, delivery_enabled=True, bind_host="127.0.0.2", port=9443,
        public_origin="https://chat.example.test",
    )
    code, out, err = run(["serve", "--config", config], environ=environ)
    assert (code, out, err) == (0, "", "")
    # The trailing newline of the credential file is stripped; nothing else is changed.
    assert created == [
        (
            SECRET_DSN,
            {"enabled": True, "public_origin": "https://chat.example.test", "delivery_enabled": True},
        )
    ]
    assert len(no_listener) == 1
    args, kwargs = no_listener[0]
    assert len(args) == 1
    pinned = ("host", "port", "access_log", "proxy_headers", "server_header", "timeout_graceful_shutdown")
    assert {key: kwargs.get(key) for key in pinned} == {
        "host": "127.0.0.2",
        "port": 9443,
        "access_log": False,
        "proxy_headers": False,
        "server_header": False,
        "timeout_graceful_shutdown": 10,
    }
    log_config = kwargs["log_config"]
    assert log_config["loggers"]["uvicorn.access"]["handlers"] == []
    assert log_config["handlers"]["stderr"]["stream"] == "ext://sys.stderr"


@pytest.mark.parametrize("failure", [OSError("sentinel-listener-address"), SystemExit(1), SystemExit(3)])
def test_listener_startup_failure_is_a_sanitized_operational_error(
    workdir: Path, monkeypatch: pytest.MonkeyPatch, failure: BaseException,
) -> None:
    def unavailable(*_args: object, **_kwargs: object) -> None:
        raise failure

    monkeypatch.setattr(uvicorn, "run", unavailable)
    environ = write_dsn(workdir, SECRET_DSN)
    config = write_config(workdir, enabled=True)
    assert run(["serve", "--config", config], environ=environ) == (
        1, "", "agent-chat-admin: LISTENER_UNAVAILABLE\n",
    )


@pytest.mark.parametrize("exit_code", [None, 0])
def test_listener_clean_exit_remains_successful(
    workdir: Path, monkeypatch: pytest.MonkeyPatch, exit_code: int | None,
) -> None:
    def stopped(*_args: object, **_kwargs: object) -> None:
        raise SystemExit(exit_code)

    monkeypatch.setattr(uvicorn, "run", stopped)
    environ = write_dsn(workdir, SECRET_DSN)
    config = write_config(workdir, enabled=True)
    assert run(["serve", "--config", config], environ=environ) == (0, "", "")


def test_listener_bind_failure_hides_uvicorn_address_and_error_text(workdir: Path) -> None:
    environ = write_dsn(workdir, SECRET_DSN)
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        config = write_config(workdir, enabled=True, port=occupied.getsockname()[1])
        result = subprocess.run(
            [sys.executable, "-I", "-m", "agent_chat.admin", "serve", "--config", config],
            env={**os.environ, **environ}, capture_output=True, text=True, timeout=10, check=False,
        )
    assert (result.returncode, result.stdout) == (1, "")
    assert result.stderr.count("agent-chat-admin: LISTENER_UNAVAILABLE\n") == 1
    for marker in ("127.0.0.1", "Errno", "address already in use", "Traceback", "sentinel-dsn"):
        assert marker not in result.stderr


# A client heartbeats every 30 s against a 90 s lease and lapses only when two consecutive beats fail, so a restart
# must keep the listener closed for well under 30 s. This is that period less the restart, with margin. It comes
# from the lease, not from the code under test.
LISTENER_CLOSED_LIMIT = 20


def _wait_until_healthy(child: subprocess.Popen[str], port: int) -> None:
    # Start-up is not what the caller measures: the bound only stops a hung child.
    deadline = time.monotonic() + 60
    while child.poll() is None and time.monotonic() < deadline:
        try:
            with closing(HTTPConnection("127.0.0.1", port, timeout=5)) as probe:
                probe.request("GET", "/healthz")
                if probe.getresponse().status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.05)
    if child.poll() is None:
        child.kill()
    pytest.fail(f"serve did not become healthy:\n{child.communicate()[1]}")


def test_sigterm_with_an_open_event_stream_does_not_hold_the_listener_closed(workdir, database, credentials):
    """uvicorn closes its listener on SIGTERM, then waits for open connections.

    `/v1/events` ignores shutdown for the rest of its 60 s lifetime, so without a grace limit one open stream kept
    the listener closed for up to a minute on every restart. The disposable HTTP child of the other process tests
    sets its own 3 s limit (`http_server_fixture.py`); only the real `serve` path shows the value production runs.
    """
    environ = write_dsn(workdir, database)
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    config = write_config(workdir, enabled=True, port=port)
    with subprocess.Popen(
        [sys.executable, "-I", "-m", "agent_chat.admin", "serve", "--config", config],
        env={**os.environ, **environ}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    ) as child:
        try:
            _wait_until_healthy(child, port)
            with closing(HTTPConnection("127.0.0.1", port, timeout=5)) as client:
                client.request("GET", "/v1/events", headers={"Authorization": "Bearer " + credentials.operator})
                response = client.getresponse()
                assert response.status == 200
                # The stream is open and past its authority check, so the drain has a connection to wait for.
                assert (response.readline(), response.readline()) == (b": connected\n", b"\n")
                child.send_signal(signal.SIGTERM)
                try:
                    child.communicate(timeout=LISTENER_CLOSED_LIMIT)
                except subprocess.TimeoutExpired:
                    child.kill()
                    _, stderr = child.communicate()
                    pytest.fail(f"serve still held its listener {LISTENER_CLOSED_LIMIT} s after SIGTERM:\n{stderr}")
        finally:
            if child.poll() is None:
                child.kill()


def test_serve_honours_a_custom_credential_name(workdir, no_listener):
    environ = write_dsn(workdir, SECRET_DSN, name="custom-dsn")
    config = write_config(workdir, enabled=True, dsn_credential="custom-dsn")
    assert run(["serve", "--config", config], environ=environ)[0] == 0
    assert len(no_listener) == 1


def test_serve_does_not_connect_to_the_database_at_startup(workdir, no_listener, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("serve connected to the database")

    monkeypatch.setattr("agent_chat.api.connect", refuse)
    monkeypatch.setattr(admin, "connect", refuse)
    environ = write_dsn(workdir, SECRET_DSN)
    assert run(["serve", "--config", write_config(workdir, enabled=True)], environ=environ)[0] == 0


def test_database_failure_is_coded_and_hides_connection_details(workdir):
    environ = write_dsn(workdir, SECRET_DSN)
    code, out, err = run(["migrate", "--config", write_config(workdir)], environ=environ)
    assert (code, out, err) == (1, "", "agent-chat-admin: DATABASE_UNAVAILABLE\n")
    assert "secret" not in err and "nonexistent" not in err


def test_migrate_is_idempotent_on_a_fresh_database(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ) == (
        0, "applied=1,2,3,4,5,6,7,8,9,10,11 current=11\n", ""
    )
    assert run(["migrate", "--config", config], environ=environ) == (0, "applied=none current=11\n", "")
    with connect(database) as db:
        assert [row["version"] for row in db.execute(
            "SELECT version FROM agent_chat.schema_migrations ORDER BY version"
        )] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]


def test_migrate_reports_a_schema_mismatch_by_code(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute("UPDATE agent_chat.schema_migrations SET digest = repeat('0', 64) WHERE version = 1")
    assert run(["migrate", "--config", config], environ=environ) == (1, "", "agent-chat-admin: SCHEMA_MISMATCH\n")


def _record_legacy_digests(database):
    with connect(database) as db:
        for version in sorted(storage.LEGACY_DIGESTS):
            db.execute(
                "UPDATE agent_chat.schema_migrations SET digest = %s WHERE version = %s",
                (min(storage.LEGACY_DIGESTS[version]), version),
            )


def test_a_reviewed_legacy_digest_is_accepted_and_left_in_place(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    _record_legacy_digests(database)
    assert run(["migrate", "--config", config], environ=environ) == (0, "applied=none current=11\n", "")
    with connect(database) as db:
        recorded = {
            row["version"]: row["digest"]
            for row in db.execute("SELECT version, digest FROM agent_chat.schema_migrations")
        }
        assert {version: recorded[version] for version in storage.LEGACY_DIGESTS} == {
            version: min(digests) for version, digests in storage.LEGACY_DIGESTS.items()
        }


def test_an_unreviewed_digest_is_refused_on_a_version_with_legacy_values(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute("UPDATE agent_chat.schema_migrations SET digest = repeat('0', 64) WHERE version = 9")
    assert run(["migrate", "--config", config], environ=environ) == (1, "", "agent-chat-admin: SCHEMA_MISMATCH\n")


def test_a_legacy_digest_recorded_for_another_version_is_refused(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute(
            "UPDATE agent_chat.schema_migrations SET digest = %s WHERE version = 9",
            (min(storage.LEGACY_DIGESTS[11]),),
        )
    assert run(["migrate", "--config", config], environ=environ) == (1, "", "agent-chat-admin: SCHEMA_MISMATCH\n")


_REVIEWED_LEGACY_DIGESTS = {
    9: "39ba29970ae65754207d4ef985715aea1fad9c3b8b5b6cbe7789de7170ebb2ab",
    11: "e4e5ea6f47acebb4d33b226651f613fdabe36ce443ac907c1a6066d3c15bda29",
}


def test_the_legacy_map_is_exactly_the_two_reviewed_digests():
    assert {version: sorted(values) for version, values in storage.LEGACY_DIGESTS.items()} == {
        version: [digest] for version, digest in _REVIEWED_LEGACY_DIGESTS.items()
    }


def test_a_legacy_prefix_still_applies_the_pending_migrations(workdir, database, monkeypatch):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    with monkeypatch.context() as patch:
        patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:9])
        assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute(
            "UPDATE agent_chat.schema_migrations SET digest = %s WHERE version = 9",
            (_REVIEWED_LEGACY_DIGESTS[9],),
        )
    assert run(["migrate", "--config", config], environ=environ) == (0, "applied=10,11 current=11\n", "")
    with connect(database) as db:
        recorded = {row["version"]: row["digest"]
                    for row in db.execute("SELECT version, digest FROM agent_chat.schema_migrations")}
    assert recorded[9] == _REVIEWED_LEGACY_DIGESTS[9]
    assert recorded[10] == _digest("010_quota_backfill.sql")
    assert recorded[11] == _digest("011_roles_and_work.sql")


def test_an_interior_gap_in_the_ledger_is_refused(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute("DELETE FROM agent_chat.schema_migrations WHERE version = 5")
    assert run(["migrate", "--config", config], environ=environ) == (1, "", "agent-chat-admin: SCHEMA_MISMATCH\n")


def test_legacy_digests_swapped_between_versions_are_refused(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute("UPDATE agent_chat.schema_migrations SET digest = %s WHERE version = 9",
                   (_REVIEWED_LEGACY_DIGESTS[11],))
        db.execute("UPDATE agent_chat.schema_migrations SET digest = %s WHERE version = 11",
                   (_REVIEWED_LEGACY_DIGESTS[9],))
    assert run(["migrate", "--config", config], environ=environ) == (1, "", "agent-chat-admin: SCHEMA_MISMATCH\n")


def _digest(name):
    return sha256((Path(admin.__file__).parent / name).read_bytes()).hexdigest()


def _reviewed(*lines):
    return "reviewed=" + sha256("".join(f"{line}\n" for line in lines).encode()).hexdigest()


def test_migrate_check_lists_every_pending_file_with_its_digest_and_creates_nothing(workdir, database):
    environ = write_dsn(workdir, database)
    code, out, err = run(["migrate", "--config", write_config(workdir), "--check"], environ=environ)
    assert (code, err) == (0, "")
    lines = [f"{version} {name} sha256={_digest(name)}" for version, name in enumerate(storage.MIGRATIONS, 1)]
    # The reviewed digest is the sha256 of the exact pending lines, each followed by a newline.
    assert out.splitlines() == ["pending=11", *lines, _reviewed(*lines)]
    with connect(database) as db:
        assert db.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'agent_chat'").fetchone() is None


def test_migrate_check_lists_only_the_pending_files_and_applies_none_of_them(workdir, database, monkeypatch):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    with connect(database) as db, monkeypatch.context() as patch:
        patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:8])
        storage.migrate(db)
    code, out, err = run(["migrate", "--config", config, "--check"], environ=environ)
    assert (code, err) == (0, "")
    line9 = f"9 009_pm_mark.sql sha256={_digest('009_pm_mark.sql')}"
    line10 = f"10 010_quota_backfill.sql sha256={_digest('010_quota_backfill.sql')}"
    line11 = f"11 011_roles_and_work.sql sha256={_digest('011_roles_and_work.sql')}"
    assert out == f"pending=3\n{line9}\n{line10}\n{line11}\n{_reviewed(line9, line10, line11)}\n"
    with connect(database) as db:
        assert [row["version"] for row in db.execute("SELECT version FROM agent_chat.schema_migrations")] == [
            1, 2, 3, 4, 5, 6, 7, 8,
        ]
        table = db.execute("SELECT to_regclass('agent_chat.room_pm') AS name").fetchone()
        assert table is not None and table["name"] is None
    # What the check listed is what the apply then runs.
    assert run(["migrate", "--config", config], environ=environ) == (0, "applied=9,10,11 current=11\n", "")


def _reviewed_digest(environ, config):
    code, out, err = run(["migrate", "--config", config, "--check"], environ=environ)
    assert (code, err) == (0, "")
    return [line for line in out.splitlines() if line.startswith("reviewed=")]


def test_the_reviewed_digest_changes_with_the_content_the_set_and_the_order_of_the_migrations(
    workdir, database, monkeypatch
):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    baseline = _reviewed_digest(environ, config)
    assert len(baseline) == 1
    assert _reviewed_digest(environ, config) == baseline  # stable across runs
    # A private copy of the migration files, so one can change without touching the source tree.
    copy = workdir / "migrations"
    copy.mkdir()
    for name in storage.MIGRATIONS:
        (copy / name).write_bytes((Path(storage.__file__).parent / name).read_bytes())
    monkeypatch.setattr(storage, "__file__", str(copy / "storage.py"))
    assert _reviewed_digest(environ, config) == baseline  # the copy is the same set
    # One byte in one file.
    (copy / "003_harness_admission.sql").write_bytes((copy / "003_harness_admission.sql").read_bytes() + b"\n")
    changed = _reviewed_digest(environ, config)
    assert len(changed) == 1 and changed != baseline
    (copy / "003_harness_admission.sql").write_bytes(
        (Path(admin.__file__).parent / "003_harness_admission.sql").read_bytes()
    )
    # A migration file added to the set.
    (copy / "010_extra.sql").write_text("SELECT 1;\n", encoding="utf-8")
    monkeypatch.setattr(storage, "MIGRATIONS", (*storage.MIGRATIONS, "010_extra.sql"))
    added = _reviewed_digest(environ, config)
    assert len(added) == 1 and added not in (baseline, changed)
    # The same files in another order.
    monkeypatch.setattr(storage, "MIGRATIONS", (storage.MIGRATIONS[1], storage.MIGRATIONS[0], *storage.MIGRATIONS[2:]))
    reordered = _reviewed_digest(environ, config)
    assert len(reordered) == 1 and reordered not in (baseline, changed, added)


def _schema_state(database):
    with connect(database) as db:
        schema = db.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'agent_chat'").fetchone()
        if schema is None:
            return None
        return [row["version"] for row in db.execute(
            "SELECT version FROM agent_chat.schema_migrations ORDER BY version"
        )]


def _apply_reviewed(environ, config, line):
    return run(["migrate", "--config", config, "--reviewed", line.removeprefix("reviewed=")], environ=environ)


def test_migrate_applies_when_the_reviewed_digest_matches_the_pending_set(workdir, database, monkeypatch):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    with connect(database) as db, monkeypatch.context() as patch:
        patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:8])
        storage.migrate(db)
    (digest,) = _reviewed_digest(environ, config)
    code, out, err = _apply_reviewed(environ, config, digest)
    assert (code, out, err) == (0, "applied=9,10,11 current=11\n", "")
    assert _schema_state(database) == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]


def test_migrate_refuses_a_mismatching_reviewed_digest_without_running_any_ddl(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    for wrong in ("0" * 64, sha256(b"").hexdigest()):
        code, out, err = run(["migrate", "--config", config, "--reviewed", wrong], environ=environ)
        assert (code, out, err) == (1, "", "agent-chat-admin: REVIEW_MISMATCH\n")
        assert wrong not in err
        # Even the bookkeeping schema stays absent: the refusal comes before any DDL.
        assert _schema_state(database) is None


def test_migrate_refuses_when_a_migration_is_added_between_the_check_and_the_apply(workdir, database, monkeypatch):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    with connect(database) as db, monkeypatch.context() as patch:
        patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:5])
        storage.migrate(db)
    (digest,) = _reviewed_digest(environ, config)
    # A deploy lands a new migration after the review: the editable install reads it from the checkout.
    copy = workdir / "migrations"
    copy.mkdir()
    for name in storage.MIGRATIONS:
        (copy / name).write_bytes((Path(storage.__file__).parent / name).read_bytes())
    (copy / "010_extra.sql").write_text("CREATE TABLE agent_chat.unreviewed (id integer);\n", encoding="utf-8")
    monkeypatch.setattr(storage, "__file__", str(copy / "storage.py"))
    monkeypatch.setattr(storage, "MIGRATIONS", (*storage.MIGRATIONS, "010_extra.sql"))
    code, out, err = _apply_reviewed(environ, config, digest)
    assert (code, out, err) == (1, "", "agent-chat-admin: REVIEW_MISMATCH\n")
    assert _schema_state(database) == [1, 2, 3, 4, 5]
    with connect(database) as db:
        row = db.execute("SELECT to_regclass('agent_chat.unreviewed') AS name").fetchone()
        assert row is not None and row["name"] is None


def test_migrate_refuses_a_reviewed_digest_once_the_pending_set_was_applied_elsewhere(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    (digest,) = _reviewed_digest(environ, config)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    code, out, err = _apply_reviewed(environ, config, digest)
    assert (code, out, err) == (1, "", "agent-chat-admin: REVIEW_MISMATCH\n")
    assert _schema_state(database) == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]


@pytest.mark.parametrize("value", ["", "abc", "A" * 64, "g" * 64, "0" * 63, "0" * 65])
def test_migrate_rejects_a_malformed_reviewed_digest_as_usage(workdir, value):
    code, out, err = run(["migrate", "--config", write_config(workdir), "--reviewed", value])
    assert (code, out, err) == (2, "", "agent-chat-admin: USAGE (see --help)\n")


def test_migrate_check_prints_pending_zero_when_current(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    assert run(["migrate", "--config", config, "--check"], environ=environ) == (0, "pending=0\n", "")


def test_migrate_check_reports_a_schema_mismatch_by_code(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    assert run(["migrate", "--config", config], environ=environ)[0] == 0
    with connect(database) as db:
        db.execute("UPDATE agent_chat.schema_migrations SET digest = repeat('0', 64) WHERE version = 1")
    assert run(["migrate", "--config", config, "--check"], environ=environ) == (
        1, "", "agent-chat-admin: SCHEMA_MISMATCH\n",
    )


def test_migrate_check_takes_the_migration_lock(workdir, database):
    environ = write_dsn(workdir, database)
    config = write_config(workdir)
    with connect(database) as holder:
        holder.execute("BEGIN")
        holder.execute("SELECT pg_advisory_xact_lock(617204831095)")
        # connect() bounds lock waits at 3s; a second migrator cannot proceed while the lock is held.
        code, out, err = run(["migrate", "--config", config, "--check"], environ=environ)
        holder.execute("ROLLBACK")
    assert (code, out) == (1, "")
    assert err == "agent-chat-admin: DATABASE_UNAVAILABLE\n"


def test_prune_on_an_empty_database_stops_after_one_batch(workdir, db, database):
    environ = write_dsn(workdir, database)
    assert run(["prune", "--config", write_config(workdir)], environ=environ) == (
        0,
        "batches=1 events=0 redacted=0 deleted=0 ended_instances=0 memberships=0 expired_undelivered=0\n",
        "",
    )


def test_prune_removes_expired_rows_and_terminates(workdir, db, database, actors):
    room, sender, _, _ = actors
    message = publish(db, sender, room, uuid4(), Publication(kind="message", body="expired body"))
    db.execute(
        "UPDATE agent_chat.messages SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = %s",
        (message["id"],),
    )
    db.execute(
        "UPDATE agent_chat.events SET created_at = clock_timestamp() - interval '721 hours' WHERE message_id = %s",
        (message["id"],),
    )
    environ = write_dsn(workdir, database)
    code, out, err = run(["prune", "--config", write_config(workdir), "--limit", "1"], environ=environ)
    assert (code, err) == (0, "")
    fields = dict(part.split("=") for part in out.split())
    assert int(fields["events"]) == 1 and int(fields["redacted"]) == 1 and int(fields["deleted"]) == 1
    assert "expired body" not in out
    assert db.execute("SELECT count(*) AS n FROM agent_chat.messages").fetchone()["n"] == 0


def test_prune_is_bounded_by_max_batches(workdir, database, monkeypatch):
    calls = []

    def always_removes(_db, limit):
        calls.append(limit)
        return {
            "events": 1, "redacted": 2, "deleted": 3, "ended_instances": 4, "memberships": 5, "expired_undelivered": 6,
        }

    monkeypatch.setattr(retention, "prune", always_removes)
    environ = write_dsn(workdir, database)
    code, out, _ = run(
        ["prune", "--config", write_config(workdir), "--limit", "7", "--max-batches", "3"], environ=environ
    )
    # The first four keys keep their order: the journal line is read by key with LogQL.
    assert (code, out) == (
        0,
        "batches=3 events=3 redacted=6 deleted=9 ended_instances=12 memberships=15 expired_undelivered=18\n",
    )
    assert calls == [7, 7, 7]


def test_prune_stops_on_the_first_empty_batch(workdir, database, monkeypatch):
    keys = ("events", "redacted", "deleted", "ended_instances", "memberships", "expired_undelivered")
    quiet = dict.fromkeys(keys, 0)
    results = iter([{**quiet, "events": 2, "expired_undelivered": 1}, quiet])
    monkeypatch.setattr(retention, "prune", lambda _db, limit: next(results))
    environ = write_dsn(workdir, database)
    assert run(["prune", "--config", write_config(workdir)], environ=environ)[1] == (
        "batches=2 events=2 redacted=0 deleted=0 ended_instances=0 memberships=0 expired_undelivered=1\n"
    )


@pytest.mark.parametrize("flags", [["--limit", "0"], ["--limit", "1001"], ["--max-batches", "0"], ["--limit", "x"]])
def test_prune_rejects_out_of_range_bounds_before_reading_the_dsn(workdir, flags):
    code, out, err = run(["prune", "--config", write_config(workdir), *flags])
    assert (code, out) == (2, "")
    assert err.startswith("agent-chat-admin: USAGE")


def test_module_entry_point_prints_usage_without_a_traceback():
    result = subprocess.run(
        [sys.executable, "-I", "-m", "agent_chat.admin", "--help"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0
    assert "serve" in result.stdout and "Traceback" not in result.stderr
    failure = subprocess.run(
        [sys.executable, "-I", "-m", "agent_chat.admin", "serve"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    assert failure.returncode == 2
    assert failure.stderr == "agent-chat-admin: USAGE (see --help)\n"


# Principal provisioning. A name maps to uuid5(PRINCIPAL_NAMESPACE, name); the schema stores no name.


def ensure(workdir, database, token, *flags, name="alpha"):
    argv = ["principal", "ensure", "--config", write_config(workdir), "--name", name, *flags]
    return run(argv, environ=write_dsn(workdir, database), stdin=token + "\n")


def revoke(workdir, database, name="alpha"):
    argv = ["principal", "revoke", "--config", write_config(workdir), "--name", name]
    return run(argv, environ=write_dsn(workdir, database))


def expected_id(name):
    return uuid5(admin.PRINCIPAL_NAMESPACE, name)


def row(db, name="alpha"):
    return db.execute("SELECT * FROM agent_chat.principals WHERE id = %s", (expected_id(name),)).fetchone()


def is_member(db, name="alpha"):
    return (
        db.execute(
            """SELECT 1 FROM agent_chat.principal_rooms pr JOIN agent_chat.rooms r ON r.id = pr.room_id
            WHERE pr.principal_id = %s AND r.slug = 'homelab'""",
            (expected_id(name),),
        ).fetchone()
        is not None
    )


AGENT = ("--kind", "agent", "--host", "node-a", "--harness", "pi")


def test_namespace_and_id_derivation_are_pinned():
    # Changing the namespace would orphan every provisioned principal.
    assert admin.PRINCIPAL_NAMESPACE == UUID("6b5a50e4-028b-4409-874a-46b9e4a3b372")
    assert expected_id("alpha") == uuid5(UUID("6b5a50e4-028b-4409-874a-46b9e4a3b372"), "alpha")
    assert admin._principal_id("alpha") == admin._principal_id("alpha") != admin._principal_id("beta")


def test_ensure_creates_an_agent_that_authenticates_and_joins_homelab(workdir, db, database):
    token = secrets.token_hex(32)
    code, out, err = ensure(workdir, database, token, *AGENT)
    assert (code, err) == (0, "")
    assert out == f"alpha {expected_id('alpha')} created\n"
    stored = row(db)
    assert (stored["kind"], stored["host"], stored["harness"], stored["producer"], stored["revoked"]) == (
        "agent",
        "node-a",
        "pi",
        None,
        False,
    )
    assert stored["credential_hash"] == sha256(token.encode()).hexdigest()
    assert authenticate(db, token, registration=True).principal_id == expected_id("alpha")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate(db, token)  # an agent token is not an operator token
    assert is_member(db)


def test_ensure_creates_an_operator(workdir, db, database):
    token = secrets.token_hex(32)
    code, out, _ = ensure(workdir, database, token, "--kind", "operator", name="ops.admin")
    assert (code, out) == (0, f"ops.admin {expected_id('ops.admin')} created\n")
    assert authenticate(db, token).principal_id == expected_id("ops.admin")
    assert is_member(db, "ops.admin")


def test_ensure_is_unchanged_on_repeat(workdir, db, database):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, *AGENT)
    before = row(db)
    assert ensure(workdir, database, token, *AGENT)[1] == f"alpha {expected_id('alpha')} unchanged\n"
    assert row(db) == before
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principal_rooms").fetchone()["n"] == 1


def test_ensure_rotates_the_token_and_clears_revocation(workdir, db, database):
    old, new = secrets.token_hex(32), secrets.token_hex(32)
    ensure(workdir, database, old, *AGENT)
    assert revoke(workdir, database)[0] == 0
    assert ensure(workdir, database, new, *AGENT)[1] == f"alpha {expected_id('alpha')} rotated\n"
    assert row(db)["revoked"] is False
    assert authenticate(db, new, registration=True).principal_id == expected_id("alpha")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate(db, old, registration=True)


def test_ensure_restores_a_revoked_principal_with_the_same_token(workdir, db, database):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, *AGENT)
    revoke(workdir, database)
    assert ensure(workdir, database, token, *AGENT)[1] == f"alpha {expected_id('alpha')} restored\n"
    assert authenticate(db, token, registration=True).principal_id == expected_id("alpha")


def test_ensure_restores_membership_removed_out_of_band(workdir, db, database):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, *AGENT)
    db.execute("DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s", (expected_id("alpha"),))
    assert ensure(workdir, database, token, *AGENT)[1].endswith(" unchanged\n")
    assert is_member(db)


@pytest.mark.parametrize("harness", ["deepseek", "opencode"])
def test_ensure_admits_the_deepseek_and_opencode_harnesses(workdir, db, database, harness):
    code, out, err = ensure(
        workdir, database, secrets.token_hex(32), "--kind", "agent", "--host", "node-a", "--harness", harness
    )
    assert (code, err) == (0, "")
    assert out == f"alpha {expected_id('alpha')} created\n"
    assert (row(db)["kind"], row(db)["harness"], row(db)["revoked"]) == ("agent", harness, False)
    assert is_member(db)


@pytest.mark.parametrize(
    "flags",
    [
        ("--kind", "operator"),
        ("--kind", "agent", "--host", "other", "--harness", "pi"),
        ("--kind", "agent", "--host", "node-a", "--harness", "codex"),
    ],
)
def test_ensure_refuses_a_different_shape_under_the_same_name(workdir, db, database, flags):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, *AGENT)
    before = row(db)
    code, out, err = ensure(workdir, database, secrets.token_hex(32), *flags)
    assert (code, out, err) == (1, "", "agent-chat-admin: PRINCIPAL_CONFLICT\n")
    assert row(db) == before


def test_ensure_refuses_a_token_used_by_another_principal(workdir, db, database):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, *AGENT, name="alpha")
    code, out, err = ensure(workdir, database, token, *AGENT, name="beta")
    assert (code, out, err) == (1, "", "agent-chat-admin: TOKEN_IN_USE\n")
    assert row(db, "beta") is None
    # Rotation onto a token another principal owns is refused and changes nothing.
    other = secrets.token_hex(32)
    ensure(workdir, database, other, *AGENT, name="gamma")
    before = row(db, "gamma")
    assert ensure(workdir, database, token, *AGENT, name="gamma")[2] == "agent-chat-admin: TOKEN_IN_USE\n"
    assert row(db, "gamma") == before


@pytest.mark.parametrize(
    "token",
    [
        "",
        "short",
        "A" * 64,
        "g" * 64,
        "a" * 63,
        "a" * 65,
        "a" * 64 + "\n\n",
        " " + "a" * 64,
        "a" * 64 + " ",
        "a" * 64 + "\r\n",
    ],
)
def test_ensure_rejects_a_malformed_stdin_token(workdir, db, database, token):
    code, out, err = run(
        ["principal", "ensure", "--config", write_config(workdir), "--name", "alpha", *AGENT],
        environ=write_dsn(workdir, database),
        stdin=token,
    )
    assert (code, out, err) == (2, "", "agent-chat-admin: TOKEN_INVALID\n")
    assert row(db) is None


def test_ensure_accepts_a_token_without_a_trailing_newline(workdir, db, database):
    token = secrets.token_hex(32)
    code, out, _ = run(
        ["principal", "ensure", "--config", write_config(workdir), "--name", "alpha", *AGENT],
        environ=write_dsn(workdir, database),
        stdin=token,
    )
    assert (code, out) == (0, f"alpha {expected_id('alpha')} created\n")


def test_token_and_digest_never_appear_in_output(workdir, db, database):
    token = secrets.token_hex(32)
    digest = sha256(token.encode()).hexdigest()
    outputs = []
    for step in (
        lambda: ensure(workdir, database, token, *AGENT),
        lambda: ensure(workdir, database, token, *AGENT),
        lambda: ensure(workdir, database, token, *AGENT, name="beta"),
        lambda: ensure(workdir, database, token, "--kind", "operator"),
        lambda: ensure(workdir, database, token[:-1] + "Z", *AGENT),
        lambda: revoke(workdir, database),
    ):
        outputs.extend(step()[1:])
    text = "\n".join(outputs)
    assert token not in text and digest not in text and token[:16] not in text


@pytest.mark.parametrize(
    "flags",
    [
        ("--kind", "agent"),
        ("--kind", "agent", "--host", "node-a"),
        ("--kind", "agent", "--harness", "pi"),
        ("--kind", "agent", "--host", "Bad_Host", "--harness", "pi"),
        ("--kind", "agent", "--host", "node-a", "--harness", "vim"),
        ("--kind", "operator", "--host", "node-a"),
        ("--kind", "operator", "--harness", "pi"),
        ("--kind", "producer", "--host", "node-a"),
    ],
)
def test_ensure_mirrors_the_principal_shape(workdir, db, database, flags):
    code, out, err = ensure(workdir, database, secrets.token_hex(32), *flags)
    assert (code, out) == (2, "")
    assert err.startswith("agent-chat-admin: USAGE")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 0


def test_producer_provision_rotate_revoke_and_shape_conflicts(workdir, db, database):
    from agent_chat.auth import authenticate_producer

    token, rotated = secrets.token_hex(32), secrets.token_hex(32)
    flags = ("--kind", "producer", "--host", "node-a", "--producer", "validation-lease")
    assert ensure(workdir, database, token, *flags)[0] == 0
    stored = row(db)
    assert (stored["kind"], stored["host"], stored["harness"], stored["producer"]) == (
        "producer", "node-a", None, "validation-lease"
    )
    assert is_member(db)
    assert authenticate_producer(db, token).principal_id == expected_id("alpha")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate(db, token, registration=True)
    assert ensure(workdir, database, token, *flags)[1].endswith(" unchanged\n")
    assert ensure(workdir, database, rotated, *flags)[1].endswith(" rotated\n")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate_producer(db, token)
    assert revoke(workdir, database)[0] == 0
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate_producer(db, rotated)
    assert ensure(workdir, database, rotated, *flags)[1].endswith(" restored\n")
    for conflicting in (AGENT, ("--kind", "producer", "--host", "other", "--producer", "validation-lease")):
        code, out, err = ensure(workdir, database, rotated, *conflicting)
        assert (code, out, err) == (1, "", "agent-chat-admin: PRINCIPAL_CONFLICT\n")


@pytest.mark.parametrize(
    "flags",
    [
        ("--kind", "producer", "--producer", "validation-lease"),
        ("--kind", "producer", "--host", "Bad_Host", "--producer", "validation-lease"),
        ("--kind", "producer", "--host", "node-a", "--producer", "Bad_Producer"),
        ("--kind", "producer", "--host", "node-a", "--producer", "validation-lease", "--harness", "pi"),
        (*AGENT, "--producer", "validation-lease"),
        ("--kind", "operator", "--producer", "validation-lease"),
    ],
)
def test_producer_flags_cannot_widen_principal_shape(workdir, db, database, flags):
    code, out, err = ensure(workdir, database, secrets.token_hex(32), *flags)
    assert (code, out) == (2, "")
    assert err.startswith("agent-chat-admin: USAGE")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 0


@pytest.mark.parametrize(
    "flags",
    [AGENT, ("--kind", "operator"), ("--kind", "producer", "--host", "node-a", "--producer", "validation-lease")],
)
def test_principal_json_reports_only_granted_metadata(workdir, db, database, flags):
    token = secrets.token_hex(32)
    code, out, err = ensure(workdir, database, token, *flags, "--json")
    room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = 'homelab'").fetchone()["id"]
    assert code == 0 and err == ""
    assert json.loads(out) == {"principal_id": str(expected_id("alpha")), "room_id": str(room), "outcome": "created"}
    assert token not in out
    assert json.loads(ensure(workdir, database, token, *flags, "--json")[1])["outcome"] == "unchanged"


def test_principal_json_bad_arguments_never_echo_the_token(workdir, db, database):
    token = secrets.token_hex(32)
    code, out, err = ensure(
        workdir, database, token, "--kind", "producer", "--host", "node-a", "--json", "--token", token
    )
    assert (code, out, err) == (2, "", "agent-chat-admin: USAGE (see --help)\n")
    assert token not in out + err
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 0


@pytest.mark.parametrize("name", ["", "Alpha", "-alpha", ".alpha", "a b", "a/b", "a" * 65, "alpha\n", "ünï"])
def test_principal_names_are_validated(workdir, db, database, name):
    assert ensure(workdir, database, secrets.token_hex(32), *AGENT, name=name)[2].startswith("agent-chat-admin: USAGE")
    assert revoke(workdir, database, name)[2].startswith("agent-chat-admin: USAGE")
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 0


@pytest.mark.parametrize("name", ["a", "alpha", "a.b_c-d", "0" + "x" * 63])
def test_valid_principal_names_are_accepted(workdir, db, database, name):
    assert ensure(workdir, database, secrets.token_hex(32), *AGENT, name=name)[0] == 0


def test_same_name_always_gives_the_same_id_across_processes():
    ids = {
        subprocess.run(
            [sys.executable, "-I", "-c", "from agent_chat.admin import _principal_id; print(_principal_id('alpha'))"],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout.strip()
        for _ in range(2)
    }
    assert ids == {str(expected_id("alpha"))}


def test_ensure_never_reads_the_token_from_argv(workdir, db, database):
    token = secrets.token_hex(32)
    argv = ["principal", "ensure", "--config", write_config(workdir), "--name", "alpha", *AGENT, "--token", token]
    code, out, err = run(argv, environ=write_dsn(workdir, database), stdin=token)
    assert (code, out, err) == (2, "", "agent-chat-admin: USAGE (see --help)\n")


def test_revoke_blocks_authentication_and_is_idempotent(workdir, db, database):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, *AGENT)
    assert revoke(workdir, database) == (0, f"alpha {expected_id('alpha')} revoked\n", "")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate(db, token, registration=True)
    assert revoke(workdir, database) == (0, f"alpha {expected_id('alpha')} already_revoked\n", "")
    assert row(db)["revoked"] is True
    assert is_member(db)  # history and grants stay


def test_revoke_blocks_an_operator_token(workdir, db, database):
    token = secrets.token_hex(32)
    ensure(workdir, database, token, "--kind", "operator", name="ops")
    revoke(workdir, database, "ops")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        authenticate(db, token)


def test_revoke_of_an_unknown_name_is_coded(workdir, db, database):
    assert revoke(workdir, database, "nobody") == (1, "", "agent-chat-admin: PRINCIPAL_NOT_FOUND\n")


def test_revoke_cannot_reach_a_principal_created_outside_the_tool(workdir, db, database, credentials):
    # Names are not stored, so a hand-made principal has no name this tool can resolve.
    assert revoke(workdir, database, "agent")[2] == "agent-chat-admin: PRINCIPAL_NOT_FOUND\n"
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals WHERE revoked").fetchone()["n"] == 0


def test_principal_commands_before_migrate_report_a_missing_schema(workdir, database):
    code, out, err = ensure(workdir, database, secrets.token_hex(32), *AGENT)
    assert (code, out) == (1, "")
    assert err == "agent-chat-admin: SCHEMA_MISSING (run migrate)\n"


def test_principal_commands_hide_database_details(workdir):
    token = secrets.token_hex(32)
    code, out, err = ensure(workdir, SECRET_DSN, token, *AGENT)
    assert (code, out, err) == (1, "", "agent-chat-admin: DATABASE_UNAVAILABLE\n")


def test_concurrent_ensure_calls_serialize(workdir, db, database):
    from concurrent.futures import ThreadPoolExecutor

    token = secrets.token_hex(32)
    argv = ["principal", "ensure", "--config", write_config(workdir), "--name", "alpha", *AGENT]
    environ = write_dsn(workdir, database)
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: run(argv, environ=environ, stdin=token), range(4)))
    assert [result[0] for result in results] == [0, 0, 0, 0]
    assert sorted(result[1].split()[2] for result in results) == ["created", "unchanged", "unchanged", "unchanged"]
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 1


def test_viewer_ensure_reconciles_only_explicit_existing_room_grants(
    workdir: Path, db: Connection[dict[str, Any]], database: str,
) -> None:
    token = secrets.token_hex(32)
    first, second = uuid4(), uuid4()
    for room, slug in ((first, "first"), (second, "second")):
        db.execute("INSERT INTO agent_chat.rooms VALUES (%s, %s, %s)", (room, slug, slug))
    before_rooms = db.execute("SELECT * FROM agent_chat.rooms ORDER BY id").fetchall()
    assert ensure(workdir, database, token, "--kind", "viewer")[0] == 2
    assert row(db) is None
    assert ensure(workdir, database, token, "--kind", "viewer", "--room", str(uuid4())) == (
        1, "", "agent-chat-admin: ROOM_NOT_FOUND\n",
    )
    assert row(db) is None
    flags = ("--kind", "viewer", "--room", str(first), "--room", str(second), "--room", str(first), "--json")
    code, out, err = ensure(workdir, database, token, *flags)
    assert (code, err) == (0, "")
    assert json.loads(out) == {
        "principal_id": str(expected_id("alpha")), "room_ids": sorted([str(first), str(second)]), "outcome": "created",
    }
    assert (row(db)["host"], row(db)["harness"], row(db)["producer"]) == (None, None, None)
    assert not is_member(db)
    assert json.loads(ensure(workdir, database, token, *flags)[1])["outcome"] == "unchanged"
    session = browser.login(db, token)
    assert ensure(workdir, database, token, "--kind", "viewer", "--room", str(second))[1].endswith(" updated\n")
    assert db.execute("SELECT room_id FROM agent_chat.principal_rooms WHERE principal_id = %s",
                      (expected_id("alpha"),)).fetchall() == [{"room_id": second}]
    assert browser.authenticate_cookie(db, session.token).principal_id == expected_id("alpha")
    assert db.execute("SELECT * FROM agent_chat.rooms ORDER BY id").fetchall() == before_rooms
    assert db.execute("SELECT * FROM agent_chat.sessions").fetchall() == []


@pytest.mark.parametrize("flags", [
    ("--host", "node-a"), ("--harness", "pi"), ("--producer", "validation-lease"),
])
def test_viewer_administration_refuses_native_or_producer_metadata(
    workdir: Path, db: Connection[dict[str, Any]], database: str, flags: tuple[str, ...],
) -> None:
    room = db.execute("SELECT id FROM agent_chat.rooms").fetchone()
    assert room is not None
    result = ensure(workdir, database, secrets.token_hex(32), "--kind", "viewer", "--room", str(room["id"]), *flags)
    assert result == (2, "", "agent-chat-admin: USAGE (see --help)\n")
    assert row(db) is None


def test_viewer_rotation_and_revocation_invalidate_only_its_cookies(
    workdir: Path, db: Connection[dict[str, Any]], database: str, credentials: Any,
) -> None:
    token, rotated, other = (secrets.token_hex(32) for _ in range(3))
    room = credentials.room
    flags = ("--kind", "viewer", "--room", room)
    assert ensure(workdir, database, token, *flags)[0] == 0
    assert ensure(workdir, database, other, *flags, name="other")[0] == 0
    old = [browser.login(db, token).token for _ in range(2)]
    unrelated = [browser.login(db, other).token, browser.login(db, credentials.operator).token]
    assert ensure(workdir, database, rotated, *flags)[1].endswith(" rotated\n")
    assert db.execute("SELECT 1 FROM agent_chat.browser_sessions WHERE principal_id = %s",
                      (expected_id("alpha"),)).fetchone() is None
    for cookie in old:
        with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
            browser.authenticate_cookie(db, cookie)
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        browser.login(db, token)
    current = browser.login(db, rotated).token
    assert revoke(workdir, database)[0] == 0
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        browser.authenticate_cookie(db, current)
    assert ensure(workdir, database, rotated, *flags)[1].endswith(" restored\n")
    with pytest.raises(ChatError, match="^UNAUTHENTICATED$"):
        browser.authenticate_cookie(db, current)
    for cookie in unrelated:
        assert browser.authenticate_cookie(db, cookie)
    assert ensure(workdir, database, rotated, "--kind", "operator")[2] == "agent-chat-admin: PRINCIPAL_CONFLICT\n"
    assert ensure(workdir, database, other, *flags)[2] == "agent-chat-admin: TOKEN_IN_USE\n"
    assert ensure(workdir, database, credentials.agent, *flags, name="host-token")[2] == (
        "agent-chat-admin: TOKEN_IN_USE\n"
    )


def test_viewer_ensure_does_not_reclassify_an_instance_credential(
    workdir: Path, db: Connection[dict[str, Any]], database: str, credentials: Any,
) -> None:
    from agent_chat import sessions
    from agent_chat.models import Registration

    token = secrets.token_hex(32)
    sessions.register(db, authenticate(db, credentials.agent, registration=True), Registration(
        native_session_id="synthetic-instance", boot_id=uuid4(),
        instance_token_hash=sha256(token.encode()).hexdigest(),
    ))
    assert ensure(workdir, database, token, "--kind", "viewer", "--room", credentials.room) == (
        1, "", "agent-chat-admin: TOKEN_IN_USE\n",
    )
    assert row(db) is None
    assert authenticate(db, token).instance_id is not None


def test_viewer_migration_upgrades_004_preserves_principals_and_refuses_unknown_versions(
    database: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import psycopg.errors

    with connect(database) as db:
        with monkeypatch.context() as patch:
            patch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:4])
            storage.migrate(db)
        for kind, host, harness, producer in (
            ("operator", None, None, None), ("agent", "node-a", "deepseek", None),
            ("producer", "node-a", None, "validation-lease"),
        ):
            db.execute("INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness, producer) "
                       "VALUES (%s, %s, %s, %s, %s, %s)",
                       (uuid4(), kind, secrets.token_hex(32), host, harness, producer))
        before = db.execute("SELECT * FROM agent_chat.principals ORDER BY id").fetchall()
        storage.migrate(db)
        storage.migrate(db)
        assert db.execute("SELECT * FROM agent_chat.principals ORDER BY id").fetchall() == before
        db.execute("INSERT INTO agent_chat.principals(id, kind, credential_hash) VALUES (%s, 'viewer', %s)",
                   (uuid4(), secrets.token_hex(32)))
        for column in ("host", "harness", "producer"):
            with pytest.raises(psycopg.errors.CheckViolation):
                db.execute(f"INSERT INTO agent_chat.principals(id, kind, credential_hash, {column}) "
                           "VALUES (%s, 'viewer', %s, 'invalid')", (uuid4(), secrets.token_hex(32)))
        db.execute("INSERT INTO agent_chat.schema_migrations(version, digest) VALUES (999, %s)", ("0" * 64,))
        with pytest.raises(ChatError, match="^SCHEMA_MISMATCH$"):
            storage.migrate(db)


@pytest.mark.parametrize(
    ("level", "priority"),
    [(logging.CRITICAL, 2), (logging.ERROR, 3), (logging.WARNING, 4), (logging.INFO, 6), (logging.DEBUG, 7)],
)
def test_journal_formatter_prefixes_the_syslog_priority_on_every_line(level, priority):
    formatter = admin.LOG_CONFIG["formatters"]["plain"]["()"](fmt="%(levelname)s %(message)s")
    record = logging.LogRecord("agent_chat.api", level, __file__, 1, "first\nsecond", None, None)
    assert formatter.format(record) == f"<{priority}>{record.levelname} first\n<{priority}>second"


def test_log_config_sends_agent_chat_api_to_stderr_with_the_priority_prefix():
    # The real consumer: dictConfig in a child, so the parent's logging state is untouched.
    program = (
        "import logging, logging.config\n"
        "from agent_chat import admin\n"
        "logging.config.dictConfig(admin.LOG_CONFIG)\n"
        "logging.getLogger('agent_chat.api').warning('code=X route=/r status=403 exc=ChatError')\n"
        "logging.getLogger('agent_chat.api').error('code=Y route=/r status=503 exc=OperationalError')\n"
        "logging.getLogger('uvicorn.error').info('Started')\n"
    )
    child = subprocess.run([sys.executable, "-I", "-c", program], capture_output=True, text=True, timeout=60)
    lines = child.stderr.splitlines()
    assert (child.returncode, child.stdout, len(lines)) == (0, "", 3)
    assert lines[0].startswith("<4>")
    assert lines[0].endswith("WARNING agent_chat.api code=X route=/r status=403 exc=ChatError")
    assert lines[1].startswith("<3>") and "ERROR agent_chat.api code=Y" in lines[1]
    assert lines[2].startswith("<6>") and lines[2].endswith("INFO uvicorn.error Started")


def run_on_journal_stderr(argv, workdir, *, environ, journal=True):
    """`main` with a real file as stderr; `journal` makes JOURNAL_STREAM name that file, as systemd does."""
    out = io.StringIO()
    with open(workdir / "stderr.log", "w+", encoding="utf-8") as err:
        status = os.fstat(err.fileno())
        stream = f"{status.st_dev}:{status.st_ino}" if journal else "1:1"
        code = admin.main(argv, stdout=out, stderr=err, environ={**environ, "JOURNAL_STREAM": stream})
        err.seek(0)
        return code, out.getvalue(), err.read()


@pytest.mark.parametrize("command", [["prune"], ["migrate"]])
def test_unreachable_database_diagnostic_carries_the_error_priority(workdir, command):
    # Fails before Uvicorn's formatter exists: the process prefixes its own line.
    environ = write_dsn(workdir, SECRET_DSN)
    code, out, err = run_on_journal_stderr([*command, "--config", write_config(workdir)], workdir, environ=environ)
    assert (code, out, err) == (1, "", "<3>agent-chat-admin: DATABASE_UNAVAILABLE\n")
    assert "sentinel-dsn" not in err and "nonexistent" not in err


def test_invalid_server_configuration_diagnostic_carries_the_error_priority(workdir):
    config = write_config(workdir, enabled=True, public_origin="http://sentinel-config-secret.test/x")
    environ = write_dsn(workdir, SECRET_DSN)
    code, out, err = run_on_journal_stderr(["serve", "--config", config], workdir, environ=environ)
    assert (code, out, err) == (2, "", "<3>agent-chat-admin: CONFIG_INVALID\n")
    assert "sentinel" not in err and "secret" not in err


def test_unusable_server_credential_diagnostic_carries_the_error_priority(workdir):
    code, out, err = run_on_journal_stderr(
        ["serve", "--config", write_config(workdir, enabled=True)], workdir, environ={}
    )
    assert (code, out, err) == (2, "", "<3>agent-chat-admin: CREDENTIALS_DIRECTORY_MISSING\n")


def test_disabled_server_notice_is_informational(workdir):
    code, out, err = run_on_journal_stderr(["serve", "--config", write_config(workdir)], workdir, environ={})
    assert (code, out, err) == (0, "", "<6>agent-chat-admin: DISABLED\n")


def test_diagnostic_has_no_priority_prefix_outside_the_journal_stream(workdir):
    # A terminal, a pipe, a captured stream, or another file than systemd's: no `<N>` noise.
    environ = write_dsn(workdir, SECRET_DSN)
    code, out, err = run_on_journal_stderr(
        ["prune", "--config", write_config(workdir)], workdir, environ=environ, journal=False
    )
    assert (code, out, err) == (1, "", "agent-chat-admin: DATABASE_UNAVAILABLE\n")
