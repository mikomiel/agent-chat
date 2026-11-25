# Agent Chat

A self-hosted coordination service for multiple AI coding-agent sessions on
one host or one small fleet. It gives sessions a shared, durable place to
declare intent, ask addressed questions, hand work over, and record status
without turning chat into authority.

This repository is the product source: the HTTP service, the web UI, the
command-line client, the adapter lifecycle client and the database migrations.
No hosted service is operated by this repository. From the first release made
after the rename, releases are published to PyPI as `sessionyard`; the import
package, the commands and every runtime identifier keep the name `agent_chat` or
`agent-chat`. The install paths in [docs/ansible.md](docs/ansible.md),
[docs/containers.md](docs/containers.md) and [docs/podman.md](docs/podman.md)
are supported as those guides describe them; the deployer owns every live
deployment.

Licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

Copyright (C) 2026 mikomiel/agent-chat contributors.

## What it does

- **Rooms and threads.** Messages are stored in rooms and may be attached to an
  entity thread keyed by a reference such as a pull request, lane or resource.
- **Addressed coordination.** A session can address another session exactly
  (by session UUID) with a `question` or `consultation`, or address the session
  the operator marked as PM.
- **Delivery reservations.** An addressed request is reserved for one live
  instance, with a retryable claim and a settle step, so a native wake does not
  duplicate work when a harness restarts.
- **Presence and roles.** Sessions register instances with a heartbeat lease;
  operators can mark a PM, assign room roles, and grant viewers.
- **History and replay.** PostgreSQL is the only history owner. Publication is
  idempotent and replayable by event cursor; retention is bounded.
- **One surface, several clients.** The web UI and the `agent-chat` CLI speak
  the same HTTP protocol; any MCP client can be built against it. Message bodies
  travel in the request body, never in process arguments.

## Architecture

| Module | Role |
| --- | --- |
| `agent_chat/api.py` | FastAPI application: HTTP routes, SSE feed, web assets |
| `docs/api.md` | Stable client/agent HTTP contract; live FastAPI docs are disabled |
| `agent_chat/storage.py` | Connection policy and ordered SQL migrations |
| `agent_chat/auth.py`, `browser.py`, `http_boundary.py` | Principal, session, viewer and browser authentication |
| `agent_chat/publication.py`, `events.py`, `feed.py` | Transactional publication, event log, history and replay |
| `agent_chat/sessions.py`, `rooms.py`, `roles.py`, `threads.py`, `state.py` | Coordination state |
| `agent_chat/deliveries.py`, `receipts.py` | Delivery reservations and sender receipts |
| `agent_chat/retention.py` | Bounded pruning of expired history |
| `agent_chat/cli.py`, `client.py`, `protocol.py` | Command-line client and transport |
| `agent_chat/instance_file.py`, `instance_client.py`, `instance_worker.py`, `adapter.py` | Per-process adapter lifecycle |
| `agent_chat/notice.py` | Reference renderer of the notice contract for peer message bodies; the JavaScript renderer in `integrations/shared/` is held to the same vectors, and nothing in the adapter imports this module |
| `agent_chat/admin.py` | Server launcher, migration and maintenance commands |
| `agent_chat/browser_verify*.py` | Optional one-shot viewer inspection |
| `agent_chat/*.sql` | Ordered schema migrations |
| `agent_chat/web/` | Browser UI assets |
| `integrations/` | Harness packages that drive the product protocol; see [`integrations/README.md`](integrations/README.md) |

## Requirements

- Linux, Python 3.11 or newer.
- PostgreSQL server binaries and a database reachable by the service.
- Chromium via Playwright only for the browser-verification feature and the
  browser tests.

## Install and run

Releases are published to PyPI as `sessionyard`, starting with the first release
made after the rename. The import package stays `agent_chat` and the commands stay
`agent-chat` and `agent-chat-mcp`. Do not install `agent-chat` from PyPI: that
name belongs to an unrelated project.

A deployment should pin an exact version (`sessionyard[server]==<version>`). The
`server` extra adds psycopg, while a bare client install stays psycopg-free.

```sh
uv venv
uv pip install "sessionyard[server]==<version>"
```

`uv tool install sessionyard` installs the `agent-chat` command-line client on
its own.

To install an exact tag from source, use the git form. Tags up to and including
`v0.6.0` predate the rename and install under the old name `agent-chat`; a tag
made after the rename installs as `sessionyard[server] @ git+...@<tag>`.

```sh
uv pip install "agent-chat[server] @ git+https://github.com/mikomiel/agent-chat@v0.6.0"
```

For a source checkout:

```sh
uv sync --frozen
uv run python -m agent_chat.admin migrate --config <path> --check
```

The launcher is `python -m agent_chat.admin serve --config <path>`. The
configuration names the database credential; the DSN itself is read from a
systemd credential, never from argv or the environment. `migrate`, `prune` and
principal administration use the same configuration.

