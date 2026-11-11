"""Wire-format helpers shared by the server and the CLI client.

This module must never import `psycopg`: the `agent-chat` CLI runs without the
optional `server` extra; a test pins that client-only import boundary.
"""

import re
from hashlib import sha256
from urllib.parse import urlsplit

from .models import ChatError


def token_digest(token: str) -> str:
    # v1 credentials are 32 random bytes encoded as lowercase hexadecimal.
    if re.fullmatch(r"[0-9a-f]{64}", token) is None:
        raise ChatError("UNAUTHENTICATED")
    return sha256(token.encode("ascii")).hexdigest()


def cursor(value: str) -> int:
    if re.fullmatch(r"[0-9]{1,19}", value) is None or int(value) > 9223372036854775807:
        raise ChatError("INVALID_CURSOR")
    return int(value)


def session_label(harness: str, host: str, native_session_id: str) -> str:
    """The stored label of a session, which is also a selector alias."""
    return f"{harness}@{host}/{native_session_id}"


def validate_origin(origin: str, *, https_only: bool = False) -> None:
    """Accept a canonical origin; loopback HTTP is allowed unless `https_only`.

    Browsers omit a default port from `Origin`, so an explicit `:443` or `:80` is not canonical.
    """
    try:
        parsed = urlsplit(origin)
        if (
            not origin.isascii()
            or any(ord(char) <= 32 or ord(char) == 127 for char in origin)
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or origin != parsed.scheme + "://" + parsed.netloc.lower()
            or parsed.scheme not in (("https",) if https_only else ("https", "http"))
            or (parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "::1"))
            or parsed.port == 0
            or (parsed.scheme, parsed.port) in (("https", 443), ("http", 80))
        ):
            raise ValueError("invalid origin")
    except ValueError:
        raise ChatError("INVALID_ORIGIN") from None
