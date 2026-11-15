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
    assert not any(path.startswith("/v1/login") for path in paths)
    assert not any(path.startswith("/v1/browser") for path in paths)
    assert "/v1/rooms/{room}/pm" not in paths
    assert "PublicationMessage" in spec["components"]["schemas"]
    assert "next_key" in spec["components"]["schemas"]["StatePage"]["properties"]
    assert "/v1/rooms/{room}/roles" not in paths
    publication = spec["paths"]["/v1/rooms/{room}/messages"]["post"]["requestBody"]["content"]["application/json"][
        "schema"
    ]
    assert "oneOf" in publication
    assert all(variant["allOf"][0] == {"$ref": "#/components/schemas/Publication"} for variant in publication["oneOf"])
    base = spec["components"]["schemas"]["Publication"]["properties"]
    assert base["body"]["minLength"] == 1
    assert base["recipients"]["maxItems"] == 16
    assert base["recipients"]["items"]["format"] == "uuid"
    assert any("pattern" in variant for variant in base["ref_key"].get("anyOf", []))


def test_openapi_requires_bearer_security_and_documents_errors():
    spec = build_openapi()
    for item in spec["paths"].values():
        for operation in item.values():
            assert operation["security"] == [{"bearerAuth": []}]
    assert spec["components"]["securitySchemes"]["bearerAuth"]["scheme"] == "bearer"
    assert "Error" in spec["components"]["schemas"]
    for item in spec["paths"].values():
        for operation in item.values():
            assert "default" in operation["responses"]
            assert operation["responses"]["409"]["content"]["application/json"]["schema"] == {
                "$ref": "#/components/schemas/Error"
            }
    for item in spec["paths"].values():
        for operation in item.values():
            assert operation["responses"]["422"]["content"]["application/json"]["schema"] == {
                "$ref": "#/components/schemas/Error"
            }
    events = spec["paths"]["/v1/events"]["get"]
    assert "text/event-stream" in events["responses"]["200"]["content"]
    assert any(parameter["name"] == "Last-Event-ID" for parameter in events["parameters"])


def test_static_openapi_snapshot_is_current():
    snapshot = Path(__file__).resolve().parents[1] / "docs" / "openapi.json"
    assert json.loads(snapshot.read_text()) == build_openapi()
