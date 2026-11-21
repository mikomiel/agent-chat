import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { ownerOf, runHook } from "../lib/hook.js"
import { MAX_OUTPUT_BYTES } from "../lib/channel.js"

const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" })
const never = () => new Promise(() => {})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function world() {
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  const state = join(root, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: state, serverOrigin: "https://chat.example",
    hostToken: "synthetic-host-token", python: "/usr/bin/python3",
  }))
  chmodSync(file, 0o600)
  return { root, state, file, env: { AGENT_CHAT_CODEX_CONFIG: file } }
}

// Runs one hook command against doubles. The receiver connection answers `reply`
// to a request; the output records every write in order, so a test can say what
// happened before what.
async function run(name, payload, {
  env, reply = { context: null }, up = true, writeOk = true, writeDelay = 0,
  hang = false, owner = () => 100, sleep = never,
} = {}) {
  const w = world()
  const out = { stdout: [], started: [], calls: [], sent: [], log: [], connects: 0 }
  const link = {
    async call(request) {
      out.calls.push(request)
      out.log.push(`call:${request.op}`)
      if (hang) await never()
      return typeof reply === "function" ? reply(request) : reply
    },
    async send(frame) { out.sent.push(frame); out.log.push(`send:${frame.op}`); return true },
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
    write: async text => {
      out.log.push("write:start")
      if (writeDelay) await delay(writeDelay)
      out.log.push("write:end")
      out.stdout.push(text)
      return writeOk
    },
    owner, sleep,
  }
  try {
    out.code = await runHook(name, io)
    return out
  } finally { rmSync(w.root, { recursive: true, force: true }) }
}

const base = { session_id: "session-1", permission_mode: "default", hook_event_name: "UserPromptSubmit" }
const json = lines => JSON.parse(lines.join(""))
const everyHook = ["session-start", "prompt", "tool", "stop", "interrupt", "session-end"]
const silent = result => {
  assert.equal(result.code, 0)
  assert.equal(result.connects, 0, "not even a connection")
  assert.deepEqual(result.log, [])
  assert.deepEqual(result.started, [])
  assert.deepEqual(result.stdout, [])
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
  assert.deepEqual(result.log, ["call:start", "write:start", "write:end", "send:done", "close"])
})

test("every SessionStart source is the same start event", async () => {
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    const result = await run("session-start", { ...base, hook_event_name: "SessionStart", source }, { reply: { context: "binding", ack: true } })
    assert.deepEqual(result.calls, [{ op: "start", wait_ms: 5000, owner_pid: 100 }], source)
    assert.equal(json(result.stdout).hookSpecificOutput.hookEventName, "SessionStart", source)
  }
})

test("a prompt and a tool event deliver through their own hookEventName and name their event", async () => {
  for (const [name, event] of [["prompt", "UserPromptSubmit"], ["tool", "PostToolUse"]]) {
    const result = await run(name, { ...base, permission_mode: "acceptEdits", hook_event_name: event }, {
      reply: { context: "Agent Chat message(s) delivered by the native adapter.\n{}", ack: true },
    })
    assert.equal(result.code, 0)
    assert.deepEqual(json(result.stdout), {
      hookSpecificOutput: { hookEventName: event, additionalContext: "Agent Chat message(s) delivered by the native adapter.\n{}" },
    })
    assert.deepEqual(result.calls, [{ op: "turn", event: name, permission_mode: "acceptEdits", patience_ms: 6000, owner_pid: 100 }])
    assert.deepEqual(result.sent, [{ op: "done", outcome: "written" }])
  }
})

test("a start and a turn name the process that runs Codex, so a resumed session moves the owner watch", async () => {
  for (const name of ["session-start", "prompt", "tool"]) {
    const result = await run(name, base, { owner: () => 777 })
    assert.equal(result.calls[0].owner_pid, 777, name)
  }
})

test("the owner skips the shell that runs a hook command, and stops at anything else", () => {
  const table = { 50: "50 (sh) S 40 0", 40: "40 (codex) S 30 0", 60: "60 (bash) S 50 0", 61: "61 (my (odd) name) S 5 0" }
  const read = path => {
    const text = table[Number(path.split("/")[2])]
    if (text === undefined) throw new Error("gone")
    return text
  }
  assert.equal(ownerOf(50, read), 40, "one shell")
  assert.equal(ownerOf(60, read), 40, "two shells, the most it skips")
  assert.equal(ownerOf(40, read), 40, "a program that is not a shell is the owner")
  assert.equal(ownerOf(61, read), 61, "a name with parentheses is read from the last one")
  assert.equal(ownerOf(99, read), 99, "an unreadable /proc leaves the parent")
})

