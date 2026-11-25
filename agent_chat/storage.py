"""Explicit migrations and bounded PostgreSQL connections, never implicit startup DDL."""

import time
from collections.abc import Generator
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import Any

import psycopg
from psycopg import Transaction
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row

from .models import ChatError

MIGRATIONS = (
    "001_core.sql", "002_coordination.sql", "003_harness_admission.sql", "004_session_titles.sql", "005_viewer.sql",
    "006_quotas.sql", "007_sender_receipts.sql", "008_direct_threads.sql", "009_pm_mark.sql",
    "010_quota_backfill.sql", "011_roles_and_work.sql", "012_session_model.sql",
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


#: Seconds a request deadline keeps free below the session's lock limit, for what the deadline cannot stop: the
#: COMMIT round trip and its flush, the response and its transport, and the request's own transit before it was
#: accepted. The deadline is checked last just before COMMIT is sent. Production's 3 s lock limit equals the CLI's
#: 3 s socket step (`agent_chat/client.py`), so a bounded request sends its COMMIT at most 2.25 s after it was
#: accepted, and only a COMMIT, response and transit slower than 0.75 s together still land after the client gave the
#: request up (issue #177). The value was 1.0 s while each statement's lock limit was also lowered to the time left,
#: which could overrun the deadline by 250 ms; that overrun is gone, and so is its share of the margin. The two
#: values are coupled only by this comment: raising the lock limit in `connect`, or lowering the client step, moves
#: the deadline to or past the client step and reopens #177. tests/agent_chat/test_request_deadline.py pins the
#: production budget.
REQUEST_MARGIN_SECONDS = 0.75

#: The session limits `connect` sets. A request deadline is measured from the lock limit.
LOCK_TIMEOUT_MS = 3000
STATEMENT_TIMEOUT_MS = 5000


class RequestDeadlineSpent(psycopg.OperationalError):
    """Raised when the request deadline has passed, before the next statement, BEGIN, SAVEPOINT or COMMIT is sent."""


class BoundedConnection(psycopg.Connection[dict[str, Any]]):
    """A connection whose transactions can share one request deadline.

    PostgreSQL 16 has no transaction-wide timeout, and `lock_timeout` bounds each wait on its own, so a request that
    waits on several locks, in one statement or in several, can finish after its client gave it up. While
    `request_deadline` is active, no statement, BEGIN or SAVEPOINT is sent past the deadline, and the outermost
    transaction checks it once more just before COMMIT: a transaction that ran past it rolls back instead. A statement
    already sent still runs under the session limits, so the refusal can come after the deadline; what it guarantees
    is that nothing commits then. An autocommit statement commits on its own, so inside a deadline only reads may run
    outside a transaction.
    """

    _deadline: float | None = None
    _lock_ms: int = 0

    @contextmanager
    def transaction(
        self, savepoint_name: str | None = None, force_rollback: bool = False
    ) -> Generator[Transaction, None, None]:
        if self._deadline is None:
            with super().transaction(savepoint_name, force_rollback) as transaction:
                yield transaction
            return
        self._left()  # a spent deadline sends no BEGIN or SAVEPOINT
        outermost = self.info.transaction_status == TransactionStatus.IDLE
        with super().transaction(savepoint_name, force_rollback) as transaction:
            yield transaction
            if outermost:
                # The last statement may have waited on locks past the deadline. Raising here, inside the block,
                # makes psycopg roll back instead of sending COMMIT.
                self._left()

    @contextmanager
    def request_deadline(self, accepted: float) -> Generator[None, None, None]:
        """Refuse to start or commit work in this block after `accepted` plus the session's lock limit, less
        `REQUEST_MARGIN_SECONDS`. `accepted` is a `time.monotonic()` reading taken when the request arrived.

        The budget comes from the lock limit this connection was given (`connect`, `set_limits`), so it costs no
        query; a lock limit of 0 (none) stays unbounded.
        """
        lock_ms = self._lock_ms
        self._deadline = accepted + lock_ms / 1000 - REQUEST_MARGIN_SECONDS if lock_ms else None
        try:
            yield
        finally:
            self._deadline = None

    # Pass-through arguments: psycopg's own execute still checks and runs every call; only the check is added.
    def execute(self, *args: Any, **kwargs: Any) -> psycopg.Cursor[dict[str, Any]]:
        if self._deadline is not None:
            self._left()
        return super().execute(*args, **kwargs)

    def _left(self) -> None:
        assert self._deadline is not None
        if time.monotonic() >= self._deadline:
            raise RequestDeadlineSpent("request deadline spent")

    def set_limits(self, lock_ms: int, statement_ms: int) -> None:
        """Set this session's lock and statement limits, and the request budget measured from them."""
        super().execute(
            "SELECT set_config('lock_timeout', %s, false), set_config('statement_timeout', %s, false)",
            (f"{lock_ms}ms", f"{statement_ms}ms"),
        )
        self._lock_ms = lock_ms


def connect(dsn: str) -> BoundedConnection:
    db = BoundedConnection.connect(
        dsn,
        autocommit=True,
        row_factory=dict_row,
        connect_timeout=3,
        options=(
            f"-c timezone=UTC -c statement_timeout={STATEMENT_TIMEOUT_MS} -c lock_timeout={LOCK_TIMEOUT_MS} "
            "-c idle_in_transaction_session_timeout=15000"
        ),
    )
    db._lock_ms = LOCK_TIMEOUT_MS
    return db


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
