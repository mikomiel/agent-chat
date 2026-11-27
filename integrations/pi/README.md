# Pi integration

A Pi extension that joins an Agent Chat session, delivers claimed messages to
the Pi conversation and keeps the binding in the system prompt. It runs the
product's `agent_chat.instance_worker` as a child process, so join, heartbeat,
pending, claim and settle stay in the Python core. The extension supplies the
native state, the delivery callback and the bounded rejoin scheduler.

## Requirements

- Pi with extension support (the [compatibility matrix](../README.md#compatibility) lists the API surface and
  the releases that were run).
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
- **Presence.** A heartbeat carries `native_state`, `stopped`, `plan_mode` and the
  session title when Pi exposes one. It goes out every 30 seconds and whenever that
  snapshot differs from the last one the worker confirmed: the 2-second poll makes the
  comparison, so an idle or busy change, a stop change, a Plan Mode flip or a new title
  reaches peers within one tick, and an unchanged state sends nothing extra.
  A changed snapshot that comes back `refused` stays unconfirmed, so the next poll
  sends it again; a refused keep-alive waits for the next 30-second heartbeat. A new
  instance after a rejoin starts with nothing confirmed. A heartbeat of a changed snapshot
  that is refused as `REQUEST_UNCERTAIN` may have been applied, so it leaves nothing
  confirmed either: the next comparison sends the current state. The other two brief
  refusals sent nothing. A refused heartbeat of the snapshot that the worker already
  confirmed, a keep-alive for example, changes nothing whatever the code: the worker holds
  that state either way, and it stays confirmed.
  A poll that finds another request in flight (a delivery poll, a claim, a settlement
  or a heartbeat) sends nothing, because a heartbeat of that state may be among them.
  It asks for one more comparison, which is made when the request is done, before the
  next request is chosen: a change seen during a slow request goes out right after it,
  ahead of a delivery poll or a receipts request that waited behind it, not at a later
  poll; the one exception is a delivery poll that waited behind a heartbeat, which goes
  first (see the turns below). A change that has reverted by then sends nothing, because
  presence reports the current state.
  A refused heartbeat is sent again at most once for each poll or event that asked, never in a loop.
  One rule chooses the next request, and it reads what is due from facts when it chooses, not
  from a flag that an earlier request left set. A heartbeat is due when one was asked for
  outright (the 30-second keep-alive, a new title, the join), or when a poll or an event asked
  for a comparison and the state is not the one that the worker confirmed. In one instance,
  a heartbeat and a delivery poll take turns, whether the worker confirms or refuses. A due
  heartbeat goes first, unless a heartbeat has gone in this run since the last delivery poll
  pass and a poll waits: then the poll goes first, and its pass gives the turn back. So at
  most one heartbeat goes between a poll tick and the next delivery poll, and at most one
  delivery poll pass goes between a heartbeat falling due, by a keep-alive or a changed
  state, and the next heartbeat; a further pass goes only when the state is the confirmed
  one as that pass is chosen and no keep-alive asked: a state that has returned to the
  confirmed one while it waited is not sent.
  A heartbeat that is refused after every tick, or a title that changes during every slow
  heartbeat, would otherwise be followed by another heartbeat each time, and the poll would
  never run. Each run starts with no heartbeat sent, so the entry that starts it may send a
  due heartbeat before its poll, once, and so does the first run of a new instance: a refusal
  that ends an instance, `STALE_INSTANCE` for one, is followed by the rejoin and that first
  heartbeat, so two heartbeats can go between one tick and its poll. A keep-alive that comes
  while a heartbeat is out goes after a poll that waits, so the order is heartbeat, poll,
  heartbeat. A receipts request goes last, when nothing else is due, and its pass does not
  give the heartbeat's turn back.
  The same rule decides whether an entry ends a receipts request in flight (see the receipts
  bullet): it counts that request as waiting, and ends it unless it is what goes next.
  `session_tree`, `session_compact` and `session_compact_failed`
  ask for the same comparison at once, with the context they carry; the poll finds the
  same change, so nothing depends on them.
- **Footer and lease.** The footer shows one of `Agent Chat: ready`, `busy`,
  `plan mode`, `paused`, `stopped (type to resume)`, `reconnecting` (while a rejoin
  episode runs) and `no live instance`. The extension mirrors the core's instance lease:
  an instance is live for `LEASE_SECONDS` (90, pinned to `agent_chat/models.py` by
  `test/lease.test.js`) after the join or heartbeat that the worker answered without
  `refused`, counted from the moment the request was sent, on a monotonic clock and on the
  wall clock: the core counts on wall time and a monotonic clock stops while the host is
  suspended, so the lease is over when either one has counted the 90 seconds. A lapse
  holds until a heartbeat is answered without `refused`: a wall clock that is set back
  afterwards does not bring the state text back first. When the
  monotonic deadline passes, a timer on it (not the poll) sets the footer to
  `Agent Chat: no live instance`; a lapse that only the wall clock shows, as after a
  suspend, is set by the next poll tick, whatever request is in flight then. It replaces
  the state text whatever the state was, `busy` and `plan mode` included; the next
  confirmed heartbeat restores the state text. The lapse itself is a
  footer change only: it starts no rejoin episode, withdraws no binding and raises no
  fault, and what starts an episode is unchanged (see Rejoin). After a fail-closed stop
  and after `/agent-chat-off` the footer says `no live instance` too.
  Only `session_shutdown` clears the footer. A Pi process with no valid chat
  configuration registers nothing, so the extension never touches its footer.
- **Delivery.** Every 2 seconds the extension asks for pending messages. It
  claims only while the session is an idle TUI, not stopped, not inside a UI
  prompt and not aborted. A claimed batch becomes one `agent-chat` custom
  message with `triggerTurn: true`; the extension reports `handed` only after
  Pi's `message_start` event carries the same marker object. A missing event
  inside the reservation is `uncertain`, never a replay. If the instance ends while that
  report is awaited, at shutdown or when the worker exits, nothing is settled and no worker
  starts. With `noticeBodies`,
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
  either is due. A state change that the comparison finds then is a heartbeat
  that fell due; a re-evaluation that finds nothing due ends nothing, a state that has
  returned to the confirmed one included. A change of the stop state is such a change:
  a stop, an abort of the turn or the user's input that ends a stop ends the request at
  once when it leaves a state that the worker has not confirmed, and ends nothing when it
  returns the state to the confirmed one. The signal
  is repeated every 5 milliseconds until the worker
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
  `STALE_INSTANCE` still rejoins. A lapsed lease alone starts nothing: when the outage
  outlasts the lease, the worker raises its own error, and that enters this path.
  A rejoin starts its worker only after the worker that it stopped has closed, because
  the new worker joins with the same native session id and would meet `BINDING_CONFLICT`
  while the old worker is still ending its instance. That removes the usual cause, and
  only that one: an exit does not show that the server accepted the old worker's `end`.
  If `end` failed, the worker exits and leaves its instance to the lease, which stays live
  until it expires, and the next join can still meet `BINDING_CONFLICT`. The rejoin path
  retries that after a back-off like any other. The worker's own stop bounds the wait: it
  kills a process that does not exit, 5 seconds after the stop. A child that still reports
  no exit holds the rejoin no longer: the wait ends after 6 seconds at the latest, and a
  join that then meets the old instance is retried the same way.
  The wait has one timer, unreferenced and cleared when the close comes first. After the
  wait the rejoin checks again that the runtime was not shut down and that chat was not
  turned off. The wait, the start and the join are one flight: a call that comes while one
  is out waits for it and starts nothing, so calls whose waits would end at different times
  start one worker, and a failed join is followed by its back-off, not by a second start.
  `disconnect()` ends the instance for good, as shutdown and the off latch do: it stops the
  live worker, and no later `connect()` starts one, nor does the flight that is out. The
  extension calls it only at those two points, and neither is followed by a start. A request
  goes to a worker only through the instance that its caller was started for, so a loop or a
  continuation that outlives its instance reaches no worker, and above all not the one that
  replaced it.
- **Fail closed.** Every other refusal, an exhausted rejoin budget, a malformed
  frame and a worker exit latch chat off for the process. The native session,
  CI and any submitted work are unchanged. The footer then says `no live instance`.
  `/agent-chat-off` is the operator switch.
- **Stop.** A session start, an abort and a non-interactive input source clear
  delivery eligibility; only interactive local input restores it. The footer
  shows whether chat is ready, busy, stopped, planning, paused, reconnecting or has no
  live instance. A stop transition is reported at the next poll or heartbeat.
- **Replacement, compaction and tree.** Pi replaces the extension runtime for
  `/reload`, `/new`, `/resume` and `/fork` (and `/clone`, which is a fork): it emits
  `session_shutdown` to the old runtime, awaits its handlers, loads a new runtime and
  emits `session_start` with the same reason. The extension stops its worker, which
  requests the end of the instance, on `session_shutdown` only, and its handler returns
  once every worker that is still closing has exited, one that a rejoin stopped earlier
  included, so no old worker is still ending its instance when the new one joins, or after
  6 seconds, so a child that never exits cannot hold the replacement for ever. Neither the
  request nor the exit is proof that the server accepted `end`: a join that still meets the
  old instance, because its `end` failed, is retried after a back-off. It subscribes to no
  `session_before_switch` or `session_before_fork`, because another handler can cancel
  those and the instance would end for a switch that never happened. The new runtime
  starts stopped. A chat session is keyed by the native session id: `/reload` and
  `/resume` return to the chat session of that Pi session, and `/new`, `/fork` and
  `/clone` begin one; every join is a new instance with a new binding. The off latch is
  process-wide, so a runtime that replaces a latched one starts no worker and shows
  `no live instance`. `/tree` and compaction keep the runtime, the native session id and
  the binding: nothing is joined or announced again, claims wait while Pi reports the
  session as not idle (which covers compaction and branch summarization), and
  `before_agent_start` sets the binding section at every turn.

## Limitations

- Plan Mode detection follows the `plan-mode` state recorded by Pi's shipped
  example extension, including its startup flag. Use `/agent-chat-off` if a
  different planning extension does not expose that state.
- A wall clock that is set forward shows `no live instance` early, by as much as it was set
  forward. That error is on the safe side, and the next confirmed heartbeat restores the text.
- The lease footer, the replacement contract and the tree and compaction events have run only
  against a harness double. No live Pi run has shown them.
- Claims wait during compaction and branch summarization because `ctx.isIdle()` is false then
  in Pi 1.5.2's implementation. Pi's documentation promises it only for agent runs and
  retries, so a contract test with a double pins the behaviour here and Pi does not.
- Sender receipts have run only against a harness double. The mark waits for
  `message_start` with the message's marker, as the Pi 1.5.2 source emits it for
  a `triggerTurn: false` message; no live Pi run has shown it. If a release did
  not emit it, the receipts would be shown again in each later turn and never
  marked.
- A receipts request is the last of the worker's requests: it goes only when
  neither a heartbeat nor a delivery poll is due, and a due heartbeat or a poll
  ends one that is in flight. In any streak of heartbeats or polls that keep
  falling due, such as heartbeats that are refused or a title that changes at
  every tick, heartbeat and delivery poll take turns and a receipts notice
  waits until the streak ends. Presence and deliveries keep their place;
  receipts are late, and the delay deletes none: the server feed offers a
  receipt while its message is retained and the session can still read its room.
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
bodies mode, the lease and the footer vocabulary (a lapse that holds until a confirmed
heartbeat), presence on change (a change seen during a slow request included, sent
ahead of a receipts request that waited behind it and after a poll that waited behind a
heartbeat, a heartbeat that takes turns with the poll whether the worker refuses or confirms
it and whether a poll, an event or the keep-alive asked for it, and a state that returns to
the confirmed one: the scheduler is checked for each of the 16 combinations of what is due
and of whether a heartbeat has gone since the last poll, and for every interleaving of ticks,
events (busy or idle, a new title) and answers (confirmed, refused, refused as
`REQUEST_UNCERTAIN`) to depth 4, from a confirmed state and from a changed one, against the
two turn rules, which are read off the request trace alone), the replacement of the runtime
for each `session_start` reason (a
reload during a rejoin, a close that never comes, calls whose waits end at different times,
a disconnect that no later connect undoes and a delivery whose hand-off is held when the
instance ends, in the first drive of a join too, included), tree navigation and compaction, and sender
receipts: the offer rules, the confirmation and the mark,
one request per pass, that a receipts request gives way (to a due heartbeat and to a poll,
a stop or an abort included, and not to an entry that finds the state confirmed), goes last and does not give back the
heartbeat's turn, and
that a delivery and the binding are byte-identical with receipts pending. It
needs no PostgreSQL, no service and no credential.
