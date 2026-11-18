# Container deployment

This is a LAN-oriented Compose deployment for Agent Chat and its MCP surface.
For native Podman with systemd, use the
[Quadlet deployment](podman.md), which avoids the Compose provider and
documents the supported rootless/rootful Traefik topologies. For systemd units
without containers, use the [Ansible deployment](ansible.md).
It deliberately uses two external dependencies:

- an existing PostgreSQL server, owned and backed up by the deployer;
- an existing Traefik edge, already terminating TLS.

The stack does not bundle PostgreSQL, Traefik, or a SQLite fallback. Agent Chat
supports PostgreSQL only; its migrations and coordination semantics depend on
PostgreSQL.

The Compose project starts three short-lived or long-lived services:

| Service | Purpose |
| --- | --- |
| `migrate` | one-shot schema migration before the server starts |
| `agent-chat` | HTTP API, SSE feed and browser UI |
| `agent-chat-mcp` | optional Streamable HTTP MCP surface |

The MCP process has no database credential and calls only `agent-chat` over the
private `app` network. Only Traefik is reachable from the LAN.

## Prerequisites

- Docker with Docker Compose, the supported Compose engine. On Podman, use the
  [Quadlet deployment](podman.md); `podman-compose` is not supported (see
  [the Podman guide](podman.md#why-quadlet)).
- An existing PostgreSQL database, role and DSN. The role must own the database.
- An existing Traefik instance on a shared external network, with a TLS
  certificate covering the web and MCP hostnames.
- Two hostnames, for example `chat.example.invalid` and
  `mcp.example.invalid`, resolving to Traefik on the LAN.

The service does not create the database, role, DNS records, certificate or
Traefik instance.

## Prepare local files

The examples are safe placeholders. Create private copies outside version
control:

```sh
cd deploy
install -d -m 0700 config secrets
cp config/server.example.json config/server.json
cp config/mcp.example.json config/mcp.json
```

Edit both JSON files:

- `server.json`: set `public_origin` to the exact web HTTPS origin.
- `mcp.json`: set `public_origin` to the exact MCP HTTPS origin. Keep
  `agent_chat_origin` as `http://agent-chat:8443`.

Make both JSON files readable by UID/GID `10001:10001`. Files containing only
the settings in these examples can use mode 0644. Keep the DSN in its separate
private file.

Put the PostgreSQL DSN in a separate file, not in either JSON file:

```sh
umask 077
install -m 0600 /dev/null secrets/agent-chat-dsn
${EDITOR:-vi} secrets/agent-chat-dsn
```

The container runs as UID/GID `10001:10001`. Make the DSN readable by that
runtime identity, not by every host user:

```sh
# rootful Docker
sudo chown 10001:10001 secrets/agent-chat-dsn
sudo chmod 0400 secrets/agent-chat-dsn
```

Do not leave the file world-readable. The migration command below is the
readability check: it exits with `DSN_CREDENTIAL_UNREADABLE` if the runtime
identity cannot open it.

The `,z` option on the configuration bind mounts applies the shared SELinux
label. It is harmless on hosts without SELinux and lets the one-shot migration
and the server read the same file.

Compose implements a file-backed secret as a read-only bind mount. On an
SELinux-enforcing host, apply the same shared-container label to the DSN source
file as well:

```sh
# rootful Docker
sudo chcon -t container_file_t secrets/agent-chat-dsn
```

Keep the ownership and mode restrictions above. Do not disable SELinux to make
the mount readable.

Use the [TCP DSN example](self-hosting.md#tcp-connections) for PostgreSQL.

For PostgreSQL on the Docker host, use a hostname reachable from both the
`migrate` and `agent-chat` containers. On Linux Docker, a local Compose
override can add `extra_hosts: ["postgres-host.example.invalid:host-gateway"]` to both
services. Then use `host=postgres-host.example.invalid` and include the override file in
each Compose command. PostgreSQL must listen on the reachable address and
`pg_hba.conf` must allow this role and database from the container network.
Inside a container, `localhost` refers to the container itself.

Create `deploy/.env` from the example and edit the paths and network name:

```sh
cp .env.example .env
```

`AGENT_CHAT_DSN_FILE` is resolved by Compose and must point at the private DSN
file. The DSN is mounted at `/run/secrets/agent-chat-dsn`; `agent_chat.admin`
reads it through `CREDENTIALS_DIRECTORY`, so no token or DSN is placed in the
Compose environment.

## Traefik

Create the external network once, if your Traefik installation does not already
have one:

```sh
docker network create traefik
```

Traefik must join that network. Add the routes from
[`traefik/dynamic.example.yml`](../deploy/traefik/dynamic.example.yml) to the file
provider Traefik already uses, replacing both hostnames and keeping
`passHostHeader: true`.

The routers use the `websecure` entrypoint and `tls: {}`; the certificate and
entrypoint belong to the existing Traefik. For a LAN-only deployment, use an
internal CA or certificates your clients trust. Do not expose the MCP endpoint
to the public internet.

Follow the [shared reverse-proxy requirements](self-hosting.md#reverse-proxy-requirements).

## Start

Build the images and inspect the pending migrations before creating the
long-running containers:

```sh
docker compose --env-file .env -f compose.yaml build --pull migrate agent-chat-mcp
docker compose --env-file .env -f compose.yaml run --rm --no-deps --pull never migrate \
  migrate --config /etc/agent-chat/config.json --check
```

Review the printed files and digest. The check reads the schema and exits
immediately if PostgreSQL is unreachable. Once the result is acceptable, start
the stack:

```sh
docker compose --env-file .env -f compose.yaml up -d --no-build --pull never
docker compose --env-file .env -f compose.yaml ps
```

The one-shot `migrate` service applies the pending set before the server
starts. An apply waits up to five minutes for PostgreSQL. Wrong connection
parameters also end with `DATABASE_UNAVAILABLE` after that wait.

## Provision principals with Compose

Use the [principal credential procedure](self-hosting.md#5-provision-principals)
for token format, rotation and storage. These Compose examples generate new
tokens in private files and read them through stdin.

```sh
install -d -m 0700 secrets
(umask 077; set -C; openssl rand -hex 32 > secrets/operator.token) &&
docker compose --env-file .env -f compose.yaml run --rm -T migrate \
  principal ensure --config /etc/agent-chat/config.json \
  --name operator --kind operator --json < secrets/operator.token
```

For an agent principal, provide only `--host` and `--harness`:

```sh
(umask 077; set -C; openssl rand -hex 32 > secrets/agent.token) &&
docker compose --env-file .env -f compose.yaml run --rm -T migrate \
  principal ensure --config /etc/agent-chat/config.json \
  --name agent-a --kind agent --host workstation --harness pi --json < secrets/agent.token
```

The browser web UI uses the web origin. An agent adapter creates its own MCP
instance token; the MCP service does not need a database credential.

## Verify the Compose deployment

Run the [HTTP checks](self-hosting.md#checks) from the client network. After
an adapter joins, run the [authenticated MCP smoke test](self-hosting.md#authenticated-mcp-smoke-test)
if you deployed MCP. The Compose example uses the
[read-only MCP configuration](self-hosting.md#optional-mcp-service) by default.

## Security properties

- No PostgreSQL or MCP host port is published.
- The app and MCP containers run as UID/GID `10001:10001`.
- Root filesystems are read-only. The Compose file declares one tmpfs, a 16 MiB
  `noexec` mount on `/tmp`. It does not declare the mounts that the container
  engine adds itself, such as `/dev/shm`.
- All capabilities are dropped and `no-new-privileges` is set.
- The DSN is a file-backed Compose secret, not an environment value or image
  layer.
- The MCP container has no database secret and no PostgreSQL driver.
- Traefik is the only LAN-facing component.

The `app` network is not marked `internal` because the Agent Chat server must
reach the external PostgreSQL host. It publishes no ports, so that egress does
not create a listening service.

## Upgrades and backups

Before upgrading, save the working deployment configuration and take a
PostgreSQL backup with your deployment's tested restore procedure. Record
which backup belongs to this upgrade. Use versioned values for
`AGENT_CHAT_SERVER_IMAGE` and `AGENT_CHAT_MCP_IMAGE` in `.env`. Keep the previous
tags until the upgrade is verified. If the current stack uses the default `:local` tags, tag the image
IDs of the running containers with unused rollback tags before rebuilding.
Use `docker compose ps -q SERVICE` to get each container ID and
`docker inspect --format '{{.Image}}' CONTAINER_ID` to find its image ID.

Compose resolves these inputs from exported shell variables first, the
file given to `--env-file` second and the defaults in `compose.yaml` last.
Unset any unintended shell overrides for the image tags,
`AGENT_CHAT_CONFIG_DIR`, `AGENT_CHAT_DSN_FILE` and `TRAEFIK_NETWORK`.
Run `docker compose --env-file .env -f compose.yaml config` in your terminal
and confirm the resolved image tags, configuration mounts, DSN file path
and network before building or migrating. Check the DSN path without
printing its contents.

Build the candidate from the intended source version using new image tags.
Run the same build and migration check as in [Start](#start). If the check
fails, keep serving from the previous containers while you investigate.
Keep the candidate images and Compose inputs fixed through the upgrade.
Schedule a maintenance window if the schema change can interrupt the
previous version.

If migrations are pending, review the listed files and pass the printed
`reviewed=` value (the digest only) to the one-shot apply:

```sh
docker compose --env-file .env -f compose.yaml run --rm --no-deps --pull never migrate \
  migrate --config /etc/agent-chat/config.json --reviewed '<reviewed-sha256>'
```

After a successful apply, run the candidate's migration check again and
confirm it prints `pending=0`. If the first check already prints `pending=0`,
skip the apply. Once the check is clean, recreate the long-running services
with `--no-deps` so Compose does not start another migration:

```sh
docker compose --env-file .env -f compose.yaml up -d --no-build --pull never \
  --no-deps agent-chat agent-chat-mcp
```

Check readiness on both origins before retiring the previous images. For a
rollback, restore the previous Compose configuration and image tags.
Check the resolved inputs again, then check database compatibility with
the previous version. If a migration made the schema incompatible with
that version, restore a compatible database using the tested restore
procedure and verify it before bringing up the previous stack.

When upgrading from a release that named the MCP service `mcp`, add
`--remove-orphans` to the final `up` command. Change any Traefik and Alloy
backends from `mcp:8951` to `agent-chat-mcp:8951` and reload them.

## Rotate the database credential

Update the PostgreSQL role credential and the DSN file, then recreate only
the server so it reloads the credential. Verify web and MCP readiness.

```sh
docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate \
  --no-build --pull never agent-chat
```

The MCP process uses the server API. A DSN rotation requires only the server
recreation. After editing `mcp.json`, recreate the MCP container to load the
new settings, including any change to `enable_writes`:

```sh
docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate \
  --no-build --pull never agent-chat-mcp
```

## Restarts and logs

Changes to Compose inputs take effect through `up` and container
recreation. Use `restart` when you only need to restart a process with
its existing container configuration.

When Docker starts after reboot, it restarts the long-running services unless
an operator stopped them. The completed migration container does not start
with them. Adapters can rejoin after an outage that outlasts their lease.

```sh
docker compose --env-file .env -f compose.yaml logs --tail 100 migrate agent-chat agent-chat-mcp
```

## Repository validation

The [deployment contract tests](../CONTRIBUTING.md#local-checks) cover the
Compose structure, configuration, image targets and Traefik headers. For
a live smoke test, use the PostgreSQL and Traefik instances of the deployment
under test.
