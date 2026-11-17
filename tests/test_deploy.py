"""Static checks for the Docker, Podman and Ansible deployment artifacts."""

from __future__ import annotations

import configparser
import json
import re
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

    # A read-only root gives crun 1.31+ and runc 1.5.2 no mount point for the secret.
    for name in ("agent-chat.container", "agent-chat-migrate.container"):
        lines = (QUADLET / name).read_text().splitlines()
        assert "Tmpfs=/run/secrets:rw,noexec,nosuid,size=1m,mode=0755" in lines

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

    on_edge = set()
    for path in sorted(QUADLET.glob("*.container")):
        raw = path.read_text()
        assert "NetworkAlias" not in raw
        if "Network=traefik" in raw:
            on_edge.add(_quadlet(path.name)["Container"]["containername"])
    assert on_edge == set(edge)

    # The examples address exactly these names.
    http = yaml.safe_load((DEPLOY / "traefik" / "dynamic.example.yml").read_text())["http"]
    backends = {
        server["url"].removeprefix("http://").split(":")[0]
        for service in http["services"].values()
        for server in service["loadBalancer"]["servers"]
    }
    assert backends == set(edge)


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


ANSIBLE = DEPLOY / "ansible"
TEMPLATES = ANSIBLE / "templates"
SERVICE_UNITS = ("agent-chat.service", "agent-chat-mcp.service", "agent-chat-prune.service")
# The MCP unit has its own user. ProtectProc=invisible hides only the processes of other users, so a process of
# the server's user could read the server's credential through /proc/<server pid>/root.
SERVICE_USER = {
    "agent-chat.service": "agent-chat",
    "agent-chat-prune.service": "agent-chat",
    "agent-chat-mcp.service": "agent-chat-mcp",
}
HARDENING = {
    "NoNewPrivileges": ["true"],
    "CapabilityBoundingSet": [""],
    "UMask": ["0077"],
    "PrivateTmp": ["true"],
    "PrivateDevices": ["true"],
    "ProtectSystem": ["strict"],
    "ProtectHome": ["true"],
    "ProtectProc": ["invisible"],
    "ProcSubset": ["pid"],
    "ProtectKernelTunables": ["true"],
    "ProtectKernelModules": ["true"],
    "ProtectKernelLogs": ["true"],
    "ProtectControlGroups": ["true"],
    "ProtectClock": ["true"],
    "ProtectHostname": ["true"],
    "RestrictAddressFamilies": ["AF_UNIX AF_INET AF_INET6"],
    "RestrictNamespaces": ["true"],
    "RestrictRealtime": ["true"],
    "RestrictSUIDSGID": ["true"],
    "LockPersonality": ["true"],
    "SystemCallArchitectures": ["native"],
    "SystemCallFilter": ["@system-service", "~@privileged @resources"],
    "SystemCallErrorNumber": ["EPERM"],
}
SERVER_VALUES = {
    "agent_chat_bind_host": "127.0.0.1",
    "agent_chat_port": "8443",  # a fact holds a number as a string; the templates convert it
    "agent_chat_public_origin": "https://chat.example.invalid",
    "agent_chat_delivery_enabled": False,
    "agent_chat_mcp_port": "8951",
    "agent_chat_mcp_public_origin": "https://mcp.example.invalid",
    "agent_chat_mcp_enable_writes": False,
}
# The section in which systemd reads a key; it ignores the key in any other section. Every other key is [Service].
SECTION_OF = {
    "Description": "Unit",
    "After": "Unit",
    "Wants": "Unit",
    "OnCalendar": "Timer",
    "RandomizedDelaySec": "Timer",
    "Persistent": "Timer",
    "WantedBy": "Install",
}


def _directives(template: str) -> dict[str, list[str]]:
    """Directives of a unit template; a repeated directive keeps each value in order.

    A directive in a section where systemd would ignore it fails the test."""
    found: dict[str, list[str]] = {}
    section = None
    for line in (TEMPLATES / template).read_text().splitlines():
        if line.startswith("["):
            section = line.strip("[]")
        elif "=" in line and not line.startswith("#"):
            key, _, value = line.partition("=")
            assert section == SECTION_OF.get(key, "Service"), (template, key, section)
            found.setdefault(key, []).append(value)
    return found


def _render(template: str, values: dict) -> dict:
    """Render a config template. Jinja is not a dependency, so only the forms the templates use are replaced."""

    def substitute(match: re.Match) -> str:
        value = values[match["name"]]
        if match["filter"] == "tojson":
            return json.dumps(value)
        return str(int(value)) if match["filter"] == "int" else str(value)

    text = (TEMPLATES / template).read_text()
    text = re.sub(r"\{\{ (?P<name>\w+)(?: \| (?P<filter>tojson|int))? \}\}", substitute, text)
    assert "{{" not in text and "{%" not in text, template
    return json.loads(text)


def _playbook() -> dict:
    (play,) = yaml.safe_load((ANSIBLE / "playbook.yml").read_text())
    return play


def _task(name: str) -> dict:
    (task,) = [task for task in _playbook()["tasks"] if task["name"] == name]
    return task


def _flat(text: str) -> str:
    return " ".join(text.split())


def test_ansible_example_is_one_play_with_a_handful_of_templates():
    assert {path.name for path in ANSIBLE.iterdir()} == {"playbook.yml", "inventory.example.yml", "templates"}
    assert {path.name for path in TEMPLATES.iterdir()} == {
        "agent-chat.service.j2",
        "agent-chat-mcp.service.j2",
        "agent-chat-prune.service.j2",
        "agent-chat-prune.timer.j2",
        "server.json.j2",
        "mcp.json.j2",
    }
    play = _playbook()
    assert play["hosts"] == "agent_chat"
    assert play["become"] is True
    assert play["force_handlers"] is True
    inventory = yaml.safe_load((ANSIBLE / "inventory.example.yml").read_text())
    assert list(inventory["all"]["children"]) == ["agent_chat"]
    assert all(host.endswith(".example.invalid") for host in inventory["all"]["children"]["agent_chat"]["hosts"])


