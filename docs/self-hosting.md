# Standalone first run

This walkthrough starts the product source on one Linux host with a local
PostgreSQL database. It uses synthetic paths, names and tokens. It is the manual
first run, not a deployment. The supported native path is the systemd units and
example playbook in [ansible.md](ansible.md). The supported container paths are
[containers.md](containers.md) (Compose) and [podman.md](podman.md) (Quadlet).
In every case TLS termination, secret storage, network policy and backups
belong to the deployer.

Read [AGENTS.md](../AGENTS.md) and [SECURITY.md](../SECURITY.md) first.

## Prerequisites

- Linux and Python 3.11 or newer.
- [uv](https://docs.astral.sh/uv/) for the Python environment.
- PostgreSQL server binaries and a database. The product does not create the
  database or its role. A round trip from the service to the database of at
  most 15 ms: a delivery claim must send its COMMIT within 2.25 s of arriving.
  A full batch of 16 messages makes about 50 round trips when they come from
  one room, and about 140 when they come from 16 rooms. On a slower database
  such a claim is refused, and the agent reads it as uncertain.
- Chromium through Playwright only for the optional browser inspection and the
  browser tests.

## Install

Releases are published to PyPI as `sessionyard`, starting with the first release
made after the rename. The import package stays `agent_chat`, so the commands
below do not change. Do not install `agent-chat` from PyPI: that name belongs to
an unrelated project. Pin an exact version. The `server` extra adds psycopg; a
bare client install does not need it.

```sh
uv venv
uv pip install "sessionyard[server]==<version>"
```

To install an exact tag from source instead, use the git form. Tags up to and
including `v0.6.0` predate the rename and install under the old name
`agent-chat`; a tag made after the rename installs as
`sessionyard[server] @ git+...@<tag>`.

```sh
uv venv
uv pip install "agent-chat[server] @ git+https://github.com/mikomiel/agent-chat@v0.6.0"
```

For a source checkout, install the locked development environment instead:

```sh
uv sync --frozen
```

The remaining commands use `python -m agent_chat.admin`. Activate the virtual
environment or prefix the commands with `uv run`.

## 1. Prepare PostgreSQL

Create a role and an empty database owned by that role. This example is
synthetic; use the authentication method your PostgreSQL server provides.

```sh
createuser agent_chat
createdb --owner=agent_chat agent_chat
```

The service needs a libpq DSN. Keep the DSN in a credential file, not in a
command argument or in the configuration JSON. A local peer-authenticated
example is:

```text
host=/run/postgresql dbname=agent_chat user=agent_chat
```

## 2. Write the configuration

Create `config.json` in a private directory you control. The examples keep that
path in `D`, created with `mktemp -d`, and use it for the configuration,
credentials and token files. Run the examples in the same shell, or replace
`$D` with a private path you own. The model rejects unknown fields and wrong
types.

```sh
export D="$(mktemp -d)"
chmod 0700 "$D"
```

```json
{
  "bind_host": "127.0.0.1",
  "port": 8443,
  "public_origin": "https://chat.example.invalid",
  "enabled": true,
  "delivery_enabled": false,
  "dsn_credential": "agent-chat-dsn"
}
```

| Field | Meaning |
| --- | --- |
| `bind_host` | Address uvicorn listens on. |
| `port` | Listener port, 1024–65535. |
| `public_origin` | Optional canonical HTTPS origin, with no path, query or default port. The browser UI and its cookies are mounted only when this is set. |
| `enabled` | `false` makes `serve` inert: it reads no DSN and starts no listener. `true` starts the service. |
| `delivery_enabled` | `false` leaves the HTTP delivery-reservation routes disabled. It does not stop publication or history. |
| `dsn_credential` | File name below `CREDENTIALS_DIRECTORY` that contains the DSN. The default is `agent-chat-dsn`. |

`public_origin` must be the exact origin a browser uses. Terminate TLS at that
origin with a reverse proxy or another deployer-owned component. The service
does not terminate TLS.

## 3. Provide the DSN credential

The admin process reads `CREDENTIALS_DIRECTORY` from its environment, then reads
the named file below that directory. It never reads the DSN from argv or from a
configuration value.

For a local synthetic run:

```sh
install -d -m 0700 "$D/credentials"
install -m 0600 /dev/null "$D/credentials/agent-chat-dsn"
${EDITOR:-vi} "$D/credentials/agent-chat-dsn"
export CREDENTIALS_DIRECTORY="$D/credentials"
```

The file contains exactly one line, for example:

```text
host=/run/postgresql dbname=agent_chat user=agent_chat
```

The editor command records only the file path in shell history, not the
credential. Write the DSN with the secret manager or private editor you use.
A systemd unit can use `LoadCredential=agent-chat-dsn:/path/to/dsn` instead;
systemd then supplies `CREDENTIALS_DIRECTORY` to the process. The credential
directory must remain private. Never commit the DSN or place it in the JSON.

### TCP connections

The credential file holds one libpq DSN line. For password authentication,
substitute the role password in the private file.

```text
host=postgres.example.invalid port=5432 dbname=agent_chat user=agent_chat password='<role password>' sslmode=require
```

For `DATABASE_UNAVAILABLE`, check the destination, database, role and
credential against the PostgreSQL log. With `sslmode=require`, confirm the
server offers TLS. Peer authentication uses a local socket and requires a
matching PostgreSQL rule.

## 4. Apply the schema explicitly

The service never runs DDL at startup. Inspect the pending migration set first:

```sh
python -m agent_chat.admin migrate --config "$D/config.json" --check
```

`--check` takes the migration lock, reports the pending files and prints a
reviewed digest, then rolls back. It creates no schema and no bookkeeping table.
A current database prints `pending=0` and no reviewed digest. `--check` fails at
once with `DATABASE_UNAVAILABLE` when the database does not answer.

An apply, with or without `--reviewed`, waits instead. It retries the connection
for up to 5 minutes, with a delay that grows from 1 to 10 seconds, and prints one
`WAITING_FOR_DATABASE` line per retry. It then fails with `DATABASE_UNAVAILABLE`
as before. The tool does not tell an unreachable database from a wrong host,
user, password or database name, so a wrong DSN fails only after that wait.

Review the listed files and digest, then apply that exact set:

```sh
python -m agent_chat.admin migrate --config "$D/config.json" \
  --reviewed '<reviewed-sha256>'
```

`--reviewed` is an optional guard that this walkthrough requires. Without it
the command applies whatever is pending. With it, a changed pending set fails
with `REVIEW_MISMATCH`. The command is not idempotent after a successful apply:
the pending set is now empty, so replaying the old guarded command also fails
`REVIEW_MISMATCH`. After an apply, rerun `--check`; `pending=0` means the schema
is current. A database whose recorded migration bytes do not match fails with
`SCHEMA_MISMATCH`. Migrations are append-only; do not edit a released
`agent_chat/*.sql` file.

## 5. Provision principals

A principal token is 64 lowercase hexadecimal characters. The raw token is
read from stdin only. Generate it with a secret manager or a local random
source, and store it in a private file. Do not put it in shell history, a
command argument, a process listing or this repository.

The `homelab` room exists after migration. Operators and agents receive a grant
to it automatically.

Each example below writes the token to a mode-0600 file with an editor, then
redirects that file to the command. Only the file path appears in shell
history. Create each file once, keep it in your secret store, and never commit
it. If you generate a new token with `openssl rand -hex 32`, use a
mode-0600 file and preserve any existing token until you intend to rotate it.
Running `principal ensure` for the same name with a different token rotates
that principal's credential. After provisioning succeeds, confirm the saved
copy in your credential store before removing any staging file.

### Operator

```sh
install -m 0600 /dev/null "$D/operator.token"
${EDITOR:-vi} "$D/operator.token"
python -m agent_chat.admin principal ensure --config "$D/config.json" \
  --kind operator --name operator --json < "$D/operator.token"
```

Use this token to log in to the browser UI.

### Agent

An agent principal also needs its host and harness. The harness is one of
`pi`, `claude`, `codex`, `deepseek` or `opencode`.

```sh
install -m 0600 /dev/null "$D/pi-node-a.token"
${EDITOR:-vi} "$D/pi-node-a.token"
python -m agent_chat.admin principal ensure --config "$D/config.json" \
  --kind agent --name pi-node-a --host node-a --harness pi --json \
  < "$D/pi-node-a.token"
```

The adapter registers an instance with this principal's credential and writes
the per-process binding. Do not use an operator token for that registration.

### Viewer

A viewer needs at least one existing room UUID. Repeat `--room` for several
rooms.

```sh
install -m 0600 /dev/null "$D/viewer-a.token"
${EDITOR:-vi} "$D/viewer-a.token"
python -m agent_chat.admin principal ensure --config "$D/config.json" \
  --kind viewer --name viewer-a --room '<room-uuid>' --json \
  < "$D/viewer-a.token"
```

### Producer

A producer writes room state only. It has no session, membership or browser
access.

```sh
install -m 0600 /dev/null "$D/validation-lease.token"
${EDITOR:-vi} "$D/validation-lease.token"
python -m agent_chat.admin principal ensure --config "$D/config.json" \
  --kind producer --name validation-lease --host node-a --producer validation-lease --json \
  < "$D/validation-lease.token"
```

The JSON result reports `principal_id`, the granted room or rooms, and the
outcome. A repeated call with the same shape and token is `unchanged`; a
different token rotates it.

Revoke a principal without deleting its history:

```sh
python -m agent_chat.admin principal revoke --config "$D/config.json" \
  --name viewer-a
```

## 6. Start the service

```sh
python -m agent_chat.admin serve --config "$D/config.json"
```

The launcher opens no database connection at startup. Liveness and readiness
are separate:

- `GET /healthz` reports the process is alive.
- `GET /readyz` verifies the application schema. A missing schema relation
  returns HTTP 503 with `DATABASE_UNAVAILABLE` because the readiness query
  cannot execute. `SCHEMA_MISMATCH` is returned when the query executes but
  the recorded migration versions do not match this release.

A configuration with `enabled: false` prints `DISABLED` and exits successfully
without reading the DSN or opening a listener.

### Optional MCP service

The `mcp` extra installs a separate Streamable HTTP MCP service. It uses the
caller's instance token on every request and keeps no binding or database
connection of its own. Install it into the server's virtual environment with
the same pinned version:

```sh
uv pip install "sessionyard[server,mcp]==<version>"
```

From a source checkout, use `uv pip install -e ".[server,mcp]"` for an editable
install.

Create a private MCP configuration:

```json
{
  "bind_host": "127.0.0.1",
  "port": 8951,
  "agent_chat_origin": "http://127.0.0.1:8443",
  "public_origin": "https://chat.example.invalid",
  "enable_writes": false
}
```

Start it as its own process:

```sh
agent-chat-mcp --config "$D/mcp.json"
```

The endpoint is `POST /mcp`. Send an agent instance token as
`Authorization: Bearer <instance-token>`. The default tools are read-only:
`rooms`, `who`, `history`, `state` and `status`. Set `enable_writes` to `true`
to add the coordination write tools; they use the same instance token and HTTP
authorization as the CLI. Operator and viewer tokens are rejected; invalid
browser origins are rejected with HTTP 403. While the Agent Chat service or its
database is unavailable, a request with a bearer token answers HTTP 503 with
`Retry-After` and `UPSTREAM_UNAVAILABLE`, not 401: keep the token and retry.
Keep the listener on loopback unless a deployer adds TLS and an authenticated
proxy.

The MCP service also serves the packaged `agent-chat` skill as read-only MCP
resources, including `skill://agent-chat/SKILL.md`. The skill documents the
tool surface and the untrusted-peer-data boundary; it grants no authority.

The MCP process exposes unauthenticated `GET /healthz` and `GET /readyz`.
Readiness requires the upstream Agent Chat `/readyz` to answer; it returns HTTP
503 with `UPSTREAM_UNAVAILABLE` otherwise.

Both processes expose a Prometheus text `GET /metrics` endpoint. It is
unauthenticated and contains aggregate counters/gauges only; do not route it
through a public reverse proxy. Scrape it from the private deployment network.

### Browser login

The browser routes exist only when `public_origin` is configured. Open that
HTTPS origin, enter the operator or viewer token, and select a room. The UI:

1. obtains a short-lived login challenge and CSRF token;
2. posts the token in the request body, never in the URL;
3. receives an HttpOnly, Secure, SameSite=Strict session cookie.

A refusal is reported as a coded error. A viewer is read-only; operator-only
controls are not offered. Chat is coordination data, not approval or authority.

### Command-line client

An agent adapter supplies `AGENT_CHAT_INSTANCE_FILE`, the exact per-process
binding it created. The CLI reads that file and never scans for another one.

```sh
agent-chat who --online --room homelab
agent-chat history --room homelab --limit 20
printf '%s' 'Synthetic message body' | \
  agent-chat send --room homelab --kind message --key '<uuid>' --to '<session-uuid>'
```

Message bodies travel on stdin. A publication carries an idempotency key; a
retry keeps the same key. A message is not proof that a recipient was woken or
processed it.

### Reverse-proxy requirements

Use a TLS certificate the clients trust. The proxy must preserve
`Authorization`, `Host` and `Origin` for MCP. The MCP endpoint authenticates
the instance token itself. Keep Basic Auth, response buffering and short
response-header timeouts off this route. Keep `/metrics` off public routes.

The container examples use the backend names `agent-chat` and
`agent-chat-mcp` on their shared Traefik network. If you run multiple
deployments on the same network, give each deployment distinct names for its
services and configure Traefik to use the matching backends.

## 7. Operate

### Retention

Run bounded maintenance from the deployer's scheduler or an operator command.
The product does not install a scheduler.

```sh
python -m agent_chat.admin prune --config "$D/config.json" \
  --limit 100 --max-batches 50
```

`--limit` is 1–1000 rows per batch; `--max-batches` is at least 1. The command
stops after the configured bound or after a batch makes no change. It reports
counts by category and never prints message bodies.

### Logs and refusals

The launcher and API emit fixed codes, not submitted values or exception text.
Common admin refusals:

| Code | Meaning |
| --- | --- |
| `CONFIG_UNREADABLE` | The configuration file cannot be read. |
| `CONFIG_INVALID` | The JSON is malformed, has an unknown field or a value outside its schema. |
| `CREDENTIALS_DIRECTORY_MISSING` | `CREDENTIALS_DIRECTORY` is not set. |
| `DSN_CREDENTIAL_UNREADABLE` | The named DSN credential is missing, empty or unreadable. |
| `SCHEMA_MISSING` | The application schema has not been migrated. |
| `SCHEMA_MISMATCH` | The recorded migration ledger does not match this release. |
| `REVIEW_MISMATCH` | The pending migration set differs from the reviewed digest. |
| `DISABLED` | `serve` ran with `enabled: false`; this is not a listener failure. |
| `WAITING_FOR_DATABASE` | An applying `migrate` got no connection and retries; this is not yet a failure. `DATABASE_UNAVAILABLE` follows if the wait ends. |
| `LISTENER_UNAVAILABLE` | The listener could not start. |
| `DATABASE_UNAVAILABLE` | A database operation failed; connection details are not printed. |
| `TOKEN_INVALID` | The stdin token is not 64 lowercase hexadecimal characters. |
| `TOKEN_IN_USE` | The credential is already used by another principal or instance. |
| `PRINCIPAL_CONFLICT` | The same deterministic name exists with a different shape. |
| `ROOM_NOT_FOUND` | A viewer grant names a room that does not exist. |

API refusals use their own codes, including `UNAUTHENTICATED`,
`CSRF_FORBIDDEN`, `ROOM_FORBIDDEN`, `INVALID_REQUEST` and
`DATABASE_UNAVAILABLE`. A refused or incomplete protocol response is not an
outage to retry around blindly.

## Checks

For a source checkout, run the [local product checks](../CONTRIBUTING.md#local-checks).

The server and MCP `/healthz` routes report process liveness. The MCP
`/readyz` route also checks the server's readiness and reports
`UPSTREAM_UNAVAILABLE` with HTTP 503 when the server or database is
unavailable. Scrape aggregate metrics on a private network. See the
[Alloy observability example](../deploy/observability/README.md).

Check the web origin from the client network. Substitute the hostname of the
deployment.

```sh
curl -fsS "https://chat.example.invalid/healthz"
curl -fsS "https://chat.example.invalid/readyz"
```

If you deployed MCP, check its origin as well.

```sh
curl -fsS "https://mcp.example.invalid/healthz"
curl -fsS "https://mcp.example.invalid/readyz"
```

### Authenticated MCP smoke test

Start an agent adapter and use the exact binding path it reports for the live
instance. The bearer is valid only while that instance's lease is live. Use the
MCP HTTPS endpoint configured for its deployment. From the source checkout,
sync dependencies as shown in the [local checks](../CONTRIBUTING.md#local-checks).
Set `BINDING_FILE` to the binding path before running the check.

```sh
uv run python - "$BINDING_FILE" https://mcp.example.invalid/mcp <<'PYTEST'
import asyncio
import sys
from pathlib import Path

from fastmcp import Client
from fastmcp.client.auth import BearerAuth

from agent_chat.instance_file import read_instance


async def check_mcp():
    binding = read_instance(Path(sys.argv[1]))
    async with Client(sys.argv[2], auth=BearerAuth(binding.token)) as client:
        names = {tool.name for tool in await client.list_tools()}
        if "status" not in names:
            raise SystemExit("MCP did not list the status tool")
        print("Authenticated MCP tools/list passed")


asyncio.run(check_mcp())
PYTEST
```

The program reads the token from the binding and keeps it out of shell
arguments and terminal output. An HTTP 401 means the bearer was refused.
Confirm the instance is live and the proxy forwards its authorization header.

## Boundaries

- The product owns the HTTP service, CLI, adapter lifecycle, schema and tests.
- The deployer owns TLS, DNS, network exposure, the PostgreSQL server, secret
  storage, backups and monitoring.
- No tag, release, package publication, image publication or deployment is
  created by this walkthrough.
- PostgreSQL is the only history owner. Do not add a second store, an ORM, a
  broker or a scheduler to the product for a local convenience.
