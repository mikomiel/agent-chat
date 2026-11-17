# Design

## Context

Release 0.7.0 (package `sessionyard`, source ref `ba8ca34` on `main`) is one FastAPI service over one PostgreSQL database with ordered SQL migrations, a CLI client, an adapter core that manages one per-process instance, and a browser UI. `openspec/specs/` is empty, so behavior is described only by code, tests and prose documentation.

This change ports that behavior into four capability specs without touching code. The code at the source ref is the source of truth. The specs were written by reading the modules, the browser assets and the tests, and every requirement states behavior that the code at that ref implements. Evidence in this change is source evidence: code, tests and documents at that ref, plus the few throwaway probes listed under "Evidence gaps". See that section for what none of it shows.

## Goals / Non-Goals

Goals:

- Make this repository the written owner of service, coordination, client and browser behavior.
- State only what a caller, a CLI user, a browser user or an operator reading the service log can observe, including stable error codes.
- State refusals and recovery next to the happy path, so a later change can be reviewed as a delta.

Non-Goals:

- Changing behavior, code, tests, migrations, the static API contract or existing documents.
- Describing deployment, TLS, credential provisioning, backups, placement or any operator runbook.
- Describing what a harness does with a delivered message, or any specific integration package.
- Claiming anything about a running deployment.

## Decisions

### Rewrite from the code, do not copy prose

The content of each requirement was decided by the code and its tests as read at the source ref: a topic that the code did not confirm was dropped or is listed below as unspecified, and some behavior that the code implements without such a topic was added.

Alternatives considered:

- Copy the prose in `docs/` into the specs: rejected. Part of it is deployment guidance, and where it disagrees with the code the code wins.
- Generate the specs from `docs/openapi.json`: rejected. The static contract covers only bearer operations. It says nothing about refusal semantics, the CLI, the adapter or the browser.
- Write one spec per source module: rejected. It would tie the specs to the module layout instead of to observable behavior.

### The code wins over prose

When this repository's own prose disagrees with the code, the specs follow the code and the disagreement is listed under "Evidence gaps". A prose fix is a separate change.

### Four capabilities, split by who observes the behavior

- `chat-service`: the contract every client relies on.
- `coordination`: the shared coordination model that messages, threads, lanes, work declarations, room state and role marks form.
- `chat-clients`: the CLI and the adapter core.
- `web-ui`: the browser surface.

Alternatives considered: one capability (rejected: nearly seventy requirements in one file cannot be reviewed or evolved independently) and one capability per module (rejected as above). Each capability can now change by its own delta.

### Specify observable behavior, not internals

Requirements name HTTP status codes, error codes, limits and visible effects. They do not name tables, lock order, SQL or function names. The error codes are included because `docs/api.md` presents them as the stable contract.

### Fewer requirements, with the rest listed as unspecified

The following behavior ships in 0.7.0 and is not specified here. Each item needs its own review, and none is needed to describe the core contract. Absence from the specs does not mean absence from the product.

- Wake limits, reservations, delivery back-off, attempt exhaustion and the claim guards (the `WAKE_LIMIT`, `CONSULTATION_LIMIT`, `DELIVERY_BACKOFF`, `DELIVERY_EXHAUSTED`, `DELIVERY_BLOCKED`, `DELIVERY_IN_FLIGHT`, `DELIVERY_BATCH_CONFLICT` and `DELIVERY_CLOSED` family). `chat-service` names `DELIVERY_BLOCKED` and `DELIVERY_IN_FLIGHT` only to state that they take precedence over `DELIVERY_INELIGIBLE`.
- Per-principal quotas (`INSTANCE_LIMIT`, `REGISTRATION_LIMIT`, `PUBLICATION_LIMIT`) and the limits and loop detector of a direct thread. `coordination` specifies only that `status` and the coordination kinds do not count toward the reply limit.
- The administration CLI, including principal management, migration and prune commands.
- The `/metrics` endpoint and its series.
- The worker protocol that integration packages use for poll, claim and settle.
- The MCP server and the shipped skills.
- The one-shot browser inspection tooling.
- One shipped producer name that has a narrower fixed key namespace and an observation schema that the browser renders specially, and the CLI `produce` command that runs it with a producer credential file instead of an instance binding. All three are left unspecified.

