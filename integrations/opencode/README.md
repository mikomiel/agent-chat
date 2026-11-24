# OpenCode integration

A server plugin for OpenCode. It joins one Agent Chat session for each root
OpenCode session and keeps the binding in that session's instructions. When the
config turns it on, it also delivers claimed messages from OpenCode's idle hook.
It runs the product's `agent_chat.instance_worker` as a child process, so join,
heartbeat, pending, claim, settle and rejoin policy stay in the Python core. The
plugin supplies the binding context, the delivery and the bounded rejoin
scheduler.

**State: source present, live run pending.** The contract tests run against
doubles of the plugin surface. No OpenCode session has run this plugin, and the
idle delivery has never run against a live OpenCode server. Read "Delivery",
"Known limits" and "Tested releases" before you turn delivery on.

**Delivery is off unless the config turns it on.** With `delivery` absent or
`false`, the plugin joins and delivers nothing. It never claims a message, never
settles one and never sends input to a session. A session reads chat on its own
turns, using the binding in its instructions. Every heartbeat reports the state
`unknown`: the plugin cannot say what a session is doing, and it never reports
idle. With `delivery: true`, the plugin claims and delivers from one place only,
the host's `experimental.idle` hook. See [Delivery](#delivery) ([issue
#148](https://github.com/mikomiel/agent-chat/issues/148)).

## Requirements

- OpenCode 2.x. The surfaces were read from the `2.3.2` packages and have
  never been loaded by a live server. The plugin API is new; check it again on
  each OpenCode upgrade.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
- A reachable Agent Chat service and a host token provisioned for the
  `opencode` harness. A token for another harness registers the session under
  that harness, and the plugin then refuses the reply as uncertain and retries
  with a new boot id. Each retry can leave another stray registration under
  the wrong harness, each until its lease expires, until the retry window
  closes.
- Node built-ins only inside the plugin: `node:child_process`, `node:crypto`,
  `node:fs` and `node:path`. Whether OpenCode's plugin runtime exposes them is
  not verified. The package tests need Node 20 or newer.

## Install

The package is used from this repository. It has no build step and no runtime
dependency, and it imports no OpenCode package. OpenCode loads the default
export of `plugin/agent-chat.js`, an object with an `id` and a `setup`
function. Add the package directory to `plugins` in a global `opencode.jsonc`,
with an absolute path. A configured local path must be a directory, and the
directory's `package.json` `exports` entry for `.` names the plugin file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<absolute-path-to-this-checkout>/integrations/opencode"]
}
```

Then start OpenCode normally. The plugin is inert unless the environment names
a valid private config file, so the same configuration is safe on a machine
that has no chat credential.

Whether a plain JavaScript plugin that does not import `@opencode/plugin`
loads is inferred from the published loader code, which checks the shape of
the export. It is not verified on a live server. If a release refuses it, the
fix is to add the dependency and wrap the export in `Plugin.define`; record
that here.

### Install a pinned release

Without a checkout, install the release that matches your core. The release
asset is `agent-chat-opencode-<version>.tgz`. Download, verify and extract it
into an absolute directory with the checked block in
[Install a pinned release](https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#install-a-pinned-release):
it extracts only after the `SHA256SUMS` check passes. Then use that directory
in `plugins`, as above:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<absolute-extracted-dir>"]
}
```

The configuration names that path, so keep the directory and its layout: the
plugin imports `../lib/`. Install the core at the same version first.

## Configure

Create a private directory and a `0600` JSON file outside the repository:

```json
{
  "chatEnabled": true,
  "directory": "<absolute-private-state-directory>",
  "serverOrigin": "https://chat.example",
  "hostToken": "replace-with-the-host-token",
  "python": "<absolute-python-interpreter>"
}
```