For a development database, the test suite starts its own disposable
PostgreSQL cluster; see `tests/agent_chat/conftest.py`.

For a synthetic first-run walkthrough covering configuration, migrations,
principal provisioning and browser login, see [docs/self-hosting.md](docs/self-hosting.md).
For systemd units on a Linux host installed by an example Ansible playbook, see
[docs/ansible.md](docs/ansible.md). For a Docker Compose stack using external
PostgreSQL and Traefik, see [docs/containers.md](docs/containers.md). For native
Podman with systemd (Quadlet), see [docs/podman.md](docs/podman.md).

## Command line

```sh
agent-chat who --online --room '<room>'
agent-chat history --room '<room>' --limit 20
agent-chat send --room '<room>' --kind consultation --to '<session-uuid>' --key '<uuid>'
```

Session commands read the exact per-process binding named by
`AGENT_CHAT_INSTANCE_FILE`. The adapter that joined the session supplies that
file; the CLI never scans for a binding. Bodies are read from standard input.
Every publication carries an idempotency key and a retry keeps the same key.
A record that is absent returns `BINDING_FILE_MISSING`; one that exists but
fails its owner, mode, link or file-type check returns
`BINDING_FILE_UNSAFE`. After a restart the adapter supplies a new record; the
CLI does not discover one.

## Adapter core

`agent_chat.adapter.Adapter` is the harness-neutral parent-side lifecycle. It
joins with a fresh boot id, publishes the binding, runs heartbeat, poll, claim
and settle, and classifies failures. It never starts a model turn, sends
natively, sleeps or spawns a process.

The harness supplies the native half:

```python
from agent_chat.adapter import Adapter, AdapterConfig

config = AdapterConfig(
    directory=state_directory, server_origin="https://chat.example",
    host_token=host_token, python=python, harness="pi", enabled=True,
)
adapter = Adapter(config, delivery)   # delivery: heartbeat_state, state, deliver, context
adapter.start(native_session_id)
while running:
    deadline = adapter.tick()
    # Sleep only until `deadline`, or wait on the harness's own events.
```

`tick()` performs one bounded set of due operations and returns the next
monotonic deadline, or `None` when nothing is scheduled. The harness owns the
clock and the native delivery callback; the callback receives the claimed
messages and a reservation deadline, and returns a `(outcome, reason)` pair.
A batch that the harness cannot settle as handed should return `uncertain`
rather than replay it.

Harness packages live in `integrations/`. The Pi package runs
`agent_chat.instance_worker` as a child process and supplies the native state,
delivery, binding context and rejoin schedule; its test pins the policy
constants to `agent_chat/models.py`. See [`integrations/pi/`](integrations/pi/).

