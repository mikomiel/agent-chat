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

An integration release is tested only with the core of the same version: both
ship at the product version, and a package at one release with a core at
another is an untested combination. A row therefore names the package version
and the core version it was run with in its Evidence cell. The rows below were recorded before
the packages shared the product version. They name the package at `0.1.0`, and
the core they ran with is not recorded.

| Package | Harness surface | Verified release | Evidence |
|---|---|---|---|
| `pi` 0.1.0 | extension factory, `session_start`, `input`, `agent_start`, `agent_settled`, `ui_prompt_*`, `session_info_changed`, `before_agent_start`, `session_shutdown`, `message_start`, `sendMessage`, `registerCommand` | `1.5.2` | RPC join and shutdown; interactive delivery and rejoin against a disposable service |
| `agent-chat-deepseek` 0.1.0 | DSH extension/Cordis surface: `ctx.inject`, `agent/created`, `agent/disposed`, `agent/pre-step`, `agent/inbox/inserted`/`claimed`/`discarded`, `agent/status`, `session/event` `turn/end`, `agent.steer`, `agent.inbox.remove`, `sessionTitle`, `sessionProjections` plan unit, `webServer` | `0.2.2-rc.1` | Web profile join, native inbox delivery, lease rejoin and disposal against a disposable service |
| `agent-chat-deepseek` 0.1.0 | eligibility: `ctx.agents.get` and the session header `origin`, plus `roots()` and `isOwnedBy()` where the registry has them | `NOT RUN` on `0.2.2-rc.5` | No run. The published type declarations were compared; nothing was executed. `@deepseek-ai/dsh-agent` `0.2.2-rc.1` declares `AgentRegistry.roots()`, `AgentRegistry.isOwnedBy(id, owner)` and `CreateAgentOptions.parentAgent`. `0.2.2-rc.2` to `0.2.2-rc.5` declare none of them, and `enter(agent)` takes no owner; `get(id)` and `list()` remain. In `0.2.2-rc.5` the host's own subagent test is `session.header.origin === 'subagent'`, and the subagent child factory sets that value. The package reads which registry surface it finds and uses that header test where `roots()` and `isOwnedBy()` are both absent; a registry with only one of them refuses every agent. |

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
- A retry batch is claimed whole, up to 16 messages. At body cap 0, 16 frames and the adapter's own lines take 7,052
  bytes in the shared suite's fixtures, and 7,685 bytes when every header field is at its widest. Both fit the Pi and
  DeepSeek bound of 8,137 bytes, and a test in each of those packages holds the widest case to it. `claude-code` has no
  fixed bound, because its announcement comes out of the same 10,000 bytes: [its README](claude-code/README.md) gives
  the room that is left.
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

## Release rule

`integrations/<harness>/` is a self-contained package directory with
`package.json` at its root, and every such directory is released at the product
version. The release lists no harness: it enumerates the directories, so a new
package is covered when its directory appears.

- **Version.** `version` in `package.json`, and in `.claude-plugin/plugin.json`
  where a package has one, equals `version` in the root `pyproject.toml`.
  release-please bumps them with the project version (`extra-files` globs in
  `release-please-config.json`).
- **Name.** `agent-chat-<harness>`. `npm pack` names the release asset after
  it: `agent-chat-<harness>-<version>.tgz`.
- **Contents.** A `files` allowlist lists the entry points, `lib/`, `scripts/`,
  `hooks/`, `.claude-plugin/` and `README.md` that the package needs, so
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

The variable names the private `0600` config file. `AGENT_CHAT_DELEGATED_CHILD=1`
keeps a harness process that a session starts on purpose from joining chat.

`tests/test_release_artifacts.py` pins this rule for every directory under
`integrations/`. `scripts/check_release_artifacts.py` packs the directories and
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
   that has this version installed.
2. **Download, verify and extract the tarball** of the harness (`pi`,
   `deepseek` or `claude-code`) in one block. The block needs `bash`, `curl`,
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
