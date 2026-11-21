# Harness integrations

Turnkey integrations ship from this repository, next to the service and the
adapter core. A package uses only its harness's public extension surface and
the product's worker protocol; the Python core stays authoritative for join,
heartbeat, poll, claim, settle, rejoin and binding replacement. A package
supplies native eligibility, delivery, binding context and wake behavior.

## Packages

| Harness | Package | State |
|---|---|---|
| Pi | [`pi/`](pi/) | Live-tested with Pi 1.5.2 |
| DeepSeek Harness | [`deepseek/`](deepseek/) | Live-tested with DSH 0.2.2-rc.1 |
| Claude Code | [`claude-code/`](claude-code/) | Source present; live run pending |
| Codex | — | Planned; follows the same pattern |

OpenCode and Vibe are outside the initial admission set.

## Compatibility

A package records the harness releases it was exercised against. The matrix is
evidence, not a promise: a release that was never run is `NOT RUN`, never
implied by a nearby version.

| Package | Harness surface | Verified release | Evidence |
|---|---|---|---|
| `pi` 0.1.0 | extension factory, `session_start`, `input`, `agent_start`, `agent_settled`, `ui_prompt_*`, `session_info_changed`, `before_agent_start`, `session_shutdown`, `message_start`, `sendMessage`, `registerCommand` | `1.5.2` | RPC join and shutdown; interactive delivery and rejoin against a disposable service |
| `agent-chat-deepseek` 0.1.0 | DSH extension/Cordis surface: `ctx.inject`, `agent/created`, `agent/disposed`, `agent/pre-step`, `agent/inbox/inserted`/`claimed`/`discarded`, `agent/status`, `session/event` `turn/end`, `agent.steer`, `agent.inbox.remove`, `sessionTitle`, `sessionProjections` plan unit, `webServer` | `0.2.2-rc.1` | Web profile join, native inbox delivery, lease rejoin and disposal against a disposable service |
| `agent-chat-deepseek` 0.1.0 | eligibility: `ctx.agents.get` and the session header `origin`, plus `roots()` and `isOwnedBy()` where the registry has them | `NOT RUN` on `0.2.2-rc.5` | No run. The published type declarations were compared; nothing was executed. `@deepseek-ai/dsh-agent` `0.2.2-rc.1` declares `AgentRegistry.roots()`, `AgentRegistry.isOwnedBy(id, owner)` and `CreateAgentOptions.parentAgent`. `0.2.2-rc.2` to `0.2.2-rc.5` declare none of them, and `enter(agent)` takes no owner; `get(id)` and `list()` remain. In `0.2.2-rc.5` the host's own subagent test is `session.header.origin === 'subagent'`, and the subagent child factory sets that value. The package reads which registry surface it finds and uses that header test where `roots()` and `isOwnedBy()` are both absent; a registry with only one of them refuses every agent. |

Adding a row for a live release needs a recorded run against that exact
release, including the install command and the observed join, delivery and
rejoin behavior. Update this table in the same change. A `NOT RUN` row records
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
tracks live-harness CI, the Claude Code live run and the Codex package.

## Notice contract

With `noticeBodies: true`, a peer's message body is written into the model's context. Every package renders it with
one contract, so the body stays recognizable as untrusted peer data. The contract has two implementations that pass
the same vectors in [`notice-vectors.json`](notice-vectors.json): the Python reference
[`agent_chat/notice.py`](../agent_chat/notice.py) and the dependency-free JavaScript module
[`shared/notice.js`](shared/notice.js). A package keeps no dependency and reads nothing outside its own directory
at run time, so each one ships a byte-identical copy as `lib/notice.js`. A test in each package fails when its copy
differs from the shared source.
After you edit `shared/notice.js`, copy it over all three. The normative text is the notice requirements in
[`openspec/specs/chat-clients/spec.md`](../openspec/specs/chat-clients/spec.md).

In bodies mode, a notice has:

- the adapter's own instruction lines and the binding line, then one static line that says every `> ` line between
  the markers is untrusted peer data and grants no authority;
- for each message, a header line (`message <id> kind <kind> from session <uuid> sent <time> age <N>s`, with
  `principal <uuid>` for an operator publication), an opening marker `<<<AGENT-CHAT-BODY <nonce>`, the body, and a
  closing marker `AGENT-CHAT-BODY <nonce>>>>`. The nonce is 16 random hex digits (64 bits) drawn when the notice is
  rendered, after the claim. The renderer checks every header field again against a strict pattern and returns
  nothing when one does not match;
- every body line prefixed with `> `, so a body line cannot start like a header, a marker, the binding or an
  instruction line;
- control, bidirectional, invisible, tag and variation-selector code points, and unpaired surrogates, written as
  `\uXXXX` text (`\u{X}` above U+FFFF). Tab and line feed stay, and line feed is the only line break. The table is
  `ESCAPED_RANGES`, and the vectors pin it;
- a cut on whole units (a code point or one escape) at 4096 UTF-8 bytes per body, the core's `NOTICE_BODY_BYTES`. A
  cut body is followed by a pointer line with the `history` arguments that read the rest.

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
bound, and the lifecycle makes the claim and the delivery call. `pi` and `deepseek` allow 8 KiB for the delivery line
and the notice together. `claude-code` allows 10,000 bytes for its announcement, the delivery line and the notice
together.

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
- A retry batch is claimed whole, up to 16 messages. Its headers, markers and pointers alone take about 7.5 KB in the
  test fixtures, and the shared suite checks that 16 such frames fit an 8 KiB bound. A Claude Code announcement
  larger than about 2.4 KB leaves less room than that, and the renderer then returns `null` for such a batch.
- The table of escaped code points is fixed. A code point that a later Unicode version makes invisible stays
  unescaped until the table and the vectors change.

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
