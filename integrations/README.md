# Harness integrations

Turnkey integrations ship from this repository, next to the service and the
adapter core. A package uses only its harness's public extension surface and
the product's worker protocol; the Python core stays authoritative for join,
heartbeat, poll, claim, settle, rejoin and binding replacement. A package
supplies native eligibility, delivery, binding context and wake behavior.

## Packages

| Harness | Package | State |
|---|---|---|
| Pi | [`pi/`](pi/) | Available in source; contract tests pass against a harness double |
| DeepSeek Harness | [`deepseek/`](deepseek/) | Available in source; contract tests pass against a harness double |
| Claude Code | — | Planned; needs a receiver/notifier built on the core |
| Codex | — | Planned; follows the same pattern |

OpenCode and Vibe are outside the initial admission set.

## Compatibility

A package records the harness releases it was exercised against. The matrix is
evidence, not a promise: a release that was never run is `NOT RUN`, never
implied by a nearby version.

| Package | Harness surface | Verified release | Evidence |
|---|---|---|---|
| `pi` 0.1.0 | extension factory, `session_start`, `input`, `agent_start`, `agent_settled`, `ui_prompt_*`, `session_info_changed`, `before_agent_start`, `session_shutdown`, `message_start`, `sendMessage`, `registerCommand` | none yet | `node --test` with a harness double; live Pi verification pending |
| `agent-chat-deepseek` 0.1.0 | DSH extension/Cordis surface: `ctx.inject`, `agent/created`, `agent/disposed`, `agent/pre-step`, `agent/inbox/inserted`/`claimed`/`discarded`, `agent/status`, `session/event` `turn/end`, `agent.steer`, `agent.inbox.remove`, `sessionTitle`, `sessionProjections` plan unit, `webServer` | none yet (target `0.2.2-rc.1`) | `node --test` with harness doubles; the API vocabulary was read from the installed `0.2.2-rc.1` type declarations; live DSH verification NOT RUN |

Adding a row for a live release needs a recorded run against that exact
release, including the install command and the observed join, delivery and
rejoin behavior. Update this table in the same change.

## Rules

- Public extension APIs and the product's worker protocol only. No private CI,
  host path or internal runbook.
- A package never publishes, merges, deploys or grants authority. A peer
  message is coordination data.
- Synthetic fixtures only. The repository's `public-content` check scans the
  commit range and its messages.
- A package keeps its credential route explicit: a private `0600` config file
  named by an environment variable, never a command-line argument.
- The Python core stays the owner of lifecycle policy. Where a package must
  mirror a core constant for a non-Python process, a test pins the copy to
  `agent_chat/models.py`.

## Test

```sh
cd integrations/pi
node --test
```

```sh
cd integrations/deepseek
node --test
```
