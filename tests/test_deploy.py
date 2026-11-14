"""Static checks for the Docker/Podman deployment artifacts."""

from __future__ import annotations

import configparser
import json
from pathlib import Path

import yaml

from agent_chat.admin import Config as ServerConfig
from agent_chat.mcp.config import Config as McpConfig

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"


def _compose() -> dict:
    return yaml.safe_load((DEPLOY / "compose.yaml").read_text())


QUADLET = DEPLOY / "podman"


def _quadlet(name: str) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.read(QUADLET / name)
    return parser


def test_quadlet_units_are_native_and_secure():
    names = {
        "agent-chat.container",
        "agent-chat-migrate.container",
        "agent-chat-mcp.container",
        "agent-chat.network",
    }
    assert {path.name for path in QUADLET.iterdir()} == names

    for name in names - {"agent-chat.network"}:
        raw = (QUADLET / name).read_text()
        assert "PublishPort=" not in raw
        assert "ReadOnly=true" in raw
        assert "DropCapability=ALL" in raw
        assert "NoNewPrivileges=true" in raw
        assert "User=10001:10001" in raw
        assert ":ro,z" not in raw
        assert _quadlet(name)["Container"]["user"] == "10001:10001"

    server = _quadlet("agent-chat.container")
    server_raw = (QUADLET / "agent-chat.container").read_text()
    assert server["Container"]["image"] == "localhost/agent-chat-server:local"
    assert server["Container"]["exec"].startswith("serve ")
    assert "agent-chat-dsn" in server["Container"]["secret"]
    assert server["Container"]["environment"] == "CREDENTIALS_DIRECTORY=/run/secrets"
    assert "Network=agent-chat.network" in server_raw
    assert "Network=traefik" in server_raw
    assert "agent-chat-migrate.service" in server["Unit"]["requires"]

    migrate = _quadlet("agent-chat-migrate.container")
    assert migrate["Service"]["type"] == "oneshot"
    assert migrate["Service"]["remainafterexit"] == "yes"
    assert migrate["Container"]["exec"].startswith("migrate ")

    mcp = _quadlet("agent-chat-mcp.container")
    assert mcp["Container"]["image"] == "localhost/agent-chat-mcp:local"
    assert mcp["Container"]["exec"].startswith("--config ")
    assert "secret" not in mcp["Container"]
    assert "agent-chat.service" in mcp["Unit"]["requires"]
    assert "NetworkAlias=mcp" in (QUADLET / "agent-chat-mcp.container").read_text()

    network = _quadlet("agent-chat.network")
    assert network["Network"]["networkname"] == "agent-chat"


def test_quadlet_guide_documents_supported_topology_and_secret_source():
    guide = (ROOT / "docs" / "podman.md").read_text()
    assert "Rootless app + rootful Traefik" in guide
    assert "Infisical" in guide
    assert "podman secret create" in guide
    assert "enable_writes" in guide
    assert "enable --now" not in guide
    assert "systemctl --user start agent-chat" in guide
    assert "chcon -t container_file_t" in guide
    assert "TOKEN_FILE" in guide
    assert "docs/podman.md" in (ROOT / "README.md").read_text()
    assert "podman.md" in (ROOT / "docs" / "containers.md").read_text()


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
    assert "USER ${UID}:${GID}" in dockerfile
    assert "EXPOSE 8443" in dockerfile
    assert "EXPOSE 8951" in dockerfile


def test_traefik_routes_preserve_host_and_have_no_extra_auth():
    dynamic = yaml.safe_load((DEPLOY / "traefik" / "dynamic.example.yml").read_text())
    http = dynamic["http"]
    assert set(http["routers"]) == {"agent-chat", "agent-chat-mcp"}
    assert http["routers"]["agent-chat-mcp"]["rule"] == "Host(`mcp.example.invalid`)"
    assert http["services"]["agent-chat-mcp"]["loadBalancer"]["passHostHeader"] is True
    assert http["services"]["agent-chat-mcp"]["loadBalancer"]["servers"] == [{"url": "http://mcp:8951"}]
    assert "basicAuth" not in str(http)