def test_ansible_units_are_hardened_and_restart_policy_is_explicit():
    for unit in SERVICE_UNITS:
        directives = _directives(f"{unit}.j2")
        for key, values in HARDENING.items():
            assert directives.get(key) == values, (unit, key)
        assert directives["User"] == directives["Group"] == [SERVICE_USER[unit]], unit

    server = _directives("agent-chat.service.j2")
    assert server["Type"] == ["exec"]
    assert server["Restart"] == ["on-failure"]
    assert server["RestartPreventExitStatus"] == ["2"]
    assert server["SyslogIdentifier"] == ["agent-chat"]
    assert server["ExecStart"] == [
        "{{ agent_chat_root }}/current/bin/python -I -m agent_chat.admin serve --config /etc/agent-chat/server.json"
    ]
    assert server["WantedBy"] == ["multi-user.target"]

    mcp = _directives("agent-chat-mcp.service.j2")
    assert "agent-chat.service" in mcp["Wants"][0].split()
    assert "agent-chat.service" in mcp["After"][0].split()
    assert mcp["ExecStart"] == [
        "{{ agent_chat_root }}/current/bin/python -I -m agent_chat.mcp --config /etc/agent-chat/mcp.json"
    ]
    assert mcp["WantedBy"] == ["multi-user.target"]

    prune = _directives("agent-chat-prune.service.j2")
    assert prune["Type"] == ["oneshot"]
    assert prune["ExecStart"] == [
        "{{ agent_chat_root }}/current/bin/python -I -m agent_chat.admin prune --config /etc/agent-chat/server.json"
        " --limit {{ agent_chat_prune_limit }} --max-batches {{ agent_chat_prune_max_batches }}"
    ]
    assert "[Install]" not in (TEMPLATES / "agent-chat-prune.service.j2").read_text()

    timer = _directives("agent-chat-prune.timer.j2")
    assert timer["OnCalendar"] == ["daily"]
    assert timer["Persistent"] == ["true"]
    assert timer["RandomizedDelaySec"]
    assert timer["WantedBy"] == ["timers.target"]


def test_ansible_dsn_is_a_credential_of_the_server_and_prune_units_only():
    credential = ["agent-chat-dsn:{{ agent_chat_dsn_file }}"]
    assert _directives("agent-chat.service.j2")["LoadCredential"] == credential
    assert _directives("agent-chat-prune.service.j2")["LoadCredential"] == credential

    mcp = _directives("agent-chat-mcp.service.j2")
    assert "agent-chat-dsn" not in (TEMPLATES / "agent-chat-mcp.service.j2").read_text()
    # A second layer behind the separate MCP user: the credential directories of the other units stay out of its view.
    assert mcp["InaccessiblePaths"] == ["-/run/credentials"]

    for unit in SERVICE_UNITS:
        directives = _directives(f"{unit}.j2")
        # Any other credential setting (Set, Import, Encrypted) or command (ExecStartPre, ...) could carry or
        # print the DSN. The ExecStart value of each unit is pinned exactly in the test above.
        credentials = {key for key in directives if "Credential" in key}
        assert credentials == (set() if unit == "agent-chat-mcp.service" else {"LoadCredential"}), unit
        assert {key for key in directives if key.startswith("Exec")} == {"ExecStart"}, unit
        assert not [key for key in directives if key.startswith("Environment") or key == "PassEnvironment"], unit


def test_ansible_mcp_service_has_its_own_user_and_reads_only_its_own_file():
    server = _directives("agent-chat.service.j2")
    mcp = _directives("agent-chat-mcp.service.j2")
    assert server["User"] == server["Group"] == _directives("agent-chat-prune.service.j2")["User"] == ["agent-chat"]
    assert mcp["User"] == mcp["Group"] == ["agent-chat-mcp"]
    assert mcp["ProtectProc"] == ["invisible"]  # with a different user this hides the server's processes

    group = _task("Create the MCP service group")["ansible.builtin.group"]
    user = _task("Create the MCP service user")["ansible.builtin.user"]
    assert (group["name"], group["system"]) == ("agent-chat-mcp", True)
    assert (user["name"], user["group"], user["system"]) == ("agent-chat-mcp", "agent-chat-mcp", True)
    assert user["shell"] == "/usr/sbin/nologin"
    assert user["create_home"] is False
    for name in ("Create the MCP service group", "Create the MCP service user"):
        assert _task(name)["when"] == "agent_chat_mcp_enabled", name

    # Each service reads only its own file: anyone may enter the directory, and each file is closed to the other user.
    directory = _task("Create the configuration directory")["ansible.builtin.file"]
    assert (directory["path"], directory["owner"], directory["group"], directory["mode"]) == (
        "/etc/agent-chat",
        "root",
        "root",
        "0755",
    )
    server_file = _task("Install the server configuration")["ansible.builtin.copy"]
    mcp_file = _task("Install the MCP configuration")["ansible.builtin.copy"]
    assert (server_file["dest"], server_file["owner"], server_file["group"], server_file["mode"]) == (
        "/etc/agent-chat/server.json",
        "root",
        "agent-chat",
        "0640",
    )
    assert (mcp_file["dest"], mcp_file["owner"], mcp_file["group"], mcp_file["mode"]) == (
        "/etc/agent-chat/mcp.json",
        "root",
        "agent-chat-mcp",
        "0640",
    )
    # The DSN file itself is closed to every service user: the play refuses anything but root:root 0600.
    require = _task("Require the deployer's DSN file")["ansible.builtin.assert"]["that"]
    for condition in (
        "agent_chat_dsn.stat.mode == '0600'",
        "agent_chat_dsn.stat.uid == 0",
        "agent_chat_dsn.stat.gid == 0",
    ):
        assert condition in require, condition


