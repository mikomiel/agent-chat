"""One private stdin/stdout lifecycle worker; no launcher, native send or retry.

The parent supplies one explicit join, then serial heartbeat, pending, claim, settle,
status, receipts, receipts_delivered and end requests. EOF, idle expiry and failure end only this
instance. All I/O runs under a real process deadline, including pipe backpressure. Imports start
nothing.

The join resolves the server host once, after the binding record is written, in a child process that
the join's deadline bounds, that arms its own alarm for that deadline and that, on Linux, dies with the
worker. A join that sends nothing keeps its record, for a retry of the same boot or for the next start's
stale sweep. Every later request connects only to those addresses, in order, and performs no name
resolution; TLS still verifies the host name. When none of them accepts a connection the request fails
with TRANSPORT_UNAVAILABLE. Only the next join, the parent's rejoin, resolves again.
"""

import json
import re
import signal
import sys
from collections.abc import Callable
from pathlib import Path
from time import monotonic
from typing import Any
from uuid import UUID

from . import instance_client, instance_file
from .client import Interrupted
from .models import LEASE_SECONDS, ChatError, DeliveryClaim, DeliveryResult, Heartbeat, ReceiptDelivery

MAX_FRAME = 128 * 1024
REQUEST_SECONDS = 20
IDLE_SECONDS = 90
# A server restart fails a poll or a heartbeat without ending the session. Each op tolerates its own
# unbroken failure streak for less than the server lease; one success of that op ends the streak.
# A repeated heartbeat is safe, a claim or settle is not. Receipts are advisory and have no streak: a receipt
# read or mark that fails, whatever the code or the length of the failure, answers `refused` and never ends the
# worker, because the parent offers the receipt again at its next poll. Liveness stays with heartbeat, pending
# and claim, which fail closed. The receipts read includes the session's mute flag (`_receipts_with_mute`), so a
# failed mute read is the same refusal, not the fatal `status` request.
PENDING_OUTAGE = frozenset({"TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE"})
HEARTBEAT_OUTAGE = PENDING_OUTAGE | {"REQUEST_UNCERTAIN"}


def _interrupt(_signum: int, _frame: Any) -> None:
    raise Interrupted("worker interrupted")


def _read(expected: int) -> dict[str, Any] | None:
    raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not raw:
        return None
    if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
        raise ChatError("INVALID_REQUEST")
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict) or type(request.get("id")) is not int or request["id"] != expected:
        raise ChatError("INVALID_REQUEST")
    return request


def _write(frame: dict[str, Any], credentials: tuple[str, ...]) -> None:
    rendered = json.dumps(frame, ensure_ascii=True)
    # Lifecycle replies contain metadata only. Never pass a reflected credential
    # to the parent even if an upstream response contains it in a label.
    for credential in credentials:
        if credential:
            rendered = re.sub(re.escape(credential), "[REDACTED]", rendered, flags=re.IGNORECASE)
    data = (rendered + "\n").encode("ascii")
    if len(data) > MAX_FRAME:
        raise ChatError("INVALID_RESPONSE")
    # Write past the buffer, straight to the stdout descriptor: a buffered byte that the alarm strands would be
    # flushed again at interpreter exit with no deadline, against a parent that no longer reads. The alarm may
    # interrupt a write after part of the frame; that frame is abandoned, because the stream is already broken.
    stdout = sys.stdout.buffer
    out = getattr(stdout, "raw", stdout)  # the unbuffered file; an in-memory stream has no buffer to bypass
    view = memoryview(data)
    while view:
        written = out.write(view)
        if not written:
            raise OSError("stdout accepted no bytes")
        view = view[written:]


def _join(request: dict[str, Any]) -> instance_client.JoinedInstance:
    if (
        set(request)
        != {
            "id",
            "op",
            "enabled",
            "directory",
            "native_session_id",
            "boot_id",
            "server_origin",
            "host_token",
            "harness",
        }
        or request["op"] != "join"
    ):
        raise ChatError("INVALID_REQUEST")
    if not isinstance(request["directory"], str) or not Path(request["directory"]).is_absolute():
        raise ChatError("INVALID_REQUEST")
    return instance_client.join_instance(
        Path(request["directory"]),
        request["native_session_id"],
        UUID(request["boot_id"]),
        server_origin=request["server_origin"],
        host_token=request["host_token"],
        harness=request["harness"],
        enabled=request["enabled"],
        # The lookup gets what is left of the alarm armed before the join frame, not a fresh budget, so a resolver
        # whose death signal is refused cannot outlive the join's own deadline.
        resolve_by=monotonic() + (signal.getitimer(signal.ITIMER_REAL)[0] or REQUEST_SECONDS),
    )


