"""One credential-bound HTTP destination; no redirect, proxy, retry or native delivery."""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from functools import partial
from typing import Any
from urllib.parse import urlsplit

from .models import HTTP_ERROR_STATUS, ChatError
from .protocol import token_digest, validate_origin


class Interrupted(TimeoutError):
    """Raised by a caller's alarm handler; the client never retries past it.

    It is a TimeoutError, so every handler that maps a timeout still maps it the same way. Only a loop that would
    otherwise go on to its next attempt tells it apart, and stops.
    """


def _time_left(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise ChatError("CLI_INTERRUPTED")
    return left


#: One stream address as getaddrinfo lists it: family, type, protocol and socket address.
Address = tuple[int, int, int, tuple[Any, ...]]

#: The resolver child's lookup. It prints the getaddrinfo list as JSON and nothing else.
_RESOLVER = (
    "import json,socket,sys; print(json.dumps(socket.getaddrinfo("
    "sys.argv[1],int(sys.argv[2]),type=socket.SOCK_STREAM)))"
)
#: Run first on every POSIX system: the child arms its own kernel alarm for the time its parent has left (argv[4]).
#: SIGALRM's default action ends the process even inside a libc lookup, so the child is bounded with no parent.
_OWN_DEADLINE = (
    "import math,signal,sys\n"
    "signal.signal(signal.SIGALRM,signal.SIG_DFL); signal.alarm(max(1,math.ceil(float(sys.argv[4]))))\n"
)
#: Then, on Linux, the faster bound. PR_SET_PDEATHSIG has the kernel send the child SIGKILL when its parent dies,
#: even by SIGKILL. A parent that died before prctl ran is no longer the child's parent, so the child then exits.
#: Without ctypes, or when prctl is refused, the child's own alarm still ends it.
_DIE_WITH_PARENT = (
    "import os,sys\n"
    "try:\n import ctypes; ctypes.CDLL(None).prctl(1,9,0,0,0)\n"
    "except (ImportError, OSError, AttributeError): pass\n"
    "if os.getppid()!=int(sys.argv[3]): os._exit(1)\n"
)


def _resolve(hostname: str, port: int, *, deadline: float) -> list[Address]:
    """Resolve in a private stdlib-only child that is killed and reaped at the deadline.

    getaddrinfo has no cancellation API. A child can be killed and reaped; abandoning a resolver thread would leave
    expired work behind. The child receives only the destination, never the credential. A caller killed while the
    lookup is pending leaves no process behind for long: the child's own alarm ends it at the deadline, rounded up
    to a whole second, and on Linux it also ends with its parent.
    """
    left = _time_left(deadline)
    source = (
        (_OWN_DEADLINE if os.name == "posix" else "")
        + (_DIE_WITH_PARENT if sys.platform.startswith("linux") else "")
        + _RESOLVER
    )
    with subprocess.Popen(
        [sys.executable, "-I", "-S", "-c", source, hostname, str(port), str(os.getpid()), repr(left)],
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
    return [(family, kind, protocol, tuple(sockaddr)) for family, kind, protocol, _, sockaddr in json.loads(output)]


def _connect(
    addresses: Sequence[Address],
    timeout: float,
    source_address: tuple[str, int] | None,
    *,
    deadline: float | None,
) -> socket.socket:
    """Try each address in order, as create_connection does, without resolving anything.

    With a deadline every attempt gets only the remaining budget. Without one, the caller's alarm is the bound.
    """
    last_error = OSError("no resolved addresses")
    for family, kind, protocol, sockaddr in addresses:
        left = timeout if deadline is None else min(timeout, _time_left(deadline))
        transport: socket.socket | None = None
        connected = False
        try:
            transport = socket.socket(family, kind, protocol)
            transport.settimeout(left)
            if source_address is not None:
                transport.bind(source_address)
            transport.connect(sockaddr)
            # HTTPSConnection wraps this socket next. Its TLS handshake must
            # get only the remaining budget, not the pre-connect timeout.
            if deadline is not None:
                transport.settimeout(min(timeout, _time_left(deadline)))
            connected = True
            return transport
        except Interrupted:
            raise  # the caller's alarm ends the whole request, not just this address
        except OSError as error:
            last_error = error
        finally:
            if transport is not None and not connected:
                transport.close()
    if deadline is not None:
        _time_left(deadline)
    raise last_error


def _connect_before_deadline(
    address: tuple[str, int],
    timeout: float,
    source_address: tuple[str, int] | None,
    *,
    deadline: float,
) -> socket.socket:
    """Replace HTTPConnection's socket factory, not its HTTP or TLS semantics."""
    return _connect(_resolve(address[0], address[1], deadline=deadline), timeout, source_address, deadline=deadline)


def _connect_pinned(
    addresses: tuple[Address, ...],
    _destination: tuple[str, int],
    timeout: float,
    source_address: tuple[str, int] | None,
    *,
    deadline: float | None,
) -> socket.socket:
    """The socket factory of a client with fixed addresses: the destination's name is never resolved."""
    return _connect(addresses, timeout, source_address, deadline=deadline)


def resolve_origin(server_origin: str, *, deadline: float) -> tuple[Address, ...]:
    """The stream addresses of a validated origin's host, resolved once, in getaddrinfo order.

    An IP literal is not resolved. A name is resolved in the bounded child of `_resolve`. A lookup that fails,
    lists nothing or does not end before `deadline` is `TRANSPORT_UNAVAILABLE`, the code of any other failed
    connection, so a caller's rejoin policy treats it like one.
    """
    validate_origin(server_origin)
    origin = urlsplit(server_origin)
    hostname = origin.hostname
    assert hostname is not None
    port = origin.port or (443 if origin.scheme == "https" else 80)
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if isinstance(literal, ipaddress.IPv4Address):
        return ((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, (hostname, port)),)
    if isinstance(literal, ipaddress.IPv6Address) and literal.scope_id is None:
        return ((socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, (hostname, port, 0, 0)),)
    try:
        addresses = tuple(_resolve(hostname, port, deadline=deadline))
    except (ChatError, OSError, ValueError, TypeError):
        # OSError includes the caller's alarm cutting the wait short; the child is already killed and reaped.
        raise ChatError("TRANSPORT_UNAVAILABLE") from None
    if not addresses:
        raise ChatError("TRANSPORT_UNAVAILABLE")
    return addresses


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
    def __init__(
        self,
        server_origin: str,
        token: str,
        *,
        deadline: float | None = None,
        allow_service_http: bool = False,
        addresses: Sequence[Address] = (),
    ):
        validate_origin(server_origin, allow_service_http=allow_service_http)
        token_digest(token)
        self._origin = server_origin
        self._token = token
        # A monotonic timestamp bounding the whole operation, or None for the CLI's signal bound.
        self._deadline = deadline
        # Addresses `resolve_origin` returned earlier. When set, a request connects only to these and resolves
        # nothing; TLS still verifies the origin's host name and the Host header still carries it.
        self._addresses = tuple(addresses)
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
        refused: str | None = None,
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
            # http.client's runtime socket-factory seam is private and absent from typeshed. It replaces only how
            # the socket is made: server_hostname and the Host header come from connection.host, the origin's host.
            if self._addresses:
                factory = partial(_connect_pinned, self._addresses, deadline=self._deadline)
                setattr(connection, "_create_connection", factory)
            elif self._deadline is not None:
                setattr(connection, "_create_connection", partial(_connect_before_deadline, deadline=self._deadline))
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
                # Any other complete 2xx is a protocol violation, for a caller that names one (`invalid`).
                if invalid is not None and 200 <= response.status < 300:
                    raise ChatError(invalid)
                error = result.get("error", {})
                code = error.get("code") if isinstance(error, dict) else None
                if isinstance(code, str) and HTTP_ERROR_STATUS.get(code) == response.status:
                    raise ChatError(code)
                if response.status >= 500:
                    raise ChatError("REQUEST_UNCERTAIN" if submitted else "SERVICE_UNAVAILABLE")
                # A caller that tells refusals from outages (`refused`) reads an unnamed 408 or 429 as an outage.
                if refused is not None and response.status in (408, 429) and not submitted:
                    raise ChatError("SERVICE_UNAVAILABLE")
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
            # A complete 2xx whose body breaks the protocol is not an outage. A caller that tolerates
            # outages names it `invalid`; every other caller keeps the classification below.
            if (
                invalid is not None
                and status is not None
                and 200 <= status < 300
                and isinstance(error, (ValueError, RecursionError))
            ):
                raise ChatError(invalid) from None
            # Likewise a complete 4xx whose body is not this service's envelope, such as a proxy's HTML 403, is a
            # refusal. A caller that must tell refusals from outages names it `refused`. 408 and 429 stay outages.
            if (
                refused is not None
                and status is not None
                and 400 <= status < 500
                and status not in (408, 429)
                and isinstance(error, (ValueError, RecursionError))
            ):
                raise ChatError(refused) from None
            raise ChatError("REQUEST_UNCERTAIN" if submitted else "TRANSPORT_UNAVAILABLE") from None
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if connection is not None:
                connection.close()