def test_ansible_config_templates_render_valid_product_configs():
    server = _render("server.json.j2", SERVER_VALUES)
    assert ServerConfig.model_validate(server).dsn_credential == "agent-chat-dsn"
    assert server["bind_host"] == "127.0.0.1"
    assert server["port"] == 8443
    assert server["enabled"] is True
    assert server["delivery_enabled"] is False
    assert "dsn" not in {key for key in server if key != "dsn_credential"}

    mcp = _render("mcp.json.j2", SERVER_VALUES)
    assert McpConfig.model_validate(mcp).agent_chat_origin == "http://127.0.0.1:8443"
    assert mcp["bind_host"] == "127.0.0.1"
    assert mcp["port"] == 8951
    assert mcp["enable_writes"] is False

    changed = {
        **SERVER_VALUES,
        "agent_chat_bind_host": "0.0.0.0",
        "agent_chat_port": 9443,
        "agent_chat_delivery_enabled": True,
        "agent_chat_mcp_enable_writes": True,
    }
    changed_server = ServerConfig.model_validate(_render("server.json.j2", changed))
    assert (changed_server.bind_host, changed_server.port, changed_server.delivery_enabled) == ("0.0.0.0", 9443, True)
    changed_mcp = McpConfig.model_validate(_render("mcp.json.j2", changed))
    assert (changed_mcp.bind_host, changed_mcp.agent_chat_origin, changed_mcp.enable_writes) == (
        "0.0.0.0",
        "http://127.0.0.1:9443",
        True,
    )


def test_ansible_playbook_requires_a_release_tag_and_never_pins_one():
    checks = _task("Check the variables")["ansible.builtin.assert"]["that"]
    assert "agent_chat_version is defined" in checks
    (pattern,) = re.findall(r"agent_chat_version is match\('(.+)'\)", "\n".join(checks))
    for tag in ("v0.6.0", "v10.20.30"):
        assert re.match(pattern, tag)
    for other in ("main", "0.6.0", "v0.6", "v0.6.0-rc1", "vX.Y.Z", "v0.6.0 "):
        assert not re.match(pattern, other)

    for path in (ANSIBLE / "playbook.yml", ANSIBLE / "inventory.example.yml", ROOT / "docs" / "ansible.md"):
        assert not re.search(r"\bv\d+\.\d+\.\d+\b", path.read_text()), path
    inventory = yaml.safe_load((ANSIBLE / "inventory.example.yml").read_text())
    placeholder = inventory["all"]["children"]["agent_chat"]["vars"]["agent_chat_version"]
    assert not re.match(pattern, placeholder)
    requirement = _playbook()["vars"]["agent_chat_requirement"]
    assert _flat(requirement) == "sessionyard[{{ agent_chat_extras }}]=={{ agent_chat_version[1:] }}"


def test_ansible_playbook_installs_only_releases_that_are_on_pypi_as_sessionyard():
    # Releases before 0.7.0 carry the distribution name agent-chat and are not on PyPI. The version test needs
    # ansible-core, which the suite does not install, so this pins the exact condition, its place right behind
    # the tag pattern (assert stops at the first failing item), and the reason it gives. The `version` test was
    # run with ansible-core 2.18 on 0.6.0 (False), 0.7.0, 0.10.0 and 1.0.0 (True).
    task = _task("Check the variables")["ansible.builtin.assert"]
    checks = task["that"]
    shape = next(index for index, check in enumerate(checks) if "agent_chat_version is match(" in check)
    assert checks[shape + 1] == "agent_chat_version[1:] is version('0.7.0', '>=')"
    assert "Releases before 0.7.0 are not on PyPI as sessionyard" in _flat(task["fail_msg"])
    assert "git" not in _flat(_playbook()["vars"]["agent_chat_requirement"])
    # The guide states the same minimum next to the variable.
    guide = (ROOT / "docs" / "ansible.md").read_text().splitlines()
    row = next(line for line in guide if line.startswith("| `agent_chat_version`"))
    assert "at least 0.7.0" in row and "`sessionyard`" in row


def test_ansible_playbook_applies_only_a_reviewed_migration_set_before_the_switch():
    play = _playbook()
    names = [task["name"] for task in play["tasks"]]
    order = [
        "Install Agent Chat into its versioned virtual environment",
        "Stage the server configuration",
        "List the pending migrations",
        "Require the reviewed digest before the schema changes",
        "Apply the reviewed migrations",
        "Install the server configuration",
        "Install the systemd units",
        "Point current at this release",
        "Run the queued restarts",
        "Wait for the server to be ready",
    ]
    assert [names.index(name) for name in order] == sorted(names.index(name) for name in order)

    # Both calls read the staged configuration of the release being installed, not the live file.
    staged = "'--config', agent_chat_staged + '/server.json'"
    check = _task("List the pending migrations")
    assert check["changed_when"] is False
    assert "'--check'" in check["ansible.builtin.command"]["argv"]
    assert staged in _flat(check["ansible.builtin.command"]["argv"])
    apply = _task("Apply the reviewed migrations")
    assert "'--reviewed', agent_chat_migrate_reviewed" in _flat(apply["ansible.builtin.command"]["argv"])
    assert staged in _flat(apply["ansible.builtin.command"]["argv"])
    assert apply["when"] == "agent_chat_pending | int > 0"

    # Any spelling of the subcommand counts, in a task or a handler: a quoted Jinja item, a list or a shell string.
    runners = ("ansible.builtin.command", "ansible.builtin.shell", "ansible.builtin.script", "ansible.builtin.raw")
    callers = [
        item["name"]
        for item in play["tasks"] + play["handlers"]
        if any(re.search(r"\bmigrate\b", json.dumps(item.get(module, ""))) for module in runners)
    ]
    assert callers == ["List the pending migrations", "Apply the reviewed migrations"]
    # Nothing may assign the digest: only the operator's -e does.
    assert "agent_chat_migrate_reviewed" not in play["vars"]
    assert not [
        item["name"]
        for item in play["tasks"] + play["handlers"]
        if "agent_chat_migrate_reviewed" in {*item.get("vars", {}), *item.get("ansible.builtin.set_fact", {})}
    ]
    gate_task = _task("Require the reviewed digest before the schema changes")
    assert set(gate_task) == {"name", "ansible.builtin.assert"}  # no when, ignore_errors or failed_when
    gate = gate_task["ansible.builtin.assert"]
    assert gate["that"] == (
        "agent_chat_pending | int == 0 or agent_chat_migrate_reviewed | default('') == agent_chat_digest"
    )
    assert "-e agent_chat_migrate_reviewed={{ agent_chat_digest }}" in _flat(gate["fail_msg"])