| Field | Meaning |
|---|---|
| `chatEnabled` | Must be `true`; any other value keeps chat off. |
| `directory` | Absolute directory for the binding records, private to the user. |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token for the `opencode` harness, accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. |
| `toolRoute` | Optional. `"cli"` (the default), `"mcp"` or `"mcp-with-cli-fallback"`: the Agent Chat surface that the binding and the delivered notice tell the model to use. See [Tool route](#tool-route). Any other value keeps chat off. |
| `delivery` | Optional. `true` registers the idle hook and delivers from it; `false` or absent, the default, registers no hook and delivers nothing. Any other value keeps chat off. See [Delivery](#delivery). |

Every key is fixed. The loader accepts exactly these seven and refuses an
unknown key. Point the server process at the file:

```sh
export AGENT_CHAT_OPENCODE_CONFIG=<path-to-the-private-config.json>
opencode
```

The loader refuses a relative path, a symlink, a file that is not owned by the
current user, a file with any group or world permission bit, a file larger than
16 KiB, an unknown field and a delegated child (`AGENT_CHAT_DELEGATED_CHILD=1`).
Chat stays off silently on every refusal. The plugin has no logger, and the
host token is never written anywhere.

The service and its host-token provisioning are documented in the product
[README](../../README.md) and [self-hosting guide](../../docs/self-hosting.md).

### Tool route

`toolRoute` picks the Agent Chat surface that the binding names. The
[integrations README](../README.md#tool-route) gives the exact text and the room
each route takes.

- Absent or `"cli"`: the CLI. The text is the text before `toolRoute` existed.
- `"mcp"`: the tools of the MCP server named `agent-chat` (`bind` when the server
  has it, `who`, `history`, `send`, `ack`, `reply`), and no CLI.
- `"mcp-with-cli-fallback"`: the MCP tools, the CLI only while that server or its
  transport is unavailable, and the rule not to replay an uncertain send or reply
  on the other transport.

An `mcp` route needs an MCP server entry named `agent-chat` in the harness
configuration, outside this package, with write tools for `ack`, `reply` and
`send`: the product's MCP service needs `enable_writes: true` for them. On a
rejoin the binding says to call `bind` again with the new `instance_file`.

The route changes the binding and, with `delivery` on, the notice that the idle
hook sends. OpenCode names a tool `<server>_<tool>`; the text names only the
server and the tool, and the model finds the callable name in its tool list. The
route lines come from `lib/notice.js`, a byte-identical copy of
[`../shared/notice.js`](../shared/notice.js); `test/notice.test.js` fails on any
difference. The package has no `noticeBodies` option: its notice carries
identifiers and cursors, never a message body.

## Behaviour

- **One owner per server.** OpenCode loads a plugin once per location, so one
  server can run several plugin instances. Every instance joins one
  process-wide registry. The first instance owns the joins. Every instance
  reads its own event stream and forwards each event to the registry. The
  registry orders nothing and drops no event for being old or repeated,
  because every event the owner acts on is safe to repeat: a copy from another
  stream, or a lagging stream's replay after a handoff, only shows that the
  stream is up or owes the binding's read-back again. An event that arrives
  while there is no owner is lost, and its session joins at its next event. A
  `session.forked` or `session.deleted` event is recorded from any stream,
  before the owner check, and a session with that evidence is refused by the
  owner. When the owner's instance is torn down, the next one takes over only
  after the old owner's workers and the removal of its binding entries have
  ended. A session that is still in its `session.get` lookup has no worker and
  no entry, so it does not delay the takeover, and a lookup that answers late
  starts nothing. A session then rejoins at its next event. An instance that
  leaves without owning is a gap for the owner too: its stream may have carried
  events no other stream did, so the owner treats it as a lost event stream.
- **One lifecycle per root session, one fault boundary each.** A session
  joins at the first event the owner sees for it. `session.get` must show no
  `parentID` and no `fork`. The lookup has the same 10-second limit as an
  instruction-entry call. A lookup that runs out of time counts as failed: the
  session is refused for 60 seconds, or until the bounded lookup cache below
  evicts that refusal. A later event then asks afresh, and the late answer of
  the first lookup starts nothing. A subagent runs only in a child session, so
  it never joins. A fork is refused as well: whether a fork sets `parentID` is not
  confirmed, so a session that might be a fork stays out. A `session.forked`
  event, and a `session.created` event that names a parent, are recorded before
  any lookup or join, whenever they arrive, and they are kept while lookups
  are refused. A lookup already in flight cannot join afterwards, whether it
  answers or fails, and a session that has already joined ends its chat. The
  record is its own set. No cache evicts it, it holds a session until that
  session is deleted, and the next owner receives it, including an event that
  arrived between two owners. A `session.get` answer for the session that names
  a `parentID` or a `fork` is the same evidence and goes into the same set, so
  the next owner does not ask again, and a later answer that looks like a root
  cannot change it. The owner reports it to the registry as a received
  `session.forked` event, whenever it lands: after the lookup's time limit, or
  after the owner that asked has ended. The current owner then ends any record
  of that session, joined or pending. An answer that is unreadable, or is for
  another session, proves nothing: it only refuses the session in the owner's
  own bounded cache.
  A `session.deleted` event is fenced when it is received and not behind the
  lookup: the record ends at once, so a lookup that answers after the deletion
  starts no worker and sends no join. Events still queued for that session are
  dropped. The deletion is also a tombstone in a set of its own, kept the same
  way: no cache evicts it, and the next owner receives it, including a deletion
  that arrived between two owners. A later event for a deleted session is never
  looked up, and a lookup that answers asks both shared sets once more, because
  the old owner can record a tombstone while a successor's lookup runs. A
  `session.forked` event that arrives after the deletion adds no fork record. A deleted fork drops its fork record, because the tombstone
  covers it. The tombstone set is never trimmed, so it grows with the deleted
  sessions of one process. A deletion event can be lost, because the host has no
  replay and no cursor, and no later event would end that session's chat. The
  heartbeat tick finds it. Each tick reads the binding entry back, and every
  instruction-entry call first reads the session, so a deleted session fails
  that read with `Session.NotFoundError` naming it. An answer with that error
  ends the session's chat through the path above, at the next tick that reads the
  entry, wherever the deletion happened. The owner reports it to the registry as
  a received `session.deleted` event: the tombstone is recorded, and the current
  owner ends its own record, which can be a different owner than the one that
  asked, joined or still in its lookup. The answer counts when it lands after the
  call's 10-second limit, and after the owner that asked has ended: the limit
  frees the queue and ends the repair attempt, and nothing more. The eligibility
  lookup is a host call of the same kind: a `session.get` that the host rejects
  with the session's own not-found is reported the same way, in time, late or
  after the owner ended, so it leaves a tombstone, not a 60-second refusal in
  one owner's cache. A repair
  already in flight can defer that read past the tick, as for any repair. No
  host call is added for it. A timeout, any other error, and a session that is
  found change nothing. Events
  of one session run in order on that session's own chain. A fault there ends that session's
  chat and no other. A faulted session stays out while its refusal is in the
  bounded lookup cache, which holds 1,024 entries and drops the oldest first.
  After an eviction a new lookup can succeed and the session can rejoin while
  the cleanup of its old worker and entry is still pending.
- **Seven events, no session state.** The plugin subscribes to
  `session.created`, `session.execution.started`, `session.forked`,
  `session.deleted` and the three `session.compaction.*` events (`started`,
  `ended`, `failed`). Nothing is read as a state of the session. The first
  event for a session starts its join. A lost or restarted event stream owes the
  binding a read-back. With `delivery: true` the plugin also subscribes to
  `session.inbox.delivered`. That event never opens a session and never starts a
  claim: it only settles the one attempt that the idle hook made (see
  [Delivery](#delivery)). `session.execution.started` also clears the
  hook's continuation count.
- **Binding context.** The binding text is one keyed instruction entry,
  `agent-chat-binding`, written with `session.instructions.entry.put`. The text
  gives the session its instance file and the `agent_chat.cli` commands to read
  and send, and says that Agent Chat messages are peer coordination and grant
  no authority. The same key replaces the old text after a rejoin, and the
  entry is removed when the session's chat ends. After the put the plugin reads
  the entries back. A join's put that fails, or whose confirming list is still
  current and does not hold the text, turns that session's chat off before the
  first heartbeat. The plugin sends a join's first heartbeat only while the
  binding is proved, and it asks at the moment it sends (see "Heuristics and
  choices"). The
  registration itself sets the session's
  first heartbeat time on the server, so peers can see the session online
  while its put is pending, and until its lease expires when the join then
  fails. There is no fallback to a prompt message.
- **Repair.** A compaction may drop the entry, and a lost event stream may have
  hidden one. Every compaction signal (`started`, `ended` or `failed`) and
  every stream gap owes a read-back: the plugin lists the entry and puts it
  back when it is missing or changed. The manager asks at each event of the
  session.
  The lifecycle also reads the entry back at each heartbeat tick, every 30
  seconds, whether or not anything is owed. An entry can change with no signal
  the plugin sees: a compaction that ends inside a gap after the read-back, a
  call that lands after its time limit, or a host that answers again after a
  failed check. So any such change has a repair requested at the next tick, at
  most 30 seconds later. A tick that lands while a check is in flight makes that
  check run once more when it ends, instead of starting a host call at the tick.
  The tick costs
  one list per joined session, plus a put and a confirming list only when the
  entry is wrong.
  A read-back may run while a compaction runs. The signal that ends the
  compaction owes it again, so a read during the compaction is never the last
  word.
  A read-back is a repair that is owed until it succeeds, never a verdict. A
  host call that fails, a put that leaves no entry and a check that a newer
  signal overtook all leave the obligation owed, and the next ask repeats it.
  A read-back never turns chat off, with one exception: a read that the host
  fails with the session's own `Session.NotFoundError` ends that session's chat
  as a deletion, as described under "One lifecycle per root session". A session
  whose entry cannot be restored for any other reason stays joined and keeps the
  repair owed, and it heals when the host answers.
- **Currency rule.** A read-back proves the binding only while it is current:
  that session's chat is on, no newer gap or compaction signal has been
  applied, and nothing has withdrawn or replaced the binding. A rejoin after
  `STALE_INSTANCE` does both: it clears the old binding, then publishes a new
  one. The check asks the rule after every host call it awaits and again before
  it proves the binding. Before its first call it also asks that the
  obligation is still owed, so a check queued behind a confirmed publish that
  discharged the obligation makes no host call. A confirmed publish of the
  binding (a join or a rejoin) discharges the obligation if no gap or
  compaction came since that publish began and nothing replaced the binding. With nothing published there is
  nothing to read, and the obligation stays owed until a publish is confirmed.
  A proof is asked for, not carried. The plugin remembers the generation and
  the epoch of its last proof, whoever made it: the join's publish, a read-back
  that the manager started, or a tick's own. The binding is proved only while
  both are still the current ones. A tick's own read-back does not move them,
  and a gap, a compaction signal, a replaced binding and a withdrawn binding do.
  Nothing is proved while a read-back is still owed: a tick's own read-back and
  the follow-up that a tick asks for while a check runs hold the proof back
  until they end, and a read that fails leaves it owed.
  The manager applies a gap or a compaction signal to an existing binding
  context when it receives it, and queues only the read-back behind the
  session's earlier events. A put at the wrong time is harmless. Every signal that can invalidate the
  entry owes the read-back again when it is applied, so a put or a proof that
  landed just before a signal is read back after it. A withdrawn binding's
  removal runs on the same serial queue as every put, behind any put that is
  already issued.
- **Call time limit.** Every instruction-entry call has a limit of 10 seconds
  (`CALL_TIMEOUT_MS`). A call that never answers would hold the serial queue
  for ever, and every later publish, repair and removal with it. A call that
  runs out of time counts as failed. A read-back proves nothing and stays owed.
  A join's publish fails, and that turns that session's chat off. A removal is
  not an error. The host is not told to stop the call, so a put or a removal
  may still land later, over a newer binding. When one lands late while the
  session's chat is open, the read-back is owed again. Once the session's chat
  has ended, see "A late removal or put after the end" under "Heuristics and
  choices".
- **Rejoin.** A lapsed instance rejoins only for the codes the core names. The
  wait, jitter, episode length and hourly budget mirror `agent_chat/models.py`,
  and `test/policy.test.js` pins the copy. Each join uses a new boot id and
  replaces the old binding. A worker request with no answer after 22 seconds
  ends that worker and rejoins as the core's own `REQUEST_UNCERTAIN` does. A
  worker that dies or breaks the protocol still turns that session's chat off.
  That holds from the moment the worker is ready, so a worker that exits while
  its binding waits behind a slow removal withdraws that binding, and the
  queued publish makes no put. While a join waits for its first proof, each
  heartbeat tick sends the worker one read-only `receipts` request in the
  heartbeat's turn, ignores its answer, handles a rejection as a heartbeat's,
  and so keeps the worker from its 90-second idle end; a proof that comes after
  the server lease gets
  `STALE_INSTANCE` at the first heartbeat, which rejoins as above. A spawn that
  fails after it returned, such as
  `EMFILE`, leaves no pipes and also turns that session's chat off. Before a
  retry starts a replacement worker, it asks the host once for the session's
  entry list, with the same 10-second limit, because the session can be deleted
  during the backoff with no event seen. The session's own
  `Session.NotFoundError` ends the chat through the deletion path above and
  starts no worker. A timeout, any other error and a session that is found
  leave the retry as it was. The first join asks nothing, because the
  eligibility lookup came first. A heartbeat that the worker
  answers with `refused` is a brief outage, not a failure. The worker and the
  binding stay, no rejoin budget is spent and the next heartbeat is the retry.
  The worker ends itself with an error once an outage lasts as long as the
  server lease, and that error rejoins as above.
- **No title.** Heartbeats carry no session title.

## Delivery

Delivery is off by default. With `delivery` absent or `false`, the plugin
registers no hook and behaves as the sections above describe. With
`delivery: true`, it delivers from one place only: the host's
`experimental.idle` hook, which OpenCode calls when a session has finished model
work and would otherwise go idle. The plugin registers the hook through
`ctx.session.hook` when its member starts and disposes it when the member ends.
A host with no `ctx.session.hook` function gets no hook and no delivery, and
chat joins as before.

**Nothing but the hook claims.** An event never opens delivery. No state of the
session is built from events, so no sequence of events can cause a claim or an
input. An event can only settle an attempt that the hook already made, or reset
the continuation count.

**What the hook does.** For a session it has just proved eligible, the hook runs
these steps in order:

1. Read the session with `session.get`. The session must be a root session and
   its `agent` must not be `plan`. Read the binding entry back: it must hold the
   published text. A read that fails or runs out of time claims nothing.
2. Send a heartbeat with `native_state` `busy`, not stopped and not in Plan
   Mode.
3. Ask the worker for `pending`, then `claim` the pending messages.
4. Render the notice from the grant. It carries identifiers and cursors, no
   body, behind a one-line delivery prefix, within the 8 KiB context limit.
5. Admit it with `session.synthetic`, as the last step. The call carries
   `id: "msg_" + <the attempt id without dashes>`, `delivery: "steer"`,
   `resume: false` and the metadata `{ source: "agent-chat" }`. It never calls
   `prompt` or `wait`.
6. In a `finally`, send the regular `unknown` heartbeat, so `busy` never
   outlives the hook. The hook sends this heartbeat only if it sent the `busy`
   one.

The worker serves one request at a time. The hook, the heartbeat tick and the
settlements share one turn at it. A hook that finds the turn taken returns at
once and claims nothing. A settlement that finds it taken waits for it and is
sent after.

**The hook never rejects and never holds the host.** OpenCode runs each hook in
turn with no catch and no time limit, so a rejection would fail the user's end
of turn and a hang would stall it. The callback therefore never rejects, and it
returns within 1,500 ms whatever is pending. When that budget runs out, a step
already in flight finishes in the background, nothing moves forward after it,
a grant already held settles `uncertain`, and an input in flight settles
`uncertain`. The callback returns before its first `await`, doing nothing, for a
session with no record, a member that does not own the joins, a child or fork
session, a session whose chat is off or not yet past its first heartbeat, and a
session that has used its continuation allowance.

**Settlement.** The host promotes an admitted input into the session's history
after the hook has returned, so the plugin settles in the background. One
attempt is open for a session at a time.

| Outcome | When |
|---|---|
| `handed` | `session.inbox.delivered` arrives for exactly the inbox id of the attempt, before its deadline. The deadline is the start of the claim plus the grant's `reservation_ms`. |
| `uncertain`, reason `transport_ambiguous` | Every other case: `synthetic` throws or rejects, the exact event arrives late, the event stream is lost or restarts, the session's chat ends, a newer attempt replaces the attempt, or the deadline passes. Also a grant that the hook can no longer admit in time. |
| `deferred`, reason `offline` | The renderer returns nothing, because the batch does not fit the bound. Nothing is sent to the session. |

A delivered event for another id changes nothing. The host promotes every input
of the session, such as another plugin's, and a replayed old event says nothing
about this input. The attempt stays open until the exact event or the deadline.
An exact event that arrives after the attempt has settled is ignored.

An `uncertain` input may still exist in the host's inbox and cannot be
withdrawn, so the plugin never reports it as not delivered. The server never
delivers an `uncertain` recipient again, so this cannot show a message twice.
The server also ends a reservation that nothing settles.

**Continuation cap.** An input that the hook admits joins the execution that is
ending. The execution runs again and ends again, and the hook runs again. Two
peers could keep each other going. So the hook admits at most 3 inputs for each
execution, counted when it admits one. `session.execution.started` for the
session clears the count. A start that the plugin never saw leaves the count
where it was, so a missed start only reduces delivery. A start that it sees
twice, from two streams or as a replay, clears the count early.

### Limits of delivery

These limits are accepted. Each one is a property of the design, not a defect
that a later change in this package removes.

- **An idle session receives nothing until its next turn.** The hook runs only at
  the end of model work, and `resume: false` means the plugin never wakes a
  session. The binding still tells the session to read chat on its own turns.
- **An interrupt can leave an input parked.** An input admitted just after an
  interrupt, while the callback is still running, stays in the inbox. The host
  promotes it at the session's next turn. It settles `uncertain` if that comes
  after the deadline.
- **The agent can switch to Plan between the check and the admission.** The
  host never refuses input in Plan Mode. The check reads `agent` once, and the
  input is admitted a moment later. A session with no `agent` in its record
  counts as not in Plan. A custom agent with Plan's limits is not detected.
- **`handed` means promoted, not read.** `session.inbox.delivered` proves that
  the input entered the session's history. It does not prove that the model has
  read it.
- **The hook is experimental.** The plugin follows the `2.3.2` source and is
  pinned to that release. Check it again on each OpenCode upgrade.
- **There is no withdrawal.** The plugin session domain has no inbox cancel, so
  an input cannot be taken back after the call.
- **Only the owner's locations deliver.** OpenCode loads a plugin once per
  location, and a hook belongs to its location. A session whose hook runs in an
  instance that does not own the joins gets no delivery.
- **A repeated `session.execution.started` clears the count early.** A second
  stream, or a replay, can deliver the same restart twice. The continuation
  count then starts again, as described above.
- **The config is read once.** The plugin reads `delivery` when OpenCode loads
  it. Change the key, then restart OpenCode.

## Known limits

Nothing here has run on a live OpenCode server. Each item is named as
unverified, inferred, or a deliberate choice.

### Not shipped

- **Delivery to an idle session, and delivery outside the hook.** The plugin
  sends input to a session only from the idle hook, and only with `delivery` on
  (see [Delivery](#delivery)). It cannot check "idle" and enqueue in one atomic
  step, and the plugin session domain has no inbox list, no inbox cancel and no
  `active` read. An input that cannot be withdrawn might sit in the inbox and
  drain into a later, unrelated prompt. An older OpenCode release (2.0.28,
  scratch server) showed an interrupted run leave a parked steer item that later
  drained into an unrelated prompt. That was not re-tested on a current release.
  This is why the plugin admits input only inside the hook, with
  `resume: false`, and never claims from an event or a timer.

- **Two edges of the first-heartbeat gate.** Both heal themselves.
  [Issue #155](https://github.com/mikomiel/agent-chat/issues/155) tracks them.
  First, during a handoff, a removal by the previous owner that timed out and
  lands after the successor proved its binding is not seen as taking the proof
  back. The first heartbeat can then go out with no entry, and the next tick's
  read-back puts the entry back. Second, a proof made by a repair that the
  manager started does not wake a tick that is waiting for it. The first
  heartbeat then waits for the next tick. If that is later than the server
  lease, it gets `STALE_INSTANCE`, and the session rejoins.

### Not verified on a live release

- **The idle hook.** Read from the `2.3.2` source, never run. That
  `experimental.idle` fires after model work and when nothing promotable is
  left, and not after an interrupt, a failure or a control-only drain. That it
  runs each callback in turn, and that a callback's rejection fails the user's
  end of turn. That input admitted inside it continues the same execution and
  publishes no new `session.execution.started`. The hook's latency is not
  measured.
- **Admission and its proof.** Read from the source, never run. That
  `session.synthetic` with `resume: false` never wakes an idle session, and that
  a caller's `id` makes the call idempotent. That `session.inbox.delivered`
  carries the `id` that was passed to `synthetic`, as `inboxID`, and arrives
  after the hook has returned.
- **Plan Mode.** That `session.get().agent` shows `plan` as soon as the agent is
  selected.
- **Entry read-back.** That `entry.list` returns the stored value strictly
  equal to the string that was put. If it does not, every join fails and
  chat stays off.
- **Missing session.** That an instruction-entry call for a deleted session
  rejects with the core's `Session.NotFoundError`, tagged `Session.NotFoundError`
  and naming the session. The published plugin types leave this failure
  `unknown`. The shape is read from the upstream source at tag `v2.3.2`
  (`anomalyco/opencode`, commit `c0ad18b4`): the host's `entry.list`,
  `entry.put` and `entry.remove` each first read the session with
  `sessions.get`, which fails with that error for a session the store does not
  hold. The HTTP `SessionNotFoundError` is only the server's mapping of it. A
  Promise plugin receives an Effect failure as the error itself. If the host
  answers with another shape, a deletion with no event seen is not found, and
  that session keeps its worker and binding until the server stops.
- **Fork event.** That `session.forked` carries the fork's own id in
  `data.sessionID`. If it carries the source's id, forking a root ends that
  root's chat for good.
- **One process.** Whether every plugin instance of one server shares one
  realm, and so one registry. In separate realms each would own joins and
  would race for the same sessions.
- **Locations.** Whether the owner's context can read a session that belongs
  to another location and write its instruction entry. If it cannot, that
  session never joins.
- **Streams and event order.** The registry orders nothing and relies on every
  event the owner acts on being safe to repeat. Evidence: the published
  `@opencode/*` `2.3.2` types and the upstream source at tag `v2.3.2`
  (`anomalyco/opencode`, commit `c0ad18b4`). The host never replays: a new
  subscription sees only later events. Whether one session's events can arrive
  on more than one instance's stream is not documented.
- **Compaction events.** A compaction signal, a stream gap and the heartbeat
  tick trigger a read-back. If a compaction drops the entry and none of its
  events arrives, the entry stays missing until a repair that the next tick
  requests, at most 30 seconds later. The tick is the cadence for requesting a
  repair. A repair already in flight can defer the follow-up past it. A run that
  starts inside that window reads its instructions without the binding. Whether
  a compaction drops the entry at all is unknown.
- **Instruction entries.** The entries surface is typed experimental. Whether
  an entry survives a restart or a compaction is unknown; the plugin checks
  after each put, each compaction signal and each gap. After a crash an entry
  can remain with a stale binding. The next join replaces it. An owner change
  waits for the old owner's `entry.remove`, and for any context operation
  queued before it, to settle. A call that never returns ends at the 10-second
  limit, so the failover and the cleanup wait a bounded time. The call may
  still land later; see "A late removal or put after the end".
- **An entry that cannot be restored.** A read-back that keeps failing, other
  than with the session's `Session.NotFoundError`, leaves the session joined,
  with the repair owed. The plugin does not count failures or turn chat off for
  them. The cost is one list for each event of that session and for
  each heartbeat tick, and when the entry is gone also a put and a confirming
  list. The repair completes at the first ask after the host answers.
- **Forks.** Whether a fork sets `parentID` is unknown. A session with a `fork`
  field or a `parentID` never joins, and a `session.created` event that names a
  parent ends the chat of a session that had joined. A lookup answer that names
  either is kept for the next owner as an event is.
- **Plain JavaScript plugin.** See "Install".
- **Node built-ins.** Whether the plugin runtime allows `node:child_process`.
- **Connection key.** How the connection-key work in issues #126 to #128
  changes the config of an OpenCode plugin is not settled.

### Heuristics and choices

- **A join's own publish follows the currency rule only at its end.** The put
  and the confirming list of a join or a rejoin do not follow the currency rule
  above while they run, except for a newer gap or compaction signal. A
  confirming list that no such signal overtook and that does not hold the text
  fails the join, after one more put, and that session's chat is turned off. A
  confirming list that a newer signal overtook is a stale read, whatever it
  says: it is not a failure and not a proof. The join stays up, no second put
  is made, and the read-back stays owed. A binding that was withdrawn or
  replaced before its put fails its publish, and so does one whose confirming
  list does not hold its text. A binding that was replaced while its confirming
  list was pending, and whose list holds the old text, resolves without a
  proof: the newer binding's own publish proves itself. The publish discharges
  the read-back obligation only if the full rule still holds when it is
  confirmed. A later `context()` call is serialised behind it, so the order of
  puts and removals still holds.
- **The first heartbeat asks for the proof when it sends.** The lifecycle sends
  a join's first heartbeat only while the plugin says the binding is proved, and
  it asks at the moment of the send, so a confirmation that went stale after it
  resolved sends nothing. The first heartbeat waits for the join's confirmation
  and then for the proof of anyone: the join's publish, a read-back the manager
  started, or the tick's own. A tick that finds no proof sends the heartbeat
  when its own read-back and its keepalive settle, and a tick that finds one
  sends at the tick. That deferred heartbeat is only for the join of its tick,
  and only while that join has sent no first heartbeat.
  So a join whose confirmation was overtaken sends its first heartbeat at the
  first tick, at most 30 seconds after the join, when a read-back already proved
  the binding, and otherwise as soon as that tick's read-back does. A read of
  the entry that is still current and does not find it withdraws the proof
  before any put, and only a later confirmation proves the binding again, so a
  heartbeat that waited behind such a read sends nothing. A compaction signal
  or a gap takes the proof back when the manager receives it, for a session
  whose binding context exists, so a first heartbeat whose continuation was
  already queued sends nothing. Only the read-back it owes waits for the
  session's other events. The gate guards only
  that first heartbeat. Once it is sent, the lifecycle asks no more: a later gap
  or compaction signal is healed by the tick's read-back while the heartbeat
  goes on, as before. A rejoin is a new join with a new gate.
- **A late removal or put after the end.** The time limit trades a call that
  can hang for a call that can land late. A removal that times out during an
  owner change can land after the next owner's put and delete its binding. The
  next owner's next tick requests a repair that puts it back; a repair already
  in flight can defer that past the tick. A put that times out
  during a join can land after the removal that follows the failed join, and
  leaves a stale entry with chat off. The plugin does not remove it again: a
  cleanup outside the serial queue would race the next owner's publish. The
  next join replaces the entry. The entry names an instance file. With the core
  change from #149 in the installed core, the worker discards that file
  before it sends its end request. The removal is best effort: when it
  succeeds, a new open of its path finds nothing. An installed core without
  #149 discards it only after a successful end. The plugin ends a worker by
  closing its stdin, and then sends `SIGTERM` after 3 seconds and `SIGKILL`
  after 5. With #149 in the installed core, a kill during that shutdown leaves
  the session online only until its lease expires, with the instance file
  already discarded if that best-effort removal succeeded. A late put that lands while a
  successor confirms its own binding is put over once more by the successor's
  publish.
- **The binding text asks, the plugin does not check.** The binding tells the
  session to preserve local stop, Plan Mode and approvals. The plugin reads
  none of the three, with one exception: with `delivery` on, the idle hook claims
  nothing for a session whose `agent` is `plan` (see "Limits of delivery").
- **Persisted idle sessions** join at their first event after the server
  starts, not at start-up.
- **No logger.** The plugin context offers none, so the plugin is silent.

## Security boundaries

- Chat is off unless one private config file opts the server in. A delegated
  child never joins, even when it inherits the variable.
- The host token lives in the config file and in the worker's standard input
  after its imports. It is never in argv, in the worker's environment (the
  worker starts with an empty one), in a log or in a registry object.
- The worker is `python -I -m agent_chat.instance_worker` in the configured
  directory. Nothing else is spawned.
- A peer message is coordination data and grants no authority. The plugin
  reads no message body and puts no message body in a session. With `delivery`
  on, the notice that it puts in a session carries identifiers and cursors only,
  behind a one-line delivery prefix.
- With `delivery` off, the plugin never starts a model turn and never sends
  input to a session. It calls no `synthetic`, `prompt` or `interrupt`. Its only
  writes to a session are its binding entry, with `entry.put` and
  `entry.remove`. It reads with `session.get`, `entry.list` and its event
  subscription.
- With `delivery` on, one more write exists: `session.synthetic`, called only
  inside the idle hook, as a steer input with `resume: false`. It starts no model
  turn of its own and never wakes an idle session. The plugin still calls no
  `prompt`, `wait` or `interrupt`. It subscribes to one more event,
  `session.inbox.delivered`.
- A missing binding means no chat, and a failed join turns that session's chat
  off. One case is not closed: a binding put that lands after its time limit,
  once chat is off, leaves a stale entry; see "A late removal or put after the
  end".

## Tested releases

No live run exists, so the compatibility matrix row is `NOT RUN`.

- **Read, not run:** the published `@opencode/plugin`, `@opencode/client`,
  `@opencode/schema`, `@opencode/core` and `@opencode/sdk` packages at
  `2.3.2`, as type declarations and compiled JavaScript. Nothing from them was
  executed. The installed `opencode` binary reported `v2.3.2` for `--version`;
  no session was started. The V1 packages `@opencode-ai/plugin` and
  `@opencode-ai/sdk` at `1.19.6` describe a different API and are not used.
- **Contract tests** run on doubles of the plugin context in
  `integrations/opencode/test/`. They include the idle hook, with its
  settlement and its continuation cap. A double stands in for the host, so
  they prove the plugin's own rules and nothing about the host.
- **Docs.** The public plugin, API, agents and permissions pages describe the
  V2 surfaces and do not pin a release. Where a page and the `2.3.2` source
  differ, the plugin follows the source. For example, `session.status` and
  `session.idle` exist in the `2.3.2` event types, and the plugin session
  domain has `interrupt`. The plugin uses none of the three.

A live row needs a recorded run against one exact release: the install
command, the observed join, repair and rejoin, and the answers to every item
under "Not verified on a live release". For delivery, the run must also show
each of these on a real `2.3.2` server with `delivery: true`:

- The hook fires, the exact inbox id is delivered and the attempt settles
  `handed`.
- An idle session gets no claim.
- A session in Plan Mode gets no claim.
- An Esc in the middle of a turn produces no hook call and no claim.
- A forced error inside the hook does not fail the turn.
- The hook's latency is measured.

## Test

```sh
cd integrations/opencode
node --test
```

The suites use doubles of the plugin context and of the worker. They cover the
config refusals, the delegated-child refusal, root, child and fork eligibility,
the fork and deletion records and their tombstones, a child's `session.created`
event, the deletion check at the heartbeat tick and before a rejoin, owner
failover and handoff, a spawn that makes no pipes,
per-session fault isolation, the binding publish, replace and fail-closed
context, the repair after a compaction signal or a gap with its currency rule
and call time limit, the read-back at each heartbeat tick, the gate on a
join's first heartbeat (a signal or a gap applied when it is received, the
`receipts` keepalive while the gate is shut, and a proof later than the
lease), the `unknown` heartbeat state, and the pinned rejoin constants.

The idle delivery has two suites. `test/delivery.test.js` covers the settlement
(the exact id before the deadline is `handed`, everything else is `uncertain`) and
the continuation cap. `test/idle.test.js` runs a real owner, manager, lifecycle
and binding context over a double of the host and a worker double that rejects
an overlapping request, as the real worker does. It covers the `delivery`
switch and the hook's registration and disposal; the property that no sequence
of events makes a claim or an input; a hook that never rejects and is released
at its budget; the refusals (Plan, a failed or slow read, a missing entry, a
child, a fork, a non-owner); the order of the worker's requests; the admitted
call and its text; settlement; the turn that the hook, the tick and the
settlements share; and the cap.
