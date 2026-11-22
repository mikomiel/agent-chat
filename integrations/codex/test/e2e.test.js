import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CHAT_PREFIX, WAKE_PREFIX } from "../lib/channel.js"
import { paths } from "../lib/ipc.js"
import { fakeAppServer } from "./fake-app-server.js"

// The real hook command and the real detached receiver, over a real socket. Only
// the product's Python worker is replaced, by a small program that answers the
// worker protocol and logs every request, and the app-server, by a fake control
// socket. The test can then see what was settled and what was queued.
const HOOK = fileURLToPath(new URL("../scripts/hook.js", import.meta.url))
const RECEIVER = fileURLToPath(new URL("../scripts/receiver.js", import.meta.url))
const ROOM = "33333333-3333-4333-8333-333333333333"
const SESSION = "e2e-session-1"
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`

const workerSource = `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
let dir = process.cwd()
const log = entry => fs.appendFileSync(dir + "/worker.log", JSON.stringify(entry) + "\\n")
const queue = () => { try { return JSON.parse(fs.readFileSync(dir + "/queue.json", "utf8")) } catch { return [] } }
const consumed = new Set()
let claimed = []
let attempts = 0
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line)
  if (frame.op === "join") {
    dir = frame.directory
    log({ op: "join", pid: process.pid, ppid: process.ppid, harness: frame.harness, native: frame.native_session_id, directory: frame.directory, env: Object.keys(process.env) })
    return reply(frame.id, {
      session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
      room_id: "${ROOM}", host: "synthetic-host", harness: "codex", instance_file: dir + "/instance.json",
    })
  }
  if (frame.op === "pending") {
    log({ op: "pending" })
    return reply(frame.id, { messages: queue().filter(row => !consumed.has(row.id)).map(row => row.id) })
  }
  if (frame.op === "claim") {
    claimed = frame.messages
    log({ op: "claim", messages: claimed })
    attempts += 1
    return reply(frame.id, {
      dispatch: true, attempt_id: "attempt-" + attempts, reservation_ms: 30000,
      messages: queue().filter(row => claimed.includes(row.id)),
    })
  }
  if (frame.op === "settle") {
    log({ op: "settle", result: frame.result })
    if (frame.result.outcome === "handed") for (const id of claimed) consumed.add(id)
    return reply(frame.id, {})
  }
  if (frame.op === "heartbeat") log({ op: "heartbeat", state: frame.state })
  reply(frame.id, frame.op === "status" ? { muted: false } : {})
}).on("close", () => { log({ op: "stdin-closed" }); process.exit(0) })
`

const row = id => ({
  id, kind: "question", room_id: ROOM, history_after: "4321", body: "synthetic body",
  sender_session_id: "00000000-0000-4000-8000-0000000000aa", created_at: "2026-01-01T00:00:00+00:00",
})

function hook(env, name, payload) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, name], { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.on("close", code => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// Answers the reads like an idle, default-mode main thread and records the queue traffic.
function appServerHandler(threadId, queued) {
  const ok = result => ({ result })
  const thread = { id: threadId, parentThreadId: null, agentRole: null, ephemeral: false, source: "cli", modelProvider: "openai", status: { type: "idle" } }
  return message => {
    switch (message.method) {
      case "thread/loaded/list": return ok({ data: [threadId], nextCursor: null })
      case "thread/read": return ok({ thread })
      case "thread/turns/list": return ok({ data: [{ id: "t1", status: "completed" }], nextCursor: null })
      case "thread/resume": return ok({ thread, collaborationMode: { mode: "default", settings: {} } })
      case "thread/queue/add":
        queued.push(message.params)
        return ok({ queuedSubmission: { id: `q${queued.length}`, input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } })
      case "thread/queue/delete": return ok({ deleted: false })
      case "thread/items/list":
        return ok({ data: queued.map(entry => ({ turnId: "t", item: { type: "userMessage", id: "i", clientId: entry.clientUserMessageId, content: entry.input } })), nextCursor: null })
      default: return { error: { code: -32601, message: "method not found" } }
    }
  }
}

// `through` names the state directory by a path that goes through a link above it (`<root>/via/s`, where `via` leads to
// `<root>/real`); `state` is always the real directory.
function fixture(session, withAppServer, { through = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acc-")))
  let state = join(root, "s")
  let named = state
  if (through) {
    mkdirSync(join(root, "real"))
    chmodSync(join(root, "real"), 0o755) // not left to the umask: 002 would make it group-writable, which the trust rule refuses
    symlinkSync(join(root, "real"), join(root, "via"))
    state = join(root, "real", "s")
    named = join(root, "via", "s")
  }
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const python = join(root, "worker")
  writeFileSync(python, workerSource)
  chmodSync(python, 0o755)
  const control = join(root, "app.sock")
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: named, serverOrigin: "https://chat.example", hostToken: "synthetic-host-token", python,
    ...(withAppServer ? { appServer: `unix://${control}` } : {}),
  }))
  chmodSync(file, 0o600)
  const logFile = join(state, "worker.log")
  const entries = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [])
  return {
    root, state, file, control, session,
    env: { AGENT_CHAT_CODEX_CONFIG: file },
    ops: name => entries().filter(entry => entry.op === name),
    queue: (...ids) => writeFileSync(join(state, "queue.json"), JSON.stringify(ids.map(row))),
    async until(done, what, limit = 15_000) {
      for (let waited = 0; waited < limit; waited += 25) {
        if (done()) return
        await sleep(25)
      }
      assert.fail(`timed out waiting for ${what}`)
    },
    async cleanup() {
      await hook({ AGENT_CHAT_CODEX_CONFIG: file }, "session-end", { session_id: session, hook_event_name: "SessionEnd", reason: "other" })
      // A failed test must not leave processes behind: stop exactly the two this test started.
      const [first] = entries().filter(entry => entry.op === "join")
      for (const pid of [first?.pid, first?.ppid]) {
        if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL")
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a session joins, receives in a turn and by queued wake, ignores a delegate, notes an interrupt and ends", { timeout: 90_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture(SESSION, true)
  const queued = []
  const server = await fakeAppServer(f.control, appServerHandler(SESSION, queued))
  const common = { session_id: SESSION, permission_mode: "default" }
  const socket = paths(f.state, SESSION).socket
  try {
    // Session start: the receiver checks the thread, joins as codex, and the hook prints the binding.
    const started = await hook(f.env, "session-start", { ...common, hook_event_name: "SessionStart", source: "startup" })
    assert.equal(started.code, 0)
    const output = JSON.parse(started.stdout)
    assert.match(output.systemMessage, /^Agent Chat: joined as /)
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart")
    assert.match(output.hookSpecificOutput.additionalContext, /Agent Chat is available to this session/)
    assert.match(output.hookSpecificOutput.additionalContext, /"native_session_id":"e2e-session-1"/)
    assert.match(output.hookSpecificOutput.additionalContext, /"harness":"codex"/)
    assert.equal(output.hookSpecificOutput.additionalContext.includes("synthetic-host-token"), false)
    const [joined] = f.ops("join")
    assert.equal(joined.harness, "codex")
    assert.equal(joined.native, SESSION)
    assert.deepEqual(joined.env, [], "the worker runs with an empty environment")
    assert.ok(existsSync(socket), "the receiver serves a socket in the state directory")
    assert.match(socket, /\/codex-[0-9a-f]{16}\.sock$/)
    assert.deepEqual(server.methods().slice(0, 4), ["initialize", "thread/loaded/list", "thread/read", "thread/queue/delete"], "bound and probed before the join")
    if (existsSync(`/proc/${joined.ppid}/environ`)) {
      const received = readFileSync(`/proc/${joined.ppid}/environ`, "utf8").split("\0").filter(Boolean)
      assert.deepEqual(received, [`AGENT_CHAT_CODEX_CONFIG=${f.file}`], "the receiver carries only the config path")
    }

    // A prompt: the claimed batch is delivered as additionalContext and then settled handed.
    f.queue(uid(1))
    const prompt = await hook(f.env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "go" })
    assert.equal(prompt.code, 0)
    const delivered = JSON.parse(prompt.stdout)
    assert.equal(delivered.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.ok(delivered.hookSpecificOutput.additionalContext.startsWith(CHAT_PREFIX))
    assert.match(delivered.hookSpecificOutput.additionalContext, /"history_after":"4321"/)
    assert.equal(delivered.hookSpecificOutput.additionalContext.includes("Agent Chat is available"), false, "the binding is announced once")
    await f.until(() => f.ops("settle").length === 1, "the settle after the first delivery")
    assert.deepEqual(f.ops("settle")[0].result, { outcome: "handed", reason: null })

    // A delegated agent never claims and never prints.
    f.queue(uid(1), uid(2))
    const claims = f.ops("claim").length
    const delegated = await hook(f.env, "prompt", { ...common, agent_id: "agent-1", agent_type: "explorer", hook_event_name: "UserPromptSubmit" })
    assert.equal(delegated.code, 0)
    assert.equal(delegated.stdout + delegated.stderr, "")
    await sleep(300)
    assert.equal(f.ops("claim").length, claims)

    // An interrupt is reported as stopped, prints nothing, and holds the wake back.
    const interrupted = await hook(f.env, "interrupt", { ...common, hook_event_name: "Interrupt", turn_id: "t1" })
    assert.equal(interrupted.code, 0)
    assert.equal(interrupted.stdout + interrupted.stderr, "")
    await f.until(() => f.ops("heartbeat").some(entry => entry.state.stopped === true), "a stopped heartbeat")
    const stoppedOnly = await hook(f.env, "stop", { ...common, hook_event_name: "Stop" })
    assert.equal(stoppedOnly.stdout + stoppedOnly.stderr, "")
    await sleep(2600)
    assert.equal(queued.length, 0, "nothing is queued while stopped")
    assert.equal(f.ops("claim").length, claims)

    // A new prompt clears the stop; after the next Stop the idle session is woken through the queue.
    f.queue(uid(2))
    const again = await hook(f.env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "again" })
    assert.equal(again.code, 0)
    await f.until(() => f.ops("settle").length === 2, "the settle after the second delivery")
    assert.deepEqual(f.ops("settle")[1].result, { outcome: "handed", reason: null })
    f.queue(uid(2), uid(3))
    await hook(f.env, "stop", { ...common, hook_event_name: "Stop" })
    await f.until(() => queued.length === 1, "the queued wake", 20_000)
    await f.until(() => f.ops("settle").length === 3, "the settle after the wake")
    assert.deepEqual(f.ops("settle")[2].result, { outcome: "handed", reason: null })
    const [wake] = queued
    assert.match(wake.clientUserMessageId, /^agent-chat:attempt-\d+$/)
    assert.ok(wake.input[0].text.startsWith(WAKE_PREFIX))
    assert.match(wake.input[0].text, new RegExp(`"id":"${uid(3)}"`))
    assert.equal(wake.input[0].text.includes("synthetic body"), false, "a wake never carries a body")
    assert.deepEqual(server.methods().slice(-3), ["thread/queue/add", "thread/queue/delete", "thread/items/list"])

    // A session end ends the worker and removes the socket.
    const ended = await hook(f.env, "session-end", { ...common, hook_event_name: "SessionEnd", reason: "other" })
    assert.equal(ended.code, 0)
    await f.until(() => f.ops("stdin-closed").length === 1, "the worker to see its stdin close")
    await f.until(() => !existsSync(socket), "the socket to be removed")
    await f.until(() => !alive(joined.ppid), "the receiver to exit")
  } finally {
    await server.close()
    await f.cleanup()
  }
})