def test_ansible_playbook_changes_nothing_live_before_the_migration_gate():
    play = _playbook()
    tasks = play["tasks"]
    gate = [task["name"] for task in tasks].index("Require the reviewed digest before the schema changes")
    before = tasks[:gate]

    # A refusal must leave the running version as it was. Before the review the play may create the service user
    # and the install tree, install the new release next to the old one and stage the new configuration inside
    # it. No other task may change the host, so a live file, a unit, `current` or a service cannot move.
    changing = ("group", "user", "file", "shell", "template", "copy", "systemd", "meta")
    assert [task["name"] for task in before if any(f"ansible.builtin.{module}" in task for module in changing)] == [
        "Create the service group",
        "Create the service user",
        "Create the missing install directories",
        "Install Agent Chat into its versioned virtual environment",
        "Create the directory for the staged configuration",
        "Stage the server configuration",
        "Stage the MCP configuration",
    ]
    # The only processes before the gate are two reads: the Python version and `migrate --check`.
    assert [task["name"] for task in before if "ansible.builtin.command" in task] == [
        "Read the Python version of the target",
        "List the pending migrations",
    ]
    # No handler can be queued before the review, so force_handlers cannot restart anything after a refusal.
    assert not [task["name"] for task in before if "notify" in task]
    live_path = re.compile(r"/etc/systemd|/current\b|/etc/agent-chat(?!/credentials)")
    for task in before:
        assert not live_path.search(json.dumps(task)), task["name"]

    # The staged files sit inside the release that is being installed and pass that release's own loader. The
    # check runs as the service user, which reads the server file through its group.
    assert play["vars"]["agent_chat_staged"].startswith("{{ agent_chat_venv }}/")
    server = _task("Stage the server configuration")["ansible.builtin.template"]
    assert server["dest"] == "{{ agent_chat_staged }}/server.json"
    assert (server["owner"], server["group"], server["mode"]) == ("root", "agent-chat", "0640")
    assert "agent_chat.admin import load_config" in server["validate"]
    mcp_task = _task("Stage the MCP configuration")
    assert mcp_task["when"] == "agent_chat_mcp_enabled"
    assert mcp_task["ansible.builtin.template"]["dest"] == "{{ agent_chat_staged }}/mcp.json"
    assert "agent_chat.mcp.config import load_config" in mcp_task["ansible.builtin.template"]["validate"]

    # After the gate the live files are copies of the staged ones, so the bytes that start the services are the
    # bytes that the check judged. A template into /etc/agent-chat would render them a second time.
    for name, staged in (
        ("Install the server configuration", "server.json"),
        ("Install the MCP configuration", "mcp.json"),
    ):
        copy = _task(name)["ansible.builtin.copy"]
        assert (copy["src"], copy["remote_src"]) == ("{{ agent_chat_staged }}/" + staged, True), name
    assert not [
        task["name"]
        for task in tasks
        if str(task.get("ansible.builtin.template", {}).get("dest", "")).startswith("/etc/agent-chat")
    ]


def test_ansible_playbook_installs_one_immutable_environment_per_install_variant():
    play = _playbook()
    # Turning MCP on or off changes the extras. A name that holds the extras gives the new variant its own
    # environment next to the running one, so no pip run reaches the environment that `current` points at.
    venv = play["vars"]["agent_chat_venv"]
    assert venv == "{{ agent_chat_root }}/venvs/{{ agent_chat_version }}-{{ agent_chat_extras | replace(',', '-') }}"
    assert "'server,mcp' if agent_chat_mcp_enabled else 'server'" in play["vars"]["agent_chat_extras"]
    assert "sessionyard[{{ agent_chat_extras }}]" in _flat(play["vars"]["agent_chat_requirement"])

    def environment(extras: str) -> str:
        return (
            venv.replace("{{ agent_chat_root }}", "/base")
            .replace("{{ agent_chat_version }}", "TAG")
            .replace("{{ agent_chat_extras | replace(',', '-') }}", extras.replace(",", "-"))
        )

    assert environment("server") == "/base/venvs/TAG-server"
    assert environment("server,mcp") == "/base/venvs/TAG-server-mcp"

    # The stamp is one file inside its environment, with no extras in the name: the directory is the variant. It is
    # written last, so an interrupted install runs again, and a stamped environment is never installed into again.
    assert play["vars"]["agent_chat_stamp"] == "{{ agent_chat_venv }}/.installed"
    install = _task("Install Agent Chat into its versioned virtual environment")["ansible.builtin.shell"]
    assert install["creates"] == "{{ agent_chat_stamp }}"
    assert install["cmd"].strip().splitlines()[-1] == "touch {{ agent_chat_stamp | quote }}"
    assert "{{ agent_chat_venv | quote }}/bin/pip install" in install["cmd"]


