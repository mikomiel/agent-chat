"""Migration 003, the admitted harness names. Admission alone grants no credential and no authority."""

import secrets
from uuid import uuid4

import psycopg
import pytest

from agent_chat import storage
from agent_chat.storage import connect, migrate

ADMITTED = ["claude", "pi", "codex", "deepseek", "opencode"]


def insert_agent(db, harness, *, host="node-a"):
    db.execute(
        """INSERT INTO agent_chat.principals(id, credential_hash, kind, host, harness)
        VALUES (%s, %s, 'agent', %s, %s)""",
        (uuid4(), secrets.token_hex(32), host, harness),
    )


def versions(db):
    return [row["version"] for row in db.execute("SELECT version FROM agent_chat.schema_migrations ORDER BY version")]


@pytest.mark.parametrize("harness", ADMITTED)
def test_every_admitted_harness_can_be_stored_for_an_agent(db, harness):
    insert_agent(db, harness)
    assert db.execute("SELECT harness FROM agent_chat.principals").fetchone() == {"harness": harness}


@pytest.mark.parametrize("harness", ["vim", "", "DeepSeek", "OpenCode", "deepseek ", "opencode\n", "gemini"])
def test_an_unknown_harness_is_still_refused(db, harness):
    with pytest.raises(psycopg.errors.CheckViolation):
        insert_agent(db, harness)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 0


@pytest.mark.parametrize("harness", ["deepseek", "opencode"])
def test_the_new_names_do_not_loosen_the_other_principal_shapes(db, harness):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            "INSERT INTO agent_chat.principals(id, credential_hash, kind, harness) VALUES (%s, %s, 'operator', %s)",
            (uuid4(), secrets.token_hex(32), harness),
        )
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """INSERT INTO agent_chat.principals(id, credential_hash, kind, host, harness, producer)
            VALUES (%s, %s, 'producer', 'node-a', %s, 'validation-lease')""",
            (uuid4(), secrets.token_hex(32), harness),
        )
    with pytest.raises(psycopg.errors.CheckViolation):
        insert_agent(db, harness, host=None)
    assert db.execute("SELECT count(*) AS n FROM agent_chat.principals").fetchone()["n"] == 0


def test_003_migrates_a_database_at_002_keeps_its_rows_and_reapplies_as_a_no_op(database, monkeypatch):
    monkeypatch.setattr(storage, "MIGRATIONS", ("001_core.sql", "002_coordination.sql"))
    with connect(database) as client:
        migrate(client)
        assert versions(client) == [1, 2]
        insert_agent(client, "pi")
        insert_agent(client, "codex")
        with pytest.raises(psycopg.errors.CheckViolation):
            insert_agent(client, "deepseek")
        monkeypatch.undo()
        migrate(client)
        digests = client.execute(
            "SELECT version, digest FROM agent_chat.schema_migrations ORDER BY version"
        ).fetchall()
        assert [row["version"] for row in digests] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        migrate(client)
        assert (
            client.execute("SELECT version, digest FROM agent_chat.schema_migrations ORDER BY version").fetchall()
            == digests
        )
        assert sorted(row["harness"] for row in client.execute("SELECT harness FROM agent_chat.principals")) == [
            "codex",
            "pi",
        ]
        insert_agent(client, "deepseek")
        insert_agent(client, "opencode")
        with pytest.raises(psycopg.errors.CheckViolation):
            insert_agent(client, "vim")
