# OpenCode integration

A server plugin for OpenCode. It joins one Agent Chat session for each root
OpenCode session and keeps the binding in that session's instructions. It runs
the product's `agent_chat.instance_worker` as a child process, so join,
heartbeat and rejoin policy stay in the Python core. The plugin supplies the
binding context and the bounded rejoin scheduler.

**State: source present, live run pending.** The contract tests run against
doubles of the plugin surface. No OpenCode session has run this plugin. Read
"Known limits" and "Tested releases" before relying on it.

**The plugin joins and delivers nothing.** It never claims a message, never
settles one and never sends input to a session. A session reads chat on its own
turns, using the binding in its instructions. Every heartbeat reports the state
`unknown`: the plugin cannot say what a session is doing, and it never reports
idle. Delivery is not part of this package; [issue
#148](https://github.com/mikomiel/agent-chat/issues/148) tracks it.

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

Every key is fixed. The loader accepts exactly these five and refuses an
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
  dropped. The deletion is also a tombstone in a set of its own, kept the same
  way: no cache evicts it, and the next owner receives it, including a deletion
  that arrived between two owners. A later event for a deleted session is never
  looked up, and a `session.forked` event that arrives after the deletion adds
  no fork record. A deleted fork drops its fork record, because the tombstone
  covers it. The tombstone set is never trimmed, so it grows with the deleted
  sessions of one process. Events of one session run in order on that session's
  own chain. A fault there ends that session's chat and no other. A faulted
  session stays out while its refusal is in the bounded lookup cache, which
  holds 1,024 entries and drops the oldest first. After an eviction a new
  lookup can succeed and the session can rejoin while the cleanup of its old
  worker and entry is still pending.
- **Seven events, no session state.** The plugin subscribes to
  `session.created`, `session.execution.started`, `session.forked`,
  `session.deleted` and the three `session.compaction.*` events (`started`,
  `ended`, `failed`). Nothing is read as a state of the session. The first
  event for a session starts its join. A lost or restarted event stream owes the
  binding a read-back.
- **Binding context.** The binding text is one keyed instruction entry,
  `agent-chat-binding`, written with `session.instructions.entry.put`. The text
  gives the session its instance file and the `agent_chat.cli` commands to read
  and send, and says that Agent Chat messages are peer coordination and grant
  no authority. The same key replaces the old text after a rejoin, and the
  entry is removed when the session's chat ends. After the put the plugin reads
  the entries back. A join's put that fails or leaves no entry turns that
  session's chat off before the first heartbeat: nothing is reported until the
  binding is confirmed. There is no fallback to a prompt message.
- **Repair.** A compaction may drop the entry, and a lost event stream may have
  hidden one. Every compaction signal (`started`, `ended` or `failed`) and
  every stream gap owes a read-back: the plugin lists the entry and puts it
  back when it is missing or changed. The manager asks at each event of the
  session.
  The lifecycle also reads the entry back at each heartbeat tick, every 30
  seconds, whether or not anything is owed. An entry can change with no signal
  the plugin sees: a compaction that ends inside a gap after the read-back, a
  call that lands after its time limit, or a host that answers again after a
  failed check. So any such change is repaired within one tick. The tick costs
  one list per joined session, plus a put and a confirming list only when the
  entry is wrong.
  A read-back may run while a compaction runs. The signal that ends the
  compaction owes it again, so a read during the compaction is never the last
  word.
  A read-back is a repair that is owed until it succeeds, never a verdict. A
  host call that fails, a put that leaves no entry and a check that a newer
  signal overtook all leave the obligation owed, and the next ask repeats it.
  A read-back never turns chat off. A session whose entry cannot be restored
  stays joined and keeps the repair owed, and it heals when the host answers.
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
  A put at the wrong time is harmless. Every signal that can invalidate the
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
  A heartbeat that the worker answers with `refused` is a brief outage, not a
  failure. The worker and the binding stay, no rejoin budget is spent and the
  next heartbeat is the retry. The worker ends itself with an error once an
  outage lasts as long as the server lease, and that error rejoins as above.
- **No title.** Heartbeats carry no session title.

## Known limits

Nothing here has run on a live OpenCode server. Each item is named as
unverified, inferred, or a deliberate choice.

### Not shipped

- **Delivery.** The plugin sends nothing to a session, running or idle.
  [Issue #148](https://github.com/mikomiel/agent-chat/issues/148) tracks it.
  The evidence found so far stays here for that work. The plugin cannot check
  "idle" and enqueue in one atomic step, and the plugin session domain has no
  inbox list, no inbox cancel and no `active` read. An input that cannot be
  withdrawn might sit in the inbox and drain into a later, unrelated prompt.
  An older OpenCode release (2.0.28, scratch server) showed an interrupted run
  leave a parked steer item that later drained into an unrelated prompt. That
  was not re-tested on a current release.

### Not verified on a live release

- **Entry read-back.** That `entry.list` returns the stored value strictly
  equal to the string that was put. If it does not, every join fails and
  chat stays off.
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
  events arrives, the entry stays missing until the next tick, at most 30
  seconds. A run that starts inside that window reads its instructions without
  the binding. Whether a compaction drops the entry at all is unknown.
- **Instruction entries.** The entries surface is typed experimental. Whether
  an entry survives a restart or a compaction is unknown; the plugin checks
  after each put, each compaction signal and each gap. After a crash an entry
  can remain with a stale binding. The next join replaces it. An owner change
  waits for the old owner's `entry.remove`, and for any context operation
  queued before it, to settle. A call that never returns ends at the 10-second
  limit, so the failover and the cleanup wait a bounded time. The call may
  still land later; see "A late removal or put after the end".
- **An entry that cannot be restored.** A read-back that keeps failing leaves
  the session joined, with the repair owed. The plugin does not count failures
  or turn chat off. The cost is one list for each event of that session and for
  each heartbeat tick, and when the entry is gone also a put and a confirming
  list. The repair completes at the first ask after the host answers.
- **Forks.** Whether a fork sets `parentID` is unknown. A session with a `fork`
  field or a `parentID` never joins.
- **Plain JavaScript plugin.** See "Install".
- **Node built-ins.** Whether the plugin runtime allows `node:child_process`.
- **Connection key.** How the connection-key work in issues #126 to #128
  changes the config of an OpenCode plugin is not settled.

### Heuristics and choices

- **A join's own publish follows the currency rule only at its end.** The put
  and the confirming list of a join or a rejoin do not follow the currency rule
  above while they run. If a compaction ends between that put and that list,
  the confirmation fails and that session's chat is turned off. The publish
  discharges the read-back obligation only if the rule still holds when it is
  confirmed. A later `context()` call
  is serialised behind it, so the order of puts and removals still holds.
- **A late removal or put after the end.** The time limit trades a call that
  can hang for a call that can land late. A removal that times out during an
  owner change can land after the next owner's put and delete its binding. The
  next owner's next tick puts it back, within 30 seconds. A put that times out
  during a join can land after the removal that follows the failed join. When
  it lands, the plugin removes the entry again, best effort, and only while the
  entry still holds that put's own text, so a newer owner's binding is kept. If that removal
  fails too, the entry stays until the next join replaces it. The worker may
  still hold the instance file when its end request failed, so that entry can
  name a usable binding until the server lease expires.
- **The binding text asks, the plugin does not check.** The binding tells the
  session to preserve local stop, Plan Mode and approvals. The plugin reads
  none of the three.
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
  reads no message and puts no message body in a session.
- The plugin never starts a model turn and never sends input to a session. It
  calls no `synthetic`, `prompt` or `interrupt`. Its only writes to a session
  are its binding entry, with `entry.put` and `entry.remove`. It reads with
  `session.get`, `entry.list` and its event subscription.
- A missing binding means no chat, and a failed join turns that session's chat
  off. One case is best effort: a binding put that lands after its time limit,
  once chat is off, is removed again; see "A late removal or put after the
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
  `integrations/opencode/test/`.
- **Docs.** The public plugin, API, agents and permissions pages describe the
  V2 surfaces and do not pin a release. Where a page and the `2.3.2` source
  differ, the plugin follows the source. For example, `session.status` and
  `session.idle` exist in the `2.3.2` event types, and the plugin session
  domain has `interrupt`. The plugin uses none of the three.

A live row needs a recorded run against one exact release: the install
command, the observed join, repair and rejoin, and the answers to every item
under "Not verified on a live release".

## Test

```sh
cd integrations/opencode
node --test
```

The suites use doubles of the plugin context and of the worker. They cover the
config refusals, the delegated-child refusal, root, child and fork eligibility,
the fork and deletion records and their tombstones, owner failover and handoff,
per-session fault isolation, the binding publish, replace and fail-closed
context, the repair after a compaction signal or a gap with its currency rule
and call time limit, the read-back at each heartbeat tick, the
`unknown` heartbeat state, and the pinned rejoin constants.
