"""Explicit adapter lifecycle calls, not a scheduler, launcher or native sender.

The native adapter owns eligibility, a fresh boot UUID, context fencing and the
outer process/request deadline. These synchronous calls perform no retry,
credential discovery, automatic join or model work.
"""

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from .client import Address, Client, resolve_origin
from .instance_file import InstanceSecret, _prepare_instance, discard_instance
from .models import RECEIPT_FEED_LIMIT, ChatError, DeliveryClaim, DeliveryResult, Heartbeat, ReceiptDelivery
from .protocol import cursor, token_digest


@dataclass(frozen=True)
class JoinedInstance:
    binding: InstanceSecret = field(repr=False)
    session_id: UUID
    instance_id: UUID
    room_id: UUID
    host: str
    harness: str
    # The server's addresses when the join resolved them (`resolve_by`), else empty. A binding with addresses
    # connects only to them for its whole lifetime and never resolves the host again; only a new join does.
    addresses: tuple[Address, ...] = field(default=(), repr=False)


def _client(instance: JoinedInstance, deadline: float | None) -> Client:
    """A binding's client: fixed to its join-time addresses, or resolving per request when it has none."""
    origin, token = instance.binding.server_origin, instance.binding.token
    addresses = getattr(instance, "addresses", ())  # a stand-in instance without the field has none
    if addresses:
        return Client(origin, token, deadline=deadline, addresses=addresses)
    return Client(origin, token, deadline=deadline)


def _uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise ValueError("invalid binding ID")
    result = UUID(value)
    if str(result) != value:
        raise ValueError("noncanonical binding ID")
    return result


def _not_refused(result: Any) -> None:
    # Only the worker writes `refused`, for an outage it tolerates. The server never sends it, so one in a server
    # reply is a protocol violation and must not pass through as that tolerated outage.
    if isinstance(result, dict) and "refused" in result:
        raise ValueError("refused in a server reply")


def join_instance(
    directory: Path,
    native_session_id: str,
    boot_id: UUID,
    *,
    server_origin: str,
    host_token: str,
    harness: Literal["pi", "codex", "claude", "deepseek", "opencode"],
    enabled: bool = False,
    deadline: float | None = None,
    resolve_by: float | None = None,
) -> JoinedInstance:
    """Persist the instance secret before sending its digest with host authority.

    On uncertainty the owner may explicitly repeat this exact boot/origin/ID.
    It must not rotate the secret or turn a retry into a replacement process.
    A malformed response remains uncertain even if registration committed.

    With `resolve_by`, a monotonic time, the server host is resolved once before that time, after the record's own
    checks. The registration and every later request of the binding connect only to those addresses.

    `TRANSPORT_UNAVAILABLE` here means nothing was sent: the lookup failed or no address accepted a connection. No
    instance can exist that the record would recover, so a record this call created is discarded. A record that
    was already there, from an attempt that may have registered, stays for the next retry, as on every other
    failure.
    """
    if enabled is not True:
        raise ChatError("INTEGRATION_DISABLED")
    if harness not in ("pi", "codex", "claude", "deepseek", "opencode"):
        raise ChatError("INVALID_REQUEST")
    registration_client = Client(server_origin, host_token, deadline=deadline)
    # Whether the exclusive open made the record, never a separate existence probe: an alarm inside a probe that
    # swallows OSError would read as "absent" and mark an earlier attempt's recoverable record for removal.
    secret, created = _prepare_instance(directory, native_session_id, boot_id, server_origin=server_origin)
    addresses: tuple[Address, ...] = ()
    try:
        if resolve_by is not None:
            addresses = resolve_origin(server_origin, deadline=resolve_by)
            registration_client = Client(server_origin, host_token, deadline=deadline, addresses=addresses)
        result = registration_client.request(
            "POST",
            "/v1/sessions",
            {
                "native_session_id": secret.native_session_id,
                "boot_id": str(secret.boot_id),
                "instance_token_hash": token_digest(secret.token),
            },
        )
    except ChatError as error:
        if created and error.code == "TRANSPORT_UNAVAILABLE":
            discard_instance(directory, boot_id)
        raise
    try:
        if (
            not isinstance(result, dict)
            or set(result) != {"session_id", "instance_id", "room_id", "host", "harness"}
            or result["harness"] != harness
            or not isinstance(result["host"], str)
            or not result["host"]
        ):
            raise ValueError("invalid registration response")
        return JoinedInstance(
            secret,
            _uuid(result["session_id"]),
            _uuid(result["instance_id"]),
            _uuid(result["room_id"]),
            result["host"],
            result["harness"],
            addresses,
        )
    except (ValueError, TypeError, KeyError):
        raise ChatError("REQUEST_UNCERTAIN") from None


