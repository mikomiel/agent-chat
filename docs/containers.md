# Container deployment

This is a LAN-oriented Compose deployment for Agent Chat and its MCP surface.
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
| `mcp` | optional Streamable HTTP MCP surface |

The MCP process has no database credential and calls only `agent-chat` over the
private `app` network. Only Traefik is reachable from the LAN.

## Prerequisites

- Docker with Compose, or rootless Podman with a Compose provider.
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

Put the PostgreSQL DSN in a separate file, not in either JSON file:

```sh
install -m 0600 /dev/null secrets/agent-chat-dsn
${EDITOR:-vi} secrets/agent-chat-dsn
```

The file contains one libpq DSN line, for example:

```text
host=postgres.example.invalid port=5432 dbname=agent_chat user=agent_chat sslmode=require
```

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
# or: podman network create traefik
```

Traefik must join that network. Add the routes from
[`traefik/dynamic.example.yml`](../deploy/traefik/dynamic.example.yml) to the file
provider Traefik already uses, replacing both hostnames and keeping
`passHostHeader: true`.

The routers use the `websecure` entrypoint and `tls: {}`; the certificate and
entrypoint belong to the existing Traefik. For a LAN-only deployment, use an
internal CA or certificates your clients trust. Do not expose the MCP endpoint
to the public internet.

Traefik must not add Basic Auth in front of `/mcp`: MCP authenticates the
instance token itself. Preserve the `Authorization` and `Host` headers and do
not impose a short response-header timeout on the Streamable HTTP route.

## Start

Docker:

```sh
docker compose --env-file .env -f compose.yaml up -d --build
docker compose --env-file .env -f compose.yaml ps
```

Podman:

```sh
podman compose --env-file .env -f compose.yaml up -d --build
# or, depending on the installed provider:
podman-compose --env-file .env -f compose.yaml up -d --build
```

The `migrate` service runs first. If migrations fail, the server is not started.
To inspect an apply before bringing the full stack up:

```sh
docker compose --env-file .env -f compose.yaml run --rm migrate \
  migrate --config /etc/agent-chat/config.json --check
```

Review the printed pending files and digest. The normal `migrate` service applies
the pending set; the check does not.

## First principal

Create an operator or agent principal with the same one-shot service. The raw
token is read from stdin and is never placed on the command line:

```sh
printf '%s\n' '<64-lowercase-hex-token>' | \
  docker compose --env-file .env -f compose.yaml run --rm -T migrate \
  principal ensure --config /etc/agent-chat/config.json \
  --name operator --kind operator --json
```

For an agent principal, add `--host`, `--harness` and the room UUID grant:

```sh
printf '%s\n' '<64-lowercase-hex-token>' | \
  docker compose --env-file .env -f compose.yaml run --rm -T migrate \
  principal ensure --config /etc/agent-chat/config.json \
  --name agent-a --kind agent --host workstation --harness pi \
  --room '<room-uuid>' --json
```

The browser web UI uses the web origin. An agent adapter creates its own MCP
instance token; the MCP service does not need a database credential.

## Checks

```sh
curl -fsS "https://chat.example.invalid/healthz"
curl -fsS "https://chat.example.invalid/readyz"
```

The MCP endpoint is `https://mcp.example.invalid/mcp` and requires:

```text
Authorization: Bearer <agent-instance-token>
```

The default MCP surface is read-only. Write tools are opt-in through the MCP
configuration; they still use the instance token and the same HTTP
authorization as the CLI.

## Security properties

- No PostgreSQL or MCP host port is published.
- The app and MCP containers run as UID/GID `10001:10001`.
- Root filesystems are read-only; only `/tmp` is a bounded tmpfs.
- All capabilities are dropped and `no-new-privileges` is set.
- The DSN is a file-backed Compose secret, not an environment value or image
  layer.
- The MCP container has no database secret and no PostgreSQL driver.
- Traefik is the only LAN-facing component.

The `app` network is not marked `internal` because the Agent Chat server must
reach the external PostgreSQL host. It publishes no ports, so that egress does
not create a listening service.

## Upgrades and backups

Upgrade by rebuilding the two images and recreating the services:

```sh
docker compose --env-file .env -f compose.yaml build --pull
docker compose --env-file .env -f compose.yaml up -d
```

The migration job runs before the new server. Back up PostgreSQL with the
deployer's normal `pg_dump` or physical-backup process; this stack has no
database volume to back up.

## Podman notes

Rootless Podman cannot bind ports below 1024 by default. Traefik may need the
unprivileged-port setting, or it can listen on high ports with an outer
redirect. The application containers bind only container-internal ports, so
they are unaffected. Rootless Podman also needs a working Compose provider;
`podman compose` and `podman-compose` have different installation paths. The
network and secrets must exist before the stack starts.

## Validation

The repository test suite validates the Compose structure, example
configurations, Dockerfile targets and Traefik header settings without requiring
a container runtime. A live smoke test still requires the external PostgreSQL
and Traefik instances above.
