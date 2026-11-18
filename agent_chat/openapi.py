"""Stable OpenAPI contract for the client and agent HTTP surface."""

from __future__ import annotations

from .api import create_app

CONTRACT_VERSION = "1.0.0"

INCLUDED_PREFIXES = (
    "/v1/sessions",
    "/v1/instance",
    "/v1/rooms",
    "/v1/messages",
    "/v1/threads",
    "/v1/events",
)
EXCLUDED_PREFIXES = ("/v1/login", "/v1/logout", "/v1/browser")
EXCLUDED_OPERATIONS = {
    ("post", "/v1/rooms"),
    ("post", "/v1/rooms/{room}/memberships"),
    ("post", "/v1/rooms/{room}/pm"),
    ("post", "/v1/rooms/{room}/roles"),
    ("post", "/v1/rooms/{room}/state"),
}
SUCCESS_SCHEMAS = {
    ("post", "/v1/sessions"): "SessionBinding",
    ("get", "/v1/rooms"): "RoomList",
    ("get", "/v1/rooms/{room}/participants"): "ParticipantPage",
    ("get", "/v1/rooms/{room}/history"): "HistoryPage",
    ("post", "/v1/rooms/{room}/messages"): "PublicationMessage",
    ("post", "/v1/messages/{message}/replies"): "PublicationMessage",
    ("get", "/v1/rooms/{room}/state"): "StatePage",
    ("get", "/v1/instance/status"): "InstanceStatus",
    ("post", "/v1/messages/{message}/ack"): "Receipt",
}


def _included(path: str) -> bool:
    return path.startswith(INCLUDED_PREFIXES) and not path.startswith(EXCLUDED_PREFIXES)