def test_ansible_playbook_leaves_an_existing_install_directory_alone_until_the_gate_passes():
    tasks = _playbook()["tasks"]
    names = [task["name"] for task in tasks]
    gate = names.index("Require the reviewed digest before the schema changes")
    directories = ["{{ agent_chat_root }}", "{{ agent_chat_root }}/venvs"]

    # Before the gate each directory is looked up and only a missing one is created. The create task never runs for
    # an existing directory, so a refused upgrade cannot reset an owner or mode that the deployer chose.
    look = _task("Look for the install directories")
    assert look["ansible.builtin.stat"]["path"] == "{{ item }}"
    assert look["loop"] == directories
    create = _task("Create the missing install directories")
    assert create["loop"] == "{{ " + look["register"] + ".results }}"
    assert create["when"] == "not item.stat.exists"
    created = create["ansible.builtin.file"]
    assert (created["path"], created["state"]) == ("{{ item.item }}", "directory")
    assert (created["owner"], created["group"], created["mode"]) == ("root", "root", "0755")
    assert names.index(look["name"]) < names.index(create["name"]) < gate
    # No other file task before the gate may name the install tree: the staged directory is inside the new environment.
    assert [task["ansible.builtin.file"]["path"] for task in tasks[:gate] if "ansible.builtin.file" in task] == [
        "{{ item.item }}",
        "{{ agent_chat_staged }}",
    ]

    # After the gate one task declares root:root 0755 for both, among the live writes and before the configuration.
    reconcile = _task("Reconcile the install directories")
    assert gate < names.index(reconcile["name"]) < names.index("Install the server configuration")
    assert "when" not in reconcile
    assert reconcile["loop"] == directories
    assert reconcile["ansible.builtin.file"] == {
        "path": "{{ item }}",
        "state": "directory",
        "owner": "root",
        "group": "root",
        "mode": "0755",
    }


def test_ansible_playbook_refuses_an_install_directory_the_service_user_cannot_enter_before_the_gate():
    # `migrate --check` runs as `agent-chat` from a virtual environment inside the install tree, so that user must be
    # able to enter every directory on the way. A deployer may have hardened an existing root to 0700 root:root: the
    # check then exits 203 (EXEC) before the gate, no digest can clear it, and the task that sets 0755 comes after
    # the gate. The play refuses such a directory first, from the stat results of the look-up, and changes nothing.
    # The condition needs ansible-core, which the suite does not install, so this pins the exact text, its place
    # and its message. Both tasks were run with ansible-core 2.18 on temporary directories, with `agent-chat` swapped
    # for an existing account that has a group of its own, and agreed with the kernel (`setpriv` as that account):
    # refused for 0700 root:root, 0750 root:root, a 0700 `venvs` and 0705 with the account's group; allowed for 0755,
    # 0711, 0750 with the account's group and 0700 owned by the account. A missing directory and an id without a
    # passwd or group entry were run too, and the unswapped task on hand-made stat results for `agent-chat` itself.
    tasks = _playbook()["tasks"]
    names = [task["name"] for task in tasks]
    gate = names.index("Require the reviewed digest before the schema changes")
    look = _task("Look for the install directories")
    check = _task("Require the install directories to be traversable by the service user")

    # It reads the stat results of the look-up and nothing else. The module only evaluates, so the task writes
    # nothing, and it has no `when`, `ignore_errors`, `failed_when` or `notify`: it can be neither skipped nor ignored.
    assert set(check) == {"name", "ansible.builtin.assert", "loop", "loop_control"}
    assert check["loop"] == "{{ " + look["register"] + ".results }}"
    assert check["loop_control"] == {"label": "{{ item.item }}"}
    assertion = check["ansible.builtin.assert"]
    assert set(assertion) == {"that", "fail_msg", "quiet"}
    # A missing directory passes, because the next task creates it 0755. Otherwise the class of mode bits that the
    # kernel applies to the service user decides: the owner's, else the group's, else the others'. `stat` leaves out
    # the name of an id that has no passwd or group entry, so each name has a default.
    assert _flat(assertion["that"]) == (
        "not item.stat.exists"
        " or (item.stat.xusr if item.stat.pw_name | default('') == 'agent-chat'"
        " else item.stat.xgrp if item.stat.gr_name | default('') == 'agent-chat'"
        " else item.stat.xoth)"
    )
    message = _flat(assertion["fail_msg"])
    refusal = "{{ item.item }} must stay traversable by the agent-chat user"
    assert message.startswith(refusal + " (for example mode 0755, or mode 0750 with group agent-chat), ")
    assert "does not change an existing install directory before the review gate" in message

    # The order: the look-up, this check, then the first task that creates a directory or installs anything, then the
    # first run as the service user (the migration check), all before the gate. The virtual environment directory
    # comes from `python3 -m venv` under `umask 022`; the play gives it no mode, so only the two directories are read.
    first_run = next(index for index, task in enumerate(tasks) if "agent_chat_admin" in json.dumps(task))
    assert names[first_run] == "List the pending migrations"
    chain = [
        names.index(look["name"]),
        names.index(check["name"]),
        names.index("Create the missing install directories"),
        names.index("Install Agent Chat into its versioned virtual environment"),
        first_run,
        gate,
    ]
    assert chain == sorted(chain)

    # The guide states the requirement where it describes the order and where it promises that a refusal leaves an
    # existing directory alone, in the words of the message.
    guide = _flat((ROOT / "docs" / "ansible.md").read_text())
    assert guide.count("mode 0755, or mode 0750 with group `agent-chat`") == 2
    assert guide.count("`" + refusal.replace("{{ item.item }}", "<directory>") + "`") == 2
    assert "refuses one that the user cannot enter, before it creates a directory or installs the release" in guide
    assert "The play refuses a directory that is not, before the gate, with the message" in guide


