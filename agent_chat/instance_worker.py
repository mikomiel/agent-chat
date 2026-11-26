"""One private stdin/stdout lifecycle worker; no launcher or native send, and no retry but a settlement's.

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

The join reply names what this worker can do beyond the base requests (`capabilities`). `receipts-cancel` means
that SIGUSR1 ends a receipts request that is running, which then answers `refused`, so that a delivery never waits
in this worker behind advisory work; the server finishes the request. Nothing else ends on it, and it never ends the
worker. A signal that lands after a receipts request has its answer and before the next frame is read may be late for
that request, and is dropped. Anywhere else outside a receipts request it is remembered once: a receipts request
read next answers `refused` without asking, and any other request read next forgets it. A signal names no request, so a
parent repeats it every few milliseconds until the request answers: the first one that lands after this worker read the
request ends it, and one that crosses the answer is dropped.
"""

import json
import re
import signal
import sys
from collections.abc import Callable
from pathlib import Path
from time import monotonic, sleep
from typing import Any
from uuid import UUID

from . import instance_client, instance_file
from .client import Interrupted, defer_signal
from .models import LEASE_SECONDS, ChatError, DeliveryClaim, DeliveryResult, Heartbeat, ReceiptDelivery

MAX_FRAME = 128 * 1024
REQUEST_SECONDS = 20
# A receipts request holds the parent's one request slot. A parent that has a delivery, a heartbeat or a state
# report to send ends it with CANCEL_SIGNAL; this deadline, well inside the alarm's REQUEST_SECONDS, is what ends
# one that nobody asks to end. A request that runs out answers `refused` like any other receipts failure, and the
# parent asks again at its next poll.
RECEIPT_SECONDS = 2.0
IDLE_SECONDS = 90
# A server restart fails a poll or a heartbeat without ending the session. Each op tolerates its own
# unbroken failure streak for less than the server lease; one success of that op ends the streak.
# A repeated heartbeat is safe and a claim is not. A settle is safe only as the same attempt with the same result,
# which `_settle` sends again itself, so it has no streak either. Receipts are advisory and have no streak: a receipt
# read or mark that fails, whatever the code or the length of the failure, answers `refused` and never ends the
# worker, because the parent offers the receipt again at its next poll. Liveness stays with heartbeat, pending
# and claim, which fail closed. The receipts read includes the session's mute flag (`_receipts_with_mute`), so a
# failed mute read is the same refusal, not the fatal `status` request.
PENDING_OUTAGE = frozenset({"TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE"})
HEARTBEAT_OUTAGE = PENDING_OUTAGE | {"REQUEST_UNCERTAIN"}
RECEIPTS_OPERATIONS = frozenset({"receipts", "receipts_delivered"})
# The signal that ends a receipts request, fixed at import: the worker names it in its join reply, and a parent
# signals only a worker that did, because a process without the handler would die of it.
CANCEL_SIGNAL = signal.SIGUSR1
CAPABILITIES = ("receipts-cancel",)
# A settlement with no answer is sent again after this pause. One try can take 3 s (the client's step), so the
# pause only keeps a refused connection from spinning; it is not a back-off.
SETTLE_PAUSE_SECONDS = 0.5
# The tries end this long before the alarm that is armed, so the worker answers its parent before the alarm fires.
SETTLE_MARGIN_SECONDS = 1.0


def _interrupt(_signum: int, _frame: Any) -> None:
    raise Interrupted("worker interrupted")


class _ReceiptsCancelled(Interrupted):
    """What CANCEL_SIGNAL raises inside a receipts request. SIGTERM and the alarm raise a plain `Interrupted`."""


def _deferrable(handler: Callable[[int, Any], None]) -> Callable[[int, Any], None]:
    """Wrap a handler that raises, so that the client can hold a call back while it starts a request's timer thread.

    An exception from a handler is not safe inside `Thread.start`. The wrapper asks the client first
    (`defer_signal`). A call that the client holds back is recorded and returns with nothing changed; the client calls
    the handler again once the start is over. Only that call latches, records or raises, so each flag is set once.
    With nothing held back, a call goes straight to the handler.
    """

    def run(signum: int, frame: Any) -> None:
        if not defer_signal(signum):
            handler(signum, frame)

    return run


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