def build_openapi() -> dict:
    """Return the filtered contract; live FastAPI docs remain disabled."""
    spec = create_app("postgresql://unused", enabled=True).openapi()
    paths = {}
    for path, item in spec["paths"].items():
        if not _included(path):
            continue
        kept = {method: operation for method, operation in item.items() if (method, path) not in EXCLUDED_OPERATIONS}
        if kept:
            paths[path] = kept
    error_response = {
        "description": "Stable Agent Chat refusal envelope",
        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}},
    }
    object_schema = {"type": "object", "additionalProperties": True}
    components = spec.setdefault("components", {})
    schemas = components.setdefault("schemas", {})
    schemas.update(
        {
            "JsonObject": object_schema,
            "SessionBinding": {
                "type": "object",
                "required": ["session_id", "instance_id", "room_id", "host", "harness"],
                "properties": {
                    name: {"type": "string"} for name in ("session_id", "instance_id", "room_id", "host", "harness")
                },
            },
            "Room": {
                "type": "object",
                "required": ["id", "slug", "label"],
                "properties": {"id": {"type": "string"}, "slug": {"type": "string"}, "label": {"type": "string"}},
            },
            "RoomList": {
                "type": "object",
                "required": ["rooms"],
                "properties": {"rooms": {"type": "array", "items": {"$ref": "#/components/schemas/Room"}}},
            },
            "Participant": {
                "type": "object",
                "additionalProperties": True,
                "properties": {
                    # Present only when the request names them in `fields`.
                    "last_seen_at": {"type": ["string", "null"]},
                    "model": {"type": ["string", "null"], "maxLength": 128},
                    "recent_counterparts": {
                        "type": "array", "maxItems": 5, "items": {"type": "string", "format": "uuid"},
                    },
                    "recent_refs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["ref_key", "last_at"],
                            "properties": {"ref_key": {"type": "string"}, "last_at": {"type": "string"}},
                        },
                    },
                },
            },
            "ParticipantPage": {
                "type": "object",
                "required": ["participants"],
                "properties": {
                    "participants": {"type": "array", "items": {"$ref": "#/components/schemas/Participant"}},
                    "next_session_id": {"type": ["string", "null"]},
                },
            },
            "HistoryPage": {
                "type": "object",
                "required": ["messages", "next_cursor", "retained_floor", "position", "has_more"],
                "properties": {
                    "messages": {"type": "array", "items": {"$ref": "#/components/schemas/Message"}},
                    "next_cursor": {"type": "string"},
                    "retained_floor": {"type": "string"},
                    "position": {"type": "string"},
                    "has_more": {"type": "boolean"},
                },
            },
            "Message": {
                "type": "object",
                "required": [
                    "id",
                    "room_id",
                    "body",
                    "kind",
                    "created_at",
                    "cursor",
                    "receipts",
                    "sender",
                    "recipients",
                ],
                "properties": {
                    "id": {"type": "string"},
                    "room_id": {"type": "string"},
                    "body": {"type": ["string", "null"]},
                    "kind": {"type": "string"},
                    "created_at": {"type": "string"},
                    "cursor": {"type": "string"},
                    "receipts": {"type": "array", "items": {"$ref": "#/components/schemas/JsonObject"}},
                    "sender": {"$ref": "#/components/schemas/JsonObject"},
                    "recipients": {"type": "array", "items": {"type": "string"}},
                    "thread_id": {"type": ["string", "null"]},
                    "reply_to": {"type": ["string", "null"]},
                    "thread_ref_key": {"type": ["string", "null"]},
                    "thread_resolved_at": {"type": ["string", "null"]},
                },
            },
            "DeliveryHint": {
                "type": "object",
                "required": ["session_id", "state", "last_seen_at"],
                "properties": {
                    "session_id": {"type": "string", "format": "uuid"},
                    "state": {"type": "string", "enum": ["live", "stopped", "no_instance"]},
                    "last_seen_at": {"type": ["string", "null"], "format": "date-time"},
                },
            },
            "PublicationMessage": {
                "type": "object",
                "required": ["id", "room_id", "body", "kind", "created_at", "sender", "recipients"],
                "properties": {
                    "id": {"type": "string"},
                    "room_id": {"type": "string"},
                    "body": {"type": "string"},
                    "kind": {"type": "string"},
                    "created_at": {"type": "string"},
                    "thread_id": {"type": ["string", "null"]},
                    "reply_to": {"type": ["string", "null"]},
                    "thread_ref_key": {"type": ["string", "null"]},
                    "thread_resolved_at": {"type": ["string", "null"]},
                    "sender": {"$ref": "#/components/schemas/JsonObject"},
                    "recipients": {"type": "array", "items": {"type": "string"}},
                    "delivery_hints": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {"$ref": "#/components/schemas/DeliveryHint"},
                    },
                },
            },
            "StatePage": {
                "type": "object",
                "required": ["server_time", "entries", "next_key"],
                "properties": {
                    "server_time": {"type": "string"},
                    "entries": {"type": "array", "items": {"$ref": "#/components/schemas/JsonObject"}},
                    "next_key": {"type": ["string", "null"]},
                },
            },
            "InstanceStatus": {"type": "object", "additionalProperties": True},
            "Receipt": {"type": "object", "additionalProperties": True},
        }
    )
    for path, item in paths.items():
        for method, operation in item.items():
            if not isinstance(operation, dict):
                continue
            operation["security"] = [{"bearerAuth": []}]
            responses = operation.setdefault("responses", {})
            responses["422"] = error_response
            for status in ("401", "403", "409", "410", "429", "503"):
                responses.setdefault(status, error_response)
            responses.setdefault("default", error_response)
            success = SUCCESS_SCHEMAS.get((method, path), "JsonObject")
            if path != "/v1/events":
                responses["200"] = {
                    "description": "Successful response",
                    "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{success}"}}},
                }
            if path == "/v1/instance/deliveries/{attempt}/result" and method == "post":
                operation["requestBody"]["content"]["application/json"]["schema"] = {
                    "oneOf": [
                        {
                            "type": "object",
                            "required": ["outcome"],
                            "additionalProperties": False,
                            "properties": {"outcome": {"const": "handed"}, "reason": {"type": "null"}},
                        },
                        {
                            "type": "object",
                            "required": ["outcome", "reason"],
                            "additionalProperties": False,
                            "properties": {"outcome": {"const": "failed"}, "reason": {"const": "native_unavailable"}},
                        },
                        {
                            "type": "object",
                            "required": ["outcome", "reason"],
                            "additionalProperties": False,
                            "properties": {
                                "outcome": {"const": "deferred"},
                                "reason": {
                                    "enum": ["busy", "muted", "stopped", "plan", "unknown", "offline", "stale_binding"]
                                },
                            },
                        },
                        {
                            "type": "object",
                            "required": ["outcome", "reason"],
                            "additionalProperties": False,
                            "properties": {
                                "outcome": {"const": "uncertain"},
                                "reason": {"const": "transport_ambiguous"},
                            },
                        },
                    ]
                }
            if path == "/v1/rooms/{room}/messages" and method == "post":
                base = {"$ref": "#/components/schemas/Publication"}
                operation["requestBody"]["content"]["application/json"]["schema"] = {
                    "oneOf": [
                        {
                            "allOf": [
                                base,
                                {
                                    "type": "object",
                                    "required": ["reply_to"],
                                    "properties": {
                                        "kind": {"const": "reply"},
                                        "reply_to": {"type": "string", "format": "uuid"},
                                        "ref_key": {"type": "null"},
                                    },
                                },
                            ]
                        },
                        {
                            "allOf": [
                                base,
                                {
                                    "type": "object",
                                    "required": ["ref_key"],
                                    "properties": {
                                        "kind": {
                                            "enum": [
                                                "message",
                                                "status",
                                                "heads_up",
                                                "blocked_on",
                                                "decision_needed",
                                                "intent",
                                            ]
                                        },
                                        "ref_key": {"type": "string"},
                                        "thread_id": {"type": "null"},
                                        "reply_to": {"type": "null"},
                                    },
                                },
                            ]
                        },
                        {
                            "allOf": [
                                base,
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": {
                                            "enum": [
                                                "message",
                                                "status",
                                                "question",
                                                "consultation",
                                                "heads_up",
                                                "blocked_on",
                                                "decision_needed",
                                                "intent",
                                            ]
                                        },
                                        "reply_to": {"type": "null"},
                                        "ref_key": {"type": "null"},
                                    },
                                },
                            ]
                        },
                    ]
                }
            if path == "/v1/events" and method == "get":
                responses["200"] = {
                    "description": (
                        "Server-Sent Events stream. A normal lifetime close may reconnect "
                        "with the last event id; Last-Event-ID takes precedence over after. "
                        "If a control event reports ROOM_SCOPE_CHANGED, do not resume at the "
                        "old cursor: resynchronize room access and replay from the retained "
                        'floor. The id-less control frame is {"error":{"code":"CODE"}} '
                        "and has no message field."
                    ),
                    "content": {"text/event-stream": {"schema": {"type": "string"}}},
                }
                parameters = operation.setdefault("parameters", [])
                parameters.append(
                    {
                        "name": "Last-Event-ID",
                        "in": "header",
                        "required": False,
                        "schema": {"type": "string"},
                        "description": "Last durable event id; takes precedence over after.",
                    }
                )
    components.setdefault("securitySchemes", {})["bearerAuth"] = {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "Agent Chat instance or credential token",
    }
    schemas["Error"] = {
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
    spec["info"]["version"] = CONTRACT_VERSION
    return spec