def test_ansible_playbook_never_reads_the_dsn_and_passes_it_as_a_credential():
    play = _playbook()
    # A play-level key such as pre_tasks or roles would hold steps that the checks below do not see.
    assert set(play) == {"name", "hosts", "become", "gather_facts", "force_handlers", "vars", "tasks", "handlers"}
    steps = [*play["tasks"], *play["handlers"]]
    # Allowlists: a step that can read a file, run a process or copy one is named here on purpose, so adding
    # one fails this test until a reviewer has decided that it never touches the DSN.
    assert all(sum(key.startswith("ansible.builtin.") for key in step) == 1 for step in steps)
    modules = "assert command copy debug file group meta set_fact shell stat systemd template uri user".split()
    assert {key for step in steps for key in step if key.startswith("ansible.builtin.")} == {
        f"ansible.builtin.{module}" for module in modules
    }
    spawning = ("ansible.builtin.command", "ansible.builtin.shell")
    assert {(key, step["name"]) for step in steps for key in step if key in spawning} == {
        ("ansible.builtin.command", "Read the Python version of the target"),
        ("ansible.builtin.shell", "Install Agent Chat into its versioned virtual environment"),
        ("ansible.builtin.command", "List the pending migrations"),
        ("ansible.builtin.command", "Apply the reviewed migrations"),
        ("ansible.builtin.command", "Restart Agent Chat"),
    }
    # Only the stat task, its checks and the defaults name the DSN file; agent_chat_admin passes it as a credential.
    assert {step["name"] for step in steps if re.search(r"dsn_file|agent-chat-dsn", str(step))} == {
        "Apply the defaults of the optional variables",
        "Check the variables",
        "Check the DSN file without reading it",
        "Require the deployer's DSN file",
    }
    text = (ANSIBLE / "playbook.yml").read_text()
    for banned in ("slurp", "lookup(", "fetch", "password"):
        assert banned not in text.lower(), banned
    stat = _task("Check the DSN file without reading it")
    assert stat["no_log"] is True
    assert {key: stat["ansible.builtin.stat"][key] for key in ("get_checksum", "get_mime", "get_attributes")} == {
        "get_checksum": False,
        "get_mime": False,
        "get_attributes": False,
    }
    require = _task("Require the deployer's DSN file")["ansible.builtin.assert"]["that"]
    assert "agent_chat_dsn.stat.mode == '0600'" in require
    assert "agent_chat_dsn.stat.uid == 0" in require
    # The one place that runs the product outside a unit: as the service user, from the release being installed.
    admin = "systemd-run --wait --pipe --collect --quiet -p User=agent-chat".split()
    admin += ["-p", "LoadCredential=agent-chat-dsn:{{ agent_chat_dsn_file }}"]
    admin += ["{{ agent_chat_venv }}/bin/python", "-I", "-m", "agent_chat.admin"]
    assert play["vars"]["agent_chat_admin"] == admin
    assert [name for name, value in play["vars"].items() if re.search(r"dsn_file|agent-chat-dsn", str(value))] == [
        "agent_chat_admin"
    ]


def test_ansible_playbook_reports_no_change_on_a_rerun_and_restarts_on_a_config_or_unit_change():
    # A command or shell task reports "changed" on every run unless it says otherwise.
    # The uri probes never report a change, so they need no marker.
    for task in _playbook()["tasks"]:
        for module in ("ansible.builtin.command", "ansible.builtin.shell"):
            if module in task and task["name"] != "Apply the reviewed migrations":
                assert task.get("changed_when") is False or "creates" in task[module], task["name"]
    for name in ("Install the server configuration", "Install the MCP configuration", "Install the systemd units"):
        notify = _task(name)["notify"]
        assert "Restart Agent Chat" in ([notify] if isinstance(notify, str) else notify), name
    # One environment per release and per set of extras: the rollback and the install stamp both depend on it.
    assert _playbook()["vars"]["agent_chat_venv"].endswith(
        "/venvs/{{ agent_chat_version }}-{{ agent_chat_extras | replace(',', '-') }}"
    )


def test_ansible_playbook_stops_and_disables_the_mcp_service_while_it_is_turned_off():
    probe = _task("Look for an MCP unit from an earlier run")
    assert probe["ansible.builtin.stat"]["path"] == "/etc/systemd/system/agent-chat-mcp.service"
    stop = _task("Stop and disable the MCP service while it is turned off")
    systemd = stop["ansible.builtin.systemd"]
    assert (systemd["name"], systemd["state"], systemd["enabled"]) == ("agent-chat-mcp.service", "stopped", False)
    # The systemd module fails on a unit that does not exist, as on a host that never ran MCP.
    assert stop["when"] == ["not agent_chat_mcp_enabled", f"{probe['register']}.stat.exists"]
    # Disabled MCP leaves the unit file and mcp.json alone, and the restart list no longer names the unit.
    assert "if agent_chat_mcp_enabled" in _playbook()["vars"]["agent_chat_runtime_units"]


def test_ansible_playbook_restarts_on_new_code_and_waits_for_readiness():
    handlers = {handler["name"]: handler for handler in _playbook()["handlers"]}
    restart = handlers["Restart Agent Chat"]["ansible.builtin.command"]["argv"]
    assert restart.startswith("{{ ['systemctl', 'try-restart']")
    assert _task("Point current at this release")["notify"] == "Restart Agent Chat"
    assert _task("Run the queued restarts")["ansible.builtin.meta"] == "flush_handlers"
    ready = _task("Wait for the server to be ready")
    assert ready["ansible.builtin.uri"]["url"] == "http://127.0.0.1:{{ agent_chat_port }}/readyz"
    mcp = _task("Wait for the MCP service to be ready")
    assert mcp["ansible.builtin.uri"]["url"] == "http://127.0.0.1:{{ agent_chat_mcp_port }}/readyz"
    assert mcp["when"] == "agent_chat_mcp_enabled"
    units = _playbook()["vars"]["agent_chat_unit_files"]
    assert "agent-chat-mcp.service" in units and "if agent_chat_mcp_enabled" in units
    for path in (*TEMPLATES.iterdir(), ANSIBLE / "playbook.yml", ANSIBLE / "inventory.example.yml"):
        assert "/metrics" not in path.read_text(), path


