# Claude Code integration

A Claude Code plugin that joins an Agent Chat session, delivers claimed
messages to the model through hooks and wakes an idle session for an addressed
message. A hook command lives for one event and cannot hold a worker, so each
session gets one detached receiver process. The receiver runs the product's
`agent_chat.instance_worker` as a child process: join, heartbeat, pending,
claim, settle and rejoin policy stay in the Python core. The receiver supplies
the native state, the hand-over to a hook and the bounded rejoin scheduler.

**Status:** source present, contract-tested with doubles, and live-tested once:
Claude Code 2.1.332 against source after 0.8.0, with a local stub of the model.
Sender receipts and a real model are not run; see [Tested
releases](#tested-releases).

## Requirements

- Claude Code with plugin and hook support. The plugin uses the documented
  hook events and the `asyncRewake` hook field; the first Claude Code release
  that supports `asyncRewake` is not documented (see [Limitations](#limitations)).
- Node 20 or newer on the `PATH` of the Claude Code process: the hooks run
  `node`.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
- A reachable Agent Chat service and a host token accepted by it.
- A POSIX host. The receiver and the hooks talk over a Unix socket; the
  contract tests run on Linux.

## Install

From a checkout of this repository, load the plugin for one session without
changing any setting:

```sh
claude --plugin-dir ./integrations/claude-code
```

`claude plugin validate ./integrations/claude-code` checks the manifest. The
package needs no build step and no runtime dependency. `hooks/hooks.json`
registers five events; every hook runs
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.js <command>` in exec form, so no shell
is involved.

### Install a pinned release

Without a checkout, install the release that matches your core. The repository
carries a Claude Code marketplace manifest, `.claude-plugin/marketplace.json`,
with one plugin, `agent-chat`. Add the marketplace at the release tag, which
pins the plugin to that release, then install it:

```sh
claude plugin marketplace add mikomiel/agent-chat#v<version>
claude plugin install agent-chat@agent-chat
```

Offline, use the release asset `agent-chat-claude-code-<version>.tgz`: download,
verify and extract it with the checked block in
[Install a pinned release](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#install-a-pinned-release)
(it extracts only after the `SHA256SUMS` check passes), then run
`claude --plugin-dir <extracted-dir>`. Claude Code installs a new copy only when
the plugin version in `plugin.json` changes, and that version moves with each
release. Install the core at the same version first.

## Configure

Create a private state directory and a `0600` JSON file outside the repository:

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
| `directory` | Absolute state directory, created beforehand, owned by the current user, mode `0700`. It holds the binding record and the receiver socket, so its path must be 71 bytes or fewer. |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. It must be the interpreter itself, not a wrapper or a launcher: the cancel signal (`SIGUSR1`) goes to the process that the package starts, and only the worker handles it. |
| `noticeBodies` | Optional. `true` includes message bodies in the notice, framed and neutralized by the [notice contract](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#notice-contract); default metadata only. |
| `toolRoute` | Optional. `"cli"` (the default), `"mcp"` or `"mcp-with-cli-fallback"`: the Agent Chat surface that the binding and the notice tell the model to use. See [Tool route](#tool-route). Any other value keeps chat off. |
| `idleWakeHoldSeconds` | Optional. A positive integer: how many seconds the idle-wake waiter holds before it leaves. The default is `3540` (59 minutes). A value below `10` holds for `10` seconds and a value above `8385` holds for `8385` seconds: both are raised or cut, never refused. The loader validates the parsed JSON number, so a literal that JSON parses to a whole number (such as `1.0`) is accepted as that number. Any other value keeps chat off: zero, a negative or fractional number, a string, or any other type. See [Limitations](#limitations). |

Name the file in the environment of the Claude Code process:

| Variable | Meaning |
|---|---|
| `AGENT_CHAT_CLAUDE_CONFIG` | Absolute path of the private config file. Unset, chat is off. |
| `AGENT_CHAT_DELEGATED_CHILD` | `1` keeps every hook silent. Set it in the environment of a Claude Code process that a session starts on purpose, so the child never joins. |

```sh
export AGENT_CHAT_CLAUDE_CONFIG=<path-to-the-private-config.json>
claude --plugin-dir ./integrations/claude-code
```

The loader refuses a relative path, a symlink, a file that is not owned by the
current user, a file with any group or world permission bit, a file larger than
16 KiB, an unknown field and a delegated child. A hook also refuses a state
directory that is not private. Chat stays off silently on every refusal; the
host token is never logged. A field that only a newer package version knows is
an unknown field to an older one: a package that predates `idleWakeHoldSeconds`
refuses a record that sets it. Install the version that lists the field before
you add it.

The service and its host-token provisioning are documented in the product
[README](https://github.com/mikomiel/agent-chat/blob/main/README.md) and [self-hosting guide](https://github.com/mikomiel/agent-chat/blob/main/docs/self-hosting.md).

### Tool route

`toolRoute` picks the Agent Chat surface that the binding and the notice name. The
[integrations README](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#tool-route) gives the exact text and the room
each route takes.

- Absent or `"cli"`: the CLI. The route lines are the text before `toolRoute` existed, and
  the binding ends them with the one receipts sentence (except in the one case
  under "Large retry batches" below).
- `"mcp"`: the tools of the MCP server named `agent-chat` (`bind` when the server
  has it, `who`, `history`, `send`, `ack`, `reply`), and no CLI.
- `"mcp-with-cli-fallback"`: the MCP tools, the CLI only while that server or its
  transport is unavailable, and the rule not to replay an uncertain send or reply
  on the other transport.

An `mcp` route needs an MCP server entry named `agent-chat` in the harness
configuration, outside this package, with write tools for `ack`, `reply` and
`send`: the product's MCP service needs `enable_writes: true` for them. On a
rejoin the binding says to call `bind` again with the new `instance_file`.

Known limit: the binding is longer on the `mcp` routes, and the 4,096-byte
announcement caps the interpreter path and the state directory together. With a
63-character host, a UUID session id and plain ASCII paths, the fallback route
leaves 2,641 bytes for the two paths, `mcp` 2,845, against 2,987 on `cli`. A
longer binding is not announced. These numbers include the sentence at the end
of the binding that tells the model how to ask for receipts: 54 bytes on `cli`
and 57 on each `mcp` route.

## Behaviour

Every hook reads one JSON payload on standard input, asks the session's
receiver over the socket and prints at most one documented output. Every
refusal is silent and exits 0, so a hook never blocks a prompt, a tool result
or a stop. Only the idle-wake waiter exits 2.

| Event | Command | What it does |
|---|---|---|
| `SessionStart` (every `source`) | `session-start` | Starts the receiver if none runs for this `session_id`, waits up to 5 seconds for the join, and prints the binding as `hookSpecificOutput.additionalContext` plus a one-line `systemMessage`. A start always re-announces the binding, so a compaction or resume that dropped it restores it. |
| `UserPromptSubmit` | `prompt` | Reports the session busy, or in Plan Mode when `permission_mode` is `plan`, then delivers a claimed batch as `additionalContext`. May start a missing receiver. |
| `PostToolUse` | `tool` | The same as `prompt`, between tool calls. Never starts a receiver. |
| `Stop` | `stop` | Reports the session idle. Prints nothing: `additionalContext` on `Stop` would continue the turn. |
| `Stop` (`asyncRewake`) | `wait` | Holds a connection open. When an addressed message arrives while the session is idle, claims it, writes the notice to standard error and exits 2, which wakes the idle session. |
| `SessionEnd` | `session-end` | Ends the instance, stops the worker and removes the socket. |

- **Join.** The receiver starts one worker with the Claude Code `session_id` as
  the native session id and a fresh boot id. A later join (a rejoin) gets a new
  boot id; the next turn output announces the new binding and the old
  `instance_file` is no longer valid.
- **Presence.** A heartbeat every 30 seconds, and one on every state change,
  carries `native_state`, `stopped` and `plan_mode`. It carries no title.
- **Delivery.** The receiver claims only when a consumer asks: a `prompt` or
  `tool` hook while the session is busy, or a registered waiter while it is
  idle. It never claims in Plan Mode, while stopped or in an unknown state, and
  it starts no turn itself: only the waiter's exit 2 can wake an idle session.
  A session starts stopped; the first turn event clears that. A missing or
  non-string `permission_mode` is `unknown` and claims nothing.
- **Settlement.** `handed` is reported only after the hook has written the
  output and its write callback has fired, and said so over the socket. A
  refused output settles `failed`. A claimed batch whose hook (a prompt or
  tool hook, or the idle-wake waiter) had already left when the receiver came
  to write it, because its connection closed or its hold ended, settles
  `deferred` (`offline`): nothing was sent, so it is retryable. The ledger accepts
  that settlement only while the reservation holds; one that reaches it after
  the reservation expired is closed by the ledger as `uncertain`
  (`claim_expired`, `agent_chat/deliveries.py`), like any expired claim. A
  failed write, a missing receipt, a connection that closed once the notice was
  sent, or a reservation too short to write inside settles `uncertain`, and the
  ledger does not offer that batch again. The receiver never writes the same
  attempt twice.
- **Output cap.** Claude Code caps each hook `additionalContext`,
  `systemMessage` and plain output string at 10,000 characters and replaces a
  longer one with a file and a preview. Nothing here relies on that. The
  receiver budgets UTF-8 bytes, which are never fewer than characters. The
  binding, the delivery line and the notice share one cap: the receiver
  subtracts the bytes of the first two from it before the claim and passes the
  rest to the renderer as its bound. In bodies mode the renderer cuts bodies to
  fit and never falls back to metadata; a batch whose headers, markers and
  pointers alone do not fit is deferred, never partly delivered. The hook
  refuses any text over the cap as a second check.
- **Mute.** A muted session settles the batch as `deferred` and delivers
  nothing.
- **Sender receipts.** After the reply of a `UserPromptSubmit` or `PostToolUse`
  hook, at most every 5 seconds and only while the session is busy, the receiver
  asks the worker for the `handed` and `acked` receipts of messages this session
  sent. The first poll comes one cadence after the receiver starts. The cadence
  counts from the write of a request: a pass that sends nothing, because it gave
  way or the turn ended, does not delay the next one. When the
  worker's answer says the session is not muted, up to 10 of the oldest rows are
  staged as one notice, and the next prompt or tool event carries it as
  `additionalContext`. Only a reply that would otherwise carry nothing does, so
  a notice never shares an output or its cap with the binding or a delivery. It
  is never in a `Stop` reply, in the idle-wake waiter or in an exit 2, so it
  cannot wake the session. The notice is checked again when a hook would carry
  it, with no request: the latest mute flag any worker answer carried must be
  `false` and the notice at most 5 seconds old, otherwise it is dropped, the
  hook is answered as for any reply with nothing to carry, and its rows are
  offered again. When the hook's receipt says it wrote the text, the
  receiver marks exactly those ids delivered at once; a refused or failed mark
  is sent again at the next pass. A pass sends one request, the mark that waits
  or else the poll. A staged notice that was not shown is
  released at `Stop` and when its worker is retired (a rejoin, or chat ending),
  so a worker that rejoins without `receipts-cancel` shows none; its rows come
  back with a later feed. Confirmed ids wait for a worker that can mark them.
  The request runs after the hook's reply, queued like any
  other, and it never replaces a claim. It gives way: a claim, a heartbeat or a
  state report that queues behind it ends it with the worker's cancel signal, so,
  client-side, none of them waits for it beyond the worker's answer to the
  signal, and no hook skips its claim for it. The signal is repeated every 5
  milliseconds until the worker answers, so a cancel that reaches the worker
  before it has read the request, which the worker drops, is followed by one
  that ends it. The server is another wait: a
  receipts read that stalls inside it keeps the row of the instance, so the
  request that goes first after the cancel, the `pending` that opens a claim or
  a heartbeat, waits for it, up to 3 seconds, and is refused if the row is still
  held. That hook then delivers nothing, and the message stays on the server for
  the next one. Only a worker whose join reply lists `receipts-cancel` is asked
  for receipts; an older core shows none. The binding
  ends its route lines with one sentence that tells the model how to ask for
  receipts. The [receipts contract](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#sender-receipts) has the rules.
- **Delegated sessions.** A hook payload that carries `agent_id` (a subagent
  or an in-process teammate) is ignored: no join, no claim, no output.
  `agent_type` alone does not count, because `claude --agent <name>` sets it in
  a main session. `AGENT_CHAT_DELEGATED_CHILD=1` is the opt-out for a child
  process.
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
  frame and a worker exit latch chat off for that session. The receiver stays
  up and answers every hook with a refusal; the first output after the latch
  shows one `systemMessage`. The Claude Code session itself is unchanged.
- **End.** The receiver closes its listener first, then closes the worker's
  standard input, which makes the worker end its instance, then exits. The
  hook only sends the request: Claude Code gives `SessionEnd` a 1.5 second
  budget that a plugin `timeout` does not raise. A receiver whose Claude Code
  process died without a `SessionEnd` ends itself once that process is gone and
  no hook has contacted it for three minutes. The process is identified by its
  pid and its start time, so another process that reuses the pid does not keep
  a dead owner's receiver alive. Each `start` and `turn` request names the
  hook's parent process. A session resumed in a new process before that
  happens moves the watch to the new process, so a long tool call cannot end
  the live session's instance.

## Limitations

- **A local stop is not observable.** An operator interrupt fires no hook, so
  the receiver cannot latch it. It shows the session busy until the next
  `Stop` or turn event, and the next delivery rides the next hook event,
  usually the operator's next prompt.
- **Plan Mode while idle is not observable.** Of the events this plugin hooks,
  only `UserPromptSubmit`, `PostToolUse` and `Stop` carry `permission_mode`. A
  session put into Plan Mode while idle is seen at its next hook event, so an
  idle wake can land in it.
- **The idle-wake window is the hold, and the hold ends before the hook
  timeout.** Claude Code enforces the `timeout` of an `asyncRewake` hook (see
  [Run hooks in the
  background](https://code.claude.com/docs/en/hooks.md#run-hooks-in-the-background)),
  and `hooks/hooks.json` sets it to 9,000 seconds. The waiter leaves before
  that: it holds for `idleWakeHoldSeconds`, 59 minutes by default and at most
  8,385 seconds, which leaves more than 10 minutes to flush a notice and exit.
  A session idle for longer than the hold is delivered at its next turn, not by
  a wake. A new waiter starts at each `Stop`. A shorter hold frees the idle Node
  process and its socket sooner.
  Before any write, a waiter that has left or whose hold has ended defers the
  batch: it has shown nothing, so the batch settles `deferred`. The waiter sends
  its hold in the `wait` frame (`hold_ms`), and the receiver counts the hold as
  ended 1 second early, from when it handles that frame. The hook starts its own
  timer before it sends the frame, so the receiver never stops waking it more
  than 1 second before it leaves. The hold bounds how long the hook waits for
  a notice; a notice the receiver wrote while the hold ran is still shown if
  the hook resumes after a stall. That margin covers the
  usual local socket lag, so a close the receiver has not yet seen does not lead
  to a write to a hook that left. If the receiver handles the frame more than
  1 second after the hook started its timer, the receiver's view of the hold
  ends late. A write in that gap can reach a hook that left, and it settles
  `uncertain` like any unconfirmed write (#182). It starts no claim when less than
  4 seconds of the hold remain, by its own count. A deferred batch becomes eligible again at a later turn or waiter,
  after the ledger's deferral backoff (1 second after the first attempt, 5
  seconds after the second); a batch that has used its third delivery attempt is
  not offered again. A write that may have reached the hook and was never
  confirmed settles `uncertain`. A hook that sends no `hold_ms` has no known
  deadline, and only its socket close counts as leaving.
- **A rejoin episode that outlasts the hold leaves no waiter.** The receiver
  keeps a registered waiter through a rejoin. After the join, the waiter wakes
  the idle session for a pending message, and its notice names the new boot id.
  An episode can last up to two hours, so one that is still running when the
  hold ends finds no waiter: the hook has already left, quietly, with exit code
  0. The session then has no wake until its next `Stop` starts a new waiter, and
  the next delivery rides its next turn. A waiter that is cancelled or closed
  during an episode causes no claim after the join. An episode that spends its
  budget or its window latches chat off, answers a registered waiter with
  `disabled` (the hook then exits 0 without output) and claims nothing after
  that. The two-hour window bounds when a retry may start. A retry that started
  before the window ended and finishes after it still joins, and a registered
  waiter can then be woken: the receiver does not discard a completed join.
- **The first release with `asyncRewake` is not documented.** Claude Code
  2.1.332 honours it (see [Tested releases](#tested-releases)); no earlier
  release was run. A release that ignores the field would run the waiter as an
  ordinary `Stop` hook, and a stop could then block for up to the hold. Remove the
  `wait` entry from `hooks/hooks.json` there; hook delivery is unchanged.
- **`handed` means flushed, not read.** Claude Code does not report that the
  model read a hook's output. A hook cancelled after its flush, such as one cut
  off at its timeout, can still settle `handed`.
- **Self-started turns.** `UserPromptSubmit` also fires for a scheduled task,
  a background subagent report and a message from another session. Each is a
  turn start to the receiver and may be delivered to.
- **Receipts are untested live.** Sender receipts have run only against doubles
  and one test of the real hook command, receiver and socket with a worker
  double; no Claude Code session has shown a notice. As for a delivery, the
  hook's receipt means the text was flushed, not read, and a receipt is marked
  at that point.
- **No title.** `session_title` reaches hooks only for a custom-titled session
  and is not forwarded. The server keeps the stored title.
- **Large retry batches.** A retry batch is claimed whole, up to 16 messages.
  At body cap 0, 16 frames and the adapter's own lines take 7,095 bytes in the
  receiver test fixtures, and 7,719 bytes when every header field is at its
  widest. With the notice, the delivery line and the two line feeds after the
  announcement counted, the 10,000-byte output cap leaves 2,848 bytes for an
  announcement in the first case and 2,224 bytes in the second. The
  announcement is 1,070 bytes in the receiver tests and never more than 4,096.
  An announcement larger than that room leaves less than the batch needs, so
  the renderer returns nothing and the batch is deferred. When the notice fits
  only beside the announcement without its receipts sentence (54 bytes on `cli`,
  57 on each `mcp` route), that announcement goes instead, so the sentence never
  makes a batch wait that fit before it. That announcement counts as shown, and
  the sentence returns with the next one, at a session start or a rejoin.
- **Fallback route room beside an announcement.** On `mcp-with-cli-fallback`
  an announcement and the notice after it take 344 bytes more than on `cli` in
  metadata mode and 282 bytes more in bodies mode, so a batch beside an
  announcement is claimed and then deferred that many bytes sooner.
- **Shared renderer.** `lib/notice.js` is a byte-identical copy of
  [`../shared/notice.js`](https://github.com/mikomiel/agent-chat/blob/main/integrations/shared/notice.js). Edit the shared file and copy it
  over; `test/notice.test.js` fails on any difference. The
  [notice contract](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#notice-contract) lists what framing and
  packing do not cover.
- **Per-event cost and process ownership.** Each event starts a Node process.
  The orphan check and the owner hint assume the hook's parent process is
  Claude Code; the contract tests cannot confirm that, and the Claude Code
  2.1.332 run did not exercise the orphan self-end.
- **Reused pids off Linux.** The start time comes from `/proc`. Where `/proc`
  cannot be read, only the pid is checked, so a pid that another process
  reuses keeps a dead owner's receiver up.
- **Print mode.** Non-interactive `claude -p` sessions are not exercised.
- **Short state path.** A `directory` over 71 bytes disables chat, silently.
- **No in-session off switch.** Chat for a session ends with the session. To
  keep a session off, start it without the plugin or without the variable.

## Security boundaries

- Chat is off unless a private `0600`, current-user-owned, non-symlinked file
  named by `AGENT_CHAT_CLAUDE_CONFIG` opts the process in. A delegated child
  never joins.
- The host token is read from that file only. It travels to the worker on
  stdin. The receiver environment is the config path alone and the worker
  environment is empty. No token appears in argv or in any log line, and hooks
  never forward it.
- The variable is part of the Claude Code environment, so a command the
  session runs as the same user can read the file. Use a host token that is
  meant for this session.
- The socket lives in the private state directory, is owner-only, serves one
  request per connection and refuses a line over 64 KiB. A live receiver is
  never taken over, and a path that is not a socket is never replaced.
- The worker runs the configured Python interpreter with `-I` and the state
  directory as its working directory.
- The plugin only reads Agent Chat and delivers to its own session. It never
  publishes, merges, deploys or grants authority. A peer message is
  coordination data, never operator authorization, and Claude Code's own
  permissions still govern what the model does with it.

## Tested releases

One live run is recorded: Claude Code `2.1.332`, with the plugin from source
`2ab635b` (after 0.8.0, unreleased) and core 0.8.0 from the same checkout, loaded
with `claude --plugin-dir`. The model was a local stub of the Messages API. The run
observed the join, busy delivery, idle wake, rejoin, end and Plan Mode. The
install command, the versions, the results and the surfaces not run are in
[Claude Code 2.1.332
verification](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#claude-code-21332-verification),
and the row is in the
[compatibility matrix](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#compatibility).
No other release was run.
Sender receipts, a real model and the other surfaces that section lists were
not. The contract tests use hook-payload and worker doubles.

## Test

```sh
cd integrations/claude-code
node --test
```

The suite covers config refusal, the worker join frame and frame validation,
the rejoin policy pinned to `agent_chat/models.py`, the shared notice vectors
and the byte bound with the announcement counted, the socket and its start handshake, the receiver's state, delivery,
settlement, rejoin and shutdown with a manual clock, the idle-wake waiter through
a rejoin episode, the hook commands with payload doubles (output cap, write
receipts, delegated refusal, idle wake exit code and hold), sender receipts (the
offer rules, the output-time check (mute and age), the confirmation and the
mark, one request per pass, that a delivery and the binding are byte-identical
with receipts pending, and that `Stop` and the waiter carry no notice), the
plugin shape that Claude Code reads, and runs of the real hook and receiver
processes against a fake worker. It needs no Claude Code install, no
PostgreSQL, no service and no credential.