test("a delegated thread is refused before it joins, and the hooks stay silent", { timeout: 60_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture("e2e-child", true)
  const handler = appServerHandler("e2e-child", [])
  const server = await fakeAppServer(f.control, message => {
    const answer = handler(message)
    return message.method === "thread/read" ? { result: { thread: { ...answer.result.thread, parentThreadId: "parent-thread" } } } : answer
  })
  try {
    const started = await hook(f.env, "session-start", { session_id: "e2e-child", permission_mode: "default", hook_event_name: "SessionStart", source: "startup" })
    assert.equal(started.code, 0)
    assert.match(JSON.parse(started.stdout).systemMessage, /CHAT_CHILD_THREAD/)
    assert.deepEqual(f.ops("join"), [], "the worker was never started")
  } finally {
    await server.close()
    await f.cleanup()
  }
})

test("hook-only: with no app-server a message waits for the next turn and nothing is queued", { timeout: 60_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture("e2e-hook-only", false)
  const common = { session_id: "e2e-hook-only", permission_mode: "default" }
  try {
    assert.equal((await hook(f.env, "session-start", { ...common, hook_event_name: "SessionStart", source: "startup" })).code, 0)
    await hook(f.env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "go" })
    await hook(f.env, "stop", { ...common, hook_event_name: "Stop" })
    await f.until(() => f.ops("heartbeat").some(entry => entry.state.native_state === "idle"), "an idle heartbeat")
    f.queue(uid(1))
    await sleep(2600)
    assert.equal(f.ops("claim").length, 0, "an idle session claims nothing without a wake route")
    const next = await hook(f.env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "next" })
    assert.ok(JSON.parse(next.stdout).hookSpecificOutput.additionalContext.startsWith(CHAT_PREFIX))
  } finally { await f.cleanup() }
})

