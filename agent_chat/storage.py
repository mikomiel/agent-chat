"""Explicit migrations and bounded PostgreSQL connections, never implicit startup DDL."""

from hashlib import sha256
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .models import ChatError

MIGRATIONS = (
    "001_core.sql", "002_coordination.sql", "003_harness_admission.sql", "004_session_titles.sql", "005_viewer.sql",
    "006_quotas.sql", "007_sender_receipts.sql", "008_direct_threads.sql", "009_pm_mark.sql",
    "010_quota_backfill.sql", "011_roles_and_work.sql",
)

#: Digests a database can still hold from the migration bytes released before 0.1.1.
#:
#: That release scrubbed private identifiers from one comment line in each of these two files, so the
#: bytes changed while the executable SQL did not. A database initialized from the earlier bytes
#: records the earlier digest; accepting exactly these reviewed values lets it upgrade without
#: rewriting its history, and leaving them unrewritten lets the earlier release read it again.
#: Every other recorded value, including any other comment-only edit, still raises SCHEMA_MISMATCH.
LEGACY_DIGESTS: dict[int, frozenset[str]] = {
    9: frozenset({"39ba29970ae65754207d4ef985715aea1fad9c3b8b5b6cbe7789de7170ebb2ab"}),
    11: frozenset({"e4e5ea6f47acebb4d33b226651f613fdabe36ce443ac907c1a6066d3c15bda29"}),
}


def connect(dsn: str) -> psycopg.Connection[dict[str, Any]]:
    return psycopg.Connection[dict[str, Any]].connect(
        dsn,
        autocommit=True,
        row_factory=dict_row,
        connect_timeout=3,
        options=(
            "-c timezone=UTC -c statement_timeout=5000 -c lock_timeout=3000 "
            "-c idle_in_transaction_session_timeout=15000"
        ),
    )


_APPLIED = "SELECT version, digest FROM agent_chat.schema_migrations ORDER BY version"


def _digest_matches(version: int, recorded: str, expected: str) -> bool:
    """Whether a recorded digest is this release's bytes or one of its reviewed legacy values."""
    return recorded == expected or recorded in LEGACY_DIGESTS.get(version, frozenset())


def review_lines(pending: list[dict[str, Any]]) -> list[str]:
    """The lines an operator reads before an apply: one per pending migration, in apply order."""
    return [f"{entry['version']} {entry['name']} sha256={entry['digest']}" for entry in pending]


def review_digest(pending: list[dict[str, Any]]) -> str:
    """The reviewed digest: sha256 over the `review_lines`, each followed by a newline.

    `migrate --check` prints it and `migrate --reviewed` compares against it, so both paths share this one function.
    """
    return sha256("".join(line + "\n" for line in review_lines(pending)).encode()).hexdigest()


def migrate(
    db: psycopg.Connection[dict[str, Any]], *, check: bool = False, reviewed: str | None = None
) -> list[dict[str, Any]]:
    """Apply the pending migrations and return them as `{version, name, digest}`.

    `check` takes the same lock and runs the same prefix check, runs no DDL (not even the bookkeeping table) and
    rolls the transaction back, so an operator can see what an apply would run before it does.

    `reviewed` binds the run to what the operator read: under the lock, after the prefix check and before any DDL,
    the `review_digest` of the pending set must equal it, else `ChatError("REVIEW_MISMATCH")` rolls back with no
    DDL run. An empty pending set has a digest too, so a digest that no longer matches nothing pending also refuses.

    A recorded digest is accepted when it matches this release's bytes or one of the reviewed
    `LEGACY_DIGESTS` for that version; the check never rewrites the ledger, so the database stays
    readable by the release that recorded it.
    """
    sources = [Path(__file__).with_name(name).read_bytes() for name in MIGRATIONS]
    expected: list[dict[str, Any]] = [
        {"version": version, "name": name, "digest": sha256(source).hexdigest()}
        for version, (name, source) in enumerate(zip(MIGRATIONS, sources, strict=True), 1)
    ]
    with db.transaction(force_rollback=check):
        # Migration serialization is separate from the event clock, which does not exist yet.
        db.execute("SELECT pg_advisory_xact_lock(617204831095)")
        present = db.execute("SELECT to_regclass('agent_chat.schema_migrations') AS name").fetchone()
        applied = db.execute(_APPLIED).fetchall() if present and present["name"] else []
        if len(applied) > len(expected) or any(
            row["version"] != want["version"] or not _digest_matches(want["version"], row["digest"], want["digest"])
            for row, want in zip(applied, expected, strict=False)
        ):
            raise ChatError("SCHEMA_MISMATCH")
        pending = expected[len(applied) :]
        if reviewed is not None and review_digest(pending) != reviewed:
            raise ChatError("REVIEW_MISMATCH")
        if not check:
            db.execute("CREATE SCHEMA IF NOT EXISTS agent_chat")
            db.execute("""CREATE TABLE IF NOT EXISTS agent_chat.schema_migrations (
                version integer PRIMARY KEY, digest text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT clock_timestamp())""")
            for entry, source in zip(pending, sources[len(applied) :], strict=True):
                db.execute(source)
                db.execute(
                    "INSERT INTO agent_chat.schema_migrations(version, digest) VALUES (%s, %s)",
                    (entry["version"], entry["digest"]),
                )
    return pending
