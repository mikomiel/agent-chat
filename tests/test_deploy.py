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
    assert "NetworkAlias" not in (QUADLET / "agent-chat-mcp.container").read_text()

    network = _quadlet("agent-chat.network")
    assert network["Network"]["networkname"] == "agent-chat"


def test_quadlet_health_commands_survive_the_generator():
    # Quadlet 5.4 drops the closing `"` of a HealthCmd that ends in a double-quoted
    # argument, so the shell refuses the command and the container never turns healthy.
    # Single quotes outside, double quotes inside, generate a balanced --health-cmd.
    for name, port in (("agent-chat.container", 8443), ("agent-chat-mcp.container", 8951)):
        command = _quadlet(name)["Container"]["healthcmd"]
        assert command == (
            "python -c 'import urllib.request; "
            f'urllib.request.urlopen("http://127.0.0.1:{port}/healthz", timeout=2)\''
        )


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


def test_observability_example_covers_metrics_probes_and_alerts():
    observability = DEPLOY / "observability"
    alloy = (observability / "alloy.example.alloy").read_text()
    for token in ("agent-chat:8443", "agent-chat-mcp:8951", "/metrics", "/healthz", "/readyz"):
        assert token in alloy
    assert "mimir.example.invalid" in alloy
    guide = (observability / "README.md").read_text()
    for token in (
        "agent_chat_instances_active", "agent_chat_delivery_pending",
        "agent_chat_delivery_uncertain", "agent_chat_sse_connections_active",
        "agent_chat_mcp_tool_calls_total",
    ):
        assert token in guide
    alerts = yaml.safe_load((observability / "agent-chat-alerts.example.yml").read_text())
    names = {rule["alert"] for group in alerts["groups"] for rule in group["rules"]}
    assert {"AgentChatServerDown", "AgentChatMCPDown", "AgentChatNotReady"} <= names
    assert "AgentChatDeliveryBacklog" in names
    rules = {rule["alert"]: rule for group in alerts["groups"] for rule in group["rules"]}
    assert 'component="server"' in rules["AgentChatNotReady"]["expr"]
    assert 'component="mcp"' in rules["AgentChatMCPNotReady"]["expr"]
    assert "deployer" in (observability / "README.md").read_text()


def test_compose_uses_external_postgres_and_traefik_only():
    compose = _compose()
    services = compose["services"]
    assert set(services) == {"migrate", "agent-chat", "agent-chat-mcp"}
    assert "postgres" not in services
    assert "traefik" not in services
    assert compose["networks"]["edge"]["external"] is True
    assert "AGENT_CHAT_DSN_FILE" in compose["secrets"]["agent-chat-dsn"]["file"]

    for service in services.values():
        assert "ports" not in service
        assert service["read_only"] is True
        assert "ALL" in service["cap_drop"]
        assert "no-new-privileges:true" in service["security_opt"]


def test_edge_network_names_are_product_specific():
    # Every name a deployment owns on the shared edge network must be unique there.
    services = _compose()["services"]
    assert "mcp" not in services
    edge = [name for name, service in services.items() if "edge" in service.get("networks", [])]
    assert set(edge) == {"agent-chat", "agent-chat-mcp"}
    for name in edge:
        assert name.startswith("agent-chat")
        assert "container_name" not in services[name]
        assert "aliases" not in str(services[name]["networks"])

    for path in sorted(QUADLET.glob("*.container")):
        raw = path.read_text()
        assert "NetworkAlias" not in raw
        container = _quadlet(path.name)["Container"]
        if "Network=traefik" in raw:
            assert container["containername"].startswith("agent-chat")


def test_compose_wires_migration_health_and_mcp_scope():
    services = _compose()["services"]
    assert services["migrate"]["command"][:2] == ["migrate", "--config"]
    assert services["agent-chat"]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
    assert services["agent-chat-mcp"]["depends_on"]["agent-chat"]["condition"] == "service_healthy"
    assert "secrets" not in services["agent-chat-mcp"]
    assert services["agent-chat-mcp"]["networks"] == ["app", "edge"]
    assert services["agent-chat"]["networks"] == ["app", "edge"]
    assert "/healthz" in " ".join(services["agent-chat-mcp"]["healthcheck"]["test"])


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
    assert "!PathPrefix(`/metrics`)" in http["routers"]["agent-chat"]["rule"]
    assert "!PathPrefix(`/metrics`)" in http["routers"]["agent-chat-mcp"]["rule"]
    assert http["services"]["agent-chat-mcp"]["loadBalancer"]["passHostHeader"] is True
    assert http["services"]["agent-chat-mcp"]["loadBalancer"]["servers"] == [{"url": "http://agent-chat-mcp:8951"}]
    assert "basicAuth" not in str(http)
