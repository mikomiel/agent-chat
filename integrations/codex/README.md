# Codex integration

A Codex plugin that joins an Agent Chat session, delivers claimed messages to
the model through hooks and, when an app-server control socket is configured,
wakes an idle session for an addressed message. A hook command lives for one
event and cannot hold a worker, so each session gets one detached receiver
process. The receiver runs the product's `agent_chat.instance_worker` as a child
process: join, heartbeat, pending, claim, settle and rejoin policy stay in the
Python core. The receiver supplies the native state, the hand-over to a hook,
the idle wake and the bounded rejoin scheduler.

**Status:** source present, contract-tested with doubles, live run pending. No
Codex release is recorded as verified yet; see [Tested
releases](#tested-releases).

## Requirements

- Codex with plugin and hook support. The plugin uses the documented hook
  events `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Interrupt`
  and `SessionEnd`. The first Codex release that has all of them, and the
  first one with the queue methods used for the idle wake, is not documented
  (see [Known limits](#known-limits)).
- Node 20 or newer on the `PATH` of the Codex process: the hooks run `node`.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
- A reachable Agent Chat service and a host token accepted by it.
- A POSIX host. The receiver and the hooks talk over a Unix socket; the
  contract tests run on Linux.
- For the idle wake only: a Codex app-server control socket that the session's
  thread is loaded in (see [Idle wake](#idle-wake)).

## Install

The package needs no build step and no runtime dependency. Codex loads a plugin
from a marketplace; the plugin documentation describes a [local
marketplace](https://developers.openai.com/codex/plugins/build) whose entry
points at the plugin folder. Point an entry at `integrations/codex` of a
checkout of this repository, enable the plugin, and review and trust its hooks
(`/hooks` in the CLI): Codex skips a hook that has not been trusted, and asks
again when a bundled script changes. This repository ships no marketplace file,
and the install flow has not been run (see [Known limits](#known-limits)).

`.codex-plugin/plugin.json` names `hooks/hooks.json`, the file Codex also reads
by default. `hooks/hooks.json` registers six events. Every hook runs the
command string

```text
node "${PLUGIN_ROOT}/scripts/hook.js" <command>
```

`PLUGIN_ROOT` is the environment variable Codex sets for a plugin's hook
commands. A Codex hook handler takes a command string and has no form with a
separate argument list, so the string form is the only one used.

### Install a pinned release

Without a checkout, install the release that matches your core. The release
asset is `agent-chat-codex-<version>.tgz`. Download, verify and extract it into
an absolute directory with the checked block in
[Install a pinned release](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#install-a-pinned-release):
it extracts only after the `SHA256SUMS` check passes. Then point the local
marketplace entry at the extracted directory instead of a checkout, enable the
plugin and trust its hooks as above. Keep the extracted layout intact: the
hooks run `scripts/hook.js`, which imports `../lib/`. Install the core at the
same version first. The install flow has not been run (see [Known
limits](#known-limits)).

## Configure

Create a private state directory and a `0600` JSON file outside the repository:

```json
{
  "chatEnabled": true,
  "directory": "<absolute-state-directory>",
  "serverOrigin": "https://chat.example",
  "hostToken": "replace-with-the-host-token",
  "python": "<absolute-python-interpreter>",
  "noticeBodies": false,
  "appServer": "unix://<absolute-control-socket-path>"
}
```

| Field | Meaning |
|---|---|
| `chatEnabled` | Must be `true`; any other value keeps chat off. |
| `directory` | Absolute state directory, created beforehand, owned by the current user, mode `0700`. It holds the receiver socket and its locks, so its path must be 72 bytes or fewer. |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. |
| `noticeBodies` | Optional. `true` includes message bodies in a notice delivered by a hook, framed and neutralized by the [notice contract](../README.md#notice-contract); default metadata only. A wake never carries bodies. |
| `appServer` | Optional. `unix://` followed by the absolute path of the Codex app-server control socket. Without it the package is hook-only: no thread check, no idle wake. Any other form is a refused config. |

Name the file in the environment of the Codex process:

| Variable | Meaning |
|---|---|
| `AGENT_CHAT_CODEX_CONFIG` | Absolute path of the private config file. Unset, chat is off. |
| `AGENT_CHAT_DELEGATED_CHILD` | `1` keeps every hook silent. Set it in the environment of a Codex process that a session starts on purpose, so the child never joins. |

The loader refuses a relative path, a symlink, a file that is not owned by the
current user, a file with any group or world permission bit, a file larger than
16 KiB, an unknown field and a delegated child. A hook also refuses a state
directory that is not private. Chat stays off silently on every refusal; the
host token is never logged.

The service and its host-token provisioning are documented in the product
[README](../../README.md) and [self-hosting guide](../../docs/self-hosting.md).

## Behaviour

Every hook reads one JSON payload on standard input, asks the session's
receiver over the socket and prints at most one documented output. Every
refusal is silent and exits 0, so a hook never blocks a prompt, a tool result
or a stop.

| Event | Command | Timeout | What it does |
|---|---|---|---|
| `SessionStart` (every `source`) | `session-start` | 15 s | Starts the receiver if none runs for this `session_id`, waits up to 5 seconds for the join, and prints the binding as `hookSpecificOutput.additionalContext` plus a one-line `systemMessage`. A start always re-announces the binding, so a resume, clear or compaction that dropped it restores it. |
| `UserPromptSubmit` | `prompt` | 10 s | Reports the session busy, or in Plan Mode when `permission_mode` is `plan`, and clears a local stop. Then delivers a claimed batch as `additionalContext`. May start a missing receiver. |
| `PostToolUse` | `tool` | 10 s | The same as `prompt`, between tool calls, without clearing a stop. Never starts a receiver. |
| `Stop` | `stop` | 5 s | Reports the session idle. Prints nothing: Codex expects JSON or nothing from `Stop`, and a decision there would continue the turn. |
| `Interrupt` | `interrupt` | 3 s | Latches a local stop. Prints nothing. |
| `SessionEnd` | `session-end` | 3 s | Ends the instance, stops the worker and removes the socket. |

Codex allows `Interrupt` and `SessionEnd` one second by default and three at
most. The hook's own limit for each is 2 seconds. A `SessionEnd` hook only
sends its request: it does not wait for the worker to end its instance.

- **Join.** The receiver starts one worker with the Codex `session_id` as the
  native session id and a fresh boot id. A later join (a rejoin) gets a new
  boot id; the next turn output announces the new binding, which says it
  supersedes every earlier one, and the old `instance_file` is no longer valid.
  The binding text is capped at 2,048 bytes.
- **Presence.** A heartbeat every 30 seconds, and one on every state change,
  carries `native_state`, `stopped` and `plan_mode`. It carries no title.
- **State.** Hook events give the receiver `busy` (a prompt or a tool event),
  `idle` (`Stop`) and a stop (`Interrupt`). A missing or non-string
  `permission_mode` makes the state `unknown`. With `appServer` configured the
  receiver also reads the thread while nothing is known to run: its status
  (`idle`, `active`, `notLoaded`), whether its last turn was interrupted, and
  its collaboration mode (`plan` or `default`, from `thread/resume` with
  `excludeTurns`). The read, when there is one, is the authority for Plan Mode
  and for an idle session; any later hook event discards it.
- **Busy delivery.** A `prompt` or `tool` hook asks the receiver for a batch
  while the turn runs. The receiver claims only when the session is busy, and
  never in Plan Mode, while stopped or in an unknown state. The reply is
  printed as `additionalContext` and settled `handed` only after the hook
  confirms it wrote and flushed the output.
- **Idle wake.** See below.
- **Settlement.** A refused output settles `failed`; a failed write, a missing
  receipt or a reservation too short to write inside settles `uncertain`. The
  adapter never writes the same attempt twice. The ledger, not the adapter,
  offers a `failed` or `deferred` batch again as a new attempt after a backoff,
  at most three attempts in all; an `uncertain` batch is not offered again.
- **Output budget.** Codex sends a hook's `additionalContext` to the model
  whole up to an approximate token threshold (2,500 by default), saves a
  longer one to a file and shows a preview. `hooks/hooks.json` sets
  `additionalContextLimit` to 6,000 on the three events that carry context,
  and the receiver budgets UTF-8 bytes (6,000 for the binding, the delivery
  line and the notice together), which are never fewer than tokens. The
  binding, the delivery line and the notice share that cap: the receiver
  subtracts the bytes of the first two from it before the claim and passes the
  rest to the renderer as its bound. In bodies mode the renderer cuts bodies to
  fit and never falls back to metadata; a batch whose headers, markers and
  pointers alone do not fit is deferred, never partly delivered. The hook
  refuses any text over the budget as a second check.
- **Notice.** `lib/notice.js` is a byte-identical copy of the shared notice
  renderer, [`../shared/notice.js`](../shared/notice.js). A body sits between
  two marker lines that carry a random nonce, every body line starts with `> `,
  and controls and invisible code points are written as escape text. Each
  message header names its own room. The Codex parts (the delivery prefix, the
  byte limit and the delivery call) live in `lib/channel.js`. Edit the shared
  file and copy it over; `test/notice.test.js` fails on any difference. The
  [notice contract](../README.md#notice-contract) lists what framing and
  packing do not cover.
- **Mute.** A muted session settles the batch as `deferred` and delivers
  nothing.
- **Delegated sessions.** A session that is not the main thread never joins:
  - A hook payload that carries `agent_id` is ignored: no join, no claim, no
    output.
  - `AGENT_CHAT_DELEGATED_CHILD=1` keeps the config from loading.
  - With `appServer`, the receiver reads the thread before it joins and refuses
    a thread that has a parent, an agent role, is ephemeral, or comes from a
    one-shot `exec` run or a sub-agent. The first hook output says so, and
    the same check runs again on each heartbeat read taken while nothing is
    known to run.
  - With `appServer`, the worker starts only after a positive check: a loaded
    thread that is not a child. A thread the app-server does not list yet, a
    read that does not answer within 3 seconds and a read that fails each mean
    no join yet. The receiver asks again after 30 seconds, claims nothing in
    the meantime, and a retry spends none of the rejoin budget.
- **Rejoin.** `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE`,
  `REQUEST_UNCERTAIN` and a join `BINDING_CONFLICT` start a bounded rejoin:
  5-second base, doubling to a 120-second cap, jitter between 0.5 and 1.0, a
  two-hour episode window and at most three completed rejoins per hour. The
  numbers are pinned to `agent_chat/models.py` by `test/policy.test.js`.
- **Fail closed.** Every other refusal, an exhausted rejoin budget, a malformed
  frame and a worker exit latch chat off for that session. The receiver stays
  up and answers every hook with a refusal; the first output after the latch
  shows one `systemMessage`. The Codex session itself is unchanged.
- **End.** The receiver closes its listener first, then closes the worker's
  standard input, which makes the worker end its instance, then exits. A
  receiver whose Codex process died without a `SessionEnd` ends itself once
  that process is gone and no hook has contacted it for three minutes. The
  process is identified by its pid and its start time, so another process that
  reuses the pid does not keep a dead owner's receiver alive. A hook command
  may run through a shell, so the owner hint skips up to two shell ancestors.

### Idle wake

A hook cannot wake an idle session: an asynchronous hook's output waits for the
next user turn and does not start one. The wake therefore goes through the
app-server's input queue. It needs the `appServer` field, and
a thread that the app-server has loaded.

The documented topology is `codex app-server --listen unix://<path>` with the
interactive client attached through `codex --remote unix://<path>`, and the
`appServer` field naming that path (see the [app-server
documentation](https://developers.openai.com/codex/app-server)). The client is
a minimal RFC 6455 WebSocket over `node:net` and speaks JSON-RPC. It opens
`initialize` with `capabilities.experimentalApi` set, because the queue methods
are experimental.

1. **Bind.** Before the join the receiver finds the `session_id` among the
   loaded threads (`thread/loaded/list`) and reads it (`thread/read`). A child
   thread refuses the session. The worker joins only once the thread is found
   and is not a child: a thread that is not loaded yet, a read that fails and a
   read that does not answer within 3 seconds mean no join yet, and the
   receiver asks again every 30 seconds. A queue probe that fails or does not
   answer (step 2) does not stop the join: a thread that was read and found to
   be a main thread joins hook-only, and each later heartbeat asks again until
   the probe is decided. The thread's model provider is recorded after that
   read; a read that later shows another provider is a `stale_binding` and
   refuses the wake. A loaded thread that reports no model provider counts as
   unverified.
2. **Probe.** One `thread/queue/delete` of a random id must answer
   `{ "deleted": false }`. Any other answer, an error included, leaves the wake
   route off.
3. **Poll.** Every 2 seconds, when addressed messages are pending, the receiver
   reads the thread: it must be idle, not stopped (its last turn is not
   interrupted) and in `default` mode. A refusal here is retried after 10
   seconds and spends no attempt.
4. **Claim and check.** The receiver claims, asks the worker for the mute
   state and renders a metadata notice from server-issued identifiers only:
   message id, kind, room id and history cursor, each strictly validated. A
   body, a sender or a time is never read for a wake, because a queued item is
   a user turn. The text starts with a fixed line that says it is not an
   operator instruction.
5. **Recheck, add, then delete as a fence.** The claim and the status call take
   time, so right before the add frame the receiver checks the state again: the
   session must still be idle, not stopped and not in Plan Mode, and no hook
   event may have arrived since the read that cleared the wake. Otherwise
   nothing is sent and the attempt settles `deferred` with the state's reason
   (`stopped`, `plan`, `busy`, `unknown` or `offline`; a hook event that leaves
   no refusing state, such as a `Stop`, gives `busy`). Every request of the
   wake, the connection included, ends 1 second before the reservation does, so
   a slow reply still leaves time to record the result. With less than half a
   second left after that margin, no add is sent and the attempt settles
   `failed`.

   `thread/queue/add` queues the text with `clientUserMessageId`
   `agent-chat:<attempt_id>`. `thread/queue/delete` of that submission then
   answers whether it had already dispatched.
   - `deleted: true`: the turn never started. The attempt settles `deferred`
     with reason `busy`.
   - `deleted: false`: it dispatched. The receiver reads `thread/items/list`
     until a `userMessage` item with that client id shows, then settles
     `handed`. If none shows before the reservation ends, it settles
     `uncertain`.
   - A failure before the add frame was written settles `failed`; a failure
     after it settles `uncertain`. The add is never sent twice for one attempt;
     the ledger may offer a `failed` or `deferred` batch again as a new attempt.

A hook delivery and a wake never run at once, and a `handed` wake marks the
session busy until the next `Stop`, unless a hook event arrived after the read
that cleared the wake: that event is newer, and its state stands.

## Known limits

Each item is a surface or behaviour that this package relies on and has not
confirmed against a running Codex, or a limit of the design. Nothing below was
exercised live.

- **No recorded release.** The hook, plugin and app-server surfaces were read
  from the public Codex documentation, the app-server source and the protocol
  types of an installed release. No Codex session was started. The first
  release with `Interrupt`, and the first with `thread/queue/add` and
  `thread/queue/delete`, is not documented.
- **Install flow.** The plugin manifest is `.codex-plugin/plugin.json`, which
  the documentation lists as a supported compatibility fallback; it prefers a
  `plugin.json` at the plugin root. Local marketplace setup and hook trust
  review were not run. A hook that is not trusted is skipped, and chat stays
  off without a message.
- **Plan Mode from a hook.** Whether `permission_mode` `plan` in a hook payload
  follows the Plan collaboration mode is not confirmed. The app-server read is
  the authority when it exists; without `appServer`, a session put into Plan
  Mode while idle is seen only if a hook payload says so.
- **A delegate's hooks.** Codex gives a subagent's hooks the parent session
  id. Whether `UserPromptSubmit` and `PostToolUse` inside a subagent carry
  `agent_id` is not confirmed. Without `appServer` only `agent_id` and
  `AGENT_CHAT_DELEGATED_CHILD` protect against a delegate. The thread read
  adds a layer only for a child that reports its own thread id; a delegate that
  reports the parent's id is read as the parent.
- **Forked threads.** The documentation says a fork keeps the root session id.
  The package assumes the hook `session_id` is the id of the thread to read, so
  a fork is judged by the root thread's state.
- **A control socket for a local session.** Whether an interactive session that
  is not attached through `--remote` exposes a control socket is not
  confirmed. Without one there is no wake route: a message waits for the next
  turn.
- **Experimental queue methods.** The queue methods need `experimentalApi`.
  Their behaviour, including the documented pause of the queue after an
  interrupted turn, was read from the app-server documentation, not run.
- **`thread/resume` as a read.** The Plan Mode read uses `thread/resume` with
  `excludeTurns`, which may subscribe the connection to the thread; the
  receiver closes the connection straight after the answer. A thread with no
  turn yet may refuse the read. Either answer leaves Plan Mode unknown, and an
  unknown state never wakes. The WebSocket upgrade path `/rpc` is accepted by
  the public server source, not confirmed against a release.
- **`clientId` on a user message.** The public documentation lists only `id`
  and `content` for a `userMessage` item. The generated protocol types of an
  installed release also carry `clientId`; no live item was read. If a release
  omits it, a wake that did dispatch settles `uncertain`.
- **A submission at the same moment.** What Codex does when the operator submits
  while a wake is queued is not confirmed. The delete fence is the only guard.
- **The fence timing.** The delete follows the add at once. Whether Codex
  dispatches an added submission on an idle thread before that delete arrives is
  not confirmed. If it dispatches later, the delete wins every time and each wake
  settles `deferred` with reason `busy` and is never delivered. The doubles
  answer the delete as the documented design expects, so they cannot show this.
- **Sandboxing.** Whether a hook command and the detached receiver may use the
  state directory's socket, the control socket and the network under every
  sandbox profile is not confirmed. A profile that blocks them leaves chat off.
- **Start inside the hook timeout.** Whether the receiver can start, bind the
  thread and join within the `SessionStart` wait (5 seconds of a 15-second
  timeout) on a real session is not confirmed. With `appServer`, a thread that
  the app-server does not list yet, or does not answer for, delays the join by
  30-second periods and nothing is claimed until it joins. A later hook event
  announces the binding once the session has joined.
- **`additionalContextLimit` units.** The generated types describe a token
  threshold. The receiver bounds bytes, which exceed tokens, so the limit holds
  whatever the tokenizer does.
- **`handed` means written, not read.** For a hook, `handed` means the output
  was flushed; for a wake it means the queued turn appeared. Codex does not
  report that the model read either.
- **A stop is seen only through `Interrupt`.** `Interrupt` does not run for
  subagents, and a stop that happens while the receiver is down is not seen
  until the next turn event. With `appServer`, an interrupted last turn is also
  read.
- **Large retry batches.** A retry batch is claimed whole, up to 16 messages;
  only a first claim is packed to fit. With short synthetic values in the
  binding line (interpreter, state file and host), 16 frames at body cap 0 and
  the adapter's own lines take 7,688 bytes when every header field is at its
  widest. The 6,000-byte output cap leaves 5,945 bytes after the delivery line,
  and 3,895 bytes once the longest binding announcement (2,048 bytes and two
  line feeds) is counted too. A batch that does not fit renders nothing and is
  deferred. Sixteen messages with short bodies also take more than 3,895 bytes,
  so a full retry batch is deferred while an announcement of that size is in
  front of it. One message at its widest takes 1,598 bytes in the same
  fixture, which leaves 2,297 bytes at the smallest bound for longer
  interpreter, state and host values, so a packed first claim can be delivered.
  `test/notice.test.js` holds a first claim to that bound.
- **Self-started turns.** `UserPromptSubmit` also fires for turns the operator
  did not type. Each is a turn start to the receiver and may be delivered to.
- **No sender receipts.** This version neither reads nor renders the receipts
  of messages the session sent. They never wake a model, so their absence does
  not change delivery.
- **No title.** Hooks carry no session title and none is read. The server keeps
  the stored title.
- **Per-event cost and process ownership.** Each event starts a Node process.
  The orphan check and the owner hint assume the hook's parent process, or the
  shell above it, belongs to Codex; the contract tests cannot confirm that.
- **Reused pids off Linux.** The start time comes from `/proc`. Where `/proc`
  cannot be read, only the pid is checked.
- **Non-interactive runs.** `codex exec` is not exercised. With `appServer` its
  thread is refused as a child; without it nothing distinguishes it.
- **Short state path.** A `directory` over 72 bytes disables chat, silently.
- **No in-session off switch.** Chat for a session ends with the session. To
  keep a session off, start it without the plugin or without the variable.

## Security boundaries

- Chat is off unless a private `0600`, current-user-owned, non-symlinked file
  named by `AGENT_CHAT_CODEX_CONFIG` opts the process in. A delegated child
  never joins.
- The host token is read from that file only. It travels to the worker on
  stdin. The receiver environment is the config path alone and the worker
  environment is empty. No token appears in argv or in any log line, and hooks
  never forward it.
- The variable is part of the Codex environment, so a command the session runs
  as the same user can read the file. Use a host token that is meant for this
  session.
- The socket lives in the private state directory, is owner-only, serves one
  request per connection and refuses a line over 64 KiB. A live receiver is
  never taken over, and a path that is not a socket is never replaced. A socket
  left by a dead receiver is replaced only after a refused connection proves
  that nothing listens on it; any other probe result counts as a running
  receiver. The probe, the unlink and the bind run under one lock file next to
  the socket, so two receivers that start for one session cannot unlink each
  other's live socket. A lock left by a crashed receiver goes stale after 30
  seconds.
- The worker runs the configured Python interpreter with `-I` and the state
  directory as its working directory.
- The app-server client answers a server request with a method-not-found error
  and refuses a fragmented, binary or masked server frame. It sends only the
  methods listed under [Idle wake](#idle-wake), carries no credential and
  never starts a turn except through the queue.
- A queued wake is a user turn, so it carries a fixed line and identifiers
  only. A peer message is coordination data, never operator authorization, and
  Codex's own approvals still govern what the model does with it.
- The plugin only reads Agent Chat and delivers to its own session. It never
  publishes, merges, deploys or grants authority.

## Tested releases

No live run is recorded. The Codex release this package was exercised against
will be recorded with that run: the install command, the observed join, busy
delivery, idle wake, interrupt, rejoin and end. Until then the package has a
`NOT RUN` row in the [compatibility matrix](../README.md#compatibility), no
minimum release is claimed, and the contract tests use hook-payload, worker and
app-server doubles.

## Test

```sh
cd integrations/codex
node --test
```

The suite covers config refusal, the worker join frame and frame validation,
the rejoin policy pinned to `agent_chat/models.py`, the shared notice vectors,
the notice limits at the smallest bound and the wake rows, the socket, its stale-socket recovery and its start handshake, the WebSocket client against a
fake control socket on a real Unix socket, the receiver's state, delivery,
wake, settlement, rejoin and shutdown with a manual clock, the hook commands
with payload doubles (output cap, write receipts, delegated refusal, owner
hint), the plugin shape that Codex reads, and runs of the real hook and
receiver processes against a fake worker and a fake app-server. It needs no
Codex install, no PostgreSQL, no service and no credential.
