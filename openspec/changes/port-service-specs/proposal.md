# Proposal

## Why

Release 0.7.0 ships a service, a command-line client, an adapter core and a browser UI, and pull request #99 has since added roster navigation and the client arguments that read history backwards from its newest page, but `openspec/specs/` is empty (issue #6). The only description of what the product promises is its code, its tests and prose documentation. This repository owns that behavior, so the written, testable description belongs here, where a later behavior change can be proposed as a delta against it.

## What Changes

- Add four capability specifications as ADDED requirements. Each requirement describes behavior that the code at release 0.7.0 (source ref `ba8ca34`) or at `ce19844`, the merge of pull request #99, implements, with its stable error codes and with refusal and recovery scenarios as well as the happy path.
- Write `design.md` to record what is deliberately left unspecified, what is left to deployments, the failure and credential rules the specs rely on, and the evidence gaps.
- Change no code, test, migration, API contract, dependency, workflow or existing document.

## Capabilities

### New Capabilities

- `chat-service`: the HTTP service's identity and credential rules, sessions and presence, durable publication, ordered replay, backward history paging and retention, delivery evidence, sender receipts, failure envelope, readiness and schema evolution.
- `coordination`: message kinds, threads and thread keys, the advisory session lane and work declaration, room state written by producers, operator-set role marks, and the participants read with its activity order, filters and field projection.
- `chat-clients`: the CLI's binding and body rules, recipient and role resolution, one-step reply and acknowledgement, the history and roster options of the CLI with the matching `history` and `who` arguments of the MCP tools, and the adapter's join, heartbeat and bounded rejoin lifecycle.
- `web-ui`: browser sign-in and session boundary, the read-only viewer, inert rendering, opt-in live events, operator writes and their uncertainty handling, and the room, sessions and state views.

### Modified Capabilities

None. The main `openspec/specs/` directory holds no capability yet.

## Impact

- Files: only `openspec/changes/port-service-specs/`. Archiving the change writes `openspec/specs/<capability>/spec.md` for the four capabilities.
- Runtime, API, schema and dependencies: none. No package version, release or migration changes.
- Operators: nothing to approve and nothing to deploy. Deployment, TLS, credentials and backups stay operator-owned.

## Non-goals

- No behavior change. Where this repository's own prose and the code disagree, the specs follow the code, and `design.md` records the disagreement for a separate follow-up.
- No deployment, credential, TLS, backup, placement or runbook content, and no description of how an operator admits callers.
- No specification of the packages under `integrations/` or of what a harness does with a delivered message.
- No specification of the MCP server beyond the arguments of its `history` and `who` tools.
- No claim about any running deployment. Source availability is not runtime evidence.
- No new tests, no change to existing tests, and no test run.
