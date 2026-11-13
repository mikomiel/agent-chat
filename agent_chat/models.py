"""Request models, limits and error codes shared by the server, the CLI and the storage boundary."""

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BIDI_CONTROLS = frozenset(map(chr, (*range(0x202A, 0x202F), *range(0x2066, 0x206A))))

# An instance is online while its last heartbeat is younger than this.
LEASE_SECONDS = 90
# The adapter core rejoins a lapsed instance only for these worker codes.
REJOIN_CODES = frozenset({"STALE_INSTANCE", "SERVICE_UNAVAILABLE", "TRANSPORT_UNAVAILABLE", "REQUEST_UNCERTAIN"})
REJOIN_BACKOFF_BASE_S = 5.0
REJOIN_BACKOFF_CAP_S = 120.0
REJOIN_JITTER_MIN = 0.5
# One episode may run this long, and a session may complete this many rejoins in the budget window.
REJOIN_EPISODE_S = 7200.0
REJOIN_PER_HOUR = 3
REJOIN_BUDGET_WINDOW_S = 3600.0
# Agent replies a thread accepts before an operator reply resets the count.
REPLY_LIMIT = 6
# Wake admissions per session in a rolling window; admissions are never refunded.
WAKE_LIMIT = 20
WAKE_WINDOW_SECONDS = 3600
# A direct 1:1 thread (exactly two sessions, created after 008_direct_threads.sql) has its own reply limit and its
# own wake allowance per session in the same window.
DIRECT_REPLY_LIMIT = 20
DIRECT_WAKE_LIMIT = 60
# Loop detector of a direct thread: this many consecutive agent replies within this many seconds refuse further
# replies and wakes in it until an operator reset.
LOOP_REPLIES = 10
LOOP_WINDOW_SECONDS = 120
# Wait after a failed or deferred attempt before attempt 2, then before attempt 3.
BACKOFF_SECONDS = (1, 5)
# An addressed item not handed within this time after it was stored is never offered again.
DELIVERY_MAX_AGE_SECONDS = 86400
# Volume caps that bound what one credential can create; hard refusals, never queued. The hourly windows roll.
QUOTA_WINDOW_SECONDS = 3600
MAX_LIVE_INSTANCES_PER_PRINCIPAL = 32
MAX_REGISTRATIONS_PER_PRINCIPAL_HOUR = 120
MAX_MESSAGES_PER_SESSION_HOUR = 120
# A room role mark lapses after this many hours without its holder's own publication or acknowledgement.
# roles.py applies it; no SQL file holds a copy.
ROLE_EXPIRY_HOURS = 48
# The closed role set. `pm` is the Forgejo PM mark and wire value, so existing messages, `--from pm` and
# the skills keep their meaning; the other two stamps are their own names.
ROLE_NAMES = ("pm", "github_pm", "delivery_manager")
# The names the CLI and the browser accept. `forgejo-pm`/`forgejo_pm` and `dm` are aliases.
# The history filter accepts this same table: every name resolves to its canonical role, which is
# also the wire stamp. One definition, so the parser and the filter cannot drift apart.
ROLE_SELECTORS = {
    "pm": "pm",
    "forgejo-pm": "pm",
    "forgejo_pm": "pm",
    "github-pm": "github_pm",
    "github_pm": "github_pm",
    "delivery-manager": "delivery_manager",
    "delivery_manager": "delivery_manager",
    "dm": "delivery_manager",
}
ROLE_FILTER_STAMPS = ROLE_SELECTORS

