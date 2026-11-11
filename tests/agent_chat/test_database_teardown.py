"""The private-cluster fixture preserves failed cleanup and safe wait evidence."""

import json
import os
import signal
from threading import enumerate as threads

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from agent_chat.storage import connect


def test_database_fixture_removes_its_database_without_changing_api_timeout(isolated_database, postgres_cluster):
    with isolated_database() as dsn:
        name = conninfo_to_dict(dsn)["dbname"]
        with connect(dsn) as db:
            timeout = db.execute("SHOW statement_timeout").fetchone()
            assert timeout is not None and timeout["statement_timeout"] == "5s"
    with connect(postgres_cluster) as admin:
        assert admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone() is None


def test_failed_drop_reports_cross_database_barrier_without_query_content(isolated_database, postgres_cluster):
    # This is our own connection's backend in the disposable private cluster,
    # not a process selected by a host-wide PID search. Always resume it.
    with psycopg.connect(postgres_cluster, autocommit=True) as blocker:
        blocker.execute("SELECT 'synthetic-query-must-not-appear-in-diagnostics'")
        pid = blocker.info.backend_pid
        name = None
        try:
            with pytest.raises(psycopg.errors.QueryCanceled) as failure:
                with isolated_database() as dsn:
                    name = conninfo_to_dict(dsn)["dbname"]
                    os.kill(pid, signal.SIGSTOP)
        finally:
            os.kill(pid, signal.SIGCONT)
    assert isinstance(name, str), "failure happened before the drop phase"
    # The failed fixture must not pretend that cleanup succeeded or retry it.
    # The test explicitly removes the failed database after releasing its blocker.
    with connect(postgres_cluster) as admin:
        assert admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
        admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
    notes = getattr(failure.value, "__notes__", [])
    assert len(notes) == 1, "cleanup failure lost its bounded wait diagnostics"
    assert "synthetic-query-must-not-appear-in-diagnostics" not in notes[0]
    assert postgres_cluster not in notes[0] and name not in notes[0]
    assert not any(thread.name == "chat-db-drop-observer" for thread in threads())
    evidence = json.loads(notes[0])
    assert set(evidence) == {"phase", "waits", "observer_errors"}
    assert evidence["observer_errors"] == []
    assert all(set(row) == {"wait_type", "wait", "target_connections"} for row in evidence["waits"])
    assert evidence["phase"] == "isolated_database_drop"
    assert any(
        row == {"wait_type": "IPC", "wait": "ProcSignalBarrier", "target_connections": 0} for row in evidence["waits"]
    )
