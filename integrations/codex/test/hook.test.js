import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Readable } from "node:stream"
import { ownerOf, runHook } from "../lib/hook.js"
import { MAX_OUTPUT_BYTES } from "../lib/channel.js"
import { connect, paths, serve } from "../lib/ipc.js"
import { trustedSocket } from "../lib/trust.js"

const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" })
const never = () => new Promise(() => {})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function world({ parentMode } = {}) {
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  let parent = root
  if (parentMode !== undefined) { // the state directory sits one level down, below a directory with this mode
    parent = join(root, "p")
    mkdirSync(parent)
    chmodSync(parent, parentMode)
  }
  const state = join(parent, "s")
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
  hang = false, owner = () => 100, provenOwner = owner, sleep = never, now, connected,
} = {}) {
  const w = world()
  const out = { stdout: [], started: [], calls: [], waits: [], sent: [], log: [], connects: 0 }
  const link = {
    async call(request, waitMs) {
      out.calls.push(request)
      out.waits.push(waitMs)
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
      connected?.()
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
    owner, provenOwner, sleep, ...(now ? { now } : {}),
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
  assert.deepEqual(result.calls, [{ op: "start", wait_ms: 5000, owner_pid: 100, permission_mode: "default" }])
  assert.deepEqual(result.sent, [{ op: "done", outcome: "written" }])
  assert.deepEqual(result.log, ["call:start", "write:start", "write:end", "send:done", "close"])
})

test("a SessionStart without a permission mode starts with none", async () => {
  const { permission_mode: _, ...bare } = base
  const result = await run("session-start", { ...bare, hook_event_name: "SessionStart", source: "resume" }, { reply: { context: "binding", ack: true } })
  assert.deepEqual(result.calls, [{ op: "start", wait_ms: 5000, owner_pid: 100, permission_mode: undefined }])
})

test("a SessionStart that resumes in Plan Mode passes the mode", async () => {
  const result = await run("session-start", { ...base, hook_event_name: "SessionStart", source: "resume", permission_mode: "plan" }, { reply: { context: "binding", ack: true } })
  assert.deepEqual(result.calls, [{ op: "start", wait_ms: 5000, owner_pid: 100, permission_mode: "plan" }])
})

test("every SessionStart source is the same start event", async () => {
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    const result = await run("session-start", { ...base, hook_event_name: "SessionStart", source }, { reply: { context: "binding", ack: true } })
    assert.deepEqual(result.calls, [{ op: "start", wait_ms: 5000, owner_pid: 100, permission_mode: "default" }], source)
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

// A turn hook has one deadline, its own limit. What the connect took comes off the wait for the reply, and the receiver's patience
// is that wait less the margin: a slow connect leaves the receiver less time, never more than the hook has left.
test("a turn hook's wait and the receiver's patience come out of one deadline that the connect spends too", async () => {
  for (const [name, spent, wait, patience] of [
    ["prompt", 0, 7500, 6000], ["prompt", 2500, 6000, 4500], ["tool", 4000, 4500, 3000], ["prompt", 8000, 500, 0], ["tool", 9500, 0, 0],
  ]) {
    let clock = 0
    const result = await run(name, base, { now: () => clock, connected: () => { clock += spent } })
    assert.deepEqual(result.waits, [wait], `${name} after ${spent} ms`)
    assert.equal(result.calls[0].patience_ms, patience, `${name} after ${spent} ms`)
  }
})

test("a start, a turn and an end name the process that runs Codex, so a resumed session moves the owner watch", async () => {
  for (const name of ["session-start", "prompt", "tool", "session-end"]) {
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

// An end names its owner only when /proc proved it: a guessed owner (no /proc, a shell with no parent, a third shell) is null
// there, and the end then names none, so the receiver's rule for an end with no owner applies. Start and turn are unchanged.
test("the proven owner is null wherever the owner is a fallback, and the end then names no owner", async () => {
  const table = {
    50: "50 (sh) S 40 0", 40: "40 (codex) S 30 0", 60: "60 (bash) S 50 0", 70: "70 (sh) S 1 0",
    80: "80 (sh) S 81 0", 81: "81 (sh) S 82 0", 82: "82 (sh) S 40 0", 83: "83 (sh) S 84 0", 84: "84 (bash) S 98 0",
  }
  const read = path => {
    const text = table[Number(path.split("/")[2])]
    if (text === undefined) throw new Error("gone")
    return text
  }
  assert.equal(ownerOf(50, read, { proven: true }), 40, "a shell under Codex: proven")
  assert.equal(ownerOf(40, read, { proven: true }), 40)
  assert.equal(ownerOf(99, read, { proven: true }), null, "no /proc")
  assert.equal(ownerOf(70, read, { proven: true }), null, "a shell with no parent")
  assert.equal(ownerOf(80, read, { proven: true }), null, "a third shell")
  assert.equal(ownerOf(60, read, { proven: true }), 40, "Codex under two shells is read and proven")
  assert.equal(ownerOf(83, read, { proven: true }), null, "two shells and then no /proc record")
  // Start and turn keep their answers: the hint with its fallbacks.
  for (const [pid, owner] of [[40, 40], [50, 40], [60, 40], [70, 70], [80, 82], [83, 98], [99, 99]]) assert.equal(ownerOf(pid, read), owner, `start and turn: ${pid}`)
  assert.equal(ownerOf(99, read), 99, "the start and turn owner keeps its fallback")
  const guessed = await run("session-end", { ...base, hook_event_name: "SessionEnd", reason: "other" }, { reply: { ok: true }, provenOwner: () => null })
  assert.deepEqual(guessed.calls, [{ op: "end" }])
  const start = await run("session-start", base, { provenOwner: () => null })
  assert.equal(start.calls[0].owner_pid, 100, "a start still names its owner")
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
  assert.deepEqual(result.calls, [{ op: "end", owner_pid: 100 }])
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

// ---- the hook prints what a receiver says only when the path to it is trusted ---------------------------------------

// A real receiver socket, and a hook that talks to it over the real transport. The receiver answers every request with a
// context that a hook would print; `handled` counts the requests it ever received.
async function overSocket(w, trust) {
  const seen = { handled: 0, started: [], stdout: [] }
  const receiver = await serve(paths(w.state, "session-1").socket, async (_first, link) => {
    seen.handled += 1
    await link.send({ context: "a notice that the model would read", ack: true })
  })
  const io = {
    stdin: Readable.from([Buffer.from(JSON.stringify(base))]),
    env: w.env,
    connect: (path, options) => connect(path, { ...options, ...(trust ? { trust } : {}) }),
    startReceiver: (_config, sessionId) => { seen.started.push(sessionId) },
    write: async text => { seen.stdout.push(text); return true },
    owner: () => 100,
    sleep: never,
  }
  try { seen.code = await runHook("prompt", io); return seen } finally { receiver.close() }
}
// The shared trust rule with a file system in which the socket belongs to another user.
const ownedByAnother = socket => path => trustedSocket(path, {
  refuse: "CHAT_SOCKET_UNTRUSTED",
  lstat: target => { const info = lstatSync(target); return basename(target) === basename(socket) ? Object.create(info, { uid: { value: process.geteuid() + 1 } }) : info },
})

test("control: a trusted socket in a private directory delivers, so the refusals below are the trust check and nothing else", async () => {
  const w = world()
  try {
    const seen = await overSocket(w)
    assert.equal(seen.code, 0)
    assert.equal(seen.handled, 1)
    assert.match(json(seen.stdout).hookSpecificOutput.additionalContext, /a notice that the model would read/)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test("a state directory below a directory that others can write prints nothing and connects to nothing, as for an absent receiver", async () => {
  for (const mode of [0o777, 0o775, 0o757]) {
    const w = world({ parentMode: mode })
    try {
      const seen = await overSocket(w)
      assert.equal(seen.code, 0, mode.toString(8))
      assert.equal(seen.handled, 0, `${mode.toString(8)}: the receiver was never asked`)
      assert.deepEqual(seen.stdout, [], mode.toString(8))
      assert.deepEqual(seen.started, [], `${mode.toString(8)}: no receiver was started`)
    } finally { rmSync(w.root, { recursive: true, force: true }) }
  }
})

test("a receiver socket that another user owns prints nothing and is never connected to, as for an absent receiver", async () => {
  const w = world()
  try {
    const socket = paths(w.state, "session-1").socket
    const seen = await overSocket(w, ownedByAnother(socket))
    assert.equal(seen.code, 0)
    assert.equal(seen.handled, 0, "the receiver was never asked")
    assert.deepEqual(seen.stdout, [])
    assert.deepEqual(seen.started, [], "no receiver was started on top of it")
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

// ---- the state directory is resolved once: every path the hook uses is the canonical one ----------------------------------

// A state directory that is reached through a link above it: `<root>/via` leads to `<root>/real`, which holds the state
// directory `s`. `decoy` has a state directory too, for a link that is moved afterwards.
function linked(realMode = 0o755) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acc-")))
  const real = join(root, "real")
  const decoy = join(root, "decoy")
  for (const directory of [real, decoy]) {
    mkdirSync(directory)
    chmodSync(directory, directory === real ? realMode : 0o755)
    mkdirSync(join(directory, "s"), { mode: 0o700 })
    chmodSync(join(directory, "s"), 0o700)
  }
  symlinkSync(real, join(root, "via"))
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: join(root, "via", "s"), serverOrigin: "https://chat.example",
    hostToken: "synthetic-host-token", python: "/usr/bin/python3",
  }))
  chmodSync(file, 0o600)
  return { root, real, decoy, state: join(real, "s"), via: join(root, "via"), env: { AGENT_CHAT_CODEX_CONFIG: file } }
}

test("a state directory behind a link is resolved once: the lock, the socket and the receiver's directory are the canonical path, even when the link moves", async () => {
  const w = linked()
  const seen = { connects: [], started: [] }
  const link = { async call() { return { context: null } }, async send() { return true }, close() {} }
  const io = {
    stdin: Readable.from([Buffer.from(JSON.stringify(base))]),
    env: w.env,
    connect: async path => {
      seen.connects.push(path)
      if (!seen.started.length) throw absent()
      return link
    },
    startReceiver: config => { // the link moves while the receiver starts, as a hostile one could
      seen.started.push(config.directory)
      unlinkSync(w.via)
      symlinkSync(w.decoy, w.via)
    },
    write: async () => true,
    owner: () => 100,
    sleep: never,
  }
  try {
    assert.equal(await runHook("session-start", io), 0)
    assert.deepEqual(seen.started, [w.state], "the receiver is started in the canonical directory")
    assert.ok(seen.connects.length >= 2)
    for (const path of seen.connects) assert.equal(path, paths(w.state, "session-1").socket, "every connection goes to the canonical socket")
    assert.deepEqual(readdirSync(w.state), [], "the start lock was taken and released at the canonical path")
    assert.deepEqual(readdirSync(join(w.decoy, "s")), [], "nothing was kept in the directory the link moved to")
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test("a state directory behind a link whose real directory others can change keeps every hook silent", async () => {
  for (const mode of [0o777, 0o775]) {
    const w = linked(mode)
    const seen = { connects: 0, started: 0, written: 0 }
    const io = {
      stdin: Readable.from([Buffer.from(JSON.stringify(base))]),
      env: w.env,
      connect: async () => { seen.connects += 1; throw absent() },
      startReceiver: () => { seen.started += 1 },
      write: async () => { seen.written += 1; return true },
      owner: () => 100,
      sleep: never,
    }
    try {
      assert.equal(await runHook("prompt", io), 0)
      assert.deepEqual(seen, { connects: 0, started: 0, written: 0 }, mode.toString(8))
    } finally { rmSync(w.root, { recursive: true, force: true }) }
  }
})
