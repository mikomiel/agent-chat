import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describeFailure, startWorker } from "../lib/worker.js"

const config = {
  python: "/usr/bin/python3",
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  enabled: true,
}
const identity = { nativeSessionId: "native-1", bootId: "boot-1" }
const joinedRecord = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "codex", instance_file: "/tmp/s.json" }

function harness() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = () => {}
  const frames = []
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) frames.push(JSON.parse(line))
  })
  return { child, frames }
}

const spawnReturning = (child, captured = {}) => (command, args, options) => {
  captured.command = command
  captured.args = args
  captured.options = options
  return child
}

test("the join frame carries the binding on stdin, never on argv", async () => {
  const { child, frames } = harness()
  const captured = {}
  const worker = startWorker(config, identity, { spawnImpl: spawnReturning(child, captured) })
  await Promise.resolve()
  assert.equal(captured.command, config.python)
  assert.deepEqual(captured.args, ["-I", "-m", "agent_chat.instance_worker"])
  assert.equal(captured.options.cwd, config.directory)
  assert.deepEqual(captured.options.env, {})
  assert.deepEqual(captured.options.stdio, ["pipe", "pipe", "ignore"])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].op, "join")
  assert.equal(frames[0].enabled, true)
  assert.equal(frames[0].directory, config.directory)
  assert.equal(frames[0].server_origin, config.serverOrigin)
  assert.equal(frames[0].host_token, config.hostToken)
  assert.equal(frames[0].native_session_id, "native-1")
  assert.equal(frames[0].boot_id, "boot-1")
  assert.equal(frames[0].harness, "codex")
  assert.equal(captured.args.includes(config.hostToken), false)
  child.stdout.write(`${JSON.stringify({ id: 0, result: joinedRecord })}\n`)
  assert.deepEqual(await worker.ready, joinedRecord)
})

test("one request is in flight and a well-formed reply resolves it", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: joinedRecord })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: { native_state: "idle", stopped: false, plan_mode: false } })
  await assert.rejects(worker.request("status"), { code: "CHAT_WORKER_BUSY" })
  child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`)
  assert.deepEqual(await heartbeat, { ok: true })
})

test("a worker error frame rejects with a fixed code", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, error: { code: "BINDING_FILE_UNSAFE" } })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_WORKER_REFUSED", workerCode: "BINDING_FILE_UNSAFE" })
})

test("an unknown error code is not passed through as a label", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, error: { code: "SYNTHETIC_LEAK" } })}\n`)
  await assert.rejects(worker.ready, error => error.code === "CHAT_WORKER_REFUSED" && error.workerCode === undefined)
})

test("a malformed frame is refused and the worker is stopped", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0 })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_PROTOCOL_INVALID" })
})

test("a frame for another request id is refused", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 7, result: joinedRecord })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_PROTOCOL_INVALID" })
})

test("a relative directory or an unexpected harness is refused before spawn", () => {
  const { child } = harness()
  let spawns = 0
  const spawnImpl = () => { spawns += 1; return child }
  assert.throws(() => startWorker({ ...config, directory: "state" }, identity, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.throws(() => startWorker(config, { ...identity, harness: "pi" }, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.throws(() => startWorker(config, { ...identity, bootId: "" }, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.equal(spawns, 0)
})

test("closing the worker ends its stdin and settles the request in flight as uncertain", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  const joinOutcome = worker.ready.then(() => null, error => error)
  const stopping = worker.stop()
  assert.equal((await joinOutcome).code, "CHAT_REQUEST_UNCERTAIN")
  assert.equal(child.stdin.writableEnded, true)
  child.emit("close", 0, null)
  assert.deepEqual(await stopping, { code: 0, signal: null })
})

// The node:test timer mock needs Node 20.11, and the package supports 20.0. This stub records each timer, fires one on demand
// and restores the originals when the test ends, so a failing test cannot leak it.
function stubTimeouts(t) {
  const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis
  const timers = new Map()
  let next = 1
  globalThis.setTimeout = (fn, ms) => { timers.set(next, { fn, ms }); return next++ }
  globalThis.clearTimeout = id => { timers.delete(id) }
  t.after(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout })
  return {
    fire(ms) {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() }
    },
  }
}

const heartbeatState = { native_state: "idle", stopped: false, plan_mode: false }

// A request whose outcome is unknown is the core's REQUEST_UNCERTAIN, which the receiver rejoins. The CHAT_ code is for a
// worker that was stopped or died, which it does not.
test("a request that outlives the parent-side deadline rejects with the core's REQUEST_UNCERTAIN and stops the worker", async t => {
  const clock = stubTimeouts(t)
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: joinedRecord })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: heartbeatState })
  clock.fire(22_000)
  await assert.rejects(heartbeat, { code: "REQUEST_UNCERTAIN", operation: "heartbeat" })
  assert.equal(child.stdin.writableEnded, true, "the worker that missed its deadline is stopped")
})

test("a join that outlives the parent-side deadline is the same uncertain request", async t => {
  const clock = stubTimeouts(t)
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  clock.fire(22_000)
  await assert.rejects(worker.ready, { code: "REQUEST_UNCERTAIN", operation: "join" })
})

test("a worker that exits with a request in flight settles it with the CHAT_ code, not the core's", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: joinedRecord })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: heartbeatState })
  child.emit("close", 1, null)
  await assert.rejects(heartbeat, { code: "CHAT_REQUEST_UNCERTAIN", operation: "heartbeat" })
})

test("a failure description carries fixed codes only", () => {
  assert.equal(describeFailure(Object.assign(new Error("x"), { code: "CHAT_WORKER_REFUSED", operation: "join", workerCode: "STALE_INSTANCE" })),
    "join:CHAT_WORKER_REFUSED:STALE_INSTANCE")
  assert.equal(describeFailure(Object.assign(new Error("x"), { code: "CHAT_WORKER_REFUSED", workerCode: "SYNTHETIC_LEAK" })), "CHAT_WORKER_REFUSED")
  assert.equal(describeFailure(new Error("secret text")), "CHAT_LIFECYCLE_FAILED")
})

// Issue #153: a spawn that fails after it returned (EMFILE, ENFILE) makes no pipes and emits `error` on the next tick.
// The handler is installed first, so that error is never unhandled, and the missing pipes are a start failure.
function pipelessChild(missing) {
  const child = new EventEmitter()
  child.stdin = missing === "stdin" ? null : new PassThrough()
  child.stdout = missing === "stdout" ? null : new PassThrough()
  child.kill = () => {}
  return child
}

for (const missing of ["stdin", "stdout"]) {
  test(`a spawn with no ${missing} that then emits an error is a start failure, and the error is handled`, async () => {
    const child = pipelessChild(missing)
    const spawnImpl = () => {
      process.nextTick(() => child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })))
      return child
    }
    const worker = startWorker(config, identity, { spawnImpl }) // does not throw
    await assert.rejects(worker.ready, { code: "CHAT_WORKER_UNAVAILABLE", operation: "join" })
    await new Promise(resolve => setImmediate(resolve)) // the error event is emitted, and nothing is unhandled
    assert.equal(child.listenerCount("error"), 1)
    assert.deepEqual(await worker.closed, { code: null, signal: null }) // it settles: no `close` event will come
    await assert.rejects(worker.request("heartbeat", {}), { code: "CHAT_WORKER_CLOSED" })
    assert.deepEqual(await worker.stop(), { code: null, signal: null }) // nothing to end
  })
}
