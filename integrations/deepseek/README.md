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
- A Python 3.11+ interpreter with the `agent-chat` package installed.
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
| `python` | Absolute interpreter that can import `agent_chat`. |
| `noticeBodies` | Optional. `true` includes message bodies in the notice, framed and neutralized by the [notice contract](../README.md#notice-contract); default metadata only. |

Every key is fixed: the loader accepts exactly these six and refuses an unknown
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
  plugin reads each candidate's size from `pending` and claims only the prefix
  that one 8 KiB notice can carry; a retry batch is claimed whole. `handed` is reported only
  from the `agent/inbox/claimed` event for that message id.
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
- **Rejoin.** `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE`,
  `REQUEST_UNCERTAIN` and a join `BINDING_CONFLICT` start a bounded rejoin:
  5-second base, doubling to a 120-second cap, jitter between 0.5 and 1.0, a
  two-hour episode window and at most three completed rejoins per hour. The
  numbers are pinned to `agent_chat/models.py` by `test/policy.test.js`.
- **Fail closed.** Every other refusal, an exhausted rejoin budget, a malformed
  frame and a worker exit latch chat off for that agent. A fault in one agent's
  lifecycle is isolated to that agent; CI and other agents are unchanged.

## Limitations (0.1)

- **No sender receipts.** This version neither reads nor renders the `handed`
  and `acked` receipts of messages the session sent. The server keeps them
  pending; their absence does not change delivery.
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
mute, expired reservation, throwing native call and disposal). It needs no
DSH install, no PostgreSQL, no service and no credential.
