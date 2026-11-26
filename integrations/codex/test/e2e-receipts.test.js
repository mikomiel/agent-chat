import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { paths } from "../lib/ipc.js"
import { MAX_OUTPUT_BYTES } from "../lib/channel.js"
import { renderReceiptNotice } from "../lib/notice.js"

// Sender receipts through the real hook command, the real detached receiver and a real socket (#130). Only the product's
// Python worker is replaced: a small program that answers the receipts operations from a file and logs every request. It
// shows what the unit tests cannot: that the hook's own write receipt is the confirmation, and that the mark follows it
// with exactly the ids the model was shown. The first poll waits one cadence from the receiver's start, so this test
// waits for real. There is no app-server here: a notice never needs one, and never causes a wake.
const HOOK = fileURLToPath(new URL("../scripts/hook.js", import.meta.url))
const ROOM = "33333333-3333-4333-8333-333333333333"
const SESSION = "e2e-receipts-1"
const POLL_WAIT_MS = 5_600
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const workerSource = `#!${process.execPath}
const fs = require("node:fs")
const readline = require("node:readline")
let dir = process.cwd()
const log = entry => fs.appendFileSync(dir + "/worker.log", JSON.stringify(entry) + "\\n")
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line)
  if (frame.op === "join") {
    dir = frame.directory
    log({ op: "join", pid: process.pid, ppid: process.ppid })
    return reply(frame.id, {
      session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
      room_id: "${ROOM}", host: "synthetic-host", harness: "codex", instance_file: dir + "/instance.json",
      capabilities: ["receipts-cancel"],
    })
  }
  if (frame.op === "pending") return reply(frame.id, { messages: [] })
  if (frame.op === "receipts") {
    log({ op: "receipts" })
    return reply(frame.id, { receipts: JSON.parse(fs.readFileSync(dir + "/receipts.json", "utf8")), muted: false })
  }
  if (frame.op === "receipts_delivered") {
    log({ op: "receipts_delivered", receipts: frame.receipts })
    return reply(frame.id, { delivered: frame.receipts })
  }
  reply(frame.id, frame.op === "status" ? { muted: false } : {})
}).on("close", () => { log({ op: "stdin-closed" }); process.exit(0) })
`

const rows = [1, 2].map(n => ({
  id: `00000000-0000-4000-8000-00000000100${n}`, message_id: `00000000-0000-4000-8000-00000000200${n}`, state: n === 1 ? "handed" : "acked",
  recipient_session_id: `00000000-0000-4000-8000-00000000300${n}`, recipient_harness: "claude", recipient_host: "synthetic-host",
  created_at: `2026-01-01T00:00:0${n}+00:00`,
}))

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
// Cleanup kill: the process may exit between a liveness check and the kill, so a missing process is not a failure.
const reap = pid => { try { process.kill(pid, "SIGKILL") } catch (error) { if (error?.code !== "ESRCH") throw error } }

test("a receipts notice reaches the model through the hook's own output, and is marked once the hook confirmed it", { timeout: 90_000 }, async t => {
  if (/\s/.test(process.execPath)) return t.skip("the fake worker needs an interpreter path without whitespace")
  const root = mkdtempSync(join(tmpdir(), "acr-"))
  const state = join(root, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const python = join(root, "worker")
  writeFileSync(python, workerSource)
  chmodSync(python, 0o755)
  writeFileSync(join(state, "receipts.json"), JSON.stringify(rows))
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({
    chatEnabled: true, directory: state, serverOrigin: "https://chat.example", hostToken: "synthetic-host-token", python,
  }))
  chmodSync(file, 0o600)
  const env = { AGENT_CHAT_CODEX_CONFIG: file }
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
  const common = { session_id: SESSION, permission_mode: "default" }
  const prompt = { ...common, hook_event_name: "UserPromptSubmit", prompt: "go" }
  const tool = { ...common, hook_event_name: "PostToolUse" }
  const socket = paths(state, SESSION).socket
  const expected = renderReceiptNotice(rows, MAX_OUTPUT_BYTES)
  try {
    const started = await hook(env, "session-start", { ...common, hook_event_name: "SessionStart", source: "startup" })
    // The cadence counts from the receiver's start, and the hook's reply follows that start: a wait counted from here is never
    // too short, however long the start took on a loaded machine.
    const began = Date.now()
    assert.equal(started.code, 0)
    assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /send\/reply --receipts asks for handed\/acked receipts\./)
    const [joined] = ops("join")

    // Before one cadence has passed there is nothing to ask for.
    const early = await hook(env, "prompt", prompt)
    assert.equal(early.code, 0)
    assert.equal(early.stdout + early.stderr, "")
    assert.equal(ops("receipts").length, 0)

    // The event after the cadence replies with nothing, and the poll runs after it.
    await sleep(Math.max(0, POLL_WAIT_MS - (Date.now() - began)))
    const polling = await hook(env, "prompt", prompt)
    assert.equal(polling.code, 0)
    assert.equal(polling.stdout + polling.stderr, "", "the event that polls shows nothing")
    await until(() => ops("receipts").length === 1, "the receipts poll")

    // The next tool event carries the notice as additionalContext; the mark follows the hook's write receipt.
    const shown = await hook(env, "tool", tool)
    assert.equal(shown.code, 0)
    const output = JSON.parse(shown.stdout)
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse")
    assert.equal(output.hookSpecificOutput.additionalContext, expected.text)
    await until(() => ops("receipts_delivered").length === 1, "the mark")
    assert.deepEqual(ops("receipts_delivered")[0].receipts, rows.map(entry => entry.id), "exactly the ids that were shown")

    // It is shown once, and a Stop event has nothing to add.
    const again = await hook(env, "prompt", prompt)
    assert.equal(again.stdout + again.stderr, "")
    const stopped = await hook(env, "stop", { ...common, hook_event_name: "Stop" })
    assert.equal(stopped.code, 0)
    assert.equal(stopped.stdout + stopped.stderr, "")
    assert.equal(ops("receipts_delivered").length, 1)

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
      if (Number.isInteger(pid) && pid > 1 && alive(pid)) reap(pid)
    }
    rmSync(root, { recursive: true, force: true })
  }
})
