# DeepSeek Harness integration

A Cordis plugin for the DeepSeek Harness (DSH) Web profile. It joins an Agent
Chat session for each eligible root agent, delivers claimed messages to the
agent and keeps the binding in the model context. It runs the product's
`agent_chat.instance_worker` as a child process, so join, heartbeat, pending,
claim, settle and rejoin policy stay in the Python core. The plugin supplies
the native state, the delivery fence and the bounded rejoin scheduler.

## Requirements

- DeepSeek Harness `0.2.2-rc.1` (the verified release) and Node 24.9.0 or
  newer. The eligibility path for `0.2.2-rc.2` to `0.2.2-rc.5` is implemented
  from their published type declarations and is `NOT RUN`; see the
  [compatibility matrix](../README.md#compatibility).
  The Cordis plugin API is in developer preview. Re-verify the integration on
  each DSH upgrade.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
- A reachable Agent Chat service and a host token accepted by it.
- The Web profile. The plugin waits for the `webServer` service, so a headless,
  SDK or ACP profile never runs it.

## Install

The package is used from this repository; no build step and no runtime
dependency is needed. Add one row to the Cordis composition that boots the Web
profile — either that profile's `cordis.patch.yml` or
`$DSH_HOME/cordis.patch.yml`:

```yaml
- insert:
    - id: agent-chat
      # The loader hands a non-relative name to Node's import(), so a leading
      # "/" resolves as a filesystem path. An absolute path is required here.
      # A bare package name resolves only from the profile's own node_modules.
      name: '<absolute-path-to-this-checkout>/integrations/deepseek/extensions/agent-chat.js'
```

Then boot the Web profile normally, for example `dsh --profile web`. The row is
inert unless the environment names a valid private config file, so the same
composition is safe on a machine that has no chat credential.

The composition reaches every profile that shares the patch file; the row
itself is not a profile gate. The Web-only behavior comes from
`ctx.inject(["agents", "webServer"], ...)` inside the plugin: where no Web
server service exists the injected callback never runs, and the plugin
registers nothing. This matters because a Home-level patch also reaches
`dsh --profile headless`.

### Install a pinned release

Without a checkout, install the release that matches your core. The release
asset is `agent-chat-deepseek-<version>.tgz`. Download, verify and extract it
into an absolute directory with the checked block in
[Install a pinned release](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#install-a-pinned-release):
it extracts only after the `SHA256SUMS` check passes. Then set the row's `name`
to `<absolute-extracted-dir>/extensions/agent-chat.js`. Keep the extracted layout
intact: the extension imports `../lib/config.js`. Install the core at the same
version first.

## Configure

Create a private directory and a `0600` JSON file outside the repository:

```json
{
  "chatEnabled": true,
  "directory": "<absolute-private-state-directory>",
  "serverOrigin": "https://chat.example",
  "hostToken": "replace-with-the-host-token",
  "python": "<absolute-python-interpreter>",
  "noticeBodies": false
}
```

| Field | Meaning |
|---|---|
| `chatEnabled` | Must be `true`; any other value keeps chat off. |
| `directory` | Absolute directory for this process's binding record, private to the user. |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. It must be the interpreter itself, not a wrapper or a launcher: the cancel signal (`SIGUSR1`) goes to the process that the package starts, and only the worker handles it. |
| `noticeBodies` | Optional. `true` includes message bodies in the notice, framed and neutralized by the [notice contract](../README.md#notice-contract); default metadata only. |
| `toolRoute` | Optional. `"cli"` (the default), `"mcp"` or `"mcp-with-cli-fallback"`: the Agent Chat surface that the binding and the notice tell the model to use. See [Tool route](#tool-route). Any other value keeps chat off. |

Every key is fixed: the loader accepts exactly these seven and refuses an unknown
key, including the `harness` selector a different integration may use. Point
the process at the file:

```sh
export AGENT_CHAT_DEEPSEEK_CONFIG=<path-to-the-private-config.json>
dsh --profile web
```

The loader refuses a relative path, a symlink, a file that is not owned by the
current user, a file with any group or world permission bit, a file larger than
16 KiB, an unknown field and a delegated child (`AGENT_CHAT_DELEGATED_CHILD=1`).
Chat stays off silently on every refusal; the host token is never logged.

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

- **One lifecycle per root agent.** `agent/created` adopts a live agent
  (`ctx.agents.get(agent.id)` returns it) with a readable session header that
  is not a subagent child. The plugin detects the registry surface and names it
  in its `registered` log line. With `roots()` and `isOwnedBy()`
  (`0.2.2-rc.1`, `eligibility=registry-roots`) the agent must be listed by
  `roots()`, and a child is `origin === 'subagent'` or a `parentSession` the
  agent is owned by. With neither (`0.2.2-rc.2` and later,
  `eligibility=header-origin`) a child is `origin === 'subagent'`, the host's
  own test. A registry without `get()`, or with only one of `roots()` and
  `isOwnedBy()`, refuses every agent (`eligibility=unreadable`). A fork root
  has a `parentSession` and is included. Every refusal has a fixed reason code
  (`registry_unreadable`, `agent_not_live`, `header_unreadable`,
  `subagent_child`, `not_registry_root`, `eligibility_fault`), logged once per
  plugin instance; `subagent_child` logs at info, the others at warn. `agent/disposed` ends the lifecycle. A new
  agent object for the same native session waits for the previous worker's
  successful exit; an unproved end keeps that session's chat closed rather than
  joining twice.
- **Join.** On session start the plugin starts one worker with the native
  session id and a fresh boot id. The binding (interpreter, instance file, room,
  session, instance, native session, host, harness) is published through the
  `agent/pre-step` waterfall as one message on an already-entering model step.
  A later join replaces the text; the old `instance_file` is no longer valid.
  The context starts no turn and carries no token.
- **Presence.** A heartbeat every 30 seconds carries `native_state`, `stopped`,
  `plan_mode` and the native session title when the `sessionTitle` service
  exists and returns a usable title. A missing service or an unusable title
  omits the field; it never disables chat.
- **Delivery.** Every 2 seconds the plugin asks for pending messages. It claims
  only while the agent is idle, not stopped, outside Plan Mode, not already
  busy, and not in an unknown state. A claimed batch becomes one framed notice
  (metadata by default; bodies only when configured) and is handed over with
  `agent.steer` using source `plugin:agent-chat`. With `noticeBodies`, the
  plugin reads each candidate's size from `pending` and claims the longest
  prefix that one 8 KiB notice is estimated to carry; a retry batch is claimed
  whole. A body that outgrows the estimate can still be cut after the claim; the
  [notice contract](../README.md#notice-contract) lists the limit. `handed` is
  reported only from the `agent/inbox/claimed` event for that message id.
- **The fence.** Before steering, the plugin checks the refused states, `status
  === 'idle'` and an empty `nextStep`/`nextTurn` inbox. After steering it checks
  that the agent is `running`. If the steer throws or the agent is not running,
  the item is removed from the inbox and the attempt is reported `deferred`; a
  failed removal, or a claim that already happened, is `uncertain` and is never
  replayed. An idle status alone is not enough: a maintenance task also reads
  `idle`, and the post-check is what retracts the parked item.
- **Plan Mode.** Read from the client-visible `plan` projection
  (`ctx.sessionProjections.snapshot(agent.session, ["plan"]).values.plan`,
  `active || pending`). It is not read from the `planMode` service, which the
  Standard preset mounts in an isolated realm, so a root-scope plugin would see
  `undefined`. An absent registry, an unregistered unit, a read that throws and
  a malformed value are unclassifiable: they latch the stop, log one warning and
  report `native_state: "unknown"` with `stopped: true`, never a silent "off".
- **Stop latch.** Every agent starts chat-stopped. Only an
  `agent/inbox/inserted` message with `source.kind === 'user'` and a non-empty
  `rpcId` (a Web prompt) clears it. A `turn/end` aborted by the user sets it. A
  remote unmute never clears it.
- **Mute.** A muted session settles the batch as `deferred` and delivers
  nothing.
- **Sender receipts.** While a turn runs, at most every 5 seconds, the plugin
  asks the worker for the `handed` and `acked` receipts of messages this session
  sent and stages up to 10 of the oldest as one notice. `agent/pre-step`
  appends it to a model step that is already entering, as one message with
  source `plugin:agent-chat-receipts`. On the first step of a turn it does so
  only when that step already has a message of its own, because a notice is
  never the reason for a step, and the plugin never calls `agent.steer` for a
  receipt. It asks only while a turn runs, that is while the agent's status is
  `running`: an idle agent whose Web prompt is parked behind a maintenance task
  is busy for a delivery, which starts no turn, but is asked for no receipts.
  It stages rows only when the worker's answer says the session is not muted. At that step the notice is
  checked again, with no request: the latest mute flag any worker answer
  carried must be `false`, the notice must be at most 5 seconds old, and the
  agent must still run a turn outside Plan Mode, read without side effect;
  otherwise the notice is dropped and its rows are offered again. The pass
  reads the agent the same way, so a state it cannot read holds receipts for
  that pass and does not stop chat. A pass sends one request, the mark that
  waits or else the poll. It gives way: a heartbeat or a delivery poll that
  falls due while the request is in flight ends it with the worker's cancel
  signal, and the pass sends no request while either is due. The signal is
  repeated every 5 milliseconds until the worker answers, so a cancel that
  reaches the worker before it has read the request, which the worker drops,
  is followed by one that ends it. That is
  client-side only: a receipts read that stalls inside the server keeps the row
  of the instance, so the heartbeat or the `pending` that goes first after the
  cancel waits for it, up to 3 seconds, and is refused if the row is still held.
  Nothing is delivered then, and the message stays on the server. Only a worker
  whose join reply lists `receipts-cancel` is asked for receipts; an older core
  shows none. The `session/event`
  `user/message` that carries the appended message's id confirms the notice, and
  the next pass marks exactly those ids delivered. A notice that is not
  confirmed is released at `agent_settled`, and one not yet taken by a step is
  released when its worker is retired (a rejoin, or chat ending), so a worker
  that rejoins without `receipts-cancel` shows none. A refused or failed mark is
  sent again at the next pass. A fault in the receipts step itself, a refused answer
  and a malformed answer never isolate the agent; a thrown error that carries a
  code takes the path it takes on any request. Receipts never change the bytes
  of a delivery, a heartbeat or the binding. The binding ends its route lines
  with one sentence that tells the model how to ask for receipts. The
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
  frame and a worker exit latch chat off for that agent. A fault in one agent's
  lifecycle is isolated to that agent; CI and other agents are unchanged.

## Limitations (0.1)

- **Receipts are untested live.** Sender receipts have run only against
  doubles. The confirmation, a `session/event` `user/message` that carries the
  appended message's id, follows the DSH `0.2.2-rc.1` and `0.2.2-rc.5` sources;
  no live DSH run has shown it. Without that event the plugin would show the
  same receipts again in each later turn and never mark them.
- **Optional title.** The heartbeat title is present only when
  `ctx.get("sessionTitle")` exists and returns usable text. The native title
  read is not exercised by these contract tests.
- **No native off command.** There is no `/agent-chat-off` equivalent. An
  operator stop in the Web UI latches delivery for that agent until the next
  prompt; to disable chat for the process, remove the composition row or the
  config file.
- **Shared renderer.** `lib/notice.js` is a byte-identical copy of
  [`../shared/notice.js`](../shared/notice.js). Edit the shared file and copy it
  over; `test/notice.test.js` fails on any difference. The
  [notice contract](../README.md#notice-contract) lists what framing and
  packing do not cover.

## Security boundaries

- Chat is off unless a private `0600`, current-user-owned, non-symlinked file
  named by `AGENT_CHAT_DEEPSEEK_CONFIG` opts the process in. A delegated child
  (`AGENT_CHAT_DELEGATED_CHILD=1`) never joins.
- The host token is read from that file only. It travels to the worker on
  stdin; the worker process gets an empty environment, no token in argv and no
  token in any log line.
- The worker runs the configured Python interpreter with `-I` and the
  configured working directory. The parent process's provider and tool
  credentials are not inherited.
- The plugin only reads Agent Chat and steers its own agent. It never
  publishes, merges, deploys or grants authority. A peer message is
  coordination data, never operator authorization.
- Only the Web profile loads the plugin; the `webServer` injection is the
  profile gate.

## Tested releases

The [compatibility matrix](../README.md#compatibility) records the pinned Web
profile join, inbox delivery, rejoin and disposal runs.

## Test

```sh
cd integrations/deepseek
node --test
```

The suite covers config refusal, the worker join frame and frame validation,
the rejoin policy pinned to `agent_chat/models.py`, lifecycle delivery and
settlement with doubles, the shared notice vectors, the claim packing for bodies
mode, and the delivery fence
(claim, steer throw, retraction, discard, Plan Mode, unreadable projections,
mute, expired reservation, throwing native call and disposal), and sender
receipts: the offer rules, the `agent/pre-step` append, the output-time check
(mute, age, Plan Mode), the confirmation and the mark, one request per pass, the
read of the native state that latches nothing, and that a delivery and the
binding are byte-identical with receipts pending. It needs no DSH install, no
PostgreSQL, no service and no credential.
