import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { startWorker } from "../lib/worker.js"

const config = {
  python: "/usr/bin/python3",
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  enabled: true,
}
const identity = { nativeSessionId: "native-1", bootId: "boot-1" }

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

const spawnReturning = (child, captured = {}) => (_command, args, options) => {
  captured.args = args
  captured.options = options
  return child
}

test("the join frame carries the binding on stdin, never on argv", async () => {
  const { child, frames } = harness()
  const captured = {}
  const worker = startWorker(config, identity, { spawnImpl: spawnReturning(child, captured) })
  await Promise.resolve()
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
  assert.equal(frames[0].harness, "opencode")
  assert.equal(captured.args.includes(config.hostToken), false)
  const joined = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "opencode", instance_file: "/tmp/s.json" }
  child.stdout.write(`${JSON.stringify({ id: 0, result: joined })}\n`)
  assert.deepEqual(await worker.ready, joined)
})

test("one request is in flight and a well-formed reply resolves it", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "opencode", instance_file: "/tmp/s.json" } })}\n`)
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

test("a relative directory or an unexpected harness is refused before spawn", () => {
  const { child } = harness()
  let spawns = 0
  const spawnImpl = () => { spawns += 1; return child }
  assert.throws(() => startWorker({ ...config, directory: "state" }, identity, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.throws(() => startWorker(config, { ...identity, harness: "pi" }, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.equal(spawns, 0)
})

// A hand-written timer stub, so no test depends on the test runner's mock clock (Node 20.11 and later). It records each
// `setTimeout` callback and fires the ones with a given delay on demand. `t.after` puts the originals back.
function stubTimeouts(t) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const pending = new Map()
  let next = 1
  globalThis.setTimeout = (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id }
  globalThis.clearTimeout = id => { pending.delete(id) }
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear })
  return {
    fire(ms) { for (const [id, timer] of [...pending]) if (timer.ms === ms) { pending.delete(id); timer.fn() } },
  }
}

test("a request that outlives the parent-side deadline rejects with the core's REQUEST_UNCERTAIN", async t => {
  const clock = stubTimeouts(t)
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "opencode", instance_file: "/tmp/s.json" } })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: { native_state: "idle", stopped: false, plan_mode: false } })
  clock.fire(22_000)
  await assert.rejects(heartbeat, { code: "REQUEST_UNCERTAIN", operation: "heartbeat" })
})

// Review 6005906094, finding 2: a spawn that fails after it returned (EMFILE, ENFILE) makes no pipes and emits `error` on
// the next tick. The handler is installed first, so that error is never unhandled, and the missing pipes are a start failure.
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

// Review 6006715460, finding 1: with nothing asked, the worker writes one frame only, at its idle expiry: REQUEST_UNCERTAIN
// under the id of the request the parent would send next (`agent_chat/instance_worker.py`, `_error(sequence, ...)` after
// the idle alarm). That frame, and no other, reports an idle end; every unsolicited frame stops the worker.
const joinedReply = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "opencode", instance_file: "/tmp/s.json" }
const idleFrame = `${JSON.stringify({ id: 1, error: { code: "REQUEST_UNCERTAIN" } })}\n`
const notIdle = {
  "an error under the join's id": `${JSON.stringify({ id: 0, error: { code: "REQUEST_UNCERTAIN" } })}\n`,
  "an error under a later id": `${JSON.stringify({ id: 2, error: { code: "REQUEST_UNCERTAIN" } })}\n`,
  "another error code": `${JSON.stringify({ id: 1, error: { code: "TRANSPORT_UNAVAILABLE" } })}\n`,
  "a result": `${JSON.stringify({ id: 1, result: {} })}\n`,
  "an error with a result": `${JSON.stringify({ id: 1, error: { code: "REQUEST_UNCERTAIN" }, result: {} })}\n`,
  "an error with another field": `${JSON.stringify({ id: 1, error: { code: "REQUEST_UNCERTAIN", detail: "x" } })}\n`,
  "the idle frame and a trailing one": idleFrame + idleFrame,
  "a frame that is not JSON": "{\n",
}

test("an idle-expiry frame with nothing asked says the worker ends for idleness, and the worker stops", async () => {
  const { child } = harness()
  let ended = false
  child.stdin.on("finish", () => { ended = true })
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  assert.equal(worker.ending(), null) // the join is in flight: serving
  child.stdout.write(`${JSON.stringify({ id: 0, result: joinedReply })}\n`)
  await worker.ready
  assert.equal(worker.ending(), null)
  child.stdout.write(idleFrame)
  assert.equal(worker.ending(), "idle")
  await assert.rejects(worker.request("heartbeat", {}), { code: "CHAT_WORKER_CLOSED" })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ended, true) // the worker's stdin is closed, as at every stop
  child.emit("close", 1, null)
  assert.deepEqual(await worker.closed, { code: 1, signal: null })
  assert.equal(worker.ending(), "idle") // it stays the reason
})

for (const [label, bytes] of Object.entries(notIdle)) {
  test(`an unsolicited frame that is ${label} is not an idle end: the worker stops`, async () => {
    const { child } = harness()
    const worker = startWorker(config, identity, { spawnImpl: () => child })
    child.stdout.write(`${JSON.stringify({ id: 0, result: joinedReply })}\n`)
    await worker.ready
    child.stdout.write(bytes)
    assert.equal(worker.ending(), "stopped")
    await assert.rejects(worker.request("heartbeat", {}), { code: "CHAT_WORKER_CLOSED" })
    child.emit("close", 1, null)
    await worker.closed
    assert.equal(worker.ending(), "stopped")
  })
}

test("an exit with no frame, a stop and a pipeless start are ends that are not idle", async () => {
  for (const end of ["exit", "stop"]) {
    const { child } = harness()
    const worker = startWorker(config, identity, { spawnImpl: () => child })
    child.stdout.write(`${JSON.stringify({ id: 0, result: joinedReply })}\n`)
    await worker.ready
    if (end === "exit") child.emit("close", 1, null)
    else { void worker.stop(); child.emit("close", 0, null) }
    await worker.closed
    assert.equal(worker.ending(), "stopped", end)
  }
  const worker = startWorker(config, identity, { spawnImpl: () => pipelessChild("stdout") })
  await assert.rejects(worker.ready)
  assert.equal(worker.ending(), "stopped")
})
