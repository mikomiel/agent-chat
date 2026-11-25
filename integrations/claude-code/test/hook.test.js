import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { HOLD_MS, MAX_HOLD_MS, MIN_HOLD_MS, effectiveHoldMs, runHook } from "../lib/hook.js"
import { MAX_OUTPUT_BYTES } from "../lib/channel.js"

const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" })
const never = () => new Promise(() => {})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// A wait that never keeps the test process alive after the test is done.
const idle = ms => new Promise(resolve => setTimeout(resolve, ms).unref())

function world(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  const state = join(root, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: state, serverOrigin: "https://chat.example",
    hostToken: "synthetic-host-token", python: "/usr/bin/python3", ...extra,
  }))
  chmodSync(file, 0o600)
  return { root, state, file, env: { AGENT_CHAT_CLAUDE_CONFIG: file } }
}

// Runs one hook command against doubles. The receiver connection answers `reply`
// to a request and serves `frames` to a waiter; the output records every write
// in order, so a test can say what happened before what. `config` adds keys to
// the config file; `holdMs: null` leaves the hold to that config, and `holds`
// records each wait the waiter asked the connection for.
async function run(name, payload, {
  env, config = {}, reply = { context: null }, frames = [], up = true, writeOk = true, writeDelay = 0,
  hang = false, holdMs = 50, orphanMs = 10, ppid = () => 100, sleep = never,
} = {}) {
  const w = world(config)
  const out = { stdout: [], stderr: [], started: [], calls: [], sent: [], log: [], connects: 0, holds: [] }
  const pending = [...frames]
  const link = {
    async call(request) {
      out.calls.push(request)
      out.log.push(`call:${request.op}`)
      if (hang) await never()
      return typeof reply === "function" ? reply(request) : reply
    },
    async send(frame) { out.sent.push(frame); out.log.push(`send:${frame.op}`); return true },
    // A hold that the code under test got wrong must fail a test, not stall the run for the hour it asked for.
    next: ms => {
      out.holds.push(ms)
      return pending.length ? Promise.resolve(pending.shift()) : idle(Math.min(ms, 10_000)).then(() => null)
    },
    close() { out.log.push("close") },
  }
  const io = {
    stdin: Readable.from([Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))]),
    env: env ?? w.env,
    connect: async () => {
      out.connects += 1
      if (!up && !out.started.length) throw absent()
      return link
    },
    startReceiver: (_config, sessionId) => { out.started.push(sessionId) },
    write: async (stream, text) => {
      out.log.push(`write:${stream}:start`)
      if (writeDelay) await delay(writeDelay)
      out.log.push(`write:${stream}:end`)
      out[stream].push(text)
      return writeOk
    },
    ppid, orphanMs, holdMs, sleep,
  }
  try {
    out.code = await runHook(name, io)
    return out
  } finally { rmSync(w.root, { recursive: true, force: true }) }
}

const base = { session_id: "session-1", permission_mode: "default", hook_event_name: "UserPromptSubmit" }
const json = lines => JSON.parse(lines.join(""))
const everyHook = ["session-start", "prompt", "tool", "stop", "wait", "session-end"]
const silent = result => {
  assert.equal(result.code, 0)
  assert.equal(result.connects, 0, "not even a connection")
  assert.deepEqual(result.log, [])
  assert.deepEqual(result.started, [])
  assert.deepEqual(result.stdout.concat(result.stderr), [])
}

test("session start prints the binding as additionalContext and acknowledges only after the write", async () => {
  const result = await run("session-start", { ...base, hook_event_name: "SessionStart", source: "startup" }, {
    reply: { context: "Agent Chat is available to this session.", ack: true, message: "Agent Chat: joined as s in room r." },
    writeDelay: 20,
  })
  assert.equal(result.code, 0)
  assert.deepEqual(json(result.stdout), {
    systemMessage: "Agent Chat: joined as s in room r.",
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Agent Chat is available to this session." },
  })
  assert.equal(result.stdout.length, 1, "one JSON object, written once")
  assert.deepEqual(result.calls, [{ op: "start", wait_ms: 5000, owner_pid: 100 }])
  assert.deepEqual(result.sent, [{ op: "done", outcome: "written" }])
  assert.deepEqual(result.log, ["call:start", "write:stdout:start", "write:stdout:end", "send:done", "close"])
})

test("a prompt and a tool event deliver through their own hookEventName", async () => {
  for (const [name, event] of [["prompt", "UserPromptSubmit"], ["tool", "PostToolUse"]]) {
    const result = await run(name, { ...base, permission_mode: "acceptEdits", hook_event_name: event }, {
      reply: { context: "Agent Chat message(s) delivered by the native adapter.\n{}", ack: true },
    })
    assert.equal(result.code, 0)
    assert.deepEqual(json(result.stdout), {
      hookSpecificOutput: { hookEventName: event, additionalContext: "Agent Chat message(s) delivered by the native adapter.\n{}" },
    })
    assert.deepEqual(result.calls, [{ op: "turn", permission_mode: "acceptEdits", patience_ms: 6000, owner_pid: 100 }])
    assert.deepEqual(result.sent, [{ op: "done", outcome: "written" }])
  }
})