// Codex can close a hook's output pipe before the hook writes to it. The write
// callback then reports EPIPE and Node also emits it as an 'error' event; a hook
// that leaves that event unhandled exits 1 before it sends its receipt. The pipe
// left open collects whatever else the hook prints, a trace included. The payload
// is sent only after the closed pipe is gone, so the order is fixed.
function hookWithClosedOutput(env, name, payload) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, name], { env, stdio: ["pipe", "pipe", "pipe"] })
    let seen = ""
    child.stderr.on("data", chunk => { seen += chunk })
    child.stdin.on("error", () => {})
    child.on("close", code => resolve({ code, seen }))
    child.stdout.destroy()
    child.stdout.once("close", () => child.stdin.end(JSON.stringify(payload)))
  })
}

test("a hook whose output pipe was closed exits 0, and the delivery it could not write settles uncertain", { timeout: 90_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture("e2e-closed-pipe", false)
  const common = { session_id: "e2e-closed-pipe", permission_mode: "default" }
  try {
    assert.equal((await hook(f.env, "session-start", { ...common, hook_event_name: "SessionStart", source: "startup" })).code, 0)
    f.queue(uid(1))
    const prompt = await hookWithClosedOutput(f.env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "go" })
    assert.equal(prompt.code, 0, prompt.seen)
    assert.equal(prompt.seen, "", "no trace on the pipe that stayed open")
    await f.until(() => f.ops("settle").length === 1, "the settle after the unwritten delivery")
    assert.deepEqual(f.ops("settle")[0].result, { outcome: "uncertain", reason: "transport_ambiguous" })
    assert.equal(f.ops("settle").some(entry => entry.result.outcome === "handed"), false, "nothing unwritten is ever handed")
  } finally { await f.cleanup() }
})

