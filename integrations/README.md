# Harness integrations

Turnkey integrations ship from this repository, next to the service and the
adapter core. A package uses only its harness's public extension surface and
the product's worker protocol; the Python core stays authoritative for join,
heartbeat, poll, claim, settle, rejoin and binding replacement. A package
supplies native eligibility, delivery, binding context and wake behavior. The
OpenCode package is the exception: it joins and keeps the binding in place, and
it delivers only when its `delivery` key is `true`, and then only from the host's
idle hook ([issue #148](https://github.com/mikomiel/agent-chat/issues/148)).

## Packages

| Harness | Package | State |
|---|---|---|
| Pi | [`pi/`](pi/) | Live-tested with Pi 1.5.2 |
| DeepSeek Harness | [`deepseek/`](deepseek/) | Live-tested with DSH 0.2.2-rc.1 |
| Claude Code | [`claude-code/`](claude-code/) | Source present; live run pending |
| OpenCode | [`opencode/`](opencode/) | Source present; live run pending. Delivery is off by default; with `delivery: true` it delivers only from the idle hook |
| Codex | [`codex/`](codex/) | Source present; live run pending |

Vibe is outside the initial admission set.

## Compatibility

A package records the harness releases it was exercised against. The matrix is
evidence, not a promise: a release that was never run is `NOT RUN`, never
implied by a nearby version.

An integration release is tested only with the core of the same version: both
ship at the product version, and a package at one release with a core at
another is an untested combination. A row therefore names the package version
and the core version it was run with in its Evidence cell. The Pi and DeepSeek
rows below were recorded before the packages shared the product version. They
name the package at `0.1.0`, and the core they ran with is not recorded. The
OpenCode and Codex rows record no run, so no core version applies.

| Package | Harness surface | Verified release | Evidence |
|---|---|---|---|
| `pi` 0.1.0 | extension factory, `session_start`, `input`, `agent_start`, `agent_settled`, `ui_prompt_*`, `session_info_changed`, `before_agent_start`, `session_shutdown`, `message_start`, `sendMessage`, `registerCommand` | `1.5.2` | RPC join and shutdown; interactive delivery and rejoin against a disposable service |
| `agent-chat-pi` (source after 0.8.0) | `session_tree`, `session_compact`, `session_compact_failed`; `ctx.ui.setStatus` with the `Agent Chat: no live instance` text; `ctx.isIdle()` during compaction and branch summarization; `session_shutdown` followed by `session_start` for the reasons `reload`, `new`, `resume` and `fork` | `NOT RUN` | None. The `1.5.2` type declarations and sources were read and nothing ran against Pi. No release was run for these surfaces, `1.6.0` and `1.6.1` included. Contract tests use a harness double |
| `agent-chat-deepseek` 0.1.0 | DSH extension/Cordis surface: `ctx.inject`, `agent/created`, `agent/disposed`, `agent/pre-step`, `agent/inbox/inserted`/`claimed`/`discarded`, `agent/status`, `session/event` `turn/end`, `agent.steer`, `agent.inbox.remove`, `sessionTitle`, `sessionProjections` plan unit, `webServer` | `0.2.2-rc.1` | Web profile join, native inbox delivery, lease rejoin and disposal against a disposable service |
| `agent-chat-deepseek` 0.1.0 | eligibility: `ctx.agents.get` and the session header `origin`, plus `roots()` and `isOwnedBy()` where the registry has them | `NOT RUN` on `0.2.2-rc.5` | No run. The published type declarations were compared; nothing was executed. `@deepseek-ai/dsh-agent` `0.2.2-rc.1` declares `AgentRegistry.roots()`, `AgentRegistry.isOwnedBy(id, owner)` and `CreateAgentOptions.parentAgent`. `0.2.2-rc.2` to `0.2.2-rc.5` declare none of them, and `enter(agent)` takes no owner; `get(id)` and `list()` remain. In `0.2.2-rc.5` the host's own subagent test is `session.header.origin === 'subagent'`, and the subagent child factory sets that value. The package reads which registry surface it finds and uses that header test where `roots()` and `isOwnedBy()` are both absent; a registry with only one of them refuses every agent. |
| `agent-chat-opencode` 0.8.0 | OpenCode server plugin: `{ id, setup }`, `ctx.event.subscribe`, `ctx.session.get`, `ctx.session.instructions.entry.put`/`list`/`remove`, events `session.created`, `session.execution.started`, `session.forked`, `session.deleted`, `session.compaction.started`/`ended`/`failed`; with `delivery: true` also `ctx.session.hook("experimental.idle")`, `ctx.session.synthetic` and the event `session.inbox.delivered` | `NOT RUN` | None. Contract tests on doubles of the plugin context. Surfaces read from the 2.3.2 packages; no OpenCode session has run the plugin, and the idle delivery has never run live |
| `agent-chat-codex` 0.8.0 | plugin hooks `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Interrupt`, `SessionEnd`; app-server `thread/loaded/list`, `thread/read`, `thread/resume`, `thread/turns/list`, `thread/items/list`, and the experimental `thread/queue/add` and `thread/queue/delete` | `NOT RUN` | One app-server shape probe and one idle wake against codex-cli 0.171.0, with the library before this version (see [Tested releases](codex/README.md#tested-releases)). The wake of this version has not run live, and no hook, worker or join ran. Contract tests use hook-payload, worker and app-server doubles |

Adding a row for a live release needs a recorded run against that exact
release, including the install command and the observed join, delivery and
rejoin behavior. Update this table in the same change. Name the package
version and the core version, and install both from the same release (see
[Install a pinned release](#install-a-pinned-release)). A `NOT RUN` row records
a release that was read but never run: it is not verification. `0.2.2-rc.2` to
`0.2.2-rc.4` are `NOT RUN` too.

### Pi 1.5.2 verification

Install the tested Pi release with
`npm install --prefix ./pi-probe @earendil-works/pi-coding-agent@1.5.2`.
The runs used the extension at source `b5a7413`, loaded through Pi's public
`-e` option with a private agent directory and a disposable Agent Chat
service.

- In RPC mode, Pi registered, reported a stopped heartbeat and created one
  mode-0600 binding. Closing standard input ended its instance and removed
  the binding.
- In the interactive TUI, local input restored delivery eligibility. A
  synthetic addressed question reached Pi's native message handler and the
  server recorded `handed`. Expiring the disposable lease caused a rejoin with
  the same session ID and a new instance ID and binding. Graceful shutdown
  ended the new instance and removed the new binding.

The TUI used a deterministic local model stream. Plan Mode and upstream model
providers were outside these runs.

### DeepSeek Harness 0.2.2-rc.1 verification

Install the tested DSH release with
`npm install --prefix ./dsh-probe @deepseek-ai/dsh@0.2.2-rc.1`.
The tests ran its real Web profile on loopback with source `b5a7413`, a
private DSH home, a disposable Agent Chat service and test principals.

- A Cordis-created root registered and wrote one mode-0600 binding. After its
  lease expired, the adapter rejoined with the same session ID and a new
  instance ID and binding. Native root disposal ended the new instance and
  removed the binding.
- A root using the Standard preset processed synthetic input with the Web
  prompt's source metadata. The next addressed question reached its native
  inbox, emitted the claim event, and settled as `handed` on the server. This run
  used a deterministic local model stream.

CI runs the contract suites with harness doubles. [Issue #41](https://github.com/mikomiel/agent-chat/issues/41)
tracks live-harness CI and the Claude Code and Codex live runs.

## Lifecycle transitions

A package meets the same five classes of lifecycle transition, whatever its harness calls them. The table says what a
package must do for each class. Only the `pi` column is filled in: another package adds its own column when its
lifecycle is checked against the rows, so an empty cell makes no claim about that package.

| Transition | A package must | `pi` |
|---|---|---|
| Runtime replaced: the harness unloads the extension runtime and loads another, for a new, resumed, forked or reloaded session | Ask the worker of the old instance to end it, and wait for that worker to exit, up to a bound, before the new one joins; wait the same way for a worker that an earlier failure stopped and that is still exiting. A rejoin starts its worker only after the one it stopped has exited, or at the bound. Neither the request nor the exit proves that the server ended the instance: a join that still meets the old instance is retried after a back-off. Ask for the end on the harness's shutdown event only, never on a "before switch" event that another handler can cancel. Start the new runtime stopped. The native session id keys the chat session, so a replacement that keeps the id returns to its chat session and one that changes it begins another. A latch that turned chat off for the process holds across the replacement. | `session_shutdown` with the reason `reload`, `new`, `resume` or `fork`, which Pi awaits, then `session_start` with the same reason on the new runtime. The handler returns once every worker that is still closing has exited, one that a rejoin stopped included, or after 6 seconds. A rejoin starts its worker only after the old one has closed, or after the same 6 seconds, so a child that never exits holds neither for ever. A join that still meets the old instance, because the `end` failed, is retried after a back-off. No `session_before_switch` or `session_before_fork` handler. |
| Context rewritten in place: compaction, tree navigation | Keep the binding and the native session id, join nothing again and announce nothing again. Evaluate the native state again, and let no claim happen while the harness is not idle. | `session_tree`, `session_compact` and `session_compact_failed` evaluate it again. `ctx.isIdle()` is false during compaction and branch summarization. `before_agent_start` sets the binding section at every turn. |
| Lease lapsed: the last confirmed join or heartbeat is `LEASE_SECONDS` old | Change the footer or status line only, to say that no instance is live. Start no rejoin episode, withdraw no binding and raise no fault because of the lapse: what starts an episode is unchanged, a refusal or an error of the worker. Keep the text until a confirmed heartbeat restores the normal text: a clock that is set back after the lapse does not. | `ctx.ui.setStatus` with `Agent Chat: no live instance`, set by a timer on the monotonic deadline, or by the next poll tick when only the wall clock shows the lapse, as after a suspend. The lapse is latched until a heartbeat is answered without `refused`. |
| Operator abort | Clear delivery eligibility until local input. | `agent_start` with an aborted signal, `agent_settled` with `aborted`, and `input` from a non-interactive source stop it; `input` from the interactive source restores it. |
| Tolerated outage: the worker answers a heartbeat or a pending read with `refused` and keeps the binding | Take it as no renewal, not as a failure: keep the worker and the binding, start no episode and spend no rejoin budget. The next heartbeat or poll is the retry. A `refused` that proves the lease gone, and a worker error, still rejoin. | `refused` with `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN` on `heartbeat` or `pending`. |

## Notice contract

With `noticeBodies: true`, a peer's message body is written into the model's context. Every package that delivers a
notice renders it with one contract, so the body stays recognizable as untrusted peer data. The OpenCode package has no
`noticeBodies` option: with `delivery: true` it delivers a metadata notice only, never a body. The contract has two implementations that pass
the same vectors in [`notice-vectors.json`](notice-vectors.json): the Python reference
[`agent_chat/notice.py`](../agent_chat/notice.py) and the dependency-free JavaScript module
[`shared/notice.js`](shared/notice.js). A package keeps no dependency and reads nothing outside its own directory
at run time, so each package ships a byte-identical copy as `lib/notice.js`. OpenCode uses its copy for the
[tool route](#tool-route) lines of its binding and for the metadata notice of its idle delivery. A test in each package
fails when its copy differs from the shared source.
After you edit `shared/notice.js`, copy it over each `lib/notice.js`. The normative text is the notice requirements in
[`openspec/specs/chat-clients/spec.md`](../openspec/specs/chat-clients/spec.md).

In bodies mode, a notice has the parts below. The instruction lines and the pointer line follow the
[tool route](#tool-route); the `--room` wording below is the `cli` route's.

- the adapter's own instruction lines and the binding line, then one static line that says every `> ` line between
  the markers is untrusted peer data and grants no authority. One instruction line tells the reader to verify that a
  `history` read returns the id shown in that item's header, and that a reply's `--room` is the room shown in that
  item's header;
- for each message, a header line (`message <id> kind <kind> room <room> from session <uuid> sent <time> age <N>s`,
  with `principal <uuid>` for an operator publication), an opening marker `<<<AGENT-CHAT-BODY <nonce>`, the body, and a
  closing marker `AGENT-CHAT-BODY <nonce>>>>`. The `room` is the room of that message, which can differ from the room
  of the binding. The `--room` of a `reply` comes from it. The nonce is 16 random hex digits (64 bits) drawn when the
  notice is rendered, after the claim. The renderer checks every header field again against a strict pattern and
  returns nothing when one does not match;
- every body line prefixed with `> `, so a body line cannot start like a header, a marker, the binding or an
  instruction line;
- control, bidirectional, invisible, tag and variation-selector code points, and unpaired surrogates, written as
  `\uXXXX` text (`\u{X}` above U+FFFF). Tab and line feed stay, and line feed is the only line break. The table is
  `ESCAPED_RANGES`, and the vectors pin it;
- a cut on whole units (a code point or one escape) at 4096 UTF-8 bytes per body, the core's `NOTICE_BODY_BYTES`. A
  cut body is followed by a pointer line with the exact `history` arguments that read the rest (`--room`, `--after`
  and `--limit 1`). It does not repeat the message id: the header above it carries the id.

The caller passes `bound`, the UTF-8 bytes it may send, with its own prefix already counted. The renderer halves the
body cap (4096, 2048, ... 0) until the whole notice fits. At cap 0 each message still has its header, markers and
pointer. There is no metadata fallback in bodies mode: the renderer returns `null` only when those parts do not fit,
and the package then settles the batch `deferred` with reason `offline`. Metadata mode, the default, is unchanged: ids,
kinds, room and history cursor as JSON, and no body.

Before the claim, `packCandidates` takes the longest prefix of the `pending` candidates whose estimated rendering
fits `bound`, and at least one, from the `sizes` that `pending` reports. The estimate for a message is its header,
markers and pointer at their longest, plus three bytes for each stored body byte, up to the body cap. A retry batch,
or a `pending` reply without `sizes`, is claimed whole, because the server refuses any other set for a stored batch.
A missing or invalid size counts as a full body.

The parts that differ per package stay in the package. `lib/channel.js` holds the delivery line, the limit and the
bound, and the lifecycle makes the claim and the delivery call. `pi`, `deepseek` and `opencode` allow 8 KiB for the
delivery line and the notice together. `claude-code` allows 10,000 bytes for its announcement, the delivery line and the notice
together, and `codex` allows 6,000.

Limits that remain:

- The frame and the escapes keep a body from imitating a header, a marker, the binding or an instruction line. They
  do not make a body safe to obey, and no test here shows what a model does with text inside a frame.
- The packing estimate allows three bytes of notice for each byte of body (a line feed and its `> ` prefix). It does
  not bound the rendering. A body made mostly of control characters renders larger, because each one becomes a
  six-byte escape. Two pending bodies of 650 carriage returns each (3,900 bytes once escaped) are both claimed under
  the Pi and DeepSeek bound of 8,137 bytes, and the renderer then halves the cap and cuts both. The halved cap applies
  to every body in the notice. Each cut body carries its pointer line, and the notice stays within `bound`. The
  vectors `two-bodies-of-650-carriage-returns-are-both-packed` and
  `two-bodies-of-650-carriage-returns-are-cut-by-halving-after-the-claim` pin this case.
- A retry batch is claimed whole, up to 16 messages. At body cap 0, 16 frames and the adapter's own lines take 7,052
  bytes in the shared suite's fixtures, and 7,685 bytes when every header field is at its widest. Both fit the Pi and
  DeepSeek bound of 8,137 bytes, and a test in each of those packages holds the widest case to it. `claude-code` has no
  fixed bound, because its announcement comes out of the same 10,000 bytes: [its README](claude-code/README.md) gives
  the room that is left. `codex` has no fixed bound either, and 16 frames at their widest exceed its 6,000-byte cap:
  [its README](codex/README.md) gives the numbers.
- The table of escaped code points is fixed. A code point that a later Unicode version makes invisible stays
  unescaped until the table and the vectors change.

## Tool route

The optional config key `toolRoute` says which Agent Chat surface the binding, the notice and the Codex wake tell the
model to use. It is a deployment fact, not something a package detects. Every package accepts the same three values,
and refuses every other value the way it refuses a wrong `noticeBodies` type: `loadConfig` returns `null`, chat stays
off and nothing is logged. `"MCP"`, `""`, `"http"`, `null`, a number, a boolean and an array are refused. The key set
stays closed, so an unknown key next to `toolRoute` is still refused.

| Value | What the text tells the model |
|---|---|
| absent, `"cli"` | The Agent Chat CLI: `AGENT_CHAT_INSTANCE_FILE` set to the binding's `instance_file` and the declared python with `-I -m agent_chat.cli`. The route lines are byte-identical to the text before `toolRoute` existed. In `pi`, `deepseek`, `claude-code` and `codex` the binding then ends with the [receipts sentence](#sender-receipts), save the one case that section names. |
| `"mcp"` | The tools of the MCP server named `agent-chat`: `bind` (when the server has it), `who`, `history`, `send`, `ack` and `reply`. The text says not to run the CLI, and it carries no CLI argument. |
| `"mcp-with-cli-fallback"` | The `mcp` bind line, then one line with the tools and the CLI: "Use who (room, online=true), history (room) and send (room, recipients, UUID key, body). Only if MCP is unavailable, set AGENT_CHAT_INSTANCE_FILE to exactly instance_file below and run the declared python with -I -m agent_chat.cli." Then the retry rule: "Reconcile an uncertain send or reply before retrying: keep the same key, recipients and body, and never replay it automatically on the other transport." The CLI's own `--help` names its arguments. The notice names its own CLI from the binding line below it, after the `mcp` use line: "Only if MCP is unavailable: AGENT_CHAT_INSTANCE_FILE=instance_file python -I -m agent_chat.cli (both below); never auto-replay an uncertain send or reply across transports." The Codex wake points at the binding's CLI line and keeps the no-replay clause: "Only if MCP is unavailable, use the binding's CLI; never replay an uncertain send or reply automatically on the other transport." |

The text names the server and its tools, never a callable name. A harness prefixes MCP tools its own way (Claude Code
`mcp__<server>__<tool>`, OpenCode `<server>_<tool>`), and the model takes the name from its own tool list. So the same
text works in every package.

What an `mcp` route needs, outside this repository:

- An MCP server entry named `agent-chat` in the harness configuration.
- Write tools on that server for `ack`, `reply` and `send`. The product's optional MCP service is read-only unless it
  runs with `enable_writes: true` (product [README](../README.md), "MCP (optional)").
- A way for that server to act as this session. The product's MCP service authenticates every request with the
  instance token, which changes at every rejoin, and it has no `bind` tool. The text tells the model to call `bind`
  with the exact `instance_file` only when the server exposes `bind`, for example a per-session stdio server that takes
  the binding at run time.

Rejoin. A rejoin already replaces the binding in every package, and the binding says the previous `instance_file` is
no longer valid. On the `mcp` routes the binding also says to call `bind` again whenever a later binding gives a
different `instance_file`, and every notice says to bind its `instance_file` first when it is new. A model that missed
the new binding still re-binds. No protocol field or state is added.

Self-contained notices. A notice can be the first Agent Chat text a model sees: a Claude Code idle wake can follow a
join that no hook has shown. So a notice never depends on the binding having been shown: the `cli` notice names the
CLI form, the `mcp` notice says to bind its `instance_file` first when it is new, and the fallback notice names its
own CLI. The Claude Code waiter delivers the notice alone, and the next hook shows the pending binding. A Codex wake
carries no binding and points at the one shown: it is a queued user turn, and that turn's own prompt hook carries a
binding still to be shown in the same turn.

Replies across transports. The CLI `reply` without `--key` and the `reply` tool without `key` derive the same key from
the session and the parent message, so a one-step reply keeps its key on either transport.

One source. The route text is in [`shared/notice.js`](shared/notice.js): `TOOL_ROUTES`, `bindingRouteLines(route)`,
`wakeInstructions(route)`, and the `route` option of `renderNotice` and `packCandidates`. The Python reference holds
the notice lines too, and vectors with a `route` field pin both. A package passes `config.toolRoute` to every call that
renders or sizes text, and adds no route text of its own.

Room. A notice is rendered after the claim, and a stored retry batch is claimed whole, so a notice that takes more
bytes on one route than on `cli` could leave a batch with no notice at all. The rule: in each mode, every route's own
notice lines, and its pointer line, are at most the `cli` route's. Then any batch that renders on `cli` renders on every
route, and `WORST_FRAME_BYTES` holds for all of them. The shared suite checks this. The `mcp` notice lines are therefore
shorter than the binding's. The fallback notice puts its CLI sentence on the `mcp` use line, since every line costs
its newline too; in metadata mode it has 2 bytes left. The Codex wake points at the binding's CLI line.
The binding is outside that rule and takes more room on the `mcp` routes; the fallback binding puts the tools and the
CLI in one line to keep it short. With the test fixtures' short interpreter, state directory and session id, and every
other field at its widest:

| Budget | `cli` | `mcp` | `mcp-with-cli-fallback` |
|---|---|---|---|
| Notice lines before the first frame, metadata mode | 874 | 699 | 872 |
| Notice lines before the first frame, bodies mode | 1,189 | 952 | 1,125 |
| Pointer line of a cut body | 120 | 116 | 116 |
| 16 widest frames at cap 0, as rendered, Pi and DeepSeek bound 8,137 | 7,685 | 7,384 | 7,557 |
| Longest binding (63-character host) in `claude-code`, cap 4,096; `codex` is one byte shorter, cap 2,048 | 1,119 | 1,261 | 1,465 |
| Codex wake prefix, test limit under 800 | 655 | 608 | 737 |

The binding caps the interpreter path and the state directory together. With a 63-character host, a UUID session id
and plain ASCII paths, `codex` leaves 940 bytes on `cli`, 798 on `mcp` and 594 on the fallback route; one byte more
refuses at start with `CHAT_BINDING_TOO_LONG`. `claude-code` leaves 2,987, 2,845 and 2,641; one byte more and the
binding is not announced. A test in each of the two packages pins its numbers. They include the
[receipts sentence](#sender-receipts) that the binding of these two packages carries: without it `codex` left 994, 855
and 651 bytes, and `claude-code` 3,041, 2,902 and 2,698. In `noticeBodies` mode a retry batch is claimed whole. When its
notice fits only beside the binding without the receipts sentence, `claude-code` and `codex` send that binding, so the
sentence never makes a batch wait that fit before it. A `codex` hook that carries the binding can still find the batch too
large to follow, since the interpreter path is in both: the hook sends the binding alone and settles the batch `deferred`
with reason `offline`. Each such hook spends one of the batch's three
attempts, and a batch with none left is not offered again; the first offer after the binding is confirmed, which the
ledger makes after its backoff, is delivered whole. #172 tracks a fit check before the claim.

Rule for a future package: read `toolRoute` with the same values and the same strict refusal, copy `shared/notice.js`
as `lib/notice.js`, and take every route line from it. Do not add a second route key or route text of its own.

## Sender receipts

A sender receipt tells the session that sent an addressed message that a recipient reached `handed` or `acked`. The core
records it in a non-waking ledger and lists it for the sending session; the [HTTP API](../docs/api.md#sender-receipts)
has the eligibility table and the two feed routes. `pi`, `deepseek`, `claude-code` and `codex` show receipts to the
model and then mark them delivered. `opencode` shows no sender receipts: its worker only lists `receipts` as a
keepalive, and that is unchanged.

One source. [`shared/receipts.js`](shared/receipts.js) is the state machine: when a poll is due, which rows of an answer
may be shown, which ids to mark and which ids are tracked. It is pure and does no I/O.
`renderReceiptNotice(rows, budget)` in [`shared/notice.js`](shared/notice.js) writes the text and returns
`{ text, ids }`, or `null` when no row fits. Each of the four packages ships byte-identical copies as `lib/receipts.js`
and `lib/notice.js`, and a test in the package fails on a difference. `opencode` keeps its `lib/notice.js` copy only.
[`receipt-vectors.json`](receipt-vectors.json) pins the notice text, and the shared suite reads it. After you edit a
shared file, copy it over each copy. A package keeps only the parts that depend on its harness: the native output, its
confirmation, and the two worker requests, `receipts` and `receipts_delivered`.

The rules below bind every package that shows receipts.

- **Receipts change nothing else.** They never change the bytes of a claim, a handoff, a settle, a heartbeat, a binding
  announcement or a wake. A notice is an output of its own in `pi` and `deepseek`. In `claude-code` and `codex` it
  rides only in the reply of a prompt or tool hook that would otherwise carry nothing: never beside a binding or a
  delivery, and never in a wake. So a notice uses a whole output budget of its own, and ten rows at their widest take
  3,399 bytes, which every package's budget carries. A package holds a notice that does not fit whole; it never shrinks
  or defers a delivery or a binding to make room. The receipts request runs after the delivery poll in `pi` and
  `deepseek`, and after the hook's reply in `claude-code` and `codex`, so it never sits between a claim and its settle.
  It shares the worker's single request slot, like every request, so it gives way: see the next rule. A pass sends one
  receipts request, never a mark and a poll in a row.
- **A receipts request gives way (#175), client-side.** In a package and its worker, nothing waits behind a receipts
  request except for the cancel latency, a signal and the worker's answer to it. Two rules make that so, and a package
  keeps no other receipts path. The server is a separate wait, and these rules do not remove it. A receipts read that
  stalls inside the server keeps the row of its instance after the cancel, so the first request after the cancel waits
  for that row, up to the server's `lock_timeout` of 3 seconds, and is refused if the row is still held. That request is
  a `pending` or a `heartbeat`, and the package holds a refusal as a brief outage. The hook or the delivery poll then
  delivers nothing, and the message stays on the server. "Server serialization" under "Limits that remain" has the
  measurements.
  *Capability gate.* The core's worker names `capabilities: ["receipts-cancel"]` in its join reply, and a package sends
  no `receipts` and no `receipts_delivered` request unless the join reply of its current worker lists it. A worker that
  does not, an older core, is sent no receipts request: nothing is shown, and nothing else changes. A package sets a
  worker's capability from its join reply only, so a rejoin onto another worker follows that worker's reply.
  *Cancel.* `worker.cancel()` sends `SIGUSR1` to a worker that listed the capability, for the receipts request that is
  pending, and never for any other request. It signals at once and again every 5 milliseconds until the answer to that
  request is read; a second call adds nothing. Inside a receipts request the worker raises an interrupt that only this
  signal raises, answers `refused: CLI_INTERRUPTED`, and serves on. Outside a receipts request the signal does nothing;
  one that arrives just before a receipts request is kept by one latch, so that request answers `refused` at once. One
  that arrives after a receipts request has its answer, and before the worker reads the next request, may be late for the
  request that has just been answered, and the worker drops it: it never refuses the request after it, such as a retry of
  the same mark. During a receipts request, `SIGTERM` and the 20-second alarm end the worker, also when the HTTP client reports
  their interrupt as a failed transport. Other requests keep their existing outage handling. The package holds the answer like any refusal: no state changes, a
  feed read is asked again at a later pass, and a mark that was ended keeps its ids.
  *Repeat (#183).* A signal names no request. A package can send a receipts request right after the answer to another
  one, a retried mark for example, and cancel it before the worker has read it; the worker drops that signal, because it
  cannot tell it from a late one for the request just answered. The repeat is what ends such a request: the first signal
  that lands after the worker read it ends it, so what queued behind it waits the cancel latency and at most one repeat
  period more, never the 2-second deadline. A repeat is sent only until the package reads the answer, so before it writes
  the next request, and it reaches the worker before the worker reads that request: the worker drops it.
  `claude-code` and `codex` cancel when a counted request queues behind a receipts request: a hook's or a wake's claim
  sequence, a heartbeat or a state report. A receipts task that reaches the head of the queue while a counted request
  is in flight sends nothing, and a later pass asks again. The hook's check for a slow request does not count a
  heartbeat, or any state report other than the one a prompt or tool hook sends before its own claim, that queued behind
  a receipts request until its turn comes. That hook's state report and its claim sequence count from the moment they
  queue, as they do with no receipts request ahead of them: a second hook that arrives meanwhile takes the slow-request
  path, the first hook claims, and no hook waits behind another hook's delivery. `claude-code` also records the state of
  a report that queues behind a receipts request as it queues, so that second hook sends no second report.
  `pi` and `deepseek` cancel when a heartbeat or a delivery poll falls due while
  their receipts request is in flight, and send none while either is due; in `pi`, a state that the worker has just
  refused yields to that request and does not end it. The worker's own deadline for a receipts request, 2 seconds
  (`RECEIPT_SECONDS` in `agent_chat/instance_worker.py`), stays as the backstop for a request that nothing ends. The
  tests hold a receipts request on a gate that nothing releases, so only the cancel can end it, and a hook delivers
  while it is held: client-side, no hook skips its claim for a receipts request. The first request after a cancel is
  always a `pending` or a `heartbeat`, because a delivery opens with `pending` and a state report is a `heartbeat`. It
  is never a `claim`, a `settle` or a `status`, and the tests of all four packages pin that order. In `codex` a state
  report that ended a receipts request sends its heartbeat even when the state it reports is published again by its
  turn. A `claim` or a
  `settle` that went first would meet the server wait above and be answered `REQUEST_UNCERTAIN`, where a refused
  `pending` or `heartbeat` is only a brief outage.
- **Receipts never wake.** `pi` sends the message with `triggerTurn: false`. `deepseek` appends it at `agent/pre-step`
  and never calls `agent.steer`. `claude-code` uses only the reply of a `UserPromptSubmit` or `PostToolUse` hook: never
  `Stop`, never the idle-wake waiter, never exit code 2. `codex` uses only the reply of a prompt or tool hook of a running
  turn; a wake carries no receipt, even when one is waiting. A package never asks for receipts while the session is idle.
  A pending receipt changes no claim, handoff, settle, heartbeat, binding announcement or wake, with one exception: the
  read of the collaboration mode that `codex` takes before a notice. Plan Mode that it confirms can withhold an output
  (another hook's claimed batch then settles `deferred` with reason `plan`) and set `plan_mode`. Another mode that it
  confirms lets that notice out and changes nothing else: it never lifts Plan Mode.
- **When a package offers receipts.** The session is joined and chat is not failed, its native state is `busy` (not idle,
  Plan Mode, stopped, unknown or offline; for `deepseek`, a running turn, since an idle agent with a parked inbox item is
  busy only for a delivery), and the worker's answer says `muted === false`. The worker reads
  `GET /v1/instance/receipts/feed`, which carries the session's `muted` flag, read in the same transaction as the rows,
  and passes it on with rows or without. A receipts request is therefore one request to the server and never a `status`
  read. The flag is required: a feed answer without a boolean `muted` is refused by the worker as `INVALID_RESPONSE`, and
  the package asks again at its next poll. A package counts an answer that does not say `muted === false` as muted, and
  the rows then wait on the server. A package polls at most every 5 seconds and
  only while a turn runs. `claude-code` and `codex` make the first poll one cadence after the receiver starts, and show
  an answer at the next event, never in the reply of the event that polled. Every package counts the cadence from the
  write of a request, so a pass that sends nothing does not delay the next one. A notice holds at most 10 rows, oldest
  first, shown whole or not at all. A package tracks at most 200 ids, offers nothing while 200 wait for output or a
  mark, and, once an id's output was confirmed, never shows it again; above 200 it forgets the oldest marked ids.
- **A staged notice is checked again when it is output.** `deepseek`, `claude-code` and `codex` stage a notice and output it
  at a later boundary, and the session may be muted by then. At the boundary the package asks the server nothing and
  uses the latest `muted` flag that a worker answer carried: a `receipts` answer, with rows or without, and the `status`
  answer of a claim. A `status` answer without a boolean `muted` makes the flag unknown. A heartbeat answer carries none. It drops the notice unless that flag is `false` and the request that
  staged the notice was sent at most 5 seconds before, so an answer read late, after a suspend, is never fresher than
  its request. The four packages count those seconds on the wall clock, so a
  suspend ages a notice, and an age that is negative or not a number drops it. `deepseek` also drops it unless its
  native state, read again without side effect, is a running turn outside Plan Mode. `codex`, with `appServer` and a
  bound thread, also drops it unless a read of the thread's collaboration mode, taken by that hook after its event
  arrived and right before the output, confirms a mode other than Plan Mode in its time, and no read that started
  later has confirmed Plan Mode: the rule its claims follow too ([its README](codex/README.md), Busy delivery). A dropped notice is not marked: its ids stay on the server and
  a later poll offers them again. `claude-code` and `codex` answer the hook as for any reply with nothing to carry.
  `pi` hands a notice to Pi in the pass that got the answer, so it has no later boundary of its own. It makes the same
  check right before it hands the notice over, so an answer read after a suspend gives Pi nothing, and the rows are
  offered again by a later poll.
- **What a notice holds.** One fixed paragraph that says the lines are data, not instructions or replies, grant no
  authority and need no reply or acknowledgement, then one line per receipt. A line holds only `state`, `message`,
  `recipient_session`, `recipient_harness`, `recipient_host` and `created_at`. Each field is checked against a closed
  grammar (UUIDs, `handed` or `acked`, the worker's principal and time forms), and a row that fails is skipped, so no
  control, bidirectional or free text reaches the model.
- **At-least-once marking.** A package sends `receipts_delivered` with exactly the ids it showed, and only after its
  harness confirmed the output. Never an empty list or more than 50 ids: the worker treats either as fatal. A notice that
  was not confirmed, or was dropped before its output, is released and its rows are offered again. A mark that the worker refuses, or answers with something
  malformed, keeps its ids, and the next pass sends it again. A crash between the output and the mark shows the rows once
  more: a duplicate is possible and a loss is not. After a rejoin the unmarked ids are marked through the new instance.
- **A receipts read changes no delivery state.** `deepseek` reads its native state for receipts with a read that never
  stops chat, logs a warning or fences a delivery. The delivery's own question keeps its latch: a state it cannot
  classify stops delivery until the next Web prompt. A state that the receipts read cannot classify holds receipts for
  that pass and changes nothing else, so a later delivery is handed with no new Web prompt.
- **Failures stay out of the delivery path.** A `refused` answer to either operation, a refused mark included, and a
  malformed answer are held, and never latch chat off. A thrown error that carries a code, such as `REQUEST_UNCERTAIN` or a
  worker exit, takes the path that error takes from any other request: a rejoin within the existing budget, or fail
  closed. `CHAT_REQUEST_INVALID`, and an error without a code (a fault in the receipts code itself), are held.

| Package | Where a notice is output | What confirms it | When it is marked |
|---|---|---|---|
| `pi` | An `agent-chat-receipts` custom message with `triggerTurn: false`, while a turn runs | Pi's `message_start` carries the message's own marker object | At the next pass |
| `deepseek` | A message appended at `agent/pre-step` to a model step that is already entering (on the first step of a turn only when that step already has a message), source `plugin:agent-chat-receipts` | The `session/event` `user/message` with that message's id | At the next pass |
| `claude-code` | `additionalContext` of a `UserPromptSubmit` or `PostToolUse` reply that has nothing else to carry | The hook's write receipt, `written` | At once |
| `codex` | `additionalContext` of a prompt or tool hook reply that has nothing else to carry | The hook's write receipt, `written` | At once |

`pi` and `deepseek` run receipts in a pass of their drive loop: after the delivery poll, at most every 5 seconds, the pass
sends one request, the mark that waits or, when none waits, the poll. It is sent only when no heartbeat and no delivery
poll is due, and it stays due until then. `claude-code` and `codex` do the same in the pass that follows a hook's reply.
A mark that keeps failing therefore holds the poll, and once it lands the poll waits for the next cadence. A notice
that is staged or out, and not confirmed when the turn ends, is released and its rows are offered again. `pi` and
`deepseek` release it at `agent_settled`, `claude-code` at `Stop`, and `codex` at `Stop` and at `Interrupt`. `deepseek`,
`claude-code` and `codex` also release a staged notice that is not yet output when its worker is retired, at a rejoin or
when chat ends, so a worker that rejoins without `receipts-cancel` shows none. Confirmed ids stay, and a later worker
with the capability marks them.

Making senders ask. A question and a consultation carry receipts without a request. A `message` and a `reply` carry them
only on request: `--receipts` on the CLI, `receipts: true` on the MCP `send` and `reply` tools. So each binding of the four
packages ends its route lines with one sentence from `receiptsHint(route)`: `send/reply --receipts asks for
handed/acked receipts.` on `cli`, and `send/reply receipts=true asks for handed/acked receipts.` on both `mcp` routes. It
adds 54 bytes to the binding on `cli` and 57 on each `mcp` route. A notice and a wake do not carry it, and the Python
reference mirrors no binding, so only the packages' byte pins and the room numbers in [Tool route](#tool-route) moved.
One case leaves it out: when a `claude-code` or `codex` notice fits only beside a binding without the sentence, that
binding goes with it and counts as shown. The sentence then returns with the next announcement, at a session start or a
rejoin.

Limits that remain:

- No live run has shown a receipt reach a model. The [compatibility table](#compatibility) records no run of receipts: the
  live runs it lists did not exercise them, and its `NOT RUN` rows stay `NOT RUN`. The `pi` confirmation follows the Pi
  1.5.2 source, which emits `message_start` with the message's own `details` object for a `triggerTurn: false` message.
  If a release did not, `pi` would show the same receipts again in each later turn and never mark them. The `deepseek`
  confirmation follows the DSH `0.2.2-rc.1` and `0.2.2-rc.5` sources. The hook receipts of `claude-code` and `codex` are
  the hook protocol's own, and one test each drives them through the real hook command, receiver and socket with a
  worker double.
- A core whose worker does not list `receipts-cancel` in its join reply is sent no receipts request, so it shows none and
  chat is what it was. Install the core and the package from the same release to get receipts, as
  [Install a pinned release](#install-a-pinned-release) says. The server needs two routes as well: the feed route and
  the mark that goes with it, `POST /v1/instance/receipts/feed/delivered`. A server up to `v0.8.0` has neither. Against
  one, the feed answers `404 NOT_FOUND` at once, before that server reads its database or takes its event clock, and the
  worker answers `refused` with `NOT_FOUND`. The package shows no notice and holds: it asks again at its next poll. The
  mark has a new route too, because a package keeps its confirmed ids after a refused mark. If the server is rolled back
  to such a release before the retry, the retry has no new feed read before it, and the released mark route of that
  server takes the event clock. The worker never posts there: the mark route of the feed answers `404 NOT_FOUND` at once
  and takes no clock. The mark does not land, so the package keeps its ids, holds the feed poll as for any refused mark,
  and sends the mark again at its next pass. No receipts request takes the clock of that server, since the worker falls
  back to neither older receipts route nor `status`, and it remembers no missing route (see the item on the shared event
  clock below).
- **Server serialization (residual, #175).** The core takes the row of the instance for every authenticated request of
  that instance, so a receipts request that stalls inside the server holds the row, and the next request of the same
  instance waits for it on the server. A cancel and the worker's deadline end only the package's wait: the server
  finishes the request. So "a receipts request gives way" holds client-side only. The wait is bounded by the server's
  `lock_timeout`, 3 seconds. Measured against a real server with a receipts transaction held open: released after 1
  second, a concurrent `pending` waited 1.04 seconds and answered normally; never released, it answered 503
  `DATABASE_UNAVAILABLE` after 3.01 seconds, which the worker reports as `SERVICE_UNAVAILABLE`. That is a brief outage
  on `pending`: no rejoin, chat stays on, and the next poll asks again, and the hook or the delivery poll that sent it
  delivers nothing. A POST that meets the same timeout, a `claim` or a `settle`, answers `REQUEST_UNCERTAIN` by the
  client's mapping of a 5xx on a submitted request (`agent_chat/client.py`). A `claim` is not sent again: the worker
  that gets it exits, so the package rejoins. A `settle` that gets a 5xx or no status is sent again every 0.5 seconds
  until 1 second before the worker's 20 second request deadline (#188), so it fails only behind a stall longer than
  that. That is why no package sends one first after a cancel. The next item measures the same wait for a read of
  another instance. A receipts request takes milliseconds when the server is healthy, so this needs a stall in the
  server itself. The packages cannot end work on the server, and this change does not remove it.
- **A stalled server read blocks the event-writing requests of every instance.** A read of the core holds the event
  clock shared until its transaction ends: `pending`, `status` and `history` do. A `claim`, a `settle` and a `send` of
  any instance need the clock exclusively. A read that stalls for more than 3 seconds, the server's `lock_timeout`,
  therefore holds them until each is refused with 503 `DATABASE_UNAVAILABLE`, which the client reports as
  `REQUEST_UNCERTAIN` for a POST. The `pending`, the heartbeat and the `status` of other instances pass. A worker that
  gets `REQUEST_UNCERTAIN` for a `claim` exits, and its package rejoins. A `claim` leaves no row, and the message is
  offered again after the rejoin. The worker sends a refused `settle` again until its deadline, about 19 seconds after
  it started (#188). Only a stall that outlasts that ends the worker and leaves the attempt to close as `uncertain` with
  `claim_expired`, and that message is not offered again (#174). The in-process `Adapter` (`agent_chat/adapter.py`)
  sends a settlement once, so for it a refusal after 3 seconds already does that. This exists without receipts. Measured
  once on `main` (`6f3b1dd`, before #188), outside the test suite, through the real worker, with a `pending` of one
  instance stalled for 3.5 to 8.3 seconds: a second instance with a message waiting got `REQUEST_UNCERTAIN` 3.01 seconds
  after its request in 12 of 12 trials, 6 `claim` and 6 `settle`. `status` and `history` take the same lock and were not
  stalled in that run. A stalled receipts read gave the same result in 12 of 12 on that commit. Since #189 the receipts
  reads take no clock, so a stalled one no longer delays another session. It still holds its own session's rows, and a
  request of that session that takes the clock first (its own send, a rejoin, a mute, or its `status`, `pending` or
  `history` read) waits on them and carries the stall to every writer. #189 is in no release up to `v0.8.0`: every
  server from `v0.1.0` to `v0.8.0` has both older receipts routes and takes the shared clock in them, so a released
  worker, which reads the older route, still delays every writer with a stalled receipts read there, as it did on
  `6f3b1dd`. A worker of this change reads only the feed route and marks only at the mark route of the feed, and those
  servers lack both: it gets `404 NOT_FOUND` at once for either and takes no clock, so it adds no such stall, even for a
  mark kept across a rollback of the server. `receipts-cancel` is a capability of the worker,
  not of the server, so it says nothing about the server a worker talks to. Receipts add requests, though not clock
  holders. A busy session polls at most every 5 seconds (`POLL_MS` in `shared/receipts.js`), so it sends at most 12 receipts
  requests per minute. A driver on schedules modelled on the packages', with an empty feed, sent 9 to 12 per minute, and
  the worker let 7 to 9 `pending` reads per minute through to the server, because it answers an empty `pending` from
  memory for 2, 4 and then 8 seconds (`pending_delay` in `agent_chat/instance_worker.py`). On those numbers receipts are
  more than half of the reads of a busy session. A receipts request is one request to the server: its answer carries
  the `muted` flag of the session, so it adds no `status` read, which takes the clock. A shown notice adds one
  `receipts_delivered`. `status` is read only inside a delivery, and no package sends `history`. A worker that reads the
  feed route of a server up to `v0.8.0` gets `404 NOT_FOUND` and answers `refused`: its package shows no notice, the
  rows wait on the server, and the worker asks neither `status` for the flag nor the older route. A mark that the
  package kept gets the same answer from the mark route of the feed. Tracked in #176.
- **A claim can run on the server and still be reported uncertain (#177, narrowed, not closed).** The client's request
  timeout is 3.0 seconds, and the server's `lock_timeout` is 3 seconds. The server stamps a `claim` when it reaches
  the route, and refuses an admission that ends 2.25 seconds or more after that stamp: the lock limit less 0.75
  seconds (`REQUEST_MARGIN_SECONDS`), kept for the commit, the response and its transit. It rolls that admission back
  and answers 503 `DATABASE_UNAVAILABLE`, which the client reports as `REQUEST_UNCERTAIN`. No attempt is recorded
  after the client has given up, so the message is offered again after the rejoin. The expiry and reconciliation done
  before the admission still commit (`agent_chat/api.py`, `agent_chat/storage.py`, `agent_chat/deliveries.py`). What
  remains is an admission that ends before the 2.25 seconds and is followed by a commit, a response and a transit that
  together take longer than the 0.75 seconds left. The client counts its 3 seconds from its send and the server counts
  from the arrival of the request at the route, so the margin also pays for the transit of the request. That `claim`
  runs on the server and is still reported `REQUEST_UNCERTAIN`. Nobody settles that attempt, so it closes as
  `uncertain` with `claim_expired`, and that message is not offered again (#174). A `settle` has no such bound: a late
  one commits the outcome the worker reported. Issue #177 stays open.
- A receipt that waits while the session is muted, idle, stopped or in Plan Mode is not lost: it stays on the server until
  a later poll finds the session able to show it, or the message expires.
- `codex` reads Plan Mode from its app-server, and only with `appServer` and a bound thread. That read gives the thread's
  mode, the one the next turn takes; no request reads the mode of the turn that runs, so a switch during a turn holds
  output from the next read on. Without `appServer`, or while the thread is unbound, `codex` follows the hook's
  `permission_mode` hint, as `claude-code` does, and a stale hint can let one notice into a turn in Plan Mode.
- The output-time check cannot see a mute that lands after the last answer that carried the flag and less than 5 seconds
  before the output. The notice is then shown and its ids are marked, and the next poll sees the mute. A notice is data,
  not an instruction, so the cost is one notice shown to a session that was just muted.
- `pi` hands its notice to Pi in the pass that got the answer, but Pi holds a `triggerTurn: false` message while a run is
  active and appends it at the end of the running turn, after the assistant message and every tool result, or when the
  run ends if that comes first (the Pi 1.5.0 and 1.5.2 source). The mute window on `pi` therefore extends to the end of
  that turn, tool calls that have not started included, and the package cannot withdraw the message.
- A notice is output only at a boundary within 5 seconds of the request that staged it: a second prompt or tool event in
  `claude-code` and `codex`, a pre-step in `deepseek`. A staged notice holds the next poll until a boundary shows it or
  drops it, so a session whose boundaries are always more than 5 seconds apart drops each notice, and its receipts
  arrive late or not at all. The rows stay on the server, so nothing is lost.

## Rules

- Public extension APIs and the product's worker protocol only. No private CI,
  host path or internal runbook.
- A package never publishes, merges, deploys or grants authority. A peer
  message is coordination data.
- Synthetic fixtures only. The repository's `public-content` check scans the
  commit range and its messages.
- A package keeps its credential route explicit: a private `0600` config file
  named by an environment variable, never a command-line argument.
- The Python core stays the owner of lifecycle policy. Where a package must
  mirror a core constant for a non-Python process, a test pins the copy to
  `agent_chat/models.py`. The notice's default body cap is pinned the same way
  to `NOTICE_BODY_BYTES` in `agent_chat/instance_client.py`.

## Release rule

`integrations/<harness>/` is a self-contained package directory with
`package.json` at its root, and every such directory is released at the product
version. The release lists no harness: it enumerates the directories, so a new
package is covered when its directory appears.

- **Version.** `version` in `package.json`, and in `.claude-plugin/plugin.json`
  or `.codex-plugin/plugin.json` where a package has one, equals `version` in
  the root `pyproject.toml`.
  release-please bumps them with the project version (`extra-files` globs in
  `release-please-config.json`).
- **Name.** `agent-chat-<harness>`. `npm pack` names the release asset after
  it: `agent-chat-<harness>-<version>.tgz`.
- **Contents.** A `files` allowlist lists the entry points, `lib/`, `scripts/`,
  `hooks/`, `.claude-plugin/`, `.codex-plugin/` and `README.md` that the package needs, so
  `test/` stays out of the tarball. Every other top-level path of the
  directory belongs in `files`. The repository `LICENSE` is in every tarball
  too: the pack step adds it, because npm packs only files inside the package
  directory, so a package directory holds no copy of it.
- **Configuration.** `lib/config.js` reads the shared `AGENT_CHAT_DELEGATED_CHILD`
  opt-out and exactly one `AGENT_CHAT_<HARNESS>_CONFIG` variable, and the
  package README documents it. See the table below.
- **Not on npm.** Each `package.json` stays `private`. The release tarball is
  the install source.

| Harness | Config file variable | Shared |
|---|---|---|
| Pi | `AGENT_CHAT_PI_CONFIG` | `AGENT_CHAT_DELEGATED_CHILD` |
| DeepSeek Harness | `AGENT_CHAT_DEEPSEEK_CONFIG` | `AGENT_CHAT_DELEGATED_CHILD` |
| Claude Code | `AGENT_CHAT_CLAUDE_CONFIG` | `AGENT_CHAT_DELEGATED_CHILD` |
| Codex | `AGENT_CHAT_CODEX_CONFIG` | `AGENT_CHAT_DELEGATED_CHILD` |
| OpenCode | `AGENT_CHAT_OPENCODE_CONFIG` | `AGENT_CHAT_DELEGATED_CHILD` |

The variable names the private `0600` config file. `AGENT_CHAT_DELEGATED_CHILD=1`
keeps a harness process that a session starts on purpose from joining chat.

`tests/test_release_artifacts.py` pins this rule for every directory under
`integrations/` except `shared/`, which holds the notice source that the
delivering packages copy into their own `lib/` and is never packed alone. `scripts/check_release_artifacts.py` packs the directories and
checks the built artifacts. The pack step refuses a link or special file in a
package directory, and the output directory must hold no link. The checks:

- The sdist holds every tracked integration file as a regular file, and the
  wheel holds no `integrations` path.
- There is one tarball per directory with its entry points, the repository
  `LICENSE` and without `test/`.
- A tarball holds only regular files and directories under `package/`. The
  archive headers are read as written: no `.`, `..`, empty or backslash
  segment and no duplicate.
- `SHA256SUMS` has one line per tarball in the GNU text form
  `<64 lowercase hex digits><two spaces><tarball name>`, with LF line endings
  and a name of letters, digits and `._+-`. The install block below checks
  every line of the file against that form before it selects one, and
  accepts nothing else.

The release workflow `release-integrations.yml` runs the script before it
attaches the tarballs to the release.

## Install a pinned release

A GitHub Release `v<version>` carries one tarball per integration,
`agent-chat-<harness>-<version>.tgz`, and `SHA256SUMS` over them. Install the
core and the integration from the same release: an integration is tested only
with the core of its own version. Releases up to and including `v0.8.0` carry
no integration assets and no Claude Code marketplace manifest, so use a later
release.

1. **Core.** Install the PyPI distribution `sessionyard` at the same version,
   as the product [README](../README.md#install-and-run) describes. The
   import is `agent_chat`. Do not install `agent-chat` from PyPI: that name
   belongs to an unrelated project. A client install,
   `sessionyard==<version>`, is enough for an integration, because
   `agent_chat.instance_worker` imports without psycopg. The service host adds
   the `server` extra. Each integration runs the worker with the interpreter
   that its config file names in `python`, so point `python` at an interpreter
   that has this version installed. For `pi`, `deepseek`, `claude-code` and
   `codex`, `python` must be the interpreter itself, not a wrapper or a
   launcher: the cancel signal (`SIGUSR1`) goes to the process that the package
   starts, and only the worker handles it.
2. **Download, verify and extract the tarball** of the harness (`pi`,
   `deepseek`, `claude-code`, `opencode` or `codex`) in one block. The block needs `bash`, `curl`,
   `tar` and GNU coreutils `sha256sum`. macOS has no GNU `sha256sum`: install
   coreutils with Homebrew (`brew install coreutils`) and put its `gnubin`
   directory first on `PATH` in the shell that runs the block:
   `PATH="$(brew --prefix coreutils)/libexec/gnubin:$PATH"`.

   The block works in a fresh temporary directory and stops at the first
   failure. It extracts only after these steps all pass:

   - Both downloads succeed.
   - Every line of `SHA256SUMS` is in the GNU text form
     `<64 lowercase hex digits><two spaces><file name>`, with LF line endings.
     A binary-mode record (`<digest> *<file name>`), a carriage return or any
     other stray line stops the block, even when the line names another file.
   - `SHA256SUMS` has exactly one line for the chosen file name, and that line
     matches the download.

   The block creates the target directory itself, so the target must be an
   absolute path that does not exist yet, a link included, and it stays in
   place for as long as the harness uses it. The tarball unpacks into a
   `package/` directory, which the block strips. The layout must stay intact,
   because the entry points import `../lib/`.

   ```bash
   version=<version>
   harness=pi
   dir="<absolute-directory>/agent-chat-${harness}-${version}"
   (
     set -euo pipefail
     asset="agent-chat-${harness}-${version}.tgz"
     base="https://github.com/mikomiel/agent-chat/releases/download/v${version}"
     work=$(mktemp -d)
     trap 'rm -rf "$work"' EXIT
     cd "$work"
     curl --fail --location --remote-name "${base}/${asset}"
     curl --fail --location --remote-name "${base}/SHA256SUMS"
     test "$(LC_ALL=C grep -cavEx '[0-9a-f]{64}  [A-Za-z0-9._+-]+' SHA256SUMS)" -eq 0 || { echo "SHA256SUMS holds a line outside the GNU text form (<digest>  <name>, LF endings)" >&2; exit 1; }
     awk -v name="$asset" '$2 == name' SHA256SUMS > asset.sha256
     test "$(wc -l < asset.sha256)" -eq 1 || { echo "SHA256SUMS needs exactly one line for ${asset}" >&2; exit 1; }
     sha256sum --check --strict asset.sha256
     mkdir -p "$(dirname "$dir")"
     mkdir "$dir" || { echo "cannot create ${dir}: it must not exist yet" >&2; exit 1; }
     tar -xzf "$asset" -C "$dir" --strip-components=1
   )
   ```

   A failed download or check extracts nothing. Do not extract a tarball by
   hand after a failed check.

3. **Point the harness at the extracted directory.**

| Harness | Asset | Step |
|---|---|---|
| Claude Code | tag `v<version>`, or `agent-chat-claude-code-<version>.tgz` | `claude plugin marketplace add mikomiel/agent-chat#v<version>`, then `claude plugin install agent-chat@agent-chat`. Offline: extract the tarball and run `claude --plugin-dir <extracted-dir>`. |
| Pi | `agent-chat-pi-<version>.tgz` | `pi install <absolute-extracted-dir>`. Pi loads a local path in place, without copying it. |
| DeepSeek Harness | `agent-chat-deepseek-<version>.tgz` | Set the `name` of the Cordis `insert` row to `<absolute-extracted-dir>/extensions/agent-chat.js`. See the [package README](deepseek/README.md#install). |
| OpenCode | `agent-chat-opencode-<version>.tgz` | Put `<absolute-extracted-dir>` in `plugins` in a global `opencode.jsonc`. See the [package README](opencode/README.md#install). |
| Codex | `agent-chat-codex-<version>.tgz` | Point the local marketplace entry at `<absolute-extracted-dir>`, enable the plugin and trust its hooks. The install flow has not been run. See the [package README](codex/README.md#install). |

Claude Code installs by tag through the repository's `.claude-plugin/marketplace.json`.
`claude plugin marketplace add owner/repo#<ref>` pins the catalog to a ref, so
a tag pins the plugin. Claude Code installs a new copy only when the plugin
version in `plugin.json` changes, so each release moves it to the new product
version.

Do not use `pi install git:github.com/mikomiel/agent-chat@v<version>`. The Pi
package root is `integrations/pi/`, and the Pi documentation describes no
subdirectory selector for a git source (not checked against the Pi source). Pi
installs from the extracted tarball.

A harness package that lands later follows the same rule: its tarball is
`agent-chat-<harness>-<version>.tgz`, and its README names the install step for
that tarball.

Then configure the integration as its README describes.

## Test

```sh
cd integrations/pi
node --test
```

```sh
cd integrations/deepseek
node --test
```

```sh
cd integrations/claude-code
node --test
```

```sh
cd integrations/opencode
node --test
```

```sh
cd integrations/codex
node --test
```
