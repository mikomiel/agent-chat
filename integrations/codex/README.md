# Codex integration

A Codex plugin that joins an Agent Chat session and delivers claimed messages to
the model through hooks. When an app-server control socket is configured, the
receiver also checks that the session's thread is a main thread before it joins
and reads the thread's state for the heartbeat. A hook command lives for one
event and cannot hold a worker, so each session gets one detached receiver
process. The receiver runs the product's `agent_chat.instance_worker` as a child
process: join, heartbeat, pending, claim, settle and rejoin policy stay in the
Python core. The receiver supplies the native state, the hand-over to a hook and
the bounded rejoin scheduler.

**Status:** source present, contract-tested with doubles. One app-server probe
against codex-cli 0.171.0 checked the wire shapes (see [Tested
releases](#tested-releases)); the join through hooks has not run live. No
Codex release is recorded as verified yet; see [Tested
releases](#tested-releases). The idle wake is not part of this version: it is a
follow-up, tracked in #154. Until it lands a session is woken only by its own
next hook (a prompt or a tool event), which delivers what waits for it; the
receiver never queues a turn.

## Requirements

- Codex with plugin and hook support. The plugin uses the documented hook
  events `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Interrupt`
  and `SessionEnd`. The first Codex release that has all of them is not
  documented (see [Known limits](#known-limits)).
- Node 20 or newer on the `PATH` of the Codex process: the hooks run `node`.
- A Python 3.11+ interpreter with the same version of the core installed: the PyPI
  distribution `sessionyard`, which provides the `agent_chat` import. Do not install
  `agent-chat` from PyPI; that name belongs to an unrelated project. The `python`
  field of the config file names this interpreter.
- A reachable Agent Chat service and a host token accepted by it.
- A POSIX host. The receiver and the hooks talk over a Unix socket; the
  contract tests run on Linux.
- Optional, for the thread check and the thread read: a Codex app-server control
  socket that the session's thread is loaded in (see [App-server control
  socket](#app-server-control-socket)).

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
| `directory` | Absolute state directory, created beforehand, owned by the current user, mode `0700`, and below directories that only the current user or root can change (see [App-server control socket](#app-server-control-socket); `/tmp`, which is sticky, counts). It holds the receiver socket and its locks. The hook and the receiver each resolve it once and use its canonical path (every link above it resolved) for everything they keep there, and that path must be 75 bytes or fewer, so that the socket path fits (see [App-server control socket](#app-server-control-socket)). |
| `serverOrigin` | The Agent Chat service origin, `http` or `https`. |
| `hostToken` | A host token accepted by that service. Keep it in this file, never in a command line. |
| `python` | Absolute interpreter that can import `agent_chat`. |
| `noticeBodies` | Optional. `true` includes message bodies in a notice delivered by a hook, framed and neutralized by the [notice contract](../README.md#notice-contract); default metadata only. |
| `appServer` | Optional. `unix://` followed by the absolute path of the Codex app-server control socket. Without it the package is hook-only: no thread check and no thread read. Any other form is a refused config. The socket must also pass the [trust check](#app-server-control-socket) before every connection: a socket that does not is refused with `CHAT_APPSERVER_UNTRUSTED`. |

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
| `SessionStart` (every `source`) | `session-start` | 15 s | Starts the receiver if none runs for this `session_id`, waits up to 5 seconds for the join, and prints the binding as `hookSpecificOutput.additionalContext` plus a one-line `systemMessage`. A start always re-announces the binding, so a resume, clear or compaction that dropped it restores it. A start also resets what the earlier hooks left, as a fresh session starts: the read is dropped, the running state goes back to unknown and the Plan Mode hint is set from the start's own `permission_mode` (cleared when it has none), so a turn that died cannot leave the session `busy` for the heartbeat. The reset state goes out in a heartbeat at once, not at the next period, and the announcement does not wait for it. A local stop stays until a prompt clears it. |
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
  The binding text is capped at 2,048 bytes. Before the first join the receiver
  renders the longest binding this config could get (UUIDs, `<boot id>.json` in
  the state directory, a host name of 63 characters, the core's longest); when
  that does not fit, it does not join, and chat stays off with
  `CHAT_BINDING_TOO_LONG` (a long `python` path is the usual cause). A join
  whose own binding still does not fit (a host outside the core's grammar) is
  ended at once with the same code, and one that lacks a field with
  `CHAT_PROTOCOL_INVALID`; a binding is never joined and then left unshown.
- **Presence.** A heartbeat every 30 seconds, and one on every state change,
  carries `native_state`, `stopped` and `plan_mode`. It carries no title. The
  flags are facts of their own: `plan_mode` follows the Plan Mode rule (see
  State), and `stopped` follows the running state alone, whatever the Plan
  Mode: a local stop, an interruption that a read found, or a state that is
  neither idle nor busy (unknown, offline). `native_state` is `unknown` in Plan
  Mode. Delivery is still decided by one state, Plan Mode first (see Busy
  delivery). A
  heartbeat belongs to the worker that was live when its tick started. A tick
  that was waiting for an app-server read when that worker was retired (for
  example by `STALE_INSTANCE`) is dropped when the read returns: it sends
  nothing to the replacement, whose join may still be in flight and would
  refuse the request as busy, and it changes nothing the replacement owns.
  Its read does not set the observed state and its bind does not record the
  provider: each commit checks, in the turn that makes it, that the worker it was
  made for is still the live one. A child found by a read that a hook event
  overtook, or by a worker that was retired meanwhile, ends nothing: the next
  read decides.
- **State.** Hook events give the receiver `busy` (a prompt or a tool event),
  `idle` (`Stop`) and a stop (`Interrupt`). A missing or non-string
  `permission_mode` makes the state `unknown`. With `appServer` configured the
  receiver also reads the thread while nothing is known to run: its status
  (`idle`, `active`, `notLoaded`; `systemError` is a documented loaded status that reads as unknown), its collaboration mode (`default` or
  `plan`, from `thread/resume` with `excludeTurns`) and the status of its newest
  turn (`completed` clears it, `inProgress` is busy, `interrupted` is stopped,
  and anything else is unknown). The read adds a busy, idle or stopped answer
  that a hook cannot give while nothing runs, and it is the authority for Plan
  Mode when it answers: `plan` is Plan Mode and `default` is not. A read that
  cannot tell the mode (no answer, another mode, or a refused `thread/resume`,
  which a thread with no turn yet may give) leaves Plan Mode
  to the hook's `permission_mode` hint, and the session is then not idle but
  unknown. The mode and the running state are two answers of the read: a
  mode it confirmed decides Plan Mode even when its running state is unknown
  (the newest turn failed, or there is none), and the state then stays unknown,
  not idle. A read that answered is kept even when its answer is unknown (a
  status the plugin does not know, such as `systemError`, no usable newest
  turn, a mode it does not know): it is newer than the hooks' idle, so the
  running state stays unknown. Only a read that failed or found the thread
  offline is dropped, and then the state follows the hooks. Any later hook
  event discards the read. Reads can overlap when one is slow; only the newest
  read that started is kept, so an older one that lands after it, whatever it
  says, is dropped. Once a hook event has
  discarded the last read, Plan Mode follows the hook's hint alone, as in the
  Claude and Pi packages: `plan` sets it and a later hook with another mode
  ends it. The hint can be stale, since a session put into Plan Mode while a
  turn runs is not seen until a hook payload says so (authoritative Plan Mode
  for busy delivery: #152). A bind that leaves the thread unbound (the provider
  changed) discards the last read too, and no read is taken while the thread
  stays unbound: the state follows the hooks, as for a session without a
  control socket.
- **Busy delivery.** A `prompt` or `tool` hook asks the receiver for a batch
  while the turn runs. The receiver claims only when the session is busy, and
  never in Plan Mode, while stopped or in an unknown state. A turn hook has one
  deadline, its own limit: the wait for the reply is what is left of it after
  the connect (at most 7.5 seconds), and the receiver gets that wait less 1.5
  seconds (at most 6) for the whole reply, its state report included. The
  receiver starts a claim only with 2.5 seconds of that left. When the claim is
  granted, after the status request, and right before the notice is written,
  it checks that the hook is still connected and in time; a hook that is not
  gets nothing more (after the grant, not even a status request). This check
  comes before the reservation check, so a write that cannot happen settles
  retryable even when the reservation ran out too. The reply is printed as `additionalContext`
  and settled `handed` only after the hook confirms it wrote and flushed the
  output.
- **No idle wake yet.** The idle wake is a follow-up, tracked in #154. Until it
  lands a session is woken only by its own next hook: a message for an idle
  session waits, and a `prompt` or `tool` hook delivers it, as under Busy
  delivery. Nothing in this version queues a turn, and the join frame and the
  heartbeat carry no claim that the session can be woken.
- **Settlement.** A refused output settles `failed`, and so does a claimed batch
  that was never sent because the hook was gone or its time was up when the
  claim was granted, after the status request or right before the write:
  nothing reached the output, so it is retryable. The ledger accepts that
  settlement only while the reservation holds; one that reaches it after the
  reservation expired is closed by the ledger as `uncertain` (`claim_expired`,
  `agent_chat/deliveries.py`), like any expired claim. A failed write, a
  missing receipt or a reservation too short to write inside settles
  `uncertain`. The
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
  - With `appServer`, every worker start, the first join and each rejoin
    alike, waits for a positive check from a read taken for that start: a
    loaded thread with a complete record (an `ephemeral` flag, a `source` and a
    model provider) and a documented loaded status (`idle`, `active` or
    `systemError`) that is not a child. The `source` is documented as a
    non-empty string or an object. A thread the app-server does not list yet, a
    read that does not answer within 3 seconds, a read that fails, a record that
    lacks one of those fields or has an empty or array `source`, and a status that is
    absent or not one of those three each mean no join yet, and so does a
    complete record whose status is `notLoaded` (the thread left the loaded list
    between the list and the read). An answer that arrives after the 3 seconds
    is dropped and verifies nothing, and no earlier read counts for a later one:
    a rejoin whose read finds the thread unloaded starts no worker, and one that
    finds a child ends chat, as the first join would. The receiver asks again
    after 30 seconds, claims nothing in the meantime, and a retry spends none of
    the rejoin budget. A retry inside a rejoin still belongs to that rejoin's
    episode, so the two-hour episode window ends it (`REJOIN_WINDOW`). The
    window is checked again when the bind answers, before the worker starts, so
    a bind that runs across the end of the window starts no worker. A first join
    has no episode, and its retries have no end. A control socket that fails the
    [trust check](#app-server-control-socket) is no positive check either: no worker starts, so a
    delegated thread cannot join through a socket that someone else could have
    put there, and the receiver asks again every 30 seconds, so the join follows
    once the path is fixed.
- **Rejoin.** `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE`,
  `REQUEST_UNCERTAIN` and a join `BINDING_CONFLICT` start a bounded rejoin:
  5-second base, doubling to a 120-second cap, jitter between 0.5 and 1.0, a
  two-hour episode window and at most three completed rejoins per hour. The
  numbers are pinned to `agent_chat/models.py` by `test/policy.test.js`. The
  exception is a worker's `refused` reply to a heartbeat or to the pending read
  with `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN`:
  the core worker answers a brief outage that way and keeps its binding, so the
  receiver does nothing, no rejoin starts, no budget is spent, and the next
  heartbeat is the retry. The same codes in a worker error, or in a refused
  claim, status or settle reply, start the rejoin; `STALE_INSTANCE` always does,
  and a `BINDING_CONFLICT` after the join still ends chat. A worker request
  that gets no answer within the worker wrapper's 22-second deadline, the join
  included, is `REQUEST_UNCERTAIN`: the receiver stops that worker and rejoins.
  A worker that is stopped, or that exits, with a request in flight reports
  `CHAT_REQUEST_UNCERTAIN` instead. That is not a rejoin code, so chat ends
  (see Fail closed).
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

### App-server control socket

The `appServer` field names a Codex app-server control socket. The receiver uses
it for two reads: the thread check before every join and the heartbeat's read of
the thread's state. Nothing is written to the thread.

The documented topology is `codex app-server --listen unix://<path>` with the
interactive client attached through `codex --remote unix://<path>`, and the
`appServer` field naming that path (see the [app-server
documentation](https://developers.openai.com/codex/app-server)). The client is
a minimal RFC 6455 WebSocket over `node:net` and speaks JSON-RPC. It opens with
`initialize`, which declares `capabilities.experimentalApi` because the
`thread/*` methods are experimental, and it calls only `thread/loaded/list`,
`thread/read`, `thread/resume` with `excludeTurns` (for the collaboration mode)
and `thread/turns/list`. None of them starts a turn or changes the thread;
`thread/resume` subscribes the connection to the thread's events, so the
connection is closed as soon as the read ends.

A WebSocket upgrade does not prove who answers it, and a JSON line does not prove
who a hook is talking to, so one rule (`lib/trust.js`) covers both local sockets.
The path is trusted before every connection, or the connection is refused: with
`CHAT_APPSERVER_UNTRUSTED` for the control socket (the bind and the heartbeat
read alike) and with `CHAT_SOCKET_UNTRUSTED` for the receiver's socket
that a hook connects to.

- the socket is itself a socket, not a symlink, owned by the current user, and
  its path does not end in a separator (`control.sock/` is refused). The one
  exception is the last name of the control socket: `codex app-server --listen
  unix://PATH` may leave `PATH` as a symlink to the socket it binds in a
  private directory of its own, so that name may be a symlink, up to
  8 links in a row. Each link must be owned by the current user and its
  directory must pass the directory rule below, and the socket at the end must
  pass this whole rule. A loop or a longer chain is refused, and a link whose
  target is gone is a closed app-server, not an untrusted one. The receiver's
  own socket is never a link;
- its directory is not a symlink, however its name ends: a trailing separator or
  a `.` name makes the kernel look through a link, so `link/`, `link//` and
  `link/.` are refused as `link` is (the name is checked without those endings,
  so `link//control.sock` has the directory `link`);
- the directory and every directory above it (links above it resolved first, the
  way the kernel walks a path: a `..` after a link names the parent of the link's
  target) is owned by the current user or by root and is not writable by group or
  other. A directory that is writable by others but has the sticky bit set, such
  as `/tmp`, passes: others cannot remove or rename what the current user owns in
  it, and the socket's owner is checked on its own. The directories are judged
  from the root down, each only once every directory above it has passed, for
  the socket and for every link on the way to it;
- after the socket or a link is looked at, its directory and every directory
  above it are looked at again: the spelling must still resolve to the same
  real path and each directory must still be the same one (device and inode),
  so a directory swapped between the two looks is refused;
- the connection goes to the checked path with those links resolved;
- that real path is at most 103 bytes long: `sun_path` holds 104 bytes on macOS
  and the BSDs (108 on Linux), terminator included, and a longer path must never
  reach Node, which on some releases could cut it to fit and connect to a
  socket other than the one that was checked (reported for older Node, not
  reproduced on the release this was written on, which refuses it). The limit
  is on the resolved pathname, so a short spelling that resolves to a long path
  is refused. The configured spelling is held to the same limit, so a later
  check of that spelling is never refused by the kernel as too long. A resolved
  path that contains U+FFFD is refused: a name that is not valid UTF-8 comes
  back with it and could stand for another directory. Once its directory has resolved, a path that is too long is refused
  rather than reported as absent, whether or not a socket is there; a directory
  that is missing is reported as absent first, before the length is looked at.
  The receiver measures the public socket path and the private name it binds
  under the same limit before it listens.

The state directory that holds the receiver socket must itself pass the directory
part of the rule (it is also required to be `0700` and the user's own), and a
receiver does not start in one that fails it. It is resolved once: the hook and
the receiver each take its canonical path (every link above it resolved) and
use that path, and no other spelling of it, for everything they keep there: the
start lock, the socket and its bind lock, the working directory of a receiver
that a hook starts, and the worker's directory, which holds the binding file. A
link that moves after the check changes none of them. The hook starts the
receiver with the canonical path it resolved as the last of the receiver's
arguments (a path is not a credential), and the receiver resolves the configured
path itself. Before it creates, binds or starts anything it requires the two to
be the same string. A link that moved between the two makes them differ: the
receiver then exits without joining and creates nothing, so no receiver serves a
directory that the hook is not looking in, and the hook gets no answer and
prints nothing. A hook whose receiver socket is untrusted prints nothing and
exits 0, as it does for an absent receiver, and it starts no receiver on top of
that socket.

The simplest safe choice is a socket in a directory of its own, mode `0700`. A
control socket that is not there is the closed app-server, not an untrusted one.
After the join, the refusal costs the thread read only: reads answer `offline`, the
state follows the hooks, and hook delivery carries on. Before the join it is no
positive thread check (see the Delegated sessions item under
[Behaviour](#behaviour)), so no worker starts and nothing is delivered until the
path passes. Nothing shows the name `CHAT_APPSERVER_UNTRUSTED` to the user:
before the join the receiver only waits, and after it the thread is simply not
read. The check is on the path, made for each connection: it does not read the
peer's credentials, a process of the same user or a root process is trusted by
it, and a replacement between the check and the connect needs a writer that the
rule has already excluded.

1. **Bind.** Before the join the receiver finds the `session_id` among the
   loaded threads (`thread/loaded/list`) and reads it (`thread/read`). A child
   thread refuses the session. The worker joins only once this bind's own reads
   show a loaded thread that is not a child and whose record is complete: an
   `ephemeral` flag, a `source` (a non-empty string or an object) and a model
   provider, with a status that is `idle`, `active` or `systemError`. A thread
   that is not loaded yet or whose read says `notLoaded`, a read that fails, a
   record that lacks one of those fields or has an empty or array `source`, a status
   that is absent or unknown, and a read that does not answer within 3 seconds
   mean no join yet, and the receiver asks again every 30 seconds. The provider
   recorded by an earlier bind, and an answer that arrives after the 3 seconds,
   never verify a later bind. A bind that is aborted (the receiver aborts it at
   the end of the 3 seconds) records nothing, so the next bind compares with what
   an earlier bind recorded and not with an aborted one. The thread's model
   provider is recorded when the bind completes; a read that later shows another
   provider is a `stale_binding`: the thread still joins, but it is unbound, so no
   read is taken and the state follows the hooks. Each later heartbeat binds again
   until a bind finds the thread with the provider that was recorded.
2. **Read.** While nothing is known to run, each heartbeat reads the thread:
   `thread/loaded/list`, `thread/read`, then `thread/resume` with
   `excludeTurns`, and last the newest turn from `thread/turns/list`. The
   `thread/resume` answer is a record of its own and must be complete, as at the
   bind (an `ephemeral` flag, a non-empty string or object `source`, a model
   provider, an id and a status), agree with the bound provider and show the
   thread idle, or the read is unknown; a child there ends chat as a child in
   `thread/read` does. Its `collaborationMode.mode` gives Plan Mode: `default`
   is not Plan Mode, `plan` is, and anything else is unknown. The mode is its
   own answer: the newest turn is read whatever the mode, and a mode that the
   resume confirmed is kept when the turn leaves the running state unknown. A
   refused `thread/resume` has no record and ends the read as unknown. A thread with no turn yet may refuse both
   `thread/resume` and `thread/turns/list`: the read is unknown at the resume
   and never reaches the turns list, and chat stays on. A
   `thread/turns/list` that fails after a resume answered leaves the thread
   unread, as an unreachable app-server does. The thread must be idle and its newest turn must be
   `completed`, the one status that shows a finished turn. A turn that is
   `inProgress` reads as `busy`, an `interrupted` one as `stopped`, and every
   other answer as `unknown`: no turn at all, a turn without a status, a status
   that is not a string and a status that is not known (`failed` included, which
   has not been confirmed as a status of a finished turn). An unknown state is
   not idle. The newest-turn read is last because an interruption is the one
   change that the status cannot show: the thread is idle after it too. A read
   that finds a child ends chat, when the read is still current; one that a hook
   event overtook, or that a retired worker started, is dropped.

## Known limits

Each item is a surface or behaviour that this package relies on and has not
confirmed against a running Codex, or a limit of the design. Apart from the
app-server probe under [Tested releases](#tested-releases), nothing below was
exercised live.

- **No recorded release.** The hook, plugin and app-server surfaces were read
  from the public Codex documentation, the app-server source and the protocol
  types of an installed release, and the app-server shapes were checked once
against codex-cli 0.171.0. No session joined through the hooks. The first
  release with `Interrupt` is not documented.
- **Install flow.** The plugin manifest is `.codex-plugin/plugin.json`, which
  the documentation lists as a supported compatibility fallback; it prefers a
  `plugin.json` at the plugin root. Local marketplace setup and hook trust
  review were not run. A hook that is not trusted is skipped, and chat stays
  off without a message.
- **Plan Mode from a hook.** Whether `permission_mode` `plan` in a hook payload
  follows the Plan collaboration mode is not confirmed, and the hint can be stale.
  The app-server read is the authority when it answers, but a hook event
  discards it, and no read is taken while a turn runs: Plan Mode for busy
  delivery follows the hint alone (see State), so a session put into Plan Mode
  during a turn is seen only if a hook payload says so. An authoritative Plan
  Mode for busy delivery is tracked in #152.
- **`thread/resume` as a read.** The Plan Mode read uses `thread/resume` with
  `excludeTurns`, which subscribes the connection to the thread; the receiver
  closes the connection straight after the answer. A thread with no turn yet
  refuses it, and a release whose answer lacks the origin, the `ephemeral` flag
  or the model provider is an incomplete record. Each of those leaves the
  reading unknown.
- **The idle wake.** A message for an idle session waits for the session's own
  next hook. The wake is not part of this version; it is tracked in #154.
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
  confirmed. Without one there is no thread check and no thread read: the state
  follows the hooks.
- **The thread record fields.** The join check needs `ephemeral` as a boolean,
  `source` as a non-empty string or an object, a status of `idle`, `active` or
  `systemError`, and the model provider. They were read from the generated
  protocol types, not from a live record. A release that omits one of them, or
  reports another status, leaves the receiver at no join, and chat stays off.
- **The WebSocket upgrade path.** The upgrade path `/rpc` is accepted by the
  public server source, not confirmed against a release. The four `thread/*`
  methods are experimental, so `initialize` declares `experimentalApi`; a
  release that refuses that capability fails the connection, and with it the
  bind (no join) and the read (offline).
- **The socket check is a path check.** `CHAT_APPSERVER_UNTRUSTED` and
  `CHAT_SOCKET_UNTRUSTED` rest on `lstat` of the socket and of every directory
  above it, taken before each connection. It does not read the peer's credentials
  (Node has no portable way to), so a process of the same user, or root, that
  answers on a trusted path is trusted. A socket in a shared directory with the
  sticky bit is accepted only while the socket is the current user's. The check
  and the connect are two steps; between them only an owner of a trusted
  directory could replace the socket. A live run on a real release is still
  needed.
- **Sandboxing.** Whether a hook command and the detached receiver may use the
  state directory's socket, the control socket and the network under every
  sandbox profile is not confirmed. A profile that blocks them leaves chat off.
- **Start inside the hook timeout.** Whether the receiver can start, bind the
  thread and join within the `SessionStart` wait (5 seconds of a 15-second
  timeout) on a real session is not confirmed. With `appServer`, the bind alone
  can take 3 seconds (the thread read), which leaves two seconds of that wait for
  the worker's join. A thread that the
  app-server does not list yet, or does not answer for, delays the join by
  30-second periods and nothing is claimed until it joins. A later hook event
  announces the binding once the session has joined.
- **`additionalContextLimit` units.** The generated types describe a token
  threshold. The receiver bounds bytes, which exceed tokens, so the limit holds
  whatever the tokenizer does.
- **`handed` means written, not read.** For a hook, `handed` means the output
  was flushed. Codex does not report that the model read it.
- **A stop is seen only through `Interrupt`.** `Interrupt` does not run for
  subagents, and a stop that happens while the receiver is down is not seen
  until the next turn event. With `appServer`, an interrupted newest turn is also
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
  cannot be read, only the pid is checked, both for the owner check and for the
  holder of the bind lock.
- **Hard links for the bind lock and the socket.** The lock is created and
  retired with hard links, and the listener's socket is linked into place from
  a private name, so the state directory must be on a file system that supports
  them. Where `link` fails, the receiver does not start and chat stays off.
  Linking a socket file was checked on Linux only.
- **A start during a close.** A closing receiver holds the bind lock for the
  few system calls of its close. A receiver that starts inside that window
  exits as a running one (`CHAT_RECEIVER_RUNNING`), so the hook event that
  started it finds no receiver; the next hook event starts another.
- **A kill between listen and link.** A receiver killed after its listener
  bound the private name and before that name was dropped leaves a socket file
  with a 12-character hexadecimal name in the state directory. Nothing reads
  it and nothing removes it; delete it by hand.
- **A kill inside a lock takeover.** A receiver killed between the two steps
  of a takeover (the second name linked, the dead owner's lock not yet
  unlinked) leaves that second name, `<socket>.bind.retired-<hash>`, next to
  the dead owner's lock. Every later receiver for that session then stands
  back and chat stays off for it, until both files are removed by hand. Age is
  not used to clear it, because an age rule is what let two receivers hold the
  lock. The window is two system calls wide.
- **Non-interactive runs.** `codex exec` is not exercised. With `appServer` its
  thread is refused as a child; without it nothing distinguishes it.
- **Short state path.** A `directory` whose canonical path is over 75 bytes
  disables chat, silently: the socket name takes 28 bytes of the 103 that a Unix
  socket path may have.
- **No in-session off switch.** Chat for a session ends with the session. To
  keep a session off, start it without the plugin or without the variable.

## Security boundaries

- Chat is off unless a private `0600`, current-user-owned, non-symlinked file
  named by `AGENT_CHAT_CODEX_CONFIG` opts the process in. A delegated child
  never joins.
- The host token is read from that file only. It travels to the worker on
  stdin. The receiver environment is the config path alone and the worker
  environment is empty. No token appears in argv or in any log line, and hooks
  never forward it. The receiver's arguments are the session id, the pid of its
  owner and the canonical state directory.
- The variable is part of the Codex environment, so a command the session runs
  as the same user can read the file. Use a host token that is meant for this
  session.
- The socket lives in the private state directory, is owner-only, serves one
  request per connection and refuses a line over 64 KiB. A hook connects only to
  a socket of the current user below directories that nobody else can change, and
  prints nothing otherwise. A live receiver is
  never taken over, and a path that is not a socket is never replaced. A socket
  left by a dead receiver is replaced only after a refused connection proves
  that nothing listens on it; any other probe result counts as a running
  receiver. The probe, the unlink and the bind run under one lock file next to
  the socket, so two receivers that start for one session cannot unlink each
  other's live socket. The lock holds its owner as `<pid> <start time> <token>`
  and is created whole, so no reader sees a partial one. It is taken over only
  when that process is gone: its pid does not run, or runs with another start
  time. A lock that cannot be read counts as held, and age is never a reason
  to take it. To take over, a contender first gives the lock a second name that
  only one contender can create for that owner line, and unlinks the lock only
  if that name still holds the line it read. A contender with an old reading
  therefore cannot remove a successor's lock, and at most one receiver binds.
- Closing a Node listener unlinks the name it was bound under, whatever is at
  that name by then. The receiver therefore binds under a private name, links
  it to the socket path and drops the private name. When it closes, it takes
  the same bind lock, removes the socket path only while that path is still its
  own file (same device and inode), releases the lock, and then closes the
  listener. The check and the unlink are two system calls, and a successor
  publishes its socket under that lock, so no successor can link its socket
  between them. A receiver that closes after its successor bound the path leaves
  the successor's socket alone. A receiver that cannot take the lock at close
  leaves the socket path in place, because the holder may be publishing its own
  socket there, and still closes its listener; a dead socket file is what the
  next receiver's stale-socket check already replaces.
- The worker runs the configured Python interpreter with `-I` and the state
  directory, as its canonical path, as its working directory and as the
  directory it keeps the binding file in.
- The app-server client answers a server request with a method-not-found error.
  It completes the upgrade only on an answer whose whole status line is
  `HTTP/1.1 101`, then the end of the line or a space and a reason phrase of
  visible ASCII, spaces and tabs, whose header lines are all `name: value` with a
  token for a name and no control byte in the value (NUL, the rest of C0 except
  tab, and DEL), and whose whole head, terminator included, is within 16 KiB. Only
  space and tab are trimmed from a value or a `Connection` token, never what a
  general-purpose trim would take. The answer needs `Upgrade: websocket`, a
  `Connection` header with the `Upgrade` token (any case) and the
  `Sec-WebSocket-Accept` proof, and it is refused if it names an extension or a
  subprotocol (none is offered). A refused answer fails the connection as a
  protocol error before the client sends `initialize` or anything else. It
  checks every server frame against RFC 6455 section 5 before it reads it. It
  refuses a frame with FIN=0 (fragmentation is not supported, so a continuation
  frame is refused too), an opcode that is not text, close, ping or pong (binary
  included), a control frame with FIN=0 or more than 125 bytes of payload, a text
  frame that is not valid UTF-8, a masked frame, a frame with a reserved bit set
  (it negotiates no extension) and a frame whose length is not in its shortest
  form (16 bits from 126, 64 bits from 65536; a 64-bit length with its top bit set
  is over the frame limit). The connection fails as a protocol error and the frame
  is never read. A close frame ends the connection and a pong is dropped; the
  body of a close is not checked. It sends only the methods listed under
  [App-server control socket](#app-server-control-socket), all of them reads,
  carries no credential and never starts a turn.
- The plugin only reads Agent Chat and delivers to its own session. It never
  publishes, merges, deploys or grants authority.

## Tested releases

One app-server probe ran against codex-cli 0.171.0, with a TUI attached
through `--remote` to `codex app-server --listen unix://PATH`. It checked the
shapes this package validates, with the package's own client: the upgrade
answer, `thread/loaded/list`, the `thread/read` record (`source` "vscode",
status `idle`), the `thread/resume` record with its collaboration mode, and the
newest turn. All passed. It also found that PATH is a symlink to a socket in
Codex's own private directory, which the trust check now follows. Before the
first user message `thread/resume` and `thread/turns/list` answer an error, and
the read is unknown. Hooks, the worker and the join did not run, so no release
is recorded as verified. A full live run will be recorded with the install command, the observed join, busy
delivery, interrupt, rejoin and end. Until then the package has a
`NOT RUN` row in the [compatibility matrix](../README.md#compatibility), no
minimum release is claimed, and the contract tests use hook-payload, worker and
app-server doubles.

## Test

```sh
cd integrations/codex
node --test
```

The suite covers config refusal, the worker join frame, frame validation and request deadline,
the rejoin policy pinned to `agent_chat/models.py`, the shared notice vectors,
the notice limits at the smallest bound, the socket, its stale-socket recovery, its shutdown beside a successor and under a held bind lock and its start handshake, the bind lock (a live owner, a dead owner, a reused pid, an interleaved takeover and several contender processes over one stale lock), the shared socket trust rule against an injected file system (the 103-byte path limit on the real path included, and a directory named with doubled or trailing separators or a `.` name), the hook and the client against a real receiver socket
on trusted and untrusted paths, the state directory resolved once behind a link and handed to the receiver, which refuses a directory that resolves differently, the WebSocket client against a
fake control socket on a real Unix socket (the upgrade answer checked whole, status line and header values included, the bind and the newest-turn statuses and thread statuses that are not strings, the bind's commit fence for a retired worker, and the trust rule against real file systems, a path resolved the way the kernel walks it included), the receiver's state, delivery,
settlement, rejoin and shutdown with a manual clock, the hook commands
with payload doubles (output cap, write receipts, delegated refusal, owner
hint), the plugin shape that Codex reads, and runs of the real hook and
receiver processes against a fake worker and a fake app-server. It needs no
Codex install, no PostgreSQL, no service and no credential.