def test_ansible_playbook_finishes_an_interrupted_activation_on_the_next_run():
    play = _playbook()
    tasks = play["tasks"]
    names = [task["name"] for task in tasks]
    gate = names.index("Require the reviewed digest before the schema changes")
    assert play["vars"]["agent_chat_marker"] == "{{ agent_chat_root }}/activation-pending"

    # The three tasks right after the gate come before the migrations and every other live write, so a run that dies
    # at any later point leaves the marker. A run that the gate refuses never reaches them and never writes it.
    look, resume, mark = tasks[gate + 1 : gate + 4]
    assert [task["name"] for task in (look, resume, mark)] == [
        "Look for an unfinished activation",
        "Resume an unfinished activation",
        "Mark the activation as pending",
    ]
    assert look["ansible.builtin.stat"]["path"] == "{{ agent_chat_marker }}"
    assert resume["when"] == f"{look['register']}.stat.exists"
    assert resume["changed_when"] is True  # a reported change is what queues the handlers
    # The restart is the one that the unit and configuration tasks queue. The reload comes with it, in handler order:
    # an earlier run may have written a unit file and stopped before systemd read it.
    assert resume["notify"] == ["Reload systemd", "Restart Agent Chat"]
    assert [handler["name"] for handler in play["handlers"]] == ["Reload systemd", "Restart Agent Chat"]
    written = mark["ansible.builtin.copy"]
    assert (written["dest"], written["owner"], written["group"], written["mode"]) == (
        "{{ agent_chat_marker }}",
        "root",
        "root",
        "0600",
    )
    assert written["content"] == "{{ agent_chat_venv }}\n"
    # The marker is bookkeeping, so a clean rerun still reports changed=0 and the write queues no handler.
    assert mark["changed_when"] is False
    assert not {"when", "notify"} & set(mark)

    # The last task removes it, after both readiness waits, so only a run that finished leaves none behind.
    clear = _task("Clear the activation marker")
    assert clear["ansible.builtin.file"] == {"path": "{{ agent_chat_marker }}", "state": "absent"}
    assert clear["changed_when"] is False
    assert "when" not in clear
    waits = ("Wait for the server to be ready", "Wait for the MCP service to be ready")
    assert max(names.index(wait) for wait in waits) < names.index(clear["name"]) == len(names) - 1
    # Nothing else may write or remove the marker, and it holds no secret.
    assert {task["name"] for task in tasks if "agent_chat_marker" in json.dumps(task)} == {
        look["name"],
        mark["name"],
        clear["name"],
    }
    assert not re.search(r"dsn", json.dumps([look, resume, mark, clear]), re.IGNORECASE)


# Every variable that `Check the variables` tests with `match`, with strings its pattern must accept and refuse.
# The samples run through `re.match`, as the playbook's `match` test does. `$` also accepts one trailing newline,
# so refuse samples keep any newline inside.
MATCH_SAMPLES = {
    ("agent_chat_version",): (
        ("v0.6.0", "v10.20.30"),
        ("main", "0.6.0", "v0.6", "v0.6.0-rc1", "v0.6.0 ", "v0.6.0/../x"),
    ),
    ("agent_chat_public_origin", "agent_chat_mcp_public_origin"): (
        ("https://chat.example.invalid", "https://chat.example.invalid:8443"),
        (
            "http://chat.example.invalid",
            "https://chat.example.invalid/",
            "https://chat.example.invalid:0",
            "https://a b",
            "",
        ),
    ),
    ("agent_chat_port", "agent_chat_mcp_port", "agent_chat_prune_limit", "agent_chat_prune_max_batches"): (
        ("1", "8443"),
        ("", "-1", "1.5", "1 --max-batches 9", "1\n2"),
    ),
    ("agent_chat_dsn_file",): (
        ("/etc/agent-chat/credentials/agent-chat-dsn", "/run/keys/dsn.v2"),
        ("dsn", "/etc/a b", "/etc/a:b", "/etc/a%h", "/etc/a$b", "/etc/a\nExecStartPre=/bin/true", ""),
    ),
    ("agent_chat_migrate_reviewed",): (
        ("", "0" * 64, "ab" * 32),
        ("0" * 63, "0" * 65, "A" * 64, "sha256:" + "0" * 64),
    ),
}