test("a state directory named through a link is resolved once: the worker is joined with the canonical directory", { timeout: 60_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture("e2e-through-link", false, { through: true })
  try {
    const started = await hook(f.env, "session-start", { session_id: "e2e-through-link", permission_mode: "default", hook_event_name: "SessionStart", source: "startup" })
    assert.equal(started.code, 0)
    const [joined] = f.ops("join")
    assert.ok(joined, "the receiver joined")
    assert.equal(joined.directory, f.state, "the join frame names the canonical directory, not the path through the link")
    assert.ok(existsSync(paths(f.state, "e2e-through-link").socket), "the socket is in the canonical directory")
  } finally { await f.cleanup() }
})

// ---- the receiver serves the directory its hook resolved, and no other ------------------------------------------------------

test("the hook starts the receiver with the canonical state directory as its last argument, and no credential travels in the arguments", { timeout: 60_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  if (!existsSync("/proc/self/cmdline")) return t.skip("the arguments of the receiver are read from /proc")
  const f = fixture("e2e-handoff", false, { through: true })
  try {
    const started = await hook(f.env, "session-start", { session_id: "e2e-handoff", permission_mode: "default", hook_event_name: "SessionStart", source: "startup" })
    assert.equal(started.code, 0)
    const [joined] = f.ops("join")
    assert.ok(joined, "the receiver joined")
    const argv = readFileSync(`/proc/${joined.ppid}/cmdline`, "utf8").split("\0").filter(Boolean) // [node, receiver.js, session, owner, directory]
    assert.equal(argv.length, 5, `the receiver is given its session, its owner and its directory: ${argv.slice(2).join(" ")}`)
    assert.equal(argv[2], "e2e-handoff")
    assert.match(argv[3], /^\d+$/)
    assert.equal(argv[4], f.state, "the directory the hook resolved")
    assert.notEqual(argv[4], join(f.root, "via", "s"), "not the path through the link that the config names")
    assert.equal(argv.join(" ").includes("synthetic-host-token"), false, "no credential in the arguments")
  } finally { await f.cleanup() }
})

test("a receiver refuses a state directory that no longer resolves to the one its hook resolved: it exits without joining and creates nothing", { timeout: 60_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture("e2e-moved-link", false, { through: true })
  const moved = join(f.root, "moved")
  const private_ = join(moved, "s")
  let child = null
  try {
    // The hook resolved `<root>/via/s` to `<root>/real/s` and started a receiver for it. Before that receiver resolves the
    // same path, `via` is pointed at `<root>/moved`, which holds a private `s` of its own: a directory the rule accepts.
    mkdirSync(moved, { mode: 0o755 })
    chmodSync(moved, 0o755)
    mkdirSync(private_, { mode: 0o700 })
    chmodSync(private_, 0o700)
    symlinkSync(moved, join(f.root, "via.next"))
    renameSync(join(f.root, "via.next"), join(f.root, "via"))
    // The receiver is started the way the hook starts it, with the directory the hook resolved as its last argument.
    child = spawn(process.execPath, [RECEIVER, "e2e-moved-link", String(process.pid), f.state], { stdio: "ignore", cwd: f.state, env: f.env })
    const ended = await new Promise(resolve => {
      const timer = setTimeout(() => resolve("still running after 8 s"), 8_000)
      child.on("exit", code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(ended, 1, "the receiver ends with a refusal")
    assert.deepEqual(readdirSync(f.state), [], "nothing is created in the directory the hook resolved")
    assert.deepEqual(readdirSync(private_), [], "nothing is created in the directory the link leads to now: no socket, no lock, no worker")
  } finally {
    // A receiver that did not refuse is still running, with a worker below it: stop exactly those two.
    const workers = [f.state, private_].flatMap(directory => {
      try { return readFileSync(join(directory, "worker.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.op === "join").map(entry => entry.pid) } catch { return [] }
    })
    if (child && child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL")
    for (const pid of workers) if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL")
    await f.cleanup()
  }
})
