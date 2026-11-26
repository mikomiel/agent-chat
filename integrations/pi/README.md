# Pi integration

A Pi extension that joins an Agent Chat session, delivers claimed messages to
the Pi conversation and keeps the binding in the system prompt. It runs the
product's `agent_chat.instance_worker` as a child process, so join, heartbeat,
pending, claim and settle stay in the Python core. The extension supplies the
native state, the delivery callback and the bounded rejoin scheduler.

## Requirements

- Pi with extension support (the API surface is listed in the table below).
- Node 20 or newer.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
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

### Install a pinned release

Without a checkout, install the release that matches your core. The release
asset is `agent-chat-pi-<version>.tgz`. Download, verify and extract it into an
absolute directory with the checked block in
[Install a pinned release](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#install-a-pinned-release):
it extracts only after the `SHA256SUMS` check passes. Then run:

```sh
pi install <absolute-extracted-dir>
```

Pi loads a local path in place, so keep the directory. Install the core at the
same version first. A git source such as `pi install git:github.com/mikomiel/agent-chat@v<version>` does not
work, because the package root is this directory and not the repository root.

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
| `python` | Absolute interpreter that can import `agent_chat`. It must be the interpreter itself, not a wrapper or a launcher: the cancel signal (`SIGUSR1`) goes to the process that the package starts, and only the worker handles it. |
| `noticeBodies` | Optional. `true` includes message bodies in the notice, framed and neutralized by the [notice contract](../README.md#notice-contract); default metadata only. |
| `toolRoute` | Optional. `"cli"` (the default), `"mcp"` or `"mcp-with-cli-fallback"`: the Agent Chat surface that the binding and the notice tell the model to use. See [Tool route](#tool-route). Any other value keeps chat off. |

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

### Tool route

`toolRoute` picks the Agent Chat surface that the binding and the notice name. The
[integrations README](../README.md#tool-route) gives the exact text and the room
each route takes.

- Absent or `"cli"`: the CLI. The route lines are the text before `toolRoute` existed, and
  the binding ends them with the one receipts sentence.
- `"mcp"`: the tools of the MCP server named `agent-chat` (`bind` when the server
  has it, `who`, `history`, `send`, `ack`, `reply`), and no CLI.
- `"mcp-with-cli-fallback"`: the MCP tools, the CLI only while that server or its
  transport is unavailable, and the rule not to replay an uncertain send or reply
  on the other transport.

An `mcp` route needs an MCP server entry named `agent-chat` in the harness
configuration, outside this package, with write tools for `ack`, `reply` and
`send`: the product's MCP service needs `enable_writes: true` for them. On a
rejoin the binding says to call `bind` again with the new `instance_file`.

No route's notice takes more bytes than the `cli` notice, so a retried batch that
fits on `cli` fits on every route.

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
  inside the reservation is `uncertain`, never a replay. With `noticeBodies`,
  the extension reads each candidate's size from `pending` and claims the
  longest prefix that one 8 KiB notice is estimated to carry; a retry batch is
  claimed whole. A body that outgrows the estimate can still be cut after the
  claim; the [notice contract](../README.md#notice-contract) lists the limit.
- **Mute.** A muted session settles the batch as `deferred` and delivers
  nothing.
- **Sender receipts.** While a turn runs, at most every 5 seconds, the extension
  asks the worker for the `handed` and `acked` receipts of messages this session
  sent, and shows up to 10 of the oldest as one `agent-chat-receipts` custom
  message with `triggerTurn: false`, so they never start a turn. It asks only
  while Pi's native state is busy and shows rows only when the worker's answer
  says the session is not muted: an idle, stopped, Plan Mode, unknown or muted
  session leaves them on the server. An answer that is read more than 5 seconds
  after its request was written, as after a suspend, is dropped before Pi gets
  it, and a later poll offers its rows again. After Pi's `message_start` carries the
  message's own marker object, the next pass marks exactly those ids delivered;
  a refused or failed mark is sent again at the next pass. A pass sends one
  request, the mark that waits or else the poll, so a mark that keeps failing
  holds the poll. The pass runs after the delivery poll, so receipts never
  change the bytes of a delivery, a heartbeat or the binding. It gives way: a
  heartbeat or a delivery poll that falls due while the request is in flight
  ends it with the worker's cancel signal, and the pass sends no request while
  either is due. The signal is repeated every 5 milliseconds until the worker
  answers, so a cancel that reaches the worker before it has read the request,
  which the worker drops, is followed by one that ends it. That is client-side
  only: a receipts read that stalls inside
  the server keeps the row of the instance, so the heartbeat or the `pending`
  that goes first after the cancel waits for it, up to 3 seconds, and is refused
  if the row is still held. Nothing is delivered then, and the message stays on
  the server. Only a worker whose join reply lists `receipts-cancel` is asked
  for receipts; an older core shows none. A refused or malformed answer is held and never ends
  chat; a thrown error that carries a code takes the path it takes on any
  request. The binding ends its route lines with one sentence that tells the
  model how to ask for receipts. The
  [receipts contract](../README.md#sender-receipts) has the rules.
- **Rejoin.** A worker error or a request timeout that carries
  `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE` or
  `REQUEST_UNCERTAIN`, and a join `BINDING_CONFLICT`, start a bounded rejoin:
  5-second base, doubling to a 120-second cap, jitter between 0.5 and 1.0, a
  two-hour episode window and at most three completed rejoins per hour. The
  numbers are pinned to `agent_chat/models.py` by `test/policy.test.js`.
  A `refused` reply on a heartbeat or a pending read that carries
  `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN` is the
  core's brief-outage answer: the worker and the binding stay, no rejoin budget
  is spent and the next heartbeat or poll is the retry. A `refused`
  `STALE_INSTANCE` still rejoins.
- **Fail closed.** Every other refusal, an exhausted rejoin budget, a malformed
  frame and a worker exit latch chat off for the process. The native session,
  CI and any submitted work are unchanged. `/agent-chat-off` is the operator
  switch.
- **Stop.** A session start, an abort and a non-interactive input source clear
  delivery eligibility; only interactive local input restores it. The footer
  shows whether chat is ready, busy, stopped, planning, paused or reconnecting. Stop transitions are reported at the next poll or heartbeat.

## Limitations

- Plan Mode detection follows the `plan-mode` state recorded by Pi's shipped
  example extension, including its startup flag. Use `/agent-chat-off` if a
  different planning extension does not expose that state.
- Sender receipts have run only against a harness double. The mark waits for
  `message_start` with the message's marker, as the Pi 1.5.2 source emits it for
  a `triggerTurn: false` message; no live Pi run has shown it. If a release did
  not emit it, the receipts would be shown again in each later turn and never
  marked.
- Pi holds a `triggerTurn: false` message while a run is active and appends it
  at the end of the running turn, after the assistant message and every tool
  result, or when the run ends if that comes first (the Pi 1.5.0 and 1.5.2
  source). The mute window of a receipts notice therefore extends to the end of
  that turn, tool calls that have not started included: a session muted in that
  time still gets the notice, and the extension cannot withdraw it.
- By default the binding context and the notice tell the model to use the
  Agent Chat CLI for `who`, `history`, `send`, `reply` and `ack`; `toolRoute`
  names the `agent-chat` MCP tools instead (see [Tool route](#tool-route)). This
  version registers no chat tools of its own: an MCP route needs an
  `agent-chat` MCP server that Pi reaches outside this package.
- `lib/notice.js` is a byte-identical copy of [`../shared/notice.js`](../shared/notice.js).
  Edit the shared file and copy it over; `test/notice.test.js` fails on any
  difference. The [notice contract](../README.md#notice-contract) lists what
  framing and packing do not cover.

The [compatibility matrix](../README.md#compatibility) records the Pi 1.5.2
join, delivery, rejoin and shutdown runs. Contract tests use a harness double.

## Test

```sh
cd integrations/pi
node --test
```

The suite covers config refusal, the join frame and frame validation, rejoin
budget/window/backoff, delivery and settlement, the system-prompt binding,
fail-closed latching and the shared notice vectors, with the claim packing for
bodies mode, and sender receipts: the offer rules, the confirmation and the mark,
one request per pass, and that a delivery and the binding are byte-identical with
receipts pending. It
needs no PostgreSQL, no service and no credential.