# Kinds that record coordination material. Delivery lists its kinds explicitly, so none of these is ever
# pending, claimed or woken; like `status`, they never count toward the reply cap.
COORDINATION_KINDS = ("heads_up", "blocked_on", "decision_needed", "intent")
# Kinds that never count toward, reset or are refused at a thread's reply limit.
UNCOUNTED_KINDS = ("status", *COORDINATION_KINDS)
# The only exact grammar of a thread key; the database checks a coarser shape (002_coordination.sql).
REF_KEY_PATTERN = (
    r"^(pr:[A-Za-z0-9_.-]{1,40}/[A-Za-z0-9_.-]{1,80}#[1-9][0-9]{0,9}"
    r"|lane:[A-Za-z0-9_./-]{1,80}::[A-Za-z0-9-]{1,40}"
    r"|resource:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62})$"
)
# Deliberately looser than the gate's lane reference; the gate stays the only exact owner of that grammar.
LANE_PATTERN = r"^[A-Za-z0-9_./-]{1,80}::[A-Za-z0-9-]{1,40}$"
LANE_MAX_LENGTH = 120
# A work declaration names at most these many `owner/name` repositories, bounded by the stored JSON text too.
REPOSITORY_PATTERN = r"^[A-Za-z0-9_.-]{1,40}/[A-Za-z0-9_.-]{1,80}$"
MAX_REPOSITORIES_PER_FORGE = 16
MAX_REPOSITORIES = 32
WORK_BYTES = 4096
PR_REF = re.compile(r"^pr:(?P<repository>[A-Za-z0-9_.-]{1,40}/[A-Za-z0-9_.-]{1,80})#(?P<number>[1-9][0-9]{0,9})$")


def pr_ref_parts(ref: str) -> tuple[str, int] | None:
    """The repository and number of a `pr:` ref, or None when the stored text does not parse."""
    match = PR_REF.fullmatch(ref)
    return None if match is None else (match["repository"], int(match["number"]))


STATE_KEY_PATTERN = r"^[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9.-]{0,62}$"
STATE_REF_KEY_PATTERN = r"^resource:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$"
STATE_VALUE_BYTES = 4096
STATE_BATCH = 8


@dataclass(frozen=True)
class Actor:
    # Internal authentication result, never constructed from publication JSON.
    principal_id: UUID
    session_id: UUID | None
    instance_id: UUID | None
    browser_session_hash: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ProducerActor:
    # A machine writer of room state. Deliberately not an Actor: it has no session, instance or browser binding,
    # and no route that takes an Actor can be handed one.
    principal_id: UUID
    host: str
    producer: str


