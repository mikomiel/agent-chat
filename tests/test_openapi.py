"""Checks for the filtered client/agent OpenAPI contract."""

import json
from pathlib import Path

from agent_chat.openapi import build_openapi


def test_openapi_is_filtered_to_client_and_agent_paths():
    spec = build_openapi()
    paths = set(spec["paths"])
    assert paths
    assert all(path.startswith("/v1/") for path in paths)
    assert not any(path.startswith(("/v1/login", "/v1/logout", "/v1/browser")) for path in paths)
    assert "/v1/rooms" in paths
    assert "/v1/events" in paths


def test_openapi_requires_bearer_security_and_documents_errors():
    spec = build_openapi()
    for item in spec["paths"].values():
        for operation in item.values():
            assert operation["security"] == [{"bearerAuth": []}]
    assert spec["components"]["securitySchemes"]["bearerAuth"]["scheme"] == "bearer"
    assert "Error" in spec["components"]["schemas"]


def test_static_openapi_snapshot_is_current():
    snapshot = Path(__file__).resolve().parents[1] / "docs" / "openapi.json"
    assert json.loads(snapshot.read_text()) == build_openapi()
