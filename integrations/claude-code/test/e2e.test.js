import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { paths } from "../lib/ipc.js"
import { CHAT_PREFIX } from "../lib/notice.js"

// The real hook command and the real detached receiver, over a real socket. Only
// the product's Python worker is replaced: a small program that answers the
// worker protocol and logs every request, so the test can see what was settled.
const HOOK = fileURLToPath(new URL("../scripts/hook.js", import.meta.url))
const ROOM = "33333333-3333-4333-8333-333333333333"
const SESSION = "e2e-session-1"
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    log({ op: "join", pid: process.pid, ppid: process.ppid, harness: frame.harness, native: frame.native_session_id, env: Object.keys(process.env) })
    return reply(frame.id, {
      session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
      room_id: "${ROOM}", host: "synthetic-host", harness: "claude", instance_file: dir + "/instance.json",
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
  id, kind: "question", room_id: ROOM, history_after: `cursor-${id}`, body: "synthetic body",
  sender_session_id: "peer-1", created_at: "2026-01-01T00:00:00Z",
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

test("a session joins, receives in a turn and by wake, ignores a delegate and ends", { timeout: 90_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  const state = join(root, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const python = join(root, "worker")
  writeFileSync(python, workerSource)
  chmodSync(python, 0o755)
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: state, serverOrigin: "https://chat.example", hostToken: "synthetic-host-token", python,
  }))
  chmodSync(file, 0o600)
  const env = { AGENT_CHAT_CLAUDE_CONFIG: file }
  const logFile = join(state, "worker.log")
  const entries = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [])
  const ops = name => entries().filter(entry => entry.op === name)
  const until = async (done, what) => {
    for (let waited = 0; waited < 15_000; waited += 25) {
      if (done()) return
      await sleep(25)
    }
    assert.fail(`timed out waiting for ${what}`)
  }
  const queue = (...ids) => writeFileSync(join(state, "queue.json"), JSON.stringify(ids.map(row)))
  const common = { session_id: SESSION, permission_mode: "default" }
  const socket = paths(state, SESSION).socket
  try {
    // Session start: the hook starts the receiver, the receiver joins, the hook prints the binding.
    const started = await hook(env, "session-start", { ...common, hook_event_name: "SessionStart", source: "startup" })
    assert.equal(started.code, 0)
    const output = JSON.parse(started.stdout)
    assert.match(output.systemMessage, /^Agent Chat: joined as /)
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart")
    assert.match(output.hookSpecificOutput.additionalContext, /Agent Chat is available to this session/)
    assert.match(output.hookSpecificOutput.additionalContext, /"native_session_id":"e2e-session-1"/)
    assert.equal(output.hookSpecificOutput.additionalContext.includes("synthetic-host-token"), false)
    const [joined] = ops("join")
    assert.equal(joined.harness, "claude")
    assert.equal(joined.native, SESSION)
    assert.deepEqual(joined.env, [], "the worker runs with an empty environment")
    assert.ok(existsSync(socket), "the receiver serves a socket in the state directory")
    if (existsSync(`/proc/${joined.ppid}/environ`)) {
      const received = readFileSync(`/proc/${joined.ppid}/environ`, "utf8").split("\0").filter(Boolean)
      assert.deepEqual(received, [`AGENT_CHAT_CLAUDE_CONFIG=${file}`], "the receiver carries only the config path")
    }

    // A prompt: the claimed batch is delivered as additionalContext and then settled handed.
    queue("msg-1")
    const prompt = await hook(env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "go" })
    assert.equal(prompt.code, 0)
    const delivered = JSON.parse(prompt.stdout)
    assert.equal(delivered.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.ok(delivered.hookSpecificOutput.additionalContext.startsWith(CHAT_PREFIX))
    assert.match(delivered.hookSpecificOutput.additionalContext, /"history_after":"cursor-msg-1"/)
    assert.equal(delivered.hookSpecificOutput.additionalContext.includes("Agent Chat is available"), false, "the binding is announced once")
    await until(() => ops("settle").length === 1, "the settle after the first delivery")
    assert.deepEqual(ops("settle")[0].result, { outcome: "handed", reason: null })

    // A delegated agent never claims and never prints.
    queue("msg-1", "msg-2")
    const claims = ops("claim").length
    const delegated = await hook(env, "prompt", { ...common, agent_id: "agent-1", agent_type: "Explore", hook_event_name: "UserPromptSubmit" })
    assert.equal(delegated.code, 0)
    assert.equal(delegated.stdout + delegated.stderr, "")
    await sleep(300)
    assert.equal(ops("claim").length, claims)

    // A stop reports idle; the waiter then wakes the session with the queued batch: exit 2, notice on stderr.
    const stopped = await hook(env, "stop", { ...common, hook_event_name: "Stop" })
    assert.equal(stopped.code, 0)
    assert.equal(stopped.stdout + stopped.stderr, "")
    await until(() => ops("heartbeat").some(entry => entry.state.native_state === "idle"), "an idle heartbeat")
    const woken = await hook(env, "wait", { ...common, hook_event_name: "Stop" })
    assert.equal(woken.code, 2)
    assert.equal(woken.stdout, "")
    assert.ok(woken.stderr.startsWith(CHAT_PREFIX))
    assert.match(woken.stderr, /"history_after":"cursor-msg-2"/)
    await until(() => ops("settle").length === 2, "the settle after the wake")
    assert.deepEqual(ops("settle")[1].result, { outcome: "handed", reason: null })

    // A session end ends the worker and removes the socket.
    const ended = await hook(env, "session-end", { ...common, hook_event_name: "SessionEnd", reason: "other" })
    assert.equal(ended.code, 0)
    await until(() => ops("stdin-closed").length === 1, "the worker to see its stdin close")
    await until(() => !existsSync(socket), "the socket to be removed")
    await until(() => !alive(joined.ppid), "the receiver to exit")
  } finally {
    await hook(env, "session-end", { ...common, hook_event_name: "SessionEnd", reason: "other" })
    // A failed test must not leave processes behind: stop exactly the two this test started.
    const [first] = ops("join")
    for (const pid of [first?.pid, first?.ppid]) {
      if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL")
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  const state = join(root, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const python = join(root, "worker")
  writeFileSync(python, workerSource)
  chmodSync(python, 0o755)
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: state, serverOrigin: "https://chat.example", hostToken: "synthetic-host-token", python,
  }))
  chmodSync(file, 0o600)
  const logFile = join(state, "worker.log")
  const entries = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [])
  return {
    root,
    env: { AGENT_CHAT_CLAUDE_CONFIG: file },
    ops: name => entries().filter(entry => entry.op === name),
    queue: (...ids) => writeFileSync(join(state, "queue.json"), JSON.stringify(ids.map(row))),
    async until(done, what) {
      for (let waited = 0; waited < 15_000; waited += 25) {
        if (done()) return
        await sleep(25)
      }
      assert.fail(`timed out waiting for ${what}`)
    },
  }
}

