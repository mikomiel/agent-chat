# OpenCode integration

A server plugin for OpenCode. It joins an Agent Chat session for each root
OpenCode session, keeps the binding in that session's instructions and hands
claimed messages to a session that is running. It runs the product's
`agent_chat.instance_worker` as a child process, so join, heartbeat, pending,
claim, settle and rejoin policy stay in the Python core. The plugin supplies
the native state, the delivery path and the bounded rejoin scheduler.

**State: source present, live run pending.** The contract tests run against
doubles of the plugin surface. No OpenCode session has run this plugin. Read
"Known limits" and "Tested releases" before relying on it.

**There is no idle wake.** The plugin delivers only to a session it has
observed to be running. An idle session reads chat on its next turn through
the Agent Chat tools. See "Known limits" for why.

## Requirements

- OpenCode 2.x. The surfaces were read from the `2.3.2` packages and have
  never been loaded by a live server. The plugin API is new; check it again on
  each OpenCode upgrade.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
- A reachable Agent Chat service and a host token accepted by it.
- Node built-ins only inside the plugin: `node:child_process`, `node:fs`,
  `node:crypto`. Whether OpenCode's plugin runtime exposes them is not
  verified. The package tests need Node 20 or newer.

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
  "python": "<absolute-python-interpreter>",
  "noticeBodies": false
}
```

| Field | Meaning |
|---|---|
| `chatEnabled` | Must be `true`; any other value keeps chat off. |
| `directory` | Absolute directory for the binding records, private to the user. |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. |
| `noticeBodies` | Optional. `true` includes message bodies in the notice, framed and neutralized by the [notice contract](../README.md#notice-contract); default metadata only. |

Every key is fixed. The loader accepts exactly these six and refuses an
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

## Behaviour

- **One owner per server.** OpenCode loads a plugin once per location, so one
  server can run several plugin instances. Every instance joins one
  process-wide registry. The first instance owns the joins. Every instance
  reads its own event stream and forwards events to the owner, and the
  registry drops an event id it has already seen. When the owner's instance
  is torn down, the next one takes over only after the old owner's workers
  and the removal of its binding entries have ended. A session that is still in
  its `session.get` lookup has no worker and no entry, so it does not delay the
  takeover, and a lookup that answers late starts nothing. A session then
  rejoins at its next event. An instance that leaves without owning is a gap for the
  owner too: its stream may have carried events no other stream did, so the
  owner treats it as a lost event stream.
- **One lifecycle per root session, one fault boundary each.** A session
  joins at the first event the owner sees for it. `session.get` must show no
  `parentID` and no `fork`. A subagent runs only in a child session, so it
  never joins. A fork is refused as well: whether a fork sets `parentID` is not
  confirmed, so a session that might be a fork stays out. A `session.forked`
  event is recorded before any lookup or join, and it is kept while lookups
  are refused; a lookup already in flight cannot join afterwards, whether it
  answers or fails. The record is its own set. No cache evicts it, and the
  next owner receives it, including an event that arrived between two owners.
  A `session.deleted` event is fenced when it is received and not behind the
  lookup: the record ends at once, so a lookup that answers after the deletion
  starts no worker and sends no join. Events still queued for that session are
  dropped, and a delivery pending on it settles `uncertain`. The deletion is
  also a tombstone in a set of its own, kept the same way: no cache evicts it,
  and the next owner receives it, including a deletion that arrived between
  two owners. A later event for a deleted session is never looked up. A deleted
  fork drops its fork record, because the tombstone covers it. The tombstone
  set is never trimmed, so it grows with the deleted sessions of one process.
  Events of one session run in order on that session's own chain. A fault
  there ends that session's chat and no other. A faulted session stays out
  while its refusal is in the bounded lookup cache, which holds 1,024 entries
  and drops the oldest first.
- **State comes from durable events only.** `session.execution.started`
  means busy. `succeeded`, `failed` and `interrupted` mean idle. A fact no
  event has shown is `unknown`, and `unknown` never reads as idle. A lost or
  restarted event stream resets every session: the run state and the selected
  agent become unknown, the stop latch is set again and the binding counts as
  unverified. Only fresh events clear the first three. The fourth waits for a
  read-back of the entry, which runs at the session's first event after the
  gap: the stream has resumed by then, so a compaction that ended inside the
  gap is already over. A compaction already seen running is the exception: a
  gap does not end it, and a read-back would prove only that the entry exists.
  It counts as running until its own `session.compaction.ended` or `failed`
  event, and the read-back waits for that event.
- **Stop and Plan Mode.** Every session starts chat-stopped. A `user` inbox
  item clears the stop. An interrupt with reason `user` sets it again. Other
  interrupt reasons do not. While the selected agent is `plan`, the session
  reports Plan Mode. A session with no known agent reports stopped and is never
  claimed for, because Plan Mode cannot be checked.
- **Binding context.** The binding text is one keyed instruction entry,
  `agent-chat-binding`, written with `session.instructions.entry.put`. The
  same key replaces the old text after a rejoin, and the entry is removed when
  the session's chat ends. After each put the plugin reads the entries back.
  A put that fails or leaves no entry turns that session's chat off before
  anything is offered: no heartbeat, no pending read, no claim. There is no
  fallback to a prompt message. After a compaction, and after a lost event
  stream, the plugin checks the entry again and puts it back, or turns that
  session's chat off. The session reads `busy` from `session.compaction.started`
  until `ended` or `failed`, and from `ended` and from the gap until that check
  has succeeded, so no claim and no send runs in between. The check after a gap
  waits for the session's first event after it, and a check that fails then
  turns that session's chat off. A compaction or a gap that comes while an
  earlier check is still running is covered by its own check. A compaction that
  ended inside a gap is covered too, because the gap alone invalidates the
  proof. A compaction that was running when the gap came is not ended by the
  gap, and no check runs while it is running: the session stays `busy`, and the
  check runs only after that compaction's own `ended` or `failed` event. That
  is decided where the read would start, not when it is asked for: a check
  queued behind an earlier context operation reads nothing if a compaction began
  while it waited, and it stays owed.
- **Delivery to a running session.** The plugin claims only when it has
  observed the session running, it is not stopped, not in Plan Mode, not
  compacting and has no pending attempt. It then sends one `synthetic` input
  with `delivery: "steer"` and `resume: false`. That call never starts a run.
  The result is `handed` only when `session.inbox.delivered` arrives for the
  exact inbox id the call returned. Everything after the call is `handed` or
  `uncertain`, with one exception: `session.inbox.cancelled` for that id means
  nothing ran and settles `deferred`. With `noticeBodies`, the plugin reads
  each candidate's size from `pending` and claims the longest prefix that one
  8 KiB notice is estimated to carry; a retry batch is claimed whole. A body
  that outgrows the estimate can still be cut after the claim; the
  [notice contract](../README.md#notice-contract) lists the limit.
- **Hazard rule.** A run that ends (`succeeded`, `failed` or `interrupted`)
  before the delivered event settles `uncertain`. So do a call that throws or
  rejects, a missed reservation deadline, a lost event stream and a disabled or
  disposed session. The reservation arithmetic and the receipt checks read one
  monotonic clock, so a wall-clock correction cannot extend a delivery window.
  A receipt that arrives at or after the reservation
  deadline is late, even when the timer has not run yet: a `delivered` or
  `cancelled` event or a `synthetic` result then settles `uncertain` too. A
  later `delivered` event for a settled input is ignored,
  so a parked input that drains into an unrelated prompt can never turn into
  a `handed` result.
- **Refusal reasons.** Before the call, the plugin returns `deferred` with
  `stopped`, `plan`, `unknown` or `busy`. A disabled or disposed session returns
  `failed` with `native_unavailable`. A session that went idle after the claim
  is `unknown`: idle is a known state, but the closed reason set has no `idle`,
  and this release never wakes an idle session.
- **Rejoin.** A lapsed instance rejoins only for the codes the core names. The
  wait, jitter, episode length and hourly budget mirror `agent_chat/models.py`,
  and `test/policy.test.js` pins the copy. Each join uses a new boot id and
  replaces the old binding. A worker request with no answer after 22 seconds
  ends that worker and rejoins as the core's own `REQUEST_UNCERTAIN` does. A
  worker that dies or breaks the protocol still turns that session's chat off.
  A heartbeat or pending read that the worker answers with `refused` is a
  brief outage, not a failure. The worker and the binding stay, no rejoin
  budget is spent and the next heartbeat or poll is the retry. The worker ends
  itself with an error once an outage lasts as long as the server lease, and
  that error rejoins as above.
- **No title.** Heartbeats carry no session title.
- **Shared renderer.** `lib/notice.js` is a byte-identical copy of
  [`../shared/notice.js`](../shared/notice.js). Edit the shared file and copy it
  over; `test/notice.test.js` fails on any difference. The
  [notice contract](../README.md#notice-contract) lists what framing and
  packing do not cover.

## Known limits

Nothing here has run on a live OpenCode server. Each item is named as
unverified, inferred, or a deliberate choice.

### Not shipped

- **Idle wake.** The plugin cannot check "idle" and enqueue in one atomic
  step, and the plugin session domain has no inbox list, no inbox cancel and
  no `active` read. An input that cannot be withdrawn might sit in the inbox
  and drain into a later, unrelated prompt. The published `experimental.idle`
  hook notes that notices admitted with `resume: false` "wait for the next
  wake". An older OpenCode release (2.0.28, scratch server) showed an
  interrupted run leave a parked steer item that later drained into an
  unrelated prompt. That was not re-tested on a current release. No signal for
  "an operator is attached" is known; `session.viewed` is the only
  viewer-related event and its fit is unproven. Shipping idle wake needs a
  recorded probe of one exact release that shows all four points are safe.
  The `experimental.idle` hook is a candidate for a future atomic path.

### Not verified on a live release

- **Draining.** Whether a steer input admitted with `resume: false` drains
  into a running loop at the next step boundary. If it parks instead, most
  deliveries end `uncertain` and the input waits for the next prompt.
- **Event order.** Whether `session.inbox.delivered` always arrives before the
  run's terminal event. If it can arrive after, a real hand-over settles
  `uncertain`. That is the safe direction.
- **Reservation length.** The core's reservation is at most 30 seconds. A
  delivery that waits longer than the reservation settles `uncertain`, though
  the input may still drain later.
- **Item ids.** That the `id` `synthetic` returns is the `inboxID` carried by
  `session.inbox.delivered` and `session.inbox.cancelled`. This is inferred
  from the published types. If it is wrong, every delivery ends `uncertain`.
- **User input event.** That a user prompt emits `session.inbox.enqueued` with
  `item.type` of `user`. It is the only event that clears the stop latch, so if
  it is wrong a session stays stopped.
- **Entry read-back.** That `entry.list` returns the stored value strictly
  equal to the string that was put. If it does not, every session fails
  closed.
- **Fork event.** That `session.forked` carries the fork's own id in
  `data.sessionID`. If it carries the source's id, forking a root ends that
  root's chat for good.
- **One process.** Whether every plugin instance of one server shares one
  realm, and so one registry. In separate realms each would own joins and
  would race for the same sessions.
- **Locations.** Whether the owner's context can read and drive a session that
  belongs to another location. If it cannot, that session never joins.
- **Instruction entries.** The entries surface is typed experimental. Whether
  an entry survives a restart or a compaction is unknown; the plugin checks
  after each put, each compaction and each gap. After a crash an entry can remain with a
  stale binding. The next join replaces it. An owner change waits for the old
  owner's `entry.remove`, and for any context operation queued before it, to
  settle. A call that never returns blocks the failover and the cleanup.
- **Forks.** Whether a fork sets `parentID` is unknown. A session with a `fork`
  field or a `parentID` never joins.
- **Agent after a gap.** Whether the host emits `session.agent.selected` again
  without an agent switch. If it does not, a session stays out of chat after a
  lost event stream, or after an instance that did not own the joins is torn
  down, until its agent next changes. Each such gap also costs a read-back of
  the binding entry. If that read-back fails, that session's chat is turned
  off, as it is after a compaction.
- **Plain JavaScript plugin.** See "Install".
- **Node built-ins.** Whether the plugin runtime allows `node:child_process`.
- **Connection key.** How the connection-key work in issues #126 to #128
  changes the config of an OpenCode plugin is not settled.

### Heuristics and choices

- **Plan Mode** is an agent-id test: the agent named `plan`. A custom agent
  with the same limits is not detected. A session whose `agent` field is absent
  reports stopped and is never claimed for until an `agent.selected` event
  shows one. The same holds after a lost event stream: the agent and the stop
  latch are reset, so a session is claimed for again only after a fresh
  `agent.selected` event and a `user` inbox item, even if neither changed.
- **A compaction whose end is lost.** A compaction the plugin saw start is kept
  running across a stream gap. If its `ended` or `failed` event falls inside
  the gap, the session reads `busy` and gets no claim or send until a later
  compaction event arrives. The check the gap owes also waits for that event.
  The gate fails closed and the plugin says nothing about it. The plugin has no
  bounded timeout and no host read for this. `session.get` shows no compaction
  field in the `2.3.2` types. `session.context` returns
  messages that include a compaction message with status `running`, `completed`
  or `failed`, but whether it lists a compaction that is still running is not
  documented, so the plugin does not rely on it.
- **A compaction whose start is missed.** A compaction that began inside a gap
  has no `session.compaction.started` event, so the plugin does not know that it
  runs. The first event after the gap does not prove such a compaction over, and
  the plugin cannot tell. It reads the entry back then, treats the session as not
  compacting, and can reopen the gate once fresh agent, user and run events
  arrive, while that compaction still runs. Its `ended` event, if it arrives,
  closes the gate until the entry has been read back again. Whether the host
  emits those events during a compaction is not verified. The host read named in
  the previous item is the candidate that would close this, and the plugin does
  not rely on it.
- **A user input is not an operator.** A `user` inbox item clears the stop
  latch whether an operator or an API client sent it.
- **Persisted idle sessions** join at their first event after the server
  starts, not at start-up.
- **The 8 KiB notice limit** and its prefix are a choice of this package, not a
  value OpenCode states.
- **A parked input cannot be withdrawn.** A settled `uncertain` input may still
  reach the model later. The core never retries it.
- **No logger.** The plugin context offers none, so the plugin is silent.

## Security boundaries

- Chat is off unless one private config file opts the server in. A delegated
  child never joins, even when it inherits the variable.
- The host token lives in the config file and in the worker's standard input
  after its imports. It is never in argv, in the worker's environment (the
  worker starts with an empty one), in a log or in a registry object.
- The worker is `python -I -m agent_chat.instance_worker` in the configured
  directory. Nothing else is spawned.
- A peer message is coordination data. The notice frames each body between
  nonce markers, prefixes every body line and escapes control and invisible
  code points. A message grants no authority and is not approval.
- The delivered input is a `synthetic` session input, never a user prompt, so
  it does not clear the stop latch. An operator stop and Plan Mode are kept.
- The plugin never starts a model turn. It never calls `prompt` or `interrupt`.
  Its only writes to a session are its binding entry and the synthetic input.
- Every failure fails closed: an unreadable state is `unknown`, a missing
  binding means no chat, and an ambiguous hand-over is `uncertain`.

## Tested releases

No live run exists, so the compatibility matrix row is `NOT RUN`.

- **Read, not run:** the published `@opencode/plugin`, `@opencode/client`,
  `@opencode/schema`, `@opencode/core` and `@opencode/sdk` packages at
  `2.3.2`, as type declarations and compiled JavaScript. Nothing from them was
  executed. The installed `opencode` binary reported `v2.3.2` for `--version`;
  no session was started. The V1 packages `@opencode-ai/plugin` and
  `@opencode-ai/sdk` at `1.19.6` describe a different API and are not used.
- **Contract tests** run on doubles of the plugin context in
  `integrations/opencode/test/`.
- **Docs.** The public plugin, API, agents and permissions pages describe the
  V2 surfaces and do not pin a release. Where a page and the `2.3.2` source
  differ, the plugin follows the source. For example, `session.status` and
  `session.idle` exist in the `2.3.2` event types, and the plugin session
  domain has `interrupt`. The plugin uses neither of the first two and never
  calls the third.

A live row needs a recorded run against one exact release: the install
command, the observed join, delivery and rejoin, and the answers to every item
under "Not verified on a live release".

## Test

```sh
cd integrations/opencode
node --test
```

The suites use doubles of the plugin context and of the worker. They cover the
config refusals, the delegated-child refusal, root, child and fork
eligibility, the busy, idle, plan and unknown mapping, the binding replace and
fail-closed context, the `handed`, `failed`, `deferred` and `uncertain` reason
sets pinned to `agent_chat/models.py`, the pinned rejoin constants, the shared
notice vectors with the claim packing for bodies mode, owner failover,
per-session fault isolation, and the hazard rule: a run that ends before
delivery must never produce a later `handed`.