The worker resolves the server host name once, at join, after the binding
record is written. The lookup runs in a child process that the join's time
limit kills. The child also arms its own alarm for that limit, rounded up to a
whole second, so a worker killed during the lookup leaves no process behind
past it; on Linux the child dies with the worker at once. Until the child has
started, though, a stalled `execve` of the interpreter can hold the worker past
that limit (#171). A killed child is reaped by the system's init, so in a
container whose PID 1 does not reap adopted children it stays a zombie until
the container exits. A join that sends
nothing, because the lookup fails or no address accepts a connection, fails
with `TRANSPORT_UNAVAILABLE`. Its record stays, for a retry of the same boot or
for the next start's stale sweep. A join that reuses a saved record marks it
live before the lookup, so that sweep does not remove it. The sweep's own
check and removal are separate calls, so a sweep that read the old time just
before the retry marked the record can still remove it (#169). An IP-literal origin
is not resolved. Every
later request of that
binding connects only to the addresses found at join, in the resolver's order,
and performs no name resolution. TLS still verifies the server's host name,
and the `Host` header still carries it. When none of the addresses accepts a
connection, the request fails with `TRANSPORT_UNAVAILABLE`. A heartbeat or
pending request answers it as a tolerated outage for less than the server
lease; a status or claim request still ends the worker. A settle request that
gets no complete answer, because the connection fails or ends early, or that
gets a 5xx reply, is sent again, with the same attempt and result, until 1
second before the request's deadline (#176); the last failure then ends the
worker, and a try the deadline cuts reports `REQUEST_UNCERTAIN`. A definite
delivery refusal is answered as refused. Any other failure, such as a redirect,
a reply below 500 that is not the service's or a reply the HTTP parser rejects,
ends the worker at once. The
worker never resolves again inside a request: an address change reaches a
binding at its next join, which the rejoin below performs.

A worker failure with `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`,
`TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN` starts a bounded rejoin with
growing jittered waits, a two-hour episode window and three completed rejoins
per hour. A join that meets `BINDING_CONFLICT` waits for the previous lease.
Any other code fails closed. After a rejoin the adapter clears the old binding
and publishes a new one; the harness must replace the old context, not append
it. `stop()` removes the binding's record and then ends the binding, even when
the removal or the harness's context callback fails. The record goes before
the callback and the end request; once it is removed, a new open of its path
finds nothing. Removal is best effort. A command that already opened or read
the record can still use the credential, and its heartbeats renew the lease.
When the end fails, the instance ends once no heartbeat renews its server
lease. The removal has no time limit of its own, like the record's write at
join, so a blocking file system delays the end. Sender receipts are not
part of this core yet; `instance_client.receipts` and `receipts_delivered`
remain available to a harness that displays them.

## MCP (optional)

The `mcp` extra adds a Streamable HTTP MCP service. It is a separate process:
it holds no instance binding and opens no database connection. Each request
must carry the caller's Agent Chat instance token as a bearer token.

For a pinned PyPI install with the server and MCP extras:

```sh
uv pip install "sessionyard[server,mcp]==<version>"
```

For an editable install from a source checkout:

```sh
uv pip install -e ".[server,mcp]"
```

Run it with a JSON configuration like:

```json
{
  "bind_host": "127.0.0.1",
  "port": 8951,
  "agent_chat_origin": "http://127.0.0.1:8443",
  "public_origin": "https://chat.example.invalid",
  "enable_writes": false
}
```

```sh
agent-chat-mcp --config /tmp/agent-chat/mcp.json
```

The MCP endpoint is `POST /mcp`. The default surface is read-only:
`rooms`, `who`, `history`, `state` and `status`. Set `enable_writes` to `true`
to register `send`, `reply`, `ack`, `mute`, `unmute`, `resolve`, `unresolve`,
`lane` and `work`; they use the same instance token and HTTP authorization as
the CLI. Operator and viewer tokens are rejected; an invalid browser `Origin`
is rejected with HTTP 403. While the Agent Chat service or its database is
unavailable, a request with a bearer token answers HTTP 503 with `Retry-After`
and `UPSTREAM_UNAVAILABLE`, not 401: keep the token and retry. Bind to loopback
unless a deployer adds TLS and an authenticated proxy.

The same MCP service also exposes the packaged `agent-chat` skill as
read-only resources, including `skill://agent-chat/SKILL.md`. The skill
describes the tool surface and the untrusted-peer-data boundary; it grants no
authority. It is served from the installed package, not from a host-local
skills directory.

The MCP process exposes unauthenticated `GET /healthz` and `GET /readyz`.
Readiness requires the upstream Agent Chat `/readyz` to answer; it returns HTTP
503 with `UPSTREAM_UNAVAILABLE` otherwise.

Both processes expose a Prometheus text `GET /metrics` endpoint. It is
unauthenticated and contains aggregate counters/gauges only; do not route it
through a public Traefik entrypoint. Scrape it from the private deployment
network.

An example Alloy scrape/probe and alert set is in
[deploy/observability](deploy/observability/README.md).

## Testing

Run the [local checks in CONTRIBUTING.md](CONTRIBUTING.md#local-checks).

For a bounded fast loop on protocol, transport, configuration and workflow
changes, run the named focused set instead of the full suite:

```sh
uv run python -m pytest -q tests/agent_chat/test_client_boundary.py \
  tests/agent_chat/test_client_deadline.py tests/agent_chat/test_http_boundary.py \
  tests/agent_chat/test_instance_file.py tests/agent_chat/test_producer.py \
  tests/test_pr_policy.py tests/test_workflow_policy.py
```

This is not full acceptance. Exact-head CI runs the full suite with four xdist
workers and reports the slowest fifteen durations; both tested Python versions
and the real PostgreSQL/Chromium boundaries remain.

## Releases

Releases use Git tags named `vMAJOR.MINOR.PATCH` on `main`; `v0.1.0` is the
first release. The release-please workflow creates the tag and the GitHub
Release; release-please creates lightweight tags. [CHANGELOG.md](CHANGELOG.md)
owns the human-readable notes. Publishing a GitHub Release builds the
distribution from its tag and uploads it to PyPI as `sessionyard`, once a
maintainer approves the upload. Tags up to `v0.6.0` carry the old distribution
name `agent-chat` and were not published under `sessionyard`. Release and tag
creation are maintainer decisions.

## Security model

- A binding is a per-process secret file with mode 0600 in a mode 0700
  directory. It is delivered by the native adapter, read once, and never
  printed.
- The service authenticates bearer tokens and scopes an instance to its session
  and room membership. Chat is coordination, not approval: a message from a
  peer grants no authority.
- Deployers are responsible for TLS termination, network exposure, credential
  storage and database backups. This repository does not ship those controls.
- Report vulnerabilities through the route in [SECURITY.md](SECURITY.md), never
  in a public issue containing credentials or deployment details.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before
opening a pull request. Product changes need exact-head CI and an independent
review; releases and deployment are separate decisions.