def _request(
    instance: JoinedInstance, method: str, path: str, payload=None, *,
    invalid: str | None = None, deadline: float | None = None,
) -> dict[str, Any]:
    # Each lifecycle operation has its own bounded response budget. Never retain
    # the host credential here or reopen/discover a different binding file.
    client = _client(instance, deadline)
    result = client.request(method, path, payload, invalid=invalid)
    try:
        if not isinstance(result, dict) or _uuid(result.get("instance_id")) != instance.instance_id:
            raise ValueError("different binding in response")
        _not_refused(result)
        if method == "GET":
            if _uuid(result.get("session_id")) != instance.session_id:
                raise ValueError("different logical session in response")
    except (ValueError, TypeError):
        # The worker tolerates a short outage on heartbeat and pending, so those two name a
        # foreign or malformed binding `invalid`: a protocol violation is never an outage.
        raise ChatError(invalid or ("REQUEST_UNCERTAIN" if method == "POST" else "TRANSPORT_UNAVAILABLE")) from None
    return result


def heartbeat(instance: JoinedInstance, state: Heartbeat, *, deadline: float | None = None) -> dict[str, Any]:
    """Only publish the owner's explicit observation; never clear stop implicitly."""
    if not isinstance(state, Heartbeat):
        raise ChatError("INVALID_REQUEST")
    return _request(
        instance,
        "POST",
        "/v1/instance/heartbeat",
        state.model_dump(mode="json", exclude_unset=True),
        invalid="INVALID_RESPONSE",
        deadline=deadline,
    )


def status(instance: JoinedInstance, *, deadline: float | None = None) -> dict[str, Any]:
    """Observe this binding without renewing its lease or acknowledging messages."""
    return _request(instance, "GET", "/v1/instance/status", deadline=deadline)


def end(instance: JoinedInstance, *, deadline: float | None = None) -> dict[str, Any]:
    """Explicitly end this exact binding, including a safe same-binding retry."""
    return _request(instance, "POST", "/v1/instance/end", {}, deadline=deadline)


def pending(instance: JoinedInstance, sizing: bool = False, *, deadline: float | None = None) -> dict[str, Any]:
    """Candidate IDs; `sizing` adds the server's body sizes and retry marker, but only when it sent them."""
    result = _request(
        instance, "GET", "/v1/instance/deliveries/pending", invalid="INVALID_RESPONSE", deadline=deadline
    )
    try:
        ids = result["messages"]
        if not isinstance(ids, list) or len(ids) > 16 or len({_uuid(value) for value in ids}) != len(ids):
            raise ValueError("invalid candidates")
        if not sizing or not ids or ("sizes" not in result and "retry" not in result):
            return {"messages": ids}
        sizes, retry = result["sizes"], result["retry"]
        if (
            type(retry) is not bool
            or not isinstance(sizes, dict)
            or set(sizes) != set(ids)
            or any(type(size) is not int or size < 0 for size in sizes.values())
        ):
            raise ValueError("invalid sizing")
    except (ValueError, TypeError, KeyError):
        raise ChatError("INVALID_RESPONSE") from None
    return {"messages": ids, "sizes": sizes, "retry": retry}


