"""One credential-bound HTTP destination; no redirect, proxy, retry or native delivery."""

from __future__ import annotations

import http.client
import json
import socket
import ssl
import subprocess
import sys
import threading
import time
from functools import partial
from typing import Any
from urllib.parse import urlsplit

from .models import HTTP_ERROR_STATUS, ChatError
from .protocol import token_digest, validate_origin


def _time_left(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise ChatError("CLI_INTERRUPTED")
    return left


def _connect_before_deadline(
    address: tuple[str, int],
    timeout: float,
    source_address: tuple[str, int] | None,
    *,
    deadline: float,
) -> socket.socket:
    """Replace HTTPConnection's socket factory, not its HTTP or TLS semantics.

    getaddrinfo has no cancellation API. A private stdlib-only child can be
    killed and reaped; abandoning a resolver thread would leave expired work
    behind. The child receives only the destination, never the credential.
    """
    _time_left(deadline)
    with subprocess.Popen(
        [
            sys.executable, "-I", "-S", "-c",
            "import json,socket,sys; print(json.dumps(socket.getaddrinfo("
            "sys.argv[1],int(sys.argv[2]),type=socket.SOCK_STREAM)))",
            address[0], str(address[1]),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ) as resolver:
        try:
            output, _ = resolver.communicate(timeout=_time_left(deadline))
        except subprocess.TimeoutExpired:
            raise ChatError("CLI_INTERRUPTED") from None
        finally:
            if resolver.poll() is None:
                resolver.kill()
                resolver.wait()
        if resolver.returncode:
            raise OSError("hostname resolution failed")

    last_error = OSError("no resolved addresses")
    for family, kind, protocol, _, sockaddr in json.loads(output):
        left = _time_left(deadline)
        transport: socket.socket | None = None
        connected = False
        try:
            transport = socket.socket(family, kind, protocol)
            transport.settimeout(min(timeout, left))
            if source_address is not None:
                transport.bind(source_address)
            transport.connect(tuple(sockaddr))
            # HTTPSConnection wraps this socket next. Its TLS handshake must
            # get only the remaining budget, not the pre-connect timeout.
            transport.settimeout(min(timeout, _time_left(deadline)))
            connected = True
            return transport
        except OSError as error:
            last_error = error
        finally:
            if transport is not None and not connected:
                transport.close()
    _time_left(deadline)
    raise last_error


class _DeadlineWatchdog:
    """Interrupt blocked transport I/O when the whole-operation deadline expires.

    ``http.client`` parses the status line, the headers and chunked framing with
    blocking reads that never return to the caller, so an inactivity timeout on
    the socket cannot bound elapsed time: a peer that drips one byte inside
    every timeout keeps each receive short while the operation continues. This
    timer shuts the connected transport down instead, which fails the blocked
    read at once. That interrupts the real I/O rather than abandoning a waiting
    caller, and the socket timeout still bounds a silent peer.

    The transport is held directly, not read from the connection when the timer
    fires: ``getresponse`` handles a ``Connection: close`` response by closing
    the HTTPConnection and clearing its ``sock``, while the response's file
    object keeps the same socket open.
    """

    def __init__(self, deadline: float, transport: socket.socket) -> None:
        self._transport = transport
        self._expired = threading.Event()
        self._timer = threading.Timer(max(0.0, deadline - time.monotonic()), self._interrupt)
        self._timer.daemon = True
        self._timer.start()

    def _interrupt(self) -> None:
        self._expired.set()
        try:
            self._transport.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    @property
    def expired(self) -> bool:
        return self._expired.is_set()

    def cancel(self) -> None:
        self._timer.cancel()


class Client:
    def __init__(self, server_origin: str, token: str, *, deadline: float | None = None):
        validate_origin(server_origin)
        token_digest(token)
        self._origin = server_origin
        self._token = token
        # A monotonic timestamp bounding the whole operation, or None for the CLI's signal bound.
        self._deadline = deadline
        # Whole-command response budget, not an unbounded allowance per page.
        self._remaining = 16 * 1024 * 1024

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        key: str | None = None,
        *,
        invalid: str | None = None,
    ) -> Any:
        origin = urlsplit(self._origin)
        assert origin.hostname is not None
        connection: http.client.HTTPConnection | None = None
        watchdog: _DeadlineWatchdog | None = None
        submitted = False
        status: int | None = None

        def check() -> float | None:
            """The time left in the whole-operation budget, or None when unbounded."""
            if self._deadline is None:
                return None
            return _time_left(self._deadline)

        try:
            left = check()
            timeout = 3.0 if left is None else max(0.001, min(3.0, left))
            if origin.scheme == "https":
                # Unlike create_default_context, this does not enable SSLKEYLOGFILE.
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.load_default_certs()
                connection = http.client.HTTPSConnection(
                    origin.hostname, origin.port, timeout=timeout, context=context
                )
            else:
                connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=timeout)
            if self._deadline is not None:
                # http.client's runtime socket-factory seam is absent from typeshed.
                connection._create_connection = partial(  # ty: ignore[unresolved-attribute]
                    _connect_before_deadline, deadline=self._deadline
                )
            connection.connect()
            check()
            # From here on every transport phase is under the absolute deadline,
            # including the blocking header and chunk-framing reads below. Hold
            # the connected socket itself: getresponse() detaches a will-close
            # response by clearing connection.sock, but the response keeps it.
            transport = connection.sock
            if self._deadline is not None and transport is not None:
                watchdog = _DeadlineWatchdog(self._deadline, transport)
            headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json"}
            body = None
            if payload is not None:
                body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
                headers["Content-Type"] = "application/json"
            if key is not None:
                headers["Idempotency-Key"] = key
            submitted = method == "POST"
            # No publication starts after the budget has already run out.
            check()
            connection.request(method, path, body=body, headers=headers)
            left = check()
            if left is not None and connection.sock is not None:
                connection.sock.settimeout(max(0.001, min(3.0, left)))
            response = connection.getresponse()
            status = response.status
            # Never inspect a redirect destination or relay a credential to it.
            if 300 <= response.status < 400:
                raise ChatError("REQUEST_UNCERTAIN" if submitted else "REDIRECT_REFUSED")
            chunks: list[bytes] = []
            total = 0
            while True:
                # read1 returns after one receive, so the budget is checked between chunks instead
                # of only when a slow-dripping peer finally closes or fills the buffer.
                left = check()
                if left is not None and connection.sock is not None:
                    connection.sock.settimeout(max(0.001, min(3.0, left)))
                chunk = response.read1(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > self._remaining:
                    break
            check()
            if watchdog is not None and watchdog.expired:
                raise ChatError("CLI_INTERRUPTED")
            data = b"".join(chunks)
            self._remaining -= len(data)
            if self._remaining < 0:
                raise ValueError("response too large")
            if response.length not in (None, 0):
                # The peer closed before the declared length: a read failure, not a malformed body.
                raise http.client.IncompleteRead(data, response.length)
            if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise ValueError("not JSON")
            result = json.loads(data.decode("utf-8"))
            # Decoding and parsing can exhaust the budget after the last read.
            check()
            if not isinstance(result, dict):
                raise ValueError("invalid response object")
            if response.status != 200:
                error = result.get("error", {})
                code = error.get("code") if isinstance(error, dict) else None
                if isinstance(code, str) and HTTP_ERROR_STATUS.get(code) == response.status:
                    raise ChatError(code)
                if response.status >= 500:
                    raise ChatError("REQUEST_UNCERTAIN" if submitted else "SERVICE_UNAVAILABLE")
                raise ChatError("REQUEST_UNCERTAIN" if submitted else "HTTP_REFUSED")
            return result
        except ChatError:
            raise
        except (OSError, http.client.HTTPException, ValueError, RecursionError, KeyboardInterrupt) as error:
            # The watchdog shut the socket down, so this failure is the deadline,
            # not a peer or protocol fault.
            if watchdog is not None and watchdog.expired:
                raise ChatError("CLI_INTERRUPTED") from None
            if self._deadline is not None and time.monotonic() >= self._deadline:
                raise ChatError("CLI_INTERRUPTED") from None
            # A complete 200 whose body breaks the protocol is not an outage. A caller that tolerates
            # outages names it `invalid`; every other caller keeps the classification below.
            if invalid is not None and status == 200 and isinstance(error, (ValueError, RecursionError)):
                raise ChatError(invalid) from None
            raise ChatError("REQUEST_UNCERTAIN" if submitted else "TRANSPORT_UNAVAILABLE") from None
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if connection is not None:
                connection.close()
