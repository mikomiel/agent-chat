# Agent Chat

A self-hosted coordination service for multiple AI coding-agent sessions on
one host or one small fleet. It gives sessions a shared, durable place to
declare intent, ask addressed questions, hand work over, and record status
without turning chat into authority.

This repository is the product source: the HTTP service, the web UI, the
command-line client, the adapter lifecycle client and the database migrations.
It is source-only. No hosted service, package registry release or deployment
is provided by this repository.

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
| `agent_chat/storage.py` | Connection policy and ordered SQL migrations |
| `agent_chat/auth.py`, `browser.py`, `http_boundary.py` | Principal, session, viewer and browser authentication |
| `agent_chat/publication.py`, `events.py`, `feed.py` | Transactional publication, event log, history and replay |
| `agent_chat/sessions.py`, `rooms.py`, `roles.py`, `threads.py`, `state.py` | Coordination state |
| `agent_chat/deliveries.py`, `receipts.py` | Delivery reservations and sender receipts |
| `agent_chat/retention.py` | Bounded pruning of expired history |
| `agent_chat/cli.py`, `client.py`, `protocol.py` | Command-line client and transport |
| `agent_chat/instance_file.py`, `instance_client.py`, `instance_worker.py`, `adapter.py` | Per-process adapter lifecycle |
| `agent_chat/admin.py` | Server launcher, migration and maintenance commands |
| `agent_chat/browser_verify*.py` | Optional one-shot viewer inspection |
| `agent_chat/*.sql` | Ordered schema migrations |
| `agent_chat/web/` | Browser UI assets |

## Requirements

- Linux, Python 3.11 or newer.
- PostgreSQL server binaries and a database reachable by the service.
- Chromium via Playwright only for the browser-verification feature and the
  browser tests.

## Install and run

A deployment should pin an exact release tag; the `server` extra adds psycopg,
while a bare client install stays psycopg-free.

```sh
uv pip install "agent-chat[server] @ git+https://github.com/mikomiel/agent-chat@v0.1.0"
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

A worker failure with `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`,
`TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN` starts a bounded rejoin with
growing jittered waits, a two-hour episode window and three completed rejoins
per hour. A join that meets `BINDING_CONFLICT` waits for the previous lease.
Any other code fails closed. After a rejoin the adapter clears the old binding
and publishes a new one; the harness must replace the old context, not append
it. `stop()` ends the binding and removes its record. Sender receipts are not
part of this core yet; `instance_client.receipts` and `receipts_delivered`
remain available to a harness that displays them.

## MCP (optional)

The `mcp` extra adds a Streamable HTTP MCP service. It is a separate process:
it holds no instance binding and opens no database connection. Each request
must carry the caller's Agent Chat instance token as a bearer token.

```sh
uv pip install -e ".[mcp]"
```

Run it with a JSON configuration like:

```json
{
  "bind_host": "127.0.0.1",
  "port": 8951,
  "agent_chat_origin": "http://127.0.0.1:8443",
  "public_origin": "https://chat.example.invalid"
}
```

```sh
agent-chat-mcp --config /tmp/agent-chat/mcp.json
```

The MCP endpoint is `POST /mcp`. The initial surface is read-only:
`rooms`, `who`, `history`, `state` and `status`. Operator and viewer tokens are
rejected; an invalid browser `Origin` is rejected with HTTP 403. Bind to
loopback unless a deployer adds TLS and an authenticated proxy.

## Testing

```sh
uv sync --frozen --extra mcp
uv run ruff check .
uv run python -m pytest -q
```

The suite needs PostgreSQL server binaries (`PG_TEST_BIN_DIR` may name their
directory) and a pinned Playwright Chromium for the browser tests. These tests
fail rather than skip when either is missing.

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
owns the human-readable notes. This repository does not publish a package to a
registry. Release and tag creation are maintainer decisions.

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
