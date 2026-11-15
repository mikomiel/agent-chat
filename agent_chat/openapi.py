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
    error_response = {
        "description": "Stable Agent Chat refusal envelope",
        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}},
    }
    for path, item in paths.items():
        for method, operation in item.items():
            if not isinstance(operation, dict):
                continue
            operation["security"] = [{"bearerAuth": []}]
            responses = operation.setdefault("responses", {})
            responses["422"] = error_response
            for status in ("401", "403", "503"):
                responses.setdefault(status, error_response)
            if path == "/v1/events" and method == "get":
                responses["200"] = {
                    "description": (
                        "Server-Sent Events stream. Reconnect with the last event id; the "
                        "Last-Event-ID header takes precedence over the after query. A "
                        "mid-stream control event may carry a stable error code."
                    ),
                    "content": {"text/event-stream": {"schema": {"type": "string"}}},
                }
                parameters = operation.setdefault("parameters", [])
                parameters.append({
                    "name": "Last-Event-ID",
                    "in": "header",
                    "required": False,
                    "schema": {"type": "string"},
                    "description": "Last durable event id; takes precedence over after.",
                })
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