#: The most UTF-8 bytes of one body that may cross IPC: the notice's own per-body bound.
NOTICE_BODY_BYTES = 4096
#: The worker frame is at most 128 KiB of ASCII-escaped JSON (instance_worker.MAX_FRAME). A character escapes to
#: up to six bytes, so a claimed batch of bodies could overflow it; the bodies share this part of the frame.
IPC_BODY_WIRE_BYTES = 96 * 1024


def _bounded_body(body: str, wire_bytes: int) -> tuple[str, bool]:
    """Cut at a code point so the body fits both bounds: `(text, whether it was cut)`."""
    used = wire = 0
    for index, char in enumerate(body):
        used += len(char.encode("utf-8"))
        wire += len(json.dumps(char, ensure_ascii=True)) - 2
        if used > NOTICE_BODY_BYTES or wire > wire_bytes:
            return body[:index], True
    return body, False


def _utc(moment: datetime) -> str:
    """A server time as UTC text with a plain `+00:00` offset: the Node renderer reads no offset with seconds."""
    return moment.astimezone(UTC).isoformat()


def _body_fields(row: dict[str, Any], wire_bytes: int) -> dict[str, Any]:
    """The named extra fields of one claimed message that bodies mode passes on."""
    body, sender = row["body"], row["sender"]
    if not isinstance(body, str) or not body or not isinstance(sender, dict):
        raise ValueError("invalid content")
    session = sender["session_id"]  # an operator or browser publication has no sending session
    created = datetime.fromisoformat(row["created_at"])
    if created.utcoffset() is None:
        raise ValueError("invalid creation time")
    text, cut = _bounded_body(body, wire_bytes)
    return {
        "body": text,
        "body_truncated": cut,
        "sender_session_id": None if session is None else str(_uuid(session)),
        "sender_principal_id": str(_uuid(sender["principal_id"])),
        "created_at": _utc(created),
        "thread_id": str(_uuid(row["thread_id"])),
    }


