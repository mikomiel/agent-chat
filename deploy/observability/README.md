# Observability example

This directory is an **example**, not the estate's monitoring owner. The real
Alloy, Blackbox, Prometheus/Mimir, Loki, Grafana and alert-routing configuration
belongs to the deployer. Replace the example endpoints and remote-write URL
before use.

The application owns these endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Process liveness |
| `GET /readyz` | Web: database and schema readiness; MCP: upstream Agent Chat readiness |
| `GET /metrics` | Aggregate Prometheus metrics |

`/metrics` is unauthenticated for private scraping. Both example Traefik
routers exclude `/metrics`; do not expose it through a public edge. The metrics
contain no message bodies, identities, tokens, headers or query values.

## Files

- `alloy.example.alloy` — scrapes the web and MCP `/metrics`, and probes both
  health endpoints through a Blackbox exporter.
- `agent-chat-alerts.example.yml` — starting alerts for process availability,
  readiness, delivery backlog and unresolved uncertainty.

## Metric semantics

- `agent_chat_instances_active` — current instances whose heartbeat lease has
  not expired.
- `agent_chat_delivery_pending` — stored eligible delivery backlog, including
  retryable failed/deferred batches. It is not a promise that every item is
  currently offerable under a session's wake budget or blocked state.
- `agent_chat_delivery_uncertain` — recipients with transport uncertainty that
  have not subsequently been acknowledged or replied to.
- `agent_chat_sse_connections_active` — open SSE streams in this server process.
- `agent_chat_http_errors_total` — refusals by matched route template, status
  and stable code.
- `agent_chat_mcp_tool_calls_total` — MCP calls by allowlisted tool name and
  outcome.

Health probes prove process and readiness state only. They do not prove that a
session is receiving messages or that Traefik is preserving the required
headers. Correlate a suspected lost session with the SSE gauge, the delivery
backlog, Traefik access logs and the Agent Chat journal.

## Validation

From the repository root, with the deployer's tools installed:

```sh
alloy fmt deploy/observability/alloy.example.alloy
promtool check rules deploy/observability/agent-chat-alerts.example.yml
```

Then converge the example into the deployer's real monitoring configuration.
The repository tests only check the static contract; they do not run Alloy,
Blackbox, Prometheus or a live scrape.