test("a start and a turn name the hook's parent process, so a resumed session moves the owner watch", async () => {
  for (const name of ["session-start", "prompt", "tool"]) {
    const result = await run(name, base, { ppid: () => 777 })
    assert.equal(result.calls[0].owner_pid, 777, name)
  }
})

test("a mode Claude Code did not report is left out of the request, never guessed", async () => {
  const { permission_mode: _omitted, ...payload } = base
  for (const unusable of [payload, { ...base, permission_mode: 7 }, { ...base, permission_mode: null }]) {
    const result = await run("tool", unusable)
    assert.equal(JSON.stringify(result.calls[0]).includes("permission_mode"), false)
  }
})

test("a turn with nothing to deliver prints nothing and acknowledges nothing", async () => {
  for (const name of ["session-start", "prompt", "tool"]) {
    const result = await run(name, base, { reply: { context: null } })
    assert.equal(result.code, 0)
    assert.deepEqual(result.stdout, [], name)
    assert.deepEqual(result.sent, [], name)
  }
})

test("a user-visible message is clipped, and is never the delivery", async () => {
  const result = await run("session-start", base, { reply: { message: "m".repeat(900) } })
  assert.equal(json(result.stdout).systemMessage.length, 500)
  assert.equal("hookSpecificOutput" in json(result.stdout), false)
})

test("output is never over the 10,000-character cap, and a refused write is never acknowledged as written", async () => {
  const over = "x".repeat(MAX_OUTPUT_BYTES + 1)
  const multibyte = "€".repeat(3400) // 3,400 characters, 10,200 bytes
  assert.ok(multibyte.length < MAX_OUTPUT_BYTES && Buffer.byteLength(multibyte) > MAX_OUTPUT_BYTES)
  for (const context of [over, multibyte]) {
    const result = await run("prompt", base, { reply: { context, ack: true } })
    assert.equal(result.code, 0)
    assert.deepEqual(result.stdout, [])
    assert.deepEqual(result.sent, [{ op: "done", outcome: "refused" }])
  }
  const fits = await run("prompt", base, { reply: { context: "y".repeat(MAX_OUTPUT_BYTES), ack: true } })
  assert.equal(json(fits.stdout).hookSpecificOutput.additionalContext.length, MAX_OUTPUT_BYTES)
  assert.deepEqual(fits.sent, [{ op: "done", outcome: "written" }])
  const message = await run("prompt", base, { reply: { context: over, ack: true, message: "Agent Chat stopped." } })
  assert.deepEqual(json(message.stdout), { systemMessage: "Agent Chat stopped." })
  assert.deepEqual(message.sent, [{ op: "done", outcome: "refused" }])
})

test("an output that failed to write is reported failed, never written", async () => {
  const result = await run("prompt", base, { reply: { context: "notice", ack: true }, writeOk: false })
  assert.equal(result.code, 0)
  assert.deepEqual(result.sent, [{ op: "done", outcome: "failed" }])
  assert.deepEqual(result.log.slice(0, 3), ["call:turn", "write:stdout:start", "write:stdout:end"])
})

test("a delegated agent never joins, claims or prints", async () => {
  for (const payload of [
    { ...base, agent_id: "agent-7", agent_type: "Explore" },
    { ...base, agent_id: "agent-7" },
    { ...base, agent_id: "" },
    { ...base, agent_id: null },
  ]) {
    for (const name of everyHook) {
      silent(await run(name, payload, { reply: { context: "notice", ack: true }, frames: [{ context: "notice", ack: true }] }))
    }
  }
})

test("a main session started with --agent still joins: agent_type alone is not delegation", async () => {
  const result = await run("prompt", { ...base, agent_type: "security-reviewer" }, { reply: { context: "notice", ack: true } })
  assert.equal(json(result.stdout).hookSpecificOutput.additionalContext, "notice")
})

