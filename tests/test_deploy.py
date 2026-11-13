"""Static checks for the Docker/Podman deployment artifacts."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from agent_chat.admin import Config as ServerConfig
from agent_chat.mcp.config import Config as McpConfig

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"


def _compose() -> dict:
    return yaml.safe_load((DEPLOY / "compose.yaml").read_text())


def test_compose_uses_external_postgres_and_traefik_only():
    compose = _compose()
    services = compose["services"]
    assert set(services) == {"migrate", "agent-chat", "mcp"}
    assert "postgres" not in services
    assert "traefik" not in services
    assert compose["networks"]["edge"]["external"] is True
    assert "AGENT_CHAT_DSN_FILE" in compose["secrets"]["agent-chat-dsn"]["file"]

    for service in services.values():
        assert "ports" not in service
        assert service["read_only"] is True
        assert "ALL" in service["cap_drop"]
        assert "no-new-privileges:true" in service["security_opt"]


def test_compose_wires_migration_health_and_mcp_scope():
    services = _compose()["services"]
    assert services["migrate"]["command"][:2] == ["migrate", "--config"]
    assert services["agent-chat"]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
    assert services["mcp"]["depends_on"]["agent-chat"]["condition"] == "service_healthy"
    assert "secrets" not in services["mcp"]
    assert services["mcp"]["networks"] == ["app", "edge"]
    assert services["agent-chat"]["networks"] == ["app", "edge"]


def test_example_configs_validate_with_the_product_models():
    server = json.loads((DEPLOY / "config" / "server.example.json").read_text())
    mcp = json.loads((DEPLOY / "config" / "mcp.example.json").read_text())
    assert ServerConfig.model_validate(server).public_origin.startswith("https://")
    validated = McpConfig.model_validate(mcp)
    assert validated.agent_chat_origin == "http://agent-chat:8443"
    assert validated.enable_writes is False


def test_dockerfile_has_two_non_root_targets():
    dockerfile = (ROOT / "Dockerfile").read_text()
    assert "AS build-server" in dockerfile
    assert "AS build-mcp" in dockerfile
    assert "--extra server" in dockerfile
    assert "--extra mcp" in dockerfile
    assert "USER 10001:10001" in dockerfile
    assert "EXPOSE 8443" in dockerfile
    assert "EXPOSE 8951" in dockerfile


def test_traefik_routes_preserve_host_and_have_no_extra_auth():
    dynamic = yaml.safe_load((DEPLOY / "traefik" / "dynamic.example.yml").read_text())
    http = dynamic["http"]
    assert set(http["routers"]) == {"agent-chat", "agent-chat-mcp"}
    assert http["routers"]["agent-chat-mcp"]["rule"] == "Host(`mcp.example.invalid`)"
    assert http["services"]["agent-chat-mcp"]["loadBalancer"]["passHostHeader"] is True
    assert http["services"]["agent-chat-mcp"]["loadBalancer"]["servers"] == [
        {"url": "http://mcp:8951"}
    ]
    assert "basicAuth" not in str(http)
