"""Stable OpenAPI contract for the client and agent HTTP surface."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from .api import create_app

INCLUDED_PREFIXES = (
    "/v1/sessions",
    "/v1/instance",
    "/v1/rooms",
    "/v1/messages",
    "/v1/threads",
    "/v1/events",
)
EXCLUDED_PREFIXES = ("/v1/login", "/v1/logout", "/v1/browser")


def _included(path: str) -> bool:
    return path.startswith(INCLUDED_PREFIXES) and not path.startswith(EXCLUDED_PREFIXES)


def _version() -> str:
    try:
        return version("agent-chat")
    except PackageNotFoundError:
        return "0.0.0"


def build_openapi() -> dict:
    """Return the filtered contract; live FastAPI docs remain disabled."""
    spec = create_app("postgresql://unused", enabled=True).openapi()
    paths = {path: item for path, item in spec["paths"].items() if _included(path)}
    for item in paths.values():
        for operation in item.values():
            if isinstance(operation, dict):
                operation["security"] = [{"bearerAuth": []}]
    components = spec.setdefault("components", {})
    components.setdefault("securitySchemes", {})["bearerAuth"] = {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "Agent Chat instance or credential token",
    }
    components.setdefault("schemas", {})["Error"] = {
        "type": "object",
        "required": ["error"],
        "properties": {
            "error": {
                "type": "object",
                "required": ["code", "message"],
                "properties": {
                    "code": {"type": "string", "description": "Stable refusal code"},
                    "message": {"type": "string", "description": "Same stable code"},
                },
            }
        },
    }
    spec["paths"] = paths
    spec["info"]["title"] = "Agent Chat client and agent API"
    spec["info"]["version"] = _version()
    return spec