def test_ansible_playbook_checks_every_variable_it_interpolates_before_changing_the_host():
    task = _task("Check the variables")
    assert not {"when", "ignore_errors", "failed_when"} & set(task)  # it can be neither skipped nor ignored
    names = [item["name"] for item in _playbook()["tasks"]]
    assert names.index(task["name"]) < names.index("Create the service group")  # the first task that changes the host

    checks = task["ansible.builtin.assert"]["that"]
    for condition in (  # nothing else backstops these before the install
        "agent_chat_bind_host in ['127.0.0.1', '0.0.0.0']",
        "agent_chat_mcp_enabled is boolean",  # only Jinja reads it: a string such as "false" would be truthy
        "agent_chat_prune_limit | int >= 1",
        "agent_chat_prune_limit | int <= 1000",
        "agent_chat_prune_max_batches | int >= 1",
        # The product loader refuses an explicit :443 and a port above 65535; the play refuses them before the install.
        "not agent_chat_public_origin is search(':443$')",
        "(agent_chat_public_origin.split(':')[2] | default('1')) | int <= 65535",
        "not agent_chat_mcp_enabled or not agent_chat_mcp_public_origin is search(':443$')",
        "not agent_chat_mcp_enabled or (agent_chat_mcp_public_origin.split(':')[2] | default('1')) | int <= 65535",
        # The loader has no cross-field check: equal ports would let the readiness probe reach the wrong service.
        "not agent_chat_mcp_enabled or agent_chat_mcp_port | int != agent_chat_port | int",
    ):
        assert condition in checks, condition
    found = re.findall(r"(agent_chat_\w+)(?: \| string| \| default\(''\))? is match\('(.+?)'\)", "\n".join(checks))
    patterns = dict(found)
    assert set(patterns) == {name for group in MATCH_SAMPLES for name in group}  # a new pattern needs samples
    for group, (accepted, refused) in MATCH_SAMPLES.items():
        for name in group:
            assert all(re.match(patterns[name], sample) for sample in accepted), name
            assert not [sample for sample in refused if re.match(patterns[name], sample)], name


def test_ansible_guide_documents_the_supported_native_path_and_every_variable():
    guide = (ROOT / "docs" / "ansible.md").read_text()
    play = _playbook()
    derived = set(play["vars"]) | {task["register"] for task in play["tasks"] if "register" in task}
    used = set(re.findall(r"agent_chat_[a-z_]+", (ANSIBLE / "playbook.yml").read_text()))
    for path in TEMPLATES.iterdir():
        for expression in re.findall(r"\{\{(.*?)\}\}", path.read_text()):
            used |= set(re.findall(r"agent_chat_[a-z_]+", expression))
    inputs = used - derived
    assert inputs == set(re.findall(r"^\| `(agent_chat_[a-z_]+)` \|", guide, re.MULTILINE))
    inventory = (ANSIBLE / "inventory.example.yml").read_text()
    assert all(name in inventory for name in inputs)

    for target in re.findall(r"\]\(([^)#]+)\)", guide):
        assert target.startswith("http") or (ROOT / "docs" / target).resolve().exists(), target
    assert "deploy/traefik/dynamic.example.yml" in guide
    flat = _flat(guide)
    assert "Keep `/metrics` off the public routers" in flat
    assert "without authentication" in flat
    for token in ("LoadCredential=agent-chat-dsn", "migrate --reviewed", "REVIEW_MISMATCH", "SCHEMA_MISMATCH"):
        assert token in guide

    assert "docs/ansible.md" in (ROOT / "README.md").read_text()
    for name in ("containers.md", "podman.md", "self-hosting.md"):
        assert "ansible.md" in (ROOT / "docs" / name).read_text(), name
    assert "does not describe a supported deployment" not in (ROOT / "docs" / "self-hosting.md").read_text()


def test_ansible_guide_documents_the_environments_the_activation_marker_and_the_dsn_rotation():
    guide = _flat((ROOT / "docs" / "ansible.md").read_text())
    play = _playbook()
    root = play["vars"]["agent_chat_root"]
    marker = play["vars"]["agent_chat_marker"].replace("{{ agent_chat_root }}", root)
    mode = _task("Mark the activation as pending")["ansible.builtin.copy"]["mode"]
    assert (root, marker) == ("/usr/local/lib/agent-chat", "/usr/local/lib/agent-chat/activation-pending")

    # The layout, the upgrade and the rollback text name the directory of an install variant, not of a release.
    assert f"`{root}/venvs/<tag>-<extras>`" in guide
    assert f"`{root}/venvs/<old tag>-<extras>`" in guide
    assert "venvs/<tag>`" not in guide and "venvs/<old tag>`" not in guide
    assert "record the activation marker" in guide and "and remove the marker." in guide
    assert "any install directory that is missing" in guide and "An install directory that exists keeps" in guide
    assert "set the install directories to `root:root` with mode 0755" in guide

    # Switching MCP no longer runs pip in the environment that the services use.
    assert "The install step is recorded per release" not in guide
    assert "runs `pip install` again in the virtual environment the services use" not in guide
    assert (
        "- Switching `agent_chat_mcp_enabled` on or off installs a separate virtual environment"
        " and activates it like an upgrade."
    ) in guide

    # The play is not transactional after the gate; the marker is what makes the rerun restart the services.
    assert (
        "The play is not transactional after the gate. If a task fails between installing the configuration"
        " and switching `current`, the forced handlers can restart the old release with the new configuration."
        " Rerun the play to finish."
    ) in guide
    assert (
        f"The play writes the activation marker `{marker}` right after the gate (owner root, mode {mode}, no secret)"
    ) in guide
    assert "The marker makes that rerun restart the services" in guide

    # The DSN rotation: the playbook never reads the file, so it cannot notice a new value.
    assert "### Rotate the DSN" in guide
    assert (
        "Replace the contents of the DSN file in place: keep the path, the owner `root:root` and the mode 0600."
    ) in guide
    assert "sudo systemctl restart agent-chat.service" in guide
    assert "The prune service reads the new credential at its next start, and the MCP service has no DSN." in guide
    assert "The playbook does not detect a changed DSN, because it never reads the file." in guide


def test_security_policy_and_readme_name_the_install_paths_that_the_guides_support():
    security = _flat((ROOT / "SECURITY.md").read_text())
    readme = (ROOT / "README.md").read_text()
    intro = "\n".join((ROOT / "docs" / "self-hosting.md").read_text().splitlines()[:12])
    for guide in ("ansible.md", "containers.md", "podman.md"):
        assert f"docs/{guide}" in security, guide
        assert f"docs/{guide}" in readme, guide
        assert guide in intro, guide
    assert "does not operate a hosted service" in security
    assert "green CI run" in security
    assert "no deployment is supported" not in security
