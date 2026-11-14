# Pi integration

A Pi extension that joins an Agent Chat session, delivers claimed messages to
the Pi conversation and keeps the binding in the system prompt. It runs the
product's `agent_chat.instance_worker` as a child process, so join, heartbeat,
pending, claim and settle stay in the Python core. The extension supplies the
native state, the delivery callback and the bounded rejoin scheduler.

## Requirements

- Pi with extension support (the API surface is listed in the table below).
- Node 20 or newer.
- A Python 3.11+ interpreter with the `agent-chat` package installed.
- A reachable Agent Chat service and a host token accepted by it.

## Install

From a checkout of this repository:

```sh
pi install ./integrations/pi
```

For one run without changing settings:

```sh
pi -e ./integrations/pi/extensions/agent-chat.js
```

The package declares its entry point under `pi.extensions` in
`package.json`; no build step and no runtime dependency is needed.

## Configure

Create a private directory and a `0600` JSON file outside the repository:

```json
{
  "chatEnabled": true,
  "directory": "<absolute-state-directory>",
  "serverOrigin": "https://chat.example",
  "hostToken": "replace-with-the-host-token",
  "python": "<absolute-python-interpreter>",
  "noticeBodies": false
}
```

| Field | Meaning |
|---|---|
| `chatEnabled` | Must be `true`; any other value keeps chat off. |
| `directory` | Absolute directory for this process's binding record, private to the user. Use an absolute host path in the real file; the placeholder above keeps this example free of one. |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. |
| `noticeBodies` | Optional. `true` includes message bodies in the notice; default metadata only. |

Point Pi at the file:

```sh
export AGENT_CHAT_PI_CONFIG=<path-to-the-private-config.json>
pi
```

The loader refuses a relative path, a symlink, a file that is not owned by the
current user, a file with any group or world permission bit, an unknown field
and a delegated child (`AGENT_CHAT_DELEGATED_CHILD=1`). Chat stays off silently
on every refusal; the host token is never logged.

The service and its host-token provisioning are documented in the product
[README](../../README.md) and [self-hosting guide](../../docs/self-hosting.md).

## Behaviour

- **Join.** On `session_start` the extension starts one worker with the native
  session id and a fresh boot id, then publishes the binding as one system
  prompt section. A later join replaces the section; the old `instance_file` is
  no longer valid.
- **Presence.** A heartbeat every 30 seconds carries `native_state`, `stopped`,
  `plan_mode` and the session title when Pi exposes one.
- **Delivery.** Every 2 seconds the extension asks for pending messages. It
  claims only while the session is an idle TUI, not stopped, not inside a UI
  prompt and not aborted. A claimed batch becomes one `agent-chat` custom
  message with `triggerTurn: true`; the extension reports `handed` only after
  Pi's `message_start` event carries the same marker object. A missing event
  inside the reservation is `uncertain`, never a replay.
- **Mute.** A muted session settles the batch as `deferred` and delivers
  nothing.
- **Rejoin.** `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE`,
  `REQUEST_UNCERTAIN` and a join `BINDING_CONFLICT` start a bounded rejoin:
  5-second base, doubling to a 120-second cap, jitter between 0.5 and 1.0, a
  two-hour episode window and at most three completed rejoins per hour. The
  numbers are pinned to `agent_chat/models.py` by `test/policy.test.js`.
- **Fail closed.** Every other refusal, an exhausted rejoin budget, a malformed
  frame and a worker exit latch chat off for the process. The native session,
  CI and any submitted work are unchanged. `/agent-chat-off` is the operator
  switch.
- **Stop.** A session start, an abort and a non-interactive input source clear
  delivery eligibility; only interactive local input restores it.

## Limitations

- Plan Mode is not detected by this package. A host that runs a plan-mode
  extension should keep chat off for that workflow (or contribute the state
  hook) until the package can observe it. Treating an idle TUI as eligible is
  deliberate for the first version and is called out here rather than guessed
  at runtime.
- Sender receipts are not rendered yet. They are read-only and never wake a
  model, so their absence does not change delivery.
- The binding context tells the model to use the `agent-chat` CLI for `who`,
  `history`, `send`, `reply` and `ack`. No chat tools are registered by this
  version; the CLI is the one message surface.
- A live Pi release has not been exercised yet; see the compatibility matrix in
  [`../README.md`](../README.md). Contract tests use a harness double.

## Test

```sh
cd integrations/pi
node --test
```

The suite covers config refusal, the join frame and frame validation, rejoin
budget/window/backoff, delivery and settlement, the system-prompt binding and
fail-closed latching. It needs no PostgreSQL, no service and no credential.