class Publication(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal[
        "message", "status", "question", "consultation", "reply", "heads_up", "blocked_on", "decision_needed", "intent"
    ]
    body: str = Field(strict=True, min_length=1)
    recipients: tuple[UUID, ...] = Field(default=(), max_length=16)
    thread_id: UUID | None = None
    reply_to: UUID | None = None
    ref_key: str | None = Field(default=None, strict=True, pattern=REF_KEY_PATTERN)
    # The sender's opt-in to receipts on an addressed message or reply; `receipts.eligible` decides what it means.
    receipts: bool = Field(default=False, strict=True)

    @field_validator("body")
    @classmethod
    def bounded_body(cls, body: str) -> str:
        if "\x00" in body or len(body.encode("utf-8")) > 16384:
            raise ValueError("body must be valid PostgreSQL text of at most 16 KiB")
        return body

    @field_validator("recipients")
    @classmethod
    def unique_recipients(cls, recipients: tuple[UUID, ...]) -> tuple[UUID, ...]:
        return tuple(sorted(set(recipients)))

    @model_validator(mode="after")
    def reply_shape(self) -> "Publication":
        if (self.kind == "reply") != (self.reply_to is not None):
            raise ValueError("reply kind and reply_to must occur together")
        if self.ref_key is not None:
            # A keyed thread is long-lived: it opens only through a new post, and a question or consultation
            # (wake-eligible, reply-capped) cannot open or join one.
            if self.thread_id is not None or self.reply_to is not None:
                raise ValueError("ref_key names a new or existing thread by itself")
            if self.kind in ("question", "consultation"):
                raise ValueError("a question or consultation cannot name a ref_key")
        return self


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    native_session_id: str = Field(strict=True, min_length=1, max_length=256, pattern=r"^[^\x00-\x1f\x7f]+$")
    boot_id: UUID
    instance_token_hash: str = Field(strict=True, pattern=r"^[0-9a-f]{64}$")
    lane: str | None = Field(default=None, strict=True, pattern=LANE_PATTERN, max_length=LANE_MAX_LENGTH)

    @field_validator("native_session_id")
    @classmethod
    def native_utf8(cls, value: str) -> str:
        value.encode("utf-8")
        # Bidirectional controls would let a stored label visually reorder the flags rendered beside it.
        if BIDI_CONTROLS.intersection(value):
            raise ValueError("native_session_id must not contain bidirectional controls")
        return value


class Heartbeat(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    native_state: Literal["idle", "busy", "unknown"]
    stopped: bool = Field(strict=True)
    plan_mode: bool = Field(strict=True)
    # Omission preserves the stored title: the normal path for harnesses without a native title owner (Claude,
    # Codex). JSON null clears it.
    title: str | None = Field(default=None, strict=True, min_length=1, max_length=128)

    @field_validator("title")
    @classmethod
    def safe_title(cls, value: str | None) -> str | None:
        if value is not None:
            if (not value.strip() or value != value.strip() or len(value.encode("utf-8")) > 512
                    or any(ord(char) < 32 or 127 <= ord(char) < 160 for char in value)
                    or (BIDI_CONTROLS | frozenset("\u061c\u200e\u200f\u2028\u2029")).intersection(value)):
                raise ValueError("invalid session title")
        return value


class LaneDeclaration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    # Required: null clears the lane, so an omitted field is not a silent clear.
    lane: str | None = Field(strict=True, pattern=LANE_PATTERN, max_length=LANE_MAX_LENGTH)


class WorkDeclaration(BaseModel):
    """The live instance's advisory map from forge to repositories; `{}` clears it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    # Required: an omitted map is not a silent clear.
    repositories: dict[Literal["forgejo", "github"], tuple[str, ...]]

    @field_validator("repositories")
    @classmethod
    def bounded(cls, value: dict[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
        total = 0
        bounded: dict[str, tuple[str, ...]] = {}
        for forge, repositories in value.items():
            if len(repositories) > MAX_REPOSITORIES_PER_FORGE:
                raise ValueError(f"at most {MAX_REPOSITORIES_PER_FORGE} repositories per forge")
            for repository in repositories:
                if not re.fullmatch(REPOSITORY_PATTERN, repository):
                    raise ValueError("a repository must be owner/name")
            total += len(repositories)
            bounded[forge] = tuple(sorted(set(repositories)))
        if total > MAX_REPOSITORIES:
            raise ValueError(f"at most {MAX_REPOSITORIES} repositories")
        rendered = json.dumps(bounded, ensure_ascii=True, separators=(",", ":"))
        if len(rendered.encode("utf-8")) > WORK_BYTES:
            raise ValueError("the declaration is larger than 4 KiB")
        return bounded


class Resolution(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    resolved: bool = Field(strict=True)


def _bounded_state_value(value: dict[str, Any]) -> dict[str, Any]:
    def walk(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                walk(key)
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)
        elif isinstance(item, str) and "\x00" in item:
            raise ValueError("state values must be valid PostgreSQL text")

    walk(value)
    # PostgreSQL measures the jsonb text form, which separates with ", " and ": ".
    rendered = json.dumps(value, ensure_ascii=False, separators=(", ", ": "), allow_nan=False)
    if len(rendered.encode("utf-8")) > STATE_VALUE_BYTES:
        raise ValueError("state value is larger than 4 KiB")
    return value


class StateEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    state_key: str = Field(strict=True, pattern=STATE_KEY_PATTERN)
    value: dict[str, Any]
    ttl_seconds: int = Field(strict=True, ge=30, le=3600)
    ref_key: str | None = Field(default=None, strict=True, pattern=STATE_REF_KEY_PATTERN)

    @field_validator("value")
    @classmethod
    def bounded_value(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _bounded_state_value(value)


class StateUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    entries: tuple[StateEntry, ...] = Field(min_length=1, max_length=STATE_BATCH)

    @field_validator("entries")
    @classmethod
    def unique_keys(cls, entries: tuple[StateEntry, ...]) -> tuple[StateEntry, ...]:
        if len({entry.state_key for entry in entries}) != len(entries):
            raise ValueError("a batch names each state_key once")
        return entries


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    token: str = Field(strict=True, pattern=r"^[0-9a-f]{64}$", repr=False)


class RoomCreation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    slug: str = Field(strict=True, pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    label: str = Field(strict=True, min_length=1, max_length=128, pattern=r"^[^\x00-\x1f\x7f]+$")

    @field_validator("label")
    @classmethod
    def label_utf8(cls, value: str) -> str:
        value.encode("utf-8")
        return value


class Membership(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    session_id: UUID


class Mute(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    muted: bool = Field(strict=True)


class PmMark(BaseModel):
    """The operator's set (`pm: true`) or clear (`pm: false`) of the room's PM mark for one session."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    session_id: UUID
    pm: bool = Field(strict=True)


class RoleMark(BaseModel):
    """The operator's set or clear of one of the three role marks for one session."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    role: Literal["pm", "github_pm", "delivery_manager"]
    session_id: UUID
    assigned: bool = Field(strict=True)


class Reply(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    body: str = Field(strict=True, min_length=1)
    recipients: tuple[UUID, ...] = Field(default=(), max_length=16)
    receipts: bool = Field(default=False, strict=True)

    @field_validator("body")
    @classmethod
    def bounded_body(cls, value: str) -> str:
        return Publication.bounded_body(value)


class DeliveryClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    messages: tuple[UUID, ...] = Field(min_length=1, max_length=16)

    @field_validator("messages")
    @classmethod
    def unique_messages(cls, value: tuple[UUID, ...]) -> tuple[UUID, ...]:
        return tuple(sorted(set(value)))


# Undelivered sender receipts one feed read returns, and the most one delivered mark names.
RECEIPT_FEED_LIMIT = 50


class ReceiptDelivery(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    receipts: tuple[UUID, ...] = Field(min_length=1, max_length=RECEIPT_FEED_LIMIT)

    @field_validator("receipts")
    @classmethod
    def unique_receipts(cls, value: tuple[UUID, ...]) -> tuple[UUID, ...]:
        return tuple(sorted(set(value)))


# Every outcome and the reasons it may carry; the only vocabulary DeliveryResult validates against.
DELIVERY_REASONS: dict[str, frozenset[str | None]] = {
    "handed": frozenset({None}),
    "failed": frozenset({"native_unavailable"}),
    "deferred": frozenset({"busy", "muted", "stopped", "plan", "unknown", "offline", "stale_binding"}),
    "uncertain": frozenset({"transport_ambiguous"}),
}


class DeliveryResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    outcome: str = Field(strict=True)
    reason: str | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def reason_matches_outcome(self) -> "DeliveryResult":
        if self.reason not in DELIVERY_REASONS.get(self.outcome, frozenset()):
            raise ValueError("delivery outcome and reason must be a known pair")
        return self


class EmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


HTTP_ERROR_STATUS = {
    "UNAUTHENTICATED": 401,
    "SESSION_FORBIDDEN": 403,
    "CSRF_FORBIDDEN": 403,
    "LOGIN_RATE_LIMITED": 429,
    "ROOM_FORBIDDEN": 403,
    "STATE_KEY_FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "BINDING_CONFLICT": 409,
    "ROOM_CONFLICT": 409,
    "ROLE_CONFLICT": 409,
    "STALE_INSTANCE": 409,
    "IDEMPOTENCY_CONFLICT": 409,
    "CONSULTATION_LIMIT": 409,
    "DELIVERY_DISABLED": 403,
    "DELIVERY_BLOCKED": 409,
    "DELIVERY_INELIGIBLE": 409,
    "DELIVERY_IN_FLIGHT": 409,
    "DELIVERY_BATCH_CONFLICT": 409,
    "DELIVERY_CLOSED": 409,
    "DELIVERY_EXHAUSTED": 409,
    "DELIVERY_BACKOFF": 409,
    "WAKE_LIMIT": 429,
    "INSTANCE_LIMIT": 429,
    "REGISTRATION_LIMIT": 429,
    "PUBLICATION_LIMIT": 429,
    "MESSAGE_EXPIRED": 410,
    "CURSOR_EXPIRED": 410,
    "INVALID_REQUEST": 422,
    "INVALID_RECIPIENT": 422,
    "INVALID_CURSOR": 422,
}


class ChatError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