def claim(
    instance: JoinedInstance, key: UUID, request: DeliveryClaim, bodies: bool = False, *,
    deadline: float | None = None,
) -> dict[str, Any]:
    """Validate a grant and return metadata only; bodies stay in explicit history unless `bodies` asks."""
    result = _client(instance, deadline).request(
        "POST",
        "/v1/instance/deliveries/claim",
        request.model_dump(mode="json"),
        str(key),
    )
    try:
        _not_refused(result)
        attempt = result["attempt"]
        if _uuid(attempt["instance_id"]) != instance.instance_id or type(result["dispatch"]) is not bool:
            raise ValueError("invalid grant identity")
        attempt_id = _uuid(attempt["id"])
        admitted, expires = (datetime.fromisoformat(attempt[field]) for field in ("admitted_at", "expires_at"))
        if admitted.utcoffset() is None or expires.utcoffset() is None:
            raise ValueError("invalid grant clock")
        reservation_ms = (expires - admitted).total_seconds() * 1000
        if not 0 < reservation_ms <= 30_000:
            raise ValueError("invalid grant lifetime")
        messages = result["messages"]
        if not isinstance(messages, list) or len(messages) > 16:
            raise ValueError("invalid batch")
        if result["dispatch"]:
            if (
                attempt["outcome"] is not None
                or {_uuid(row["id"]) for row in messages} != set(request.messages)
                or len(messages) != len(request.messages)
            ):
                raise ValueError("invalid dispatch")
        elif messages:
            raise ValueError("replayed content")
        metadata = []
        for row in messages:
            if row["kind"] not in ("question", "consultation", "reply"):
                raise ValueError("ineligible kind")
            # Whitelist, not a shallow copy: no body or upstream extras cross IPC unless a field is named.
            item = {
                "id": str(_uuid(row["id"])),
                "room_id": str(_uuid(row["room_id"])),
                "history_after": str(cursor(row["history_after"])),
                "kind": row["kind"],
            }
            if bodies:
                item.update(_body_fields(row, IPC_BODY_WIRE_BYTES // len(messages)))
            metadata.append(item)
        grant = {
            "dispatch": result["dispatch"],
            "attempt_id": str(attempt_id),
            "reservation_ms": reservation_ms,
            "messages": metadata,
        }
        if bodies:
            grant["admitted_at"] = _utc(admitted)
        return grant
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, ChatError):
        raise ChatError("REQUEST_UNCERTAIN") from None


#: A server-controlled principal field (harness or host): the administration owner's host grammar.
_PRINCIPAL_FIELD = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")


def _receipt(row: dict[str, Any]) -> dict[str, str]:
    """Whitelist one sender receipt: IDs, state, the recipient's harness and host, creation time. No free text."""
    created = datetime.fromisoformat(row["created_at"])
    if (
        row["state"] not in ("handed", "acked")
        or created.utcoffset() is None
        or not all(
            isinstance(row[key], str) and _PRINCIPAL_FIELD.fullmatch(row[key])
            for key in ("recipient_harness", "recipient_host")
        )
    ):
        raise ValueError("invalid receipt")
    return {
        "id": str(_uuid(row["id"])),
        "message_id": str(_uuid(row["message_id"])),
        "state": row["state"],
        "recipient_session_id": str(_uuid(row["recipient_session_id"])),
        "recipient_harness": row["recipient_harness"],
        "recipient_host": row["recipient_host"],
        "created_at": created.isoformat(),
    }


def receipts(instance: JoinedInstance, *, deadline: float | None = None) -> dict[str, Any]:
    """The session's own undelivered sender receipts, oldest first. Reading marks nothing delivered."""
    result = _request(
        instance, "GET", "/v1/instance/receipts", invalid="INVALID_RESPONSE", deadline=deadline
    )
    try:
        rows = result["receipts"]
        if not isinstance(rows, list) or len(rows) > RECEIPT_FEED_LIMIT:
            raise ValueError("invalid receipts")
        items = [_receipt(row) for row in rows]
        if len({item["id"] for item in items}) != len(items):
            raise ValueError("duplicate receipt")
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ChatError("INVALID_RESPONSE") from None
    return {"receipts": items}


def receipts_delivered(
    instance: JoinedInstance, request: ReceiptDelivery, *, deadline: float | None = None
) -> dict[str, Any]:
    """Mark receipts the adapter output as delivered; only the session's own are marked, and a repeat is safe."""
    if not isinstance(request, ReceiptDelivery):
        raise ChatError("INVALID_REQUEST")
    result = _request(
        instance, "POST", "/v1/instance/receipts/delivered", request.model_dump(mode="json"), deadline=deadline
    )
    try:
        delivered = result["delivered"]
        if not isinstance(delivered, list):
            raise ValueError("invalid delivered list")
        ids = [str(_uuid(value)) for value in delivered]
        if len(set(ids)) != len(ids) or not set(ids) <= {str(value) for value in request.receipts}:
            raise ValueError("delivered receipts were not requested")
    except (ValueError, TypeError, KeyError):
        raise ChatError("REQUEST_UNCERTAIN") from None
    return {"delivered": ids}


def settle(
    instance: JoinedInstance, attempt: UUID, request: DeliveryResult, *, deadline: float | None = None
) -> dict[str, Any]:
    result = _client(instance, deadline).request(
        "POST",
        f"/v1/instance/deliveries/{attempt}/result",
        request.model_dump(mode="json"),
    )
    try:
        _not_refused(result)
        if (
            _uuid(result["instance_id"]) != instance.instance_id
            or _uuid(result["id"]) != attempt
            or (result["outcome"], result["reason"]) != (request.outcome, request.reason)
        ):
            raise ValueError("invalid settlement")
    except (ValueError, TypeError, KeyError):
        raise ChatError("REQUEST_UNCERTAIN") from None
    return {"attempt_id": str(attempt), "outcome": request.outcome, "reason": request.reason}