test("a mode Codex did not report is left out of the request, never guessed", async () => {
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

test("output is never over the 6,000-byte cap, and a refused write is never acknowledged as written", async () => {
  const over = "x".repeat(MAX_OUTPUT_BYTES + 1)
  const multibyte = "€".repeat(2001) // 2,001 characters, 6,003 bytes
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
  assert.deepEqual(result.log.slice(0, 3), ["call:turn", "write:start", "write:end"])
})

test("a delegated agent never joins, claims or prints", async () => {
  for (const payload of [
    { ...base, agent_id: "agent-7", agent_type: "explorer" },
    { ...base, agent_id: "agent-7" },
    { ...base, agent_id: "" },
    { ...base, agent_id: null },
  ]) {
    for (const name of everyHook) {
      silent(await run(name, payload, { reply: { context: "notice", ack: true } }))
    }
  }
})

test("a payload with agent_type alone is not delegation", async () => {
  const result = await run("prompt", { ...base, agent_type: "reviewer" }, { reply: { context: "notice", ack: true } })
  assert.equal(json(result.stdout).hookSpecificOutput.additionalContext, "notice")
})

test("the delegated-child environment variable keeps every hook silent", async () => {
  const w = world()
  try {
    for (const name of everyHook) {
      silent(await run(name, base, { env: { ...w.env, AGENT_CHAT_DELEGATED_CHILD: "1" }, reply: { context: "notice" } }))
    }
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test("no config, a bad config or a bad payload keeps every hook silent", async () => {
  for (const env of [{}, { AGENT_CHAT_CODEX_CONFIG: "relative.json" }, { AGENT_CHAT_CODEX_CONFIG: "/nonexistent/chat.json" }]) {
    silent(await run("prompt", base, { env, reply: { context: "notice", ack: true } }))
  }
  for (const payload of ["", "not json", "[]", "null", "7", JSON.stringify({ permission_mode: "default" }),
    JSON.stringify({ session_id: "" }), JSON.stringify({ session_id: 7 })]) {
    silent(await run("prompt", payload, { reply: { context: "notice", ack: true } }))
  }
  silent(await run("nope", base))
  silent(await run("wait", base))
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
  assert.deepEqual(result.stdout, [])
  assert.deepEqual(result.sent, [])
})

test("an interrupt reports a stop and prints nothing, whatever the receiver answers", async () => {
  const result = await run("interrupt", { ...base, hook_event_name: "Interrupt", turn_id: "t1" }, {
    reply: { context: "should never be printed", ack: true, message: "nor this" },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [{ op: "interrupt" }])
  assert.deepEqual(result.stdout, [])
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
  for (const name of ["tool", "stop", "interrupt", "session-end"]) {
    const result = await run(name, base, { up: false, reply: { context: null } })
    assert.equal(result.code, 0, name)
    assert.deepEqual(result.started, [], name)
    assert.deepEqual(result.calls, [], name)
  }
})

test("every hook exits 0 whatever the receiver answers, and prints nothing outside the documented shape", async () => {
  const hostile = [{ context: "notice", ack: true }, { context: "notice" }, { message: "m" }, { error: "bad_op" }, { disabled: true }, {}]
  for (const name of everyHook) {
    for (const reply of hostile) {
      const result = await run(name, base, { reply })
      assert.equal(result.code, 0, `${name} ${JSON.stringify(reply)}`)
      for (const line of result.stdout) {
        const value = JSON.parse(line)
        assert.ok(Object.keys(value).every(key => ["systemMessage", "hookSpecificOutput"].includes(key)), name)
      }
    }
  }
})

test("a receiver that never answers cannot hold a hook past its budget, and still exits 0", async () => {
  for (const name of everyHook) {
    const result = await run(name, base, { hang: true, sleep: () => delay(30) })
    assert.equal(result.code, 0, name)
    assert.deepEqual(result.stdout, [], name)
  }
})