### Delivery is specified on the server side only

The specs cover claim, result, acknowledgement, expiry after 24 hours and sender receipts. They do not cover what a harness does at its native boundary, how a harness holds delivery while a session is muted or in Plan Mode, or how an integration package wakes a session. Those behaviors belong to the integration packages.

## Failure behavior

These rules describe the code at the source ref. No deployment was observed.

- Refusals use one envelope `{"error":{"code":C,"message":C}}`. A database failure answers 503 `DATABASE_UNAVAILABLE`, an unexpected failure 500 `INTERNAL_ERROR`, and a code without an assigned status 503. Responses carry no message body, token or connection string. A handled refusal is logged with only its code, route, status and exception class. The server also logs the traceback of an unexpected failure, which is outside that fixed-field line.
- A keyed write whose outcome is unknown is recovered by repeating the same request with the same idempotency key. The CLI reports a POST that has no answer as `REQUEST_UNCERTAIN` with exit code 4, the adapter rejoins on it, and the browser never retries a write by itself.
- Readiness is separate from health. `/readyz` refuses with `SCHEMA_MISMATCH` until the recorded migration versions are exactly 1 through the shipped count, and it does not compare digests. It answers `DATABASE_UNAVAILABLE` when the application tables are missing. Only the migrate operation compares digests. Serving never runs migrations.
- Access that cannot be confirmed fails closed. The browser treats an unknown access kind as an invalid session, locks on HTTP 401 or 403, and drops loaded content after a refusal that could mask a lost scope. The service refuses a foreign origin before routing.
- Revocation, lease expiry and message retention take effect when a request reads the data, without waiting for a scheduled prune.

## Credential boundaries

- Each credential has one purpose. An operator credential signs in to the browser and reaches the operator routes. A viewer credential signs in to the browser only. An agent credential registers sessions only. An instance token is created per process at registration and reaches only instance routes. A producer credential writes room state only.
- A credential is a 64-character lowercase hexadecimal token. The service stores only its SHA-256 digest. A browser session value is a separate random value of the same form and is also stored as a digest.
- The instance token is the one secret a client keeps. The adapter writes it to a binding file with mode 0600 in a directory with mode 0700 before it sends the digest, and the CLI refuses a file that is a symlink, has several links or has the wrong mode or owner.
- The specs contain no credential and no address. Examples use synthetic names such as `node-a` and `acme/widgets`.
- Provisioning, delivery and rotation of credentials, and the value of the public origin, are operator-owned and not specified.

## Left to deployments

These are outside the product source and outside the specs: process placement, supervision, restart and confinement; TLS termination and ingress; the choice of the public origin; credential creation, distribution and rotation; database creation, roles and network admission; backups and restore; scheduling of prune and migration runs; log collection and metrics scraping; upgrade order and rollback of a deployment; enabling and packaging of integrations on a host.

## Evidence gaps

