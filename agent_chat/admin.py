"""Server launcher and administration: `python -m agent_chat.admin <subcommand> --config PATH`.

Every expected failure prints one `agent-chat-admin: <CODE>` line to stderr and exits nonzero
(2 for configuration or usage, 1 for operational). Nothing here prints a DSN, token, digest,
message body or raw database exception text. The DSN comes only from the systemd credential
named by the configuration; there is no argv or environment fallback.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TextIO
from uuid import UUID, uuid5

import psycopg
import psycopg.errors
import uvicorn
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from . import retention
from .api import create_app
from .models import ChatError
from .protocol import token_digest, validate_origin
from .storage import connect, migrate, review_digest, review_lines

PROGRAM = "agent-chat-admin"
USAGE_EXIT = 2
OPERATIONAL_EXIT = 1
MAX_CONFIG_BYTES = 65536
MAX_CREDENTIAL_BYTES = 4096
# Seconds uvicorn waits for open connections after SIGTERM before it cancels them. Its listener is already closed
# for that whole wait, so the wait is the restart outage. Without a limit one open `/v1/events` stream, which
# ignores shutdown for the rest of its 60 s lifetime, kept the listener closed for up to a minute. A client
# heartbeats every 30 s against a 90 s lease and lapses only when two consecutive beats fail, so an outage under
# 30 s lapses no lease: this limit plus about 2 s of start-up stays well below it. It is twice the 5 s statement
# limit of `storage.connect`, so a request cut at the deadline is the rare case. A cut stream reconnects with its
# last event id.
GRACEFUL_SHUTDOWN_SECONDS = 10

# The schema stores no principal name, so a name maps to the deterministic id uuid5(PRINCIPAL_NAMESPACE, name).
# The primary key then backs the name's uniqueness. NEVER change this constant: every provisioned id would move
# and `revoke --name` would stop finding the principals this tool created.
PRINCIPAL_NAMESPACE = UUID("6b5a50e4-028b-4409-874a-46b9e4a3b372")
# Serializes principal provisioning across processes. Distinct from storage.migrate's key (617204831095).
PRINCIPAL_LOCK = 617204831096
NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
HOST_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
HOMELAB_ROOM = "homelab"
REVIEWED_PATTERN = re.compile(r"[0-9a-f]{64}")


class _ListenerErrorFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Uvicorn logs the bind OSError before exiting; _serve emits the fixed code.
        return not isinstance(record.msg, OSError)


# systemd (SyslogLevelPrefix=yes) turns a leading `<N>` on a stderr line into the journal PRIORITY. Python's
# levels map onto syslog's; every line of a multi-line record carries the prefix, so a traceback keeps its level.
_SYSLOG_PRIORITY = (
    (logging.CRITICAL, 2),
    (logging.ERROR, 3),
    (logging.WARNING, 4),
    (logging.INFO, 6),
    (logging.NOTSET, 7),
)


class _JournalFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        priority = next(value for level, value in _SYSLOG_PRIORITY if record.levelno >= level)
        return "\n".join(f"<{priority}>{line}" for line in super().format(record).splitlines())


# Stderr only, no uvicorn.access handler: access lines would carry raw request URLs.
LOG_CONFIG: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "plain": {"()": _JournalFormatter, "format": "%(asctime)s %(levelname)s %(name)s %(message)s"},
    },
    "filters": {"listener_errors": {"()": _ListenerErrorFilter}},
    "handlers": {"stderr": {"class": "logging.StreamHandler", "stream": "ext://sys.stderr", "formatter": "plain"}},
    "loggers": {
        "uvicorn": {"handlers": ["stderr"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"level": "INFO", "filters": ["listener_errors"]},
        "uvicorn.access": {"handlers": [], "level": "CRITICAL", "propagate": False},
        "agent_chat.api": {"handlers": ["stderr"], "level": "INFO", "propagate": False},
    },
}


def _diagnose(stderr: TextIO, environ: Mapping[str, str], text: str, priority: int = 3) -> None:
    # Uvicorn's formatter is installed only once it runs, so a failure before that (and every prune or migrate
    # failure) prefixes its own line. systemd names the journal stream it connected in JOURNAL_STREAM; matching it
    # to stderr keeps the prefix out of a terminal, a pipe and a captured stream, where it would be noise.
    try:
        status = os.fstat(stderr.fileno())
        journal = environ.get("JOURNAL_STREAM") == f"{status.st_dev}:{status.st_ino}"
    except (OSError, ValueError):
        journal = False
    print(f"<{priority}>{text}" if journal else text, file=stderr)


class AdminError(Exception):
    """An expected failure: a fixed code, never a message that could carry a secret."""

    def __init__(self, code: str, status: int = USAGE_EXIT, hint: str | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.hint = hint


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    bind_host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1024, le=65535)
    public_origin: str | None = None
    enabled: bool = False
    delivery_enabled: bool = False
    dsn_credential: str = Field(default="agent-chat-dsn", max_length=255, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

    @field_validator("public_origin")
    @classmethod
    def canonical_https_origin(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                validate_origin(value, https_only=True)
            except ChatError:
                raise ValueError("public_origin must be a canonical HTTPS origin") from None
        return value


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):
        # argparse messages quote the offending argument; none is echoed.
        raise AdminError("USAGE", USAGE_EXIT, "see --help")


def _reviewed_digest(value: str) -> str:
    if REVIEWED_PATTERN.fullmatch(value) is None:
        raise argparse.ArgumentTypeError("not a sha256 digest")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="python -m agent_chat.admin", description="Agent Chat server launcher and administration.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (
        ("serve", "Run the HTTP server. Inert unless the configuration sets enabled=true."),
        (
            "migrate",
            "Apply the schema migrations; idempotent. --check applies nothing and lists the pending ones; "
            "--reviewed refuses to apply any other pending set.",
        ),
        ("prune", "Run bounded retention batches."),
    ):
        command = commands.add_parser(name, help=text, description=text)
        command.add_argument("--config", required=True, metavar="PATH", help="JSON configuration file")
        if name == "migrate":
            command.add_argument(
                "--check",
                action="store_true",
                help="run no DDL: print pending=<n>, one line per pending file and reviewed=<sha256>",
            )
            command.add_argument(
                "--reviewed",
                type=_reviewed_digest,
                metavar="SHA256",
                help="the reviewed=<sha256> of --check; under the migration lock, run nothing (REVIEW_MISMATCH) "
                "unless the pending set has this digest",
            )
        if name == "prune":
            command.add_argument("--limit", type=int, default=100, help="rows per batch, 1-1000 (default 100)")
            command.add_argument("--max-batches", type=int, default=50, help="batch bound, at least 1 (default 50)")
    principal = commands.add_parser("principal", help="Provision or revoke a principal.")
    actions = principal.add_subparsers(dest="action", required=True)
    ensure = actions.add_parser(
        "ensure",
        help="Create or update a principal; the raw token is read from stdin.",
        description="Create, rotate or restore a principal. The raw token (64 lowercase hex characters) is read "
        "from stdin only.",
    )
    ensure.add_argument("--config", required=True, metavar="PATH", help="JSON configuration file")
    ensure.add_argument("--name", required=True, help="principal name; maps to a deterministic id")
    ensure.add_argument("--kind", required=True, choices=("operator", "agent", "producer", "viewer"))
    ensure.add_argument("--host", help="agent or producer host")
    ensure.add_argument(
        "--harness",
        choices=("pi", "claude", "codex", "deepseek", "opencode"),
        help="agent harness (agent only)",
    )
    ensure.add_argument("--producer", help="producer namespace (producer only)")
    ensure.add_argument(
        "--room", action="append", type=UUID, default=[], help="existing room UUID; repeat for viewer grants"
    )
    ensure.add_argument("--json", action="store_true", help="Return principal_id, room_id(s) and outcome as JSON")
    revoke = actions.add_parser("revoke", help="Revoke a principal created by `principal ensure`.")
    revoke.add_argument("--config", required=True, metavar="PATH", help="JSON configuration file")
    revoke.add_argument("--name", required=True)
    return parser


def load_config(path: str) -> Config:
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_CONFIG_BYTES + 1)
    except OSError:
        raise AdminError("CONFIG_UNREADABLE") from None
    if len(raw) > MAX_CONFIG_BYTES:
        raise AdminError("CONFIG_INVALID")
    try:
        document = json.loads(raw.decode("utf-8"))
        return Config.model_validate(document)
    except (ValueError, ValidationError):
        # ValidationError text includes the submitted input; report the code only.
        raise AdminError("CONFIG_INVALID") from None


def read_dsn(config: Config, environ: Mapping[str, str]) -> str:
    directory = environ.get("CREDENTIALS_DIRECTORY")
    if not directory:
        raise AdminError("CREDENTIALS_DIRECTORY_MISSING")
    try:
        with open(Path(directory) / config.dsn_credential, "rb") as handle:
            raw = handle.read(MAX_CREDENTIAL_BYTES + 1)
        value = raw.decode("utf-8")
    except (OSError, ValueError):
        raise AdminError("DSN_CREDENTIAL_UNREADABLE") from None
    if len(raw) > MAX_CREDENTIAL_BYTES:
        raise AdminError("DSN_CREDENTIAL_UNREADABLE")
    value = value.removesuffix("\n")
    if not value:
        raise AdminError("DSN_CREDENTIAL_UNREADABLE")
    return value


def _serve(config: Config, environ: Mapping[str, str], stderr: TextIO) -> int:
    if not config.enabled:
        # A deployed unit stays inert until inventory enables it: no DSN read, no listener.
        _diagnose(stderr, environ, f"{PROGRAM}: DISABLED", 6)
        return 0
    dsn = read_dsn(config, environ)
    # No database connection here: create_app connects per request, so liveness survives a database outage.
    app = create_app(dsn, enabled=True, public_origin=config.public_origin, delivery_enabled=config.delivery_enabled)
    # proxy_headers=False is deliberate. Origin and CSRF checks compare against the configured public_origin
    # (RequestBoundary) and the login limit is global (browser.login, table agent_chat.login_guard), so no client
    # IP or forwarded header is trusted.
    try:
        uvicorn.run(
            app,
            host=config.bind_host,
            port=config.port,
            access_log=False,
            proxy_headers=False,
            server_header=False,
            log_config=LOG_CONFIG,
            timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SECONDS,
        )
    except (OSError, SystemExit) as error:
        if isinstance(error, SystemExit) and error.code in (None, 0):
            return 0
        raise AdminError("LISTENER_UNAVAILABLE", OPERATIONAL_EXIT) from None
    return 0


def _migrate(
    config: Config, environ: Mapping[str, str], stdout: TextIO, *, check: bool = False, reviewed: str | None = None
) -> int:
    with connect(read_dsn(config, environ)) as db:
        before = _applied_versions(db)
        pending = migrate(db, check=check, reviewed=reviewed)
        if check:
            # The printed lines and the reviewed digest come from the same list, in the printed order. With
            # nothing pending there is nothing to review, so no `reviewed=` line is printed.
            print(f"pending={len(pending)}", file=stdout)
            for line in review_lines(pending):
                print(line, file=stdout)
            if pending:
                print(f"reviewed={review_digest(pending)}", file=stdout)
            return 0
        after = _applied_versions(db)
    applied = [version for version in after if version not in before]
    current = after[-1] if after else "none"
    print(f"applied={','.join(map(str, applied)) or 'none'} current={current}", file=stdout)
    return 0


def _applied_versions(db: psycopg.Connection[dict[str, Any]]) -> list[int]:
    try:
        rows = db.execute("SELECT version FROM agent_chat.schema_migrations ORDER BY version").fetchall()
    except (psycopg.errors.UndefinedTable, psycopg.errors.InvalidSchemaName):
        return []
    return [row["version"] for row in rows]


def _prune(config: Config, environ: Mapping[str, str], limit: int, max_batches: int, stdout: TextIO) -> int:
    if not 1 <= limit <= 1000 or max_batches < 1:
        raise _usage()
    totals = dict.fromkeys(
        (
            "events",
            "redacted",
            "deleted",
            "ended_instances",
            "memberships",
            "expired_undelivered",
            "reservations",
            "delivery_batches",
            "browser_sessions",
            "room_state",
        ),
        0,
    )
    batches = 0
    with connect(read_dsn(config, environ)) as db:
        while batches < max_batches:
            removed = retention.prune(db, limit=limit)
            batches += 1
            for key, count in removed.items():
                totals[key] += count
            if not any(removed.values()):
                break
    # One line, the original keys first in their original order: a LogQL parser reads it by key.
    print(f"batches={batches} " + " ".join(f"{key}={count}" for key, count in totals.items()), file=stdout)
    return 0


def _usage() -> AdminError:
    return AdminError("USAGE", USAGE_EXIT, "see --help")


def _principal_id(name: str) -> UUID:
    if NAME_PATTERN.fullmatch(name) is None:
        raise _usage()
    return uuid5(PRINCIPAL_NAMESPACE, name)


def _read_token(stdin: TextIO) -> str:
    """The raw token: 64 lowercase hex characters and at most one trailing newline, from stdin only."""
    raw = stdin.read(67)
    digest_source = raw.removesuffix("\n")
    try:
        token_digest(digest_source)
    except ChatError:
        raise AdminError("TOKEN_INVALID") from None
    return digest_source


def _ensure_principal(
    config: Config, environ: Mapping[str, str], args: argparse.Namespace, stdin: TextIO, stdout: TextIO
) -> int:
    principal_id = _principal_id(args.name)
    if args.kind == "agent":
        if (
            args.host is None
            or args.harness is None
            or args.producer is not None
            or HOST_PATTERN.fullmatch(args.host) is None
        ):
            raise _usage()
    elif args.kind == "producer":
        if (
            args.host is None
            or args.producer is None
            or args.harness is not None
            or HOST_PATTERN.fullmatch(args.host) is None
            or HOST_PATTERN.fullmatch(args.producer) is None
        ):
            raise _usage()
    elif args.host is not None or args.harness is not None or args.producer is not None:
        raise _usage()
    room_ids = sorted(set(args.room))
    if (args.kind == "viewer") != bool(room_ids):
        raise _usage()
    digest = token_digest(_read_token(stdin))
    with connect(read_dsn(config, environ)) as db, db.transaction():
        db.execute("SELECT pg_advisory_xact_lock(%s)", (PRINCIPAL_LOCK,))
        row = db.execute(
            """SELECT kind, host, harness, producer, credential_hash, revoked
            FROM agent_chat.principals WHERE id = %s FOR UPDATE""",
            (principal_id,),
        ).fetchone()
        if args.kind == "viewer" and db.execute(
            "SELECT 1 FROM agent_chat.instances WHERE token_hash = %s", (digest,)
        ).fetchone() is not None:
            raise AdminError("TOKEN_IN_USE", OPERATIONAL_EXIT)
        try:
            if row is None:
                db.execute(
                    """INSERT INTO agent_chat.principals(id, kind, credential_hash, host, harness, producer)
                    VALUES (%s, %s, %s, %s, %s, %s)""",
                    (principal_id, args.kind, digest, args.host, args.harness, args.producer),
                )
                outcome = "created"
            elif (row["kind"], row["host"], row["harness"], row["producer"]) != (
                args.kind,
                args.host,
                args.harness,
                args.producer,
            ):
                raise AdminError("PRINCIPAL_CONFLICT", OPERATIONAL_EXIT)
            elif row["credential_hash"] != digest:
                db.execute(
                    "UPDATE agent_chat.principals SET credential_hash = %s, revoked = false WHERE id = %s",
                    (digest, principal_id),
                )
                outcome = "rotated"
            elif row["revoked"]:
                db.execute("UPDATE agent_chat.principals SET revoked = false WHERE id = %s", (principal_id,))
                outcome = "restored"
            else:
                outcome = "unchanged"
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name != "principals_credential_hash_key":
                raise
            raise AdminError("TOKEN_IN_USE", OPERATIONAL_EXIT) from None
        if args.kind == "viewer":
            existing = db.execute(
                "SELECT id FROM agent_chat.rooms WHERE id = ANY(%s::uuid[]) ORDER BY id FOR SHARE", (room_ids,)
            ).fetchall()
            if [room["id"] for room in existing] != room_ids:
                raise AdminError("ROOM_NOT_FOUND", OPERATIONAL_EXIT)
            removed = db.execute(
                "DELETE FROM agent_chat.principal_rooms WHERE principal_id = %s AND NOT (room_id = ANY(%s::uuid[]))",
                (principal_id, room_ids),
            ).rowcount
            added = 0
            for room_id in room_ids:
                added += db.execute(
                    "INSERT INTO agent_chat.principal_rooms VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (principal_id, room_id),
                ).rowcount
            if outcome in ("rotated", "restored"):
                db.execute("DELETE FROM agent_chat.browser_sessions WHERE principal_id = %s", (principal_id,))
            elif outcome == "unchanged" and (removed or added):
                outcome = "updated"
            scope = {"room_ids": [str(room_id) for room_id in room_ids]}
        else:
            room = db.execute("SELECT id FROM agent_chat.rooms WHERE slug = %s", (HOMELAB_ROOM,)).fetchone()
            if room is None:
                raise ChatError("SCHEMA_MISMATCH")
            db.execute(
                "INSERT INTO agent_chat.principal_rooms VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (principal_id, room["id"]),
            )
            scope = {"room_id": str(room["id"])}
    if args.json:
        print(json.dumps({"principal_id": str(principal_id), **scope, "outcome": outcome}), file=stdout)
    else:
        print(f"{args.name} {principal_id} {outcome}", file=stdout)
    return 0


def _revoke_principal(config: Config, environ: Mapping[str, str], name: str, stdout: TextIO) -> int:
    principal_id = _principal_id(name)
    with connect(read_dsn(config, environ)) as db, db.transaction():
        db.execute("SELECT pg_advisory_xact_lock(%s)", (PRINCIPAL_LOCK,))
        row = db.execute(
            "SELECT kind, revoked FROM agent_chat.principals WHERE id = %s FOR UPDATE", (principal_id,)
        ).fetchone()
        if row is None:
            raise AdminError("PRINCIPAL_NOT_FOUND", OPERATIONAL_EXIT)
        # History stays. Authentication already requires NOT revoked, so every token of the principal fails.
        db.execute("UPDATE agent_chat.principals SET revoked = true WHERE id = %s", (principal_id,))
        if row["kind"] == "viewer":
            db.execute("DELETE FROM agent_chat.browser_sessions WHERE principal_id = %s", (principal_id,))
    print(f"{name} {principal_id} {'already_revoked' if row['revoked'] else 'revoked'}", file=stdout)
    return 0


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    environ: Mapping[str, str] | None = None,
) -> int:
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    stderr = stderr if stderr is not None else sys.stderr
    environ = environ if environ is not None else os.environ
    try:
        try:
            args = _parser().parse_args(argv)
        except SystemExit as stop:  # --help
            return stop.code if isinstance(stop.code, int) else 0
        config = load_config(args.config)
        if args.command == "serve":
            return _serve(config, environ, stderr)
        if args.command == "migrate":
            return _migrate(config, environ, stdout, check=args.check, reviewed=args.reviewed)
        if args.command == "prune":
            return _prune(config, environ, args.limit, args.max_batches, stdout)
        if args.action == "ensure":
            return _ensure_principal(config, environ, args, stdin, stdout)
        return _revoke_principal(config, environ, args.name, stdout)
    except AdminError as error:
        _diagnose(stderr, environ, f"{PROGRAM}: {error.code}" + (f" ({error.hint})" if error.hint else ""))
        return error.status
    except ChatError as error:
        _diagnose(stderr, environ, f"{PROGRAM}: {re.sub(r'[^A-Z_]', '', error.code) or 'INTERNAL_ERROR'}")
        return OPERATIONAL_EXIT
    except (psycopg.errors.UndefinedTable, psycopg.errors.InvalidSchemaName):
        _diagnose(stderr, environ, f"{PROGRAM}: SCHEMA_MISSING (run migrate)")
        return OPERATIONAL_EXIT
    except psycopg.Error:
        # Connection errors can carry host and user details; print nothing from the exception.
        _diagnose(stderr, environ, f"{PROGRAM}: DATABASE_UNAVAILABLE")
        return OPERATIONAL_EXIT


if __name__ == "__main__":
    sys.exit(main())