test("the delegated-child environment variable keeps every hook silent", async () => {
  const w = world()
  try {
    for (const name of everyHook) {
      silent(await run(name, base, {
        env: { ...w.env, AGENT_CHAT_DELEGATED_CHILD: "1" }, reply: { context: "notice" }, frames: [{ context: "notice" }],
      }))
    }
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test("no config, a bad config or a bad payload keeps every hook silent", async () => {
  for (const env of [{}, { AGENT_CHAT_CLAUDE_CONFIG: "relative.json" }, { AGENT_CHAT_CLAUDE_CONFIG: "/nonexistent/chat.json" }]) {
    silent(await run("prompt", base, { env, reply: { context: "notice", ack: true } }))
  }
  for (const payload of ["", "not json", "[]", "null", "7", JSON.stringify({ permission_mode: "default" }),
    JSON.stringify({ session_id: "" }), JSON.stringify({ session_id: 7 })]) {
    silent(await run("prompt", payload, { reply: { context: "notice", ack: true } }))
  }
  silent(await run("nope", base))
})

test("a config directory that is not private keeps every hook silent", async () => {
  const w = world()
  chmodSync(w.state, 0o755)
  try { silent(await run("prompt", base, { env: w.env, reply: { context: "notice", ack: true } })) }
  finally { rmSync(w.root, { recursive: true, force: true }) }
})

test("a stop event reports the mode and prints nothing, whatever the receiver answers", async () => {
  const result = await run("stop", base, { reply: { context: "should never be printed", ack: true, message: "nor this" } })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [{ op: "stop", permission_mode: "default" }])
  assert.deepEqual(result.stdout.concat(result.stderr), [])
  assert.deepEqual(result.sent, [])
})

test("a session end asks the receiver to end and never starts one", async () => {
  const result = await run("session-end", { ...base, hook_event_name: "SessionEnd", reason: "other" }, { reply: { ok: true } })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [{ op: "end" }])
  const gone = await run("session-end", base, { up: false })
  assert.equal(gone.code, 0)
  assert.deepEqual(gone.started, [])
})

test("only a session start and a prompt start a missing receiver", async () => {
  for (const name of ["session-start", "prompt"]) {
    const result = await run(name, base, { up: false, reply: { context: null } })
    assert.deepEqual(result.started, ["session-1"], name)
    assert.equal(result.calls.length, 1, name)
  }
  for (const name of ["tool", "stop", "wait", "session-end"]) {
    const result = await run(name, base, { up: false, reply: { context: null } })
    assert.equal(result.code, 0, name)
    assert.deepEqual(result.started, [], name)
    assert.deepEqual(result.calls, [], name)
  }
})

test("only the idle-wake waiter ever exits with code 2", async () => {
  const hostile = [{ context: "notice", ack: true }, { context: "notice" }, { message: "m" }, { error: "bad_op" }, { disabled: true }, {}]
  for (const name of ["session-start", "prompt", "tool", "stop", "session-end"]) {
    for (const reply of hostile) {
      const result = await run(name, base, { reply })
      assert.equal(result.code, 0, `${name} ${JSON.stringify(reply)}`)
    }
  }
})

test("a receiver that never answers cannot hold a hook past its budget", async () => {
  const result = await run("prompt", base, { hang: true, sleep: () => delay(30) })
  assert.equal(result.code, 0)
  assert.deepEqual(result.stdout, [])
  assert.deepEqual(result.sent, [])
})

test("the waiter acknowledges the write only after stderr is flushed, then exits 2", async () => {
  const result = await run("wait", base, { frames: [{ context: "Agent Chat notice.", ack: true }], writeDelay: 20 })
  assert.equal(result.code, 2)
  assert.deepEqual(result.stderr, ["Agent Chat notice."])
  assert.deepEqual(result.stdout, [])
  assert.deepEqual(result.log, ["send:wait", "write:stderr:start", "write:stderr:end", "send:done", "close"])
  assert.deepEqual(result.sent, [{ op: "wait" }, { op: "done", outcome: "written" }])
})

test("a waiter whose stderr write failed exits 0 and reports failed", async () => {
  const result = await run("wait", base, { frames: [{ context: "notice", ack: true }], writeOk: false })
  assert.equal(result.code, 0)
  assert.deepEqual(result.sent, [{ op: "wait" }, { op: "done", outcome: "failed" }])
})

test("a waiter never writes an oversized notice", async () => {
  for (const context of ["x".repeat(MAX_OUTPUT_BYTES + 1), "€".repeat(3400)]) {
    const result = await run("wait", base, { frames: [{ context, ack: true }] })
    assert.equal(result.code, 0)
    assert.deepEqual(result.stderr, [])
    assert.deepEqual(result.sent, [{ op: "wait" }, { op: "done", outcome: "refused" }])
  }
  const exact = await run("wait", base, { frames: [{ context: "y".repeat(MAX_OUTPUT_BYTES), ack: true }] })
  assert.equal(exact.code, 2)
  assert.equal(exact.stderr[0].length, MAX_OUTPUT_BYTES)
})

test("a waiter that is cancelled, disabled, closed or out of hold leaves quietly", async () => {
  for (const frames of [[{ cancelled: true }], [{ disabled: true }], [null], [{ context: "" }], []]) {
    const result = await run("wait", base, { frames, holdMs: 30 })
    assert.equal(result.code, 0, JSON.stringify(frames))
    assert.deepEqual(result.stderr.concat(result.stdout), [])
    assert.deepEqual(result.sent, [{ op: "wait" }], "no acknowledgement for a notice it never wrote")
  }
})

test("a waiter whose parent process vanished leaves without waiting out the hold", async () => {
  let reads = 0
  const started = Date.now()
  const result = await run("wait", base, { ppid: () => (reads++ === 0 ? 100 : 1), orphanMs: 10, holdMs: 3000 })
  assert.equal(result.code, 0)
  assert.deepEqual(result.stderr, [])
  assert.deepEqual(result.sent, [{ op: "wait" }])
  assert.ok(Date.now() - started < 1500, "the orphan check, not the hold, ended the wait")
})

// Issue #133: the waiter holds for the configured `idleWakeHoldSeconds`, clamped between the shortest and the longest hold. A refused config
// also exits 0 and says nothing, the same as a waiter that held, so these cases check what a refusal cannot show: the
// waiter connected and sent its `wait` frame (`sent`), and it asked the connection for the hold the config names
// (`holds`). `holdMs: null` takes the test seam away, so the config alone decides.
test("the effective hold is the configured seconds, raised to the shortest hold, cut to the longest, and the default when none is usable", () => {
  assert.equal(HOLD_MS, 3_540_000, "59 minutes by default")
  assert.equal(MIN_HOLD_MS, 10_000, "10 seconds at least")
  assert.equal(MAX_HOLD_MS, 8_385_000, "8,385 seconds at most")
  assert.equal(effectiveHoldMs(undefined), HOLD_MS)
  // A hold below the floor is raised, never refused.
  for (const seconds of [1, 2, 9]) assert.equal(effectiveHoldMs(seconds), MIN_HOLD_MS, String(seconds))
  assert.equal(effectiveHoldMs(MIN_HOLD_MS / 1000), MIN_HOLD_MS)
  assert.equal(effectiveHoldMs(MIN_HOLD_MS / 1000 + 1), MIN_HOLD_MS + 1000)
  assert.equal(effectiveHoldMs(MAX_HOLD_MS / 1000), MAX_HOLD_MS)
  for (const seconds of [MAX_HOLD_MS / 1000 + 1, 10_000, 86_400, Number.MAX_SAFE_INTEGER]) {
    assert.equal(effectiveHoldMs(seconds), MAX_HOLD_MS, String(seconds))
  }
  // The loader refuses these. The function still never returns a zero, negative or NaN hold.
  for (const unusable of [0, -1, 0.5, 1.5, "60", "", null, true, [60], {}, Number.NaN, Infinity, -Infinity]) {
    assert.equal(effectiveHoldMs(unusable), HOLD_MS, String(unusable))
  }
})

test("the waiter holds for the configured seconds, raises a shorter hold, clamps a longer one and keeps the default when none is set", async () => {
  const cap = MAX_HOLD_MS / 1000
  for (const [seconds, expected] of [
    [undefined, HOLD_MS], [1, MIN_HOLD_MS], [9, MIN_HOLD_MS], [10, 10_000], [11, 11_000], [120, 120_000], [3540, HOLD_MS],
    [cap, MAX_HOLD_MS], [cap + 1, MAX_HOLD_MS], [86_400, MAX_HOLD_MS], [Number.MAX_SAFE_INTEGER, MAX_HOLD_MS],
  ]) {
    // A cancel frame ends the wait at once, so the case does not wait out the hold it measures.
    const result = await run("wait", base, {
      config: seconds === undefined ? {} : { idleWakeHoldSeconds: seconds }, holdMs: null, frames: [{ cancelled: true }],
    })
    assert.equal(result.code, 0, String(seconds))
    assert.deepEqual(result.sent, [{ op: "wait" }], `${seconds}: the waiter registered`)
    assert.deepEqual(result.holds, [expected], String(seconds))
  }
})

// The test seam `holdMs` wins over the config, so a case that must see the hold run out does not wait for the
// 10-second floor. The e2e suite runs the real 10-second hold.
test("when the hold runs out the waiter leaves quietly and sends no receipt, and the seam wins over the config", async () => {
  const result = await run("wait", base, { config: { idleWakeHoldSeconds: 1 }, holdMs: 50 })
  assert.equal(result.code, 0)
  assert.deepEqual(result.stdout.concat(result.stderr), [])
  assert.deepEqual(result.sent, [{ op: "wait" }], "it registered, waited and acknowledged nothing: no done frame")
  assert.deepEqual(result.holds, [50])
})

test("a bad idleWakeHoldSeconds keeps the waiter silent: no connection, no wait, no output", async () => {
  for (const idleWakeHoldSeconds of [0, -1, 1.5, "60", null]) {
    silent(await run("wait", base, {
      config: { idleWakeHoldSeconds }, holdMs: null, frames: [{ context: "notice", ack: true }],
    }))
  }
})