def _settle(
    instance: instance_client.JoinedInstance, attempt: UUID, result: DeliveryResult, stopping: Callable[[], bool]
) -> dict[str, Any]:
    """Settle, and send the same attempt and result again while the request has no answer and has time left.

    A try has no answer when the client marks its error `unanswered` (it got no status, or a 5xx) and its code is
    one of `HEARTBEAT_OUTAGE`. Such a settlement may have committed, and a server that waits too
    long for a lock answers it with a 5xx that did not. The client reports both as `REQUEST_UNCERTAIN`. Ending the
    worker there would leave the reservation to lapse as `uncertain`, and the message would never be offered again
    (#176). The server answers a repeat of the same outcome with the recorded one, and another outcome or a lapsed
    reservation with `DELIVERY_CLOSED`, so a repeat can neither settle twice nor change the record. The service
    sends a status below 500 only once the settlement is committed or definitely refused, so a reply below 500 that
    cannot be accepted (a redirect, a body that is not the service's or is cut, a 200 that names another attempt) is
    an answer even where its code is `REQUEST_UNCERTAIN`. It is never sent again, and neither are a definite
    refusal, any other code and a stop (`stopping`, the worker's SIGTERM). A stop during a pause ends the worker with
    `REQUEST_UNCERTAIN`, as it ends any request it interrupts; a pause that ends after the deadline starts no try,
    and the last failure propagates.

    All tries share one deadline, `SETTLE_MARGIN_SECONDS` before the alarm armed for the request (`REQUEST_SECONDS`
    when none is, as in `_join`). When it is spent the last error propagates and ends the worker. The client ends a
    try that crosses the deadline with `CLI_INTERRUPTED`, which the parent does not know, so it leaves as
    `REQUEST_UNCERTAIN`, the code of a request that may have been sent (`Adapter._failed_operation` maps it the same
    way).
    """
    deadline = monotonic() + (signal.getitimer(signal.ITIMER_REAL)[0] or REQUEST_SECONDS) - SETTLE_MARGIN_SECONDS
    while True:
        try:
            return instance_client.settle(instance, attempt, result, deadline=deadline)
        except ChatError as error:
            if error.code == "CLI_INTERRUPTED":
                raise ChatError("REQUEST_UNCERTAIN") from None
            no_answer = error.unanswered and error.code in HEARTBEAT_OUTAGE
            if stopping() or not no_answer or monotonic() + SETTLE_PAUSE_SECONDS >= deadline:
                raise
            last = error
        # SIGTERM's handler raises, so a stop ends the pause at once and leaves as `REQUEST_UNCERTAIN` (`main`).
        sleep(SETTLE_PAUSE_SECONDS)
        # A pause that overslept the deadline starts no try: the client would refuse it before sending, and its
        # CLI_INTERRUPTED would replace the last failure.
        if monotonic() >= deadline:
            raise last


def _delivery(
    instance: instance_client.JoinedInstance, request: dict[str, Any], stopping: Callable[[], bool] = lambda: False
) -> dict[str, Any]:
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
            return _settle(
                instance, UUID(request["attempt"]), DeliveryResult.model_validate(request["result"]), stopping
            )
    except ChatError as error:
        # A definite refusal is the ledger's answer, not a failed transport, and that holds for settlement
        # too: a reservation that lapsed while the native send ran answers DELIVERY_CLOSED, and the server has
        # already settled the attempt as uncertain. Ending the worker there would disable chat for the whole
        # session over an ordinary race. Only an uncertain or unavailable transport ends the worker, and a
        # settlement's only after `_settle` has sent it again until its deadline.
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