- The test suite was not run by this change (`NOT RUN`). The tests are source evidence that the behavior was intended and checked at the source ref. They are not evidence that any deployment behaves that way. The browser tests in `tests/agent_chat/test_ui.py` drive real Chromium against an isolated HTTPS server and a private PostgreSQL, and are also source evidence only.
- No running service, browser or deployment was observed, apart from the throwaway probes described below. Browser behavior was derived from `chat.js`, `i18n.js`, `index.html` and the test names, not seen in a running browser.
- `integrations/README.md` states that the Pi and DeepSeek Harness packages are available in source with contract tests against a harness double. It records the live verification of the Pi package as pending and that of the DeepSeek Harness package as `NOT RUN`. The Claude Code and Codex integrations are planned. No spec describes live behavior of any package.
- The harness set differs between sources. The code (`agent_chat/admin.py`, `agent_chat/instance_client.py`) and `docs/self-hosting.md` accept `pi`, `claude`, `codex`, `deepseek` and `opencode`. `integrations/README.md` lists packages only for two of them and says OpenCode is outside the initial admission set. `chat-clients` follows the code. Reconciling the prose is a separate change.
- The CLI help for `--to` names five role selectors (`pm`, `forgejo-pm`, `github-pm`, `delivery-manager` and `dm`). The code also accepts `forgejo_pm`, `github_pm` and `delivery_manager`. `chat-clients` follows the code. Updating the help text is a separate change.
- Behavior under load, resource limits and failure injection beyond the existing tests is unknown.
- Receipts that depend on the harness side, such as holds while a session is muted, and delivery at the native boundary, are not observed here.
- A few statements rest on throwaway probes that are not repository tests. They ran against the source at that ref, with no database and no deployed service. With the CLI's alarm lowered, a request that stalled surfaced as `REQUEST_UNCERTAIN` for a POST and as `TRANSPORT_UNAVAILABLE` for a GET, and a silent peer produced the same codes after the 3-second step timeout. A minimal uvicorn application, not this service, run under the service's own log configuration (`LOG_CONFIG` in `agent_chat/admin.py`), showed that a registered handler for unexpected exceptions still leaves a traceback with the exception text on the server's error log while the response stays clean. `create_app`, driven through an in-process test client, answered 404 with the standard envelope for `/docs`, `/redoc` and `/openapi.json`. Building the publication model showed that a recipient list counts its entries before duplicates are dropped.
- The 20-second CLI alarm during a request: `chat-clients` follows the code, which reports a stall as `REQUEST_UNCERTAIN` or `TRANSPORT_UNAVAILABLE`, not as `CLI_INTERRUPTED`. No repository test exercises the alarm during a request. See "Open Questions".
- No repository test was found for the roster scan limit (`PARTICIPANT_SCAN_LIMIT`), a binding file with several links or the wrong owner, the browser's allowlist of refusal texts, the growth of the live-stream retry delay from 1 to 10 seconds, or an initial join that retries and counts against the rejoin bound. Those statements rest on reading the code.
- Concurrency and lock-order statements (publications under one entity key, role changes, event order, lease rechecks after lock waits) were judged from the locking code and the existing tests, not observed under load. The 48-hour role lapse and the 24-hour `messages_24h` window were checked in SQL and not by advancing a clock.
- A producer is revoked through the administration CLI, which is unspecified. Only the effect of revocation on authentication and on the state read is specified and was checked.
- `docs/api.md`, `docs/openapi.json`, the other pages under `docs/`, `integrations/` (beyond the harness sets above) and `chat.css` were not compared line by line with the specs. The `web-ui` statements about collapsed panels and hidden controls rest on `chat.js` and the browser tests.
- The specs state no number for the event stream lifetime. The code default is 60 seconds and the serve path passes no override.

## Risks / Trade-offs

- Drift: code can change after this ref. Mitigation: later behavior changes are proposed as deltas against these specs, and a reviewer compares each requirement with the code at the head under review. This change adds no automatic link between a requirement and a test.
- Over-specification of the UI: the specs describe behavior, not Polish copy. A wording change needs no spec change, and a behavior change does.
- The login throttle counts failures service-wide, not per client. A burst of failed sign-ins therefore delays every sign-in for up to a minute. This is shipped behavior and is specified as it is, not endorsed as the final design.
- Unspecified behavior can be mistaken for unsupported behavior. Mitigation: the list under "Fewer requirements, with the rest listed as unspecified".

## Migration Plan

None at runtime. After review and merge, archive the change so that the four specs move to `openspec/specs/`. To roll back, remove the change directory, or revert the commit before archive. No deployed system depends on these files.

## Open Questions

- Should the producer-specific key namespace and the browser's rendering of its observation schema get a capability of their own, or stay internal?
- Should the harness lists in `docs/self-hosting.md` and `integrations/README.md` be reconciled with the code, and which list is authoritative?
- Should a later change add a traceability check that links each requirement to a test?
- Should the CLI report an alarm that fires during a request as `CLI_INTERRUPTED`, or is `REQUEST_UNCERTAIN` for a POST and `TRANSPORT_UNAVAILABLE` for other requests the intended contract? `chat-clients` records the current behavior.
- Should every dynamic browser message get an English entry? Today a message without one appears in Polish while English is selected, and `web-ui` records that.
- Should `/readyz` compare migration digests as the migrate operation does? Today it checks only the recorded versions, and `chat-service` records that.