// Claude Code can close a hook's output pipe before the hook writes to it. The
// write callback then reports EPIPE and Node also emits it as an 'error' event;
// a hook that leaves that event unhandled exits 1 before it sends its receipt.
// The pipe left open collects whatever else the hook prints, a trace included.
// The payload is sent only after the closed pipe is gone, so the order is fixed.
function hookWithClosedOutput(env, name, payload, closed) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, name], { env, stdio: ["pipe", "pipe", "pipe"] })
    let seen = ""
    child[closed === "stdout" ? "stderr" : "stdout"].on("data", chunk => { seen += chunk })
    child.stdin.on("error", () => {})
    child.on("close", code => resolve({ code, seen }))
    child[closed].destroy()
    child[closed].once("close", () => child.stdin.end(JSON.stringify(payload)))
  })
}

test("a hook whose output pipe was closed exits 0, and the delivery it could not write settles uncertain", { timeout: 90_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const f = fixture()
  const common = { session_id: "e2e-closed-pipe", permission_mode: "default" }
  try {
    const started = await hook(f.env, "session-start", { ...common, hook_event_name: "SessionStart", source: "startup" })
    assert.equal(started.code, 0)

    // A prompt hook delivers to a standard output nobody reads.
    f.queue("msg-1")
    const prompt = await hookWithClosedOutput(f.env, "prompt", { ...common, hook_event_name: "UserPromptSubmit", prompt: "go" }, "stdout")
    assert.equal(prompt.code, 0, prompt.seen)
    assert.equal(prompt.seen, "", "no trace on the pipe that stayed open")
    await f.until(() => f.ops("settle").length === 1, "the settle after the unwritten delivery")
    assert.deepEqual(f.ops("settle")[0].result, { outcome: "uncertain", reason: "transport_ambiguous" })

    // The idle-wake waiter writes its notice to a standard error nobody reads: it must not exit 2.
    await hook(f.env, "stop", { ...common, hook_event_name: "Stop" })
    await f.until(() => f.ops("heartbeat").some(entry => entry.state.native_state === "idle"), "an idle heartbeat")
    const wake = await hookWithClosedOutput(f.env, "wait", { ...common, hook_event_name: "Stop" }, "stderr")
    assert.equal(wake.code, 0, wake.seen)
    assert.equal(wake.seen, "")
    await f.until(() => f.ops("settle").length === 2, "the settle after the unwritten wake")
    assert.deepEqual(f.ops("settle")[1].result, { outcome: "uncertain", reason: "transport_ambiguous" })
    assert.equal(f.ops("settle").some(entry => entry.result.outcome === "handed"), false, "nothing unwritten is ever handed")
  } finally {
    await hook(f.env, "session-end", { ...common, hook_event_name: "SessionEnd", reason: "other" })
    // A failed test must not leave processes behind: stop exactly the two this test started.
    const [first] = f.ops("join")
    for (const pid of [first?.pid, first?.ppid]) {
      if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL")
    }
    rmSync(f.root, { recursive: true, force: true })
  }
})