def _receipts_with_mute(instance: instance_client.JoinedInstance, *, deadline: float) -> dict[str, Any]:
    """The receipt feed, and the session's `muted` flag when the feed has rows, as one answer.

    A receipt waits while the session is muted, so the parent needs the flag before it shows one. `status` is a
    fatal request in this worker: a parent that asked for it separately would end the session over an advisory
    receipt. The flag is read here instead, inside the receipt refusal, so a failed or malformed read answers
    `refused` for the whole request and the worker keeps serving. An empty feed has nothing to hold, so it needs no
    flag. An older worker never sends one, which a parent must read as muted.
    """
    feed = instance_client.receipts(instance, deadline=deadline)
    if feed["receipts"]:
        muted = instance_client.status(instance, deadline=deadline).get("muted")
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
    alarmed = False  # the alarm fired in the receipts request that runs; the client reports it as a failed transport
    # What CANCEL_SIGNAL does now. "open": a receipts request runs, and the signal ends it. "answered": a receipts
    # request has its answer and the next frame is not read yet, so the signal may be late for that request and is
    # dropped; a parent that meant it for the next request repeats it until that one answers. "latch": anywhere else,
    # the signal is remembered for a receipts request that comes next. One store moves between them, so no signal can
    # land between two of them.
    cancel_window = "latch"
    cancel_latched = False  # a cancel arrived that no request has answered; a receipts request that follows answers it

    def _terminate(signum: int, frame: Any) -> None:
        # SIGTERM makes the blocked request fail like a transport error. Record it so it is never tolerated.
        nonlocal terminated
        terminated = True
        _interrupt(signum, frame)

    def _alarm(signum: int, frame: Any) -> None:
        # The alarm also reaches a receipts request as a failed transport. Record it, so that `_receipt` ends the
        # worker on it instead of answering `refused`.
        nonlocal alarmed
        alarmed = True
        _interrupt(signum, frame)

    def _outage(op: str, error: ChatError, codes: frozenset[str]) -> bool:
        if terminated or error.code not in codes:
            return False
        return monotonic() - failing_since.setdefault(op, monotonic()) < LEASE_SECONDS

    def _cancel(_signum: int, _frame: Any) -> None:
        nonlocal cancel_window, cancel_latched
        if cancel_window == "answered":
            return
        cancel_latched = True
        if cancel_window == "open":
            cancel_window = "latch"  # one interrupt per request: a second signal latches, it never raises again
            raise _ReceiptsCancelled("receipts request cancelled")

    def _receipt(call: Callable[..., Any], *arguments: Any) -> Any:
        nonlocal alarmed, cancel_window, cancel_latched
        alarmed = False  # only an alarm inside this receipts request counts; other requests keep their outage rules
        try:
            try:
                try:
                    # From this store until the `finally`, everything is inside the outer `try`, so a cancel that
                    # lands anywhere in the request, or in its clean-up, is answered below. Before it, the handler only
                    # latches.
                    cancel_window = "open"
                    if cancel_latched:
                        raise _ReceiptsCancelled("receipts request cancelled before it began")
                    return call(*arguments, deadline=monotonic() + RECEIPT_SECONDS)
                finally:
                    # The request has its answer. A signal from here until the next frame is read was sent for it, and
                    # must not reach the next request, which can be a retry the server has never seen.
                    cancel_window = "answered"
            except _ReceiptsCancelled:
                if terminated or alarmed:  # SIGTERM or the alarm came with it: either still ends the worker
                    raise
                return {"refused": "CLI_INTERRUPTED"}
            except ChatError as error:
                if terminated or alarmed:  # SIGTERM or the alarm interrupted the call: either still ends the worker
                    raise
                if cancel_latched:  # the cancel interrupted the client, which reported it as a failed transport
                    return {"refused": "CLI_INTERRUPTED"}
                return {"refused": error.code}
        finally:
            cancel_latched = False  # whatever this request's signal was, it is answered

    signal.signal(signal.SIGALRM, _deferrable(_alarm))
    signal.signal(signal.SIGTERM, _deferrable(_terminate))
    signal.signal(CANCEL_SIGNAL, _deferrable(_cancel))
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
                    "capabilities": list(CAPABILITIES),
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
            cancel_window = "latch"  # a new request: a signal from now on is for a receipts request this one may be
            if request is None:
                break
            operation = request.get("op")
            if operation not in RECEIPTS_OPERATIONS:
                cancel_latched = False  # a cancel is for a receipts request; it never carries over to another kind
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
                result = _delivery(instance, request, lambda: terminated)
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