def _end(instance: instance_client.JoinedInstance, directory: Path) -> dict[str, Any]:
    """Drop this binding's record, then end it.

    The record goes first. Once its removal succeeds, a new open of its path finds nothing while the end is in
    flight, or after an end that fails or is cut short by a kill; the instance then ends when no heartbeat renews its
    server lease. Removal is best effort. A caller that already holds the file open or has read the credential can
    still use it, and its heartbeats renew the lease. A removal that fails or runs out of time is not raised. The
    worker's alarm is armed again after it, because the removal may have used it up: the end request, everything it
    loads first and the reply that follows stay under one hard limit, like every other worker request. The end uses
    the credential held in memory.
    """
    instance_file.discard_instance(directory, instance.binding.boot_id)
    signal.setitimer(signal.ITIMER_REAL, REQUEST_SECONDS)
    return instance_client.end(instance)


def _asks_bodies(request: dict[str, Any]) -> bool:
    """The optional `bodies` flag of pending and claim: absent is false, and only a JSON boolean is accepted."""
    flag = request.get("bodies", False)
    if type(flag) is not bool:
        raise ChatError("INVALID_REQUEST")
    return flag


def _is_pending(request: dict[str, Any]) -> bool:
    return request.get("op") == "pending" and {"id", "op"} <= set(request) <= {"id", "op", "bodies"}


def _delivery(instance: instance_client.JoinedInstance, request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("op")
    try:
        if _is_pending(request):
            return instance_client.pending(instance, _asks_bodies(request))
        if operation == "claim" and {"id", "op", "key", "messages"} <= set(request) <= {
            "id",
            "op",
            "key",
            "messages",
            "bodies",
        }:
            return instance_client.claim(
                instance, UUID(request["key"]), DeliveryClaim(messages=request["messages"]), _asks_bodies(request)
            )
        if operation == "settle" and set(request) == {"id", "op", "attempt", "result"}:
            return instance_client.settle(
                instance, UUID(request["attempt"]), DeliveryResult.model_validate(request["result"])
            )
    except ChatError as error:
        # A definite refusal is the ledger's answer, not a failed transport, and that holds for settlement
        # too: a reservation that lapsed while the native send ran answers DELIVERY_CLOSED, and the server has
        # already settled the attempt as uncertain. Ending the worker there would disable chat for the whole
        # session over an ordinary race. Only an uncertain or unavailable transport ends the worker.
        if error.code in {
            "DELIVERY_DISABLED",
            "DELIVERY_BLOCKED",
            "DELIVERY_IN_FLIGHT",
            "DELIVERY_BATCH_CONFLICT",
            "DELIVERY_CLOSED",
            "DELIVERY_EXHAUSTED",
            "DELIVERY_BACKOFF",
            "DELIVERY_INELIGIBLE",
            "CONSULTATION_LIMIT",
            "WAKE_LIMIT",
            "NOT_FOUND",
            "MESSAGE_EXPIRED",
        }:
            return {"refused": error.code}
        raise
    raise ChatError("INVALID_REQUEST")


def _receipts_with_mute(instance: instance_client.JoinedInstance) -> dict[str, Any]:
    """The receipt feed, and the session's `muted` flag when the feed has rows, as one answer.

    A receipt waits while the session is muted, so the parent needs the flag before it shows one. `status` is a
    fatal request in this worker: a parent that asked for it separately would end the session over an advisory
    receipt. The flag is read here instead, inside the receipt refusal, so a failed or malformed read answers
    `refused` for the whole request and the worker keeps serving. An empty feed has nothing to hold, so it needs no
    flag. An older worker never sends one, which a parent must read as muted.
    """
    feed = instance_client.receipts(instance)
    if feed["receipts"]:
        muted = instance_client.status(instance).get("muted")
        if type(muted) is not bool:
            raise ChatError("INVALID_RESPONSE")
        feed["muted"] = muted
    return feed


def main() -> int:
    instance = None
    directory: Path | None = None
    ended = False
    sequence = 0
    code = 0
    credentials: tuple[str, ...] = ()
    pending_at: float | None = None
    pending_delay = 2.0
    published_state: Heartbeat | None = None
    failing_since: dict[str, float] = {}
    terminated = False

    def _terminate(signum: int, frame: Any) -> None:
        # SIGTERM makes the blocked request fail like a transport error. Record it so it is never tolerated.
        nonlocal terminated
        terminated = True
        _interrupt(signum, frame)

    def _outage(op: str, error: ChatError, codes: frozenset[str]) -> bool:
        if terminated or error.code not in codes:
            return False
        return monotonic() - failing_since.setdefault(op, monotonic()) < LEASE_SECONDS

    def _receipt(call: Callable[..., Any], *arguments: Any) -> Any:
        try:
            return call(*arguments)
        except ChatError as error:
            if terminated:  # SIGTERM interrupted the call: a stop still ends the worker
                raise
            return {"refused": error.code}

    signal.signal(signal.SIGALRM, _interrupt)
    signal.signal(signal.SIGTERM, _terminate)
    signal.setitimer(signal.ITIMER_REAL, REQUEST_SECONDS)
    try:
        request = _read(0)
        if request is None:
            return 0
        instance = _join(request)
        directory = Path(request["directory"])
        credentials = (request["host_token"], instance.binding.token)
        _write(
            {
                "id": 0,
                "result": {
                    "session_id": str(instance.session_id),
                    "instance_id": str(instance.instance_id),
                    "room_id": str(instance.room_id),
                    "host": instance.host,
                    "harness": instance.harness,
                    "instance_file": str(directory / f"{instance.binding.boot_id}.json"),
                },
            },
            credentials,
        )
        # Host authority is not needed again. Do not retain it across idle waits.
        credentials = (instance.binding.token,)
        request = None
        # Local housekeeping after the join reply: peers' records untouched for an hour. No content, no network.
        instance_file.sweep_stale(directory, instance.binding.boot_id)
        while True:
            sequence += 1
            signal.setitimer(signal.ITIMER_REAL, IDLE_SECONDS)
            request = _read(sequence)
            signal.setitimer(signal.ITIMER_REAL, REQUEST_SECONDS)
            if request is None:
                break
            operation = request.get("op")
            if operation == "heartbeat" and set(request) == {"id", "op", "state"}:
                state = Heartbeat.model_validate(request["state"])
                try:
                    result = instance_client.heartbeat(instance, state)
                except ChatError as error:
                    if not _outage("heartbeat", error, HEARTBEAT_OUTAGE):
                        raise
                    # Nothing was published or renewed; the parent's next heartbeat is the retry.
                    result = {"refused": error.code}
                else:
                    failing_since.pop("heartbeat", None)
                    instance_file.touch_instance(directory, instance.binding.boot_id)
                    if state != published_state:
                        pending_at, pending_delay = None, 2.0
                    published_state = state
            elif _is_pending(request):
                if pending_at is not None and monotonic() < pending_at:
                    result = {"messages": []}
                else:
                    try:
                        result = _delivery(instance, request)
                    except ChatError as error:
                        if not _outage("pending", error, PENDING_OUTAGE):
                            raise
                        result = {"refused": error.code}
                    else:
                        # An admission refusal also proves the server answered.
                        failing_since.pop("pending", None)
                    if result == {"messages": []}:
                        pending_at = monotonic() + pending_delay
                        pending_delay = min(8.0, pending_delay * 2)
                    elif result.get("messages"):
                        pending_at, pending_delay = None, 2.0
            elif operation == "status" and set(request) == {"id", "op"}:
                result = instance_client.status(instance)
            elif operation == "receipts" and set(request) == {"id", "op"}:
                # Receipts never wake: the parent outputs them at its next native boundary, then marks them.
                result = _receipt(_receipts_with_mute, instance)
            elif operation == "receipts_delivered" and set(request) == {"id", "op", "receipts"}:
                receipts = ReceiptDelivery(receipts=request["receipts"])
                # A refusal marks nothing: the parent keeps its evidence and marks again at its next poll.
                result = _receipt(instance_client.receipts_delivered, instance, receipts)
            elif operation == "end" and set(request) == {"id", "op"}:
                result = _end(instance, directory)
                ended = True
            else:
                result = _delivery(instance, request)
            _write({"id": sequence, "result": result}, credentials)
            if ended:
                break
    except ChatError as error:
        code = 1
        _error(sequence, error.code)
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        code = 1
        _error(sequence, "INVALID_REQUEST")
    except (OSError, KeyboardInterrupt):
        code = 1
        # Timeout or loss of the parent does not prove that a mutation failed.
        _error(sequence, "REQUEST_UNCERTAIN")
    finally:
        if instance is not None and directory is not None and not ended:
            signal.setitimer(signal.ITIMER_REAL, REQUEST_SECONDS)
            try:
                _end(instance, directory)
            except (ChatError, OSError, KeyboardInterrupt):
                code = 1  # the server lease remains the fallback, not a success claim
        signal.setitimer(signal.ITIMER_REAL, 0)
    return code


def _error(sequence: int, code: str) -> None:
    # Fixed codes only, no tracebacks, input, destination or upstream text.
    signal.setitimer(signal.ITIMER_REAL, 1)
    try:
        _write({"id": sequence, "error": {"code": code}}, ())
    except (ChatError, OSError):
        pass


if __name__ == "__main__":
    raise SystemExit(main())
