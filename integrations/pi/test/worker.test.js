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

test("the join frame carries the binding, never argv", async () => {
  const { child, frames } = harness()
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" },
    { spawnImpl: () => child })
  await Promise.resolve()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].op, "join")
  assert.equal(frames[0].enabled, true)
  assert.equal(frames[0].directory, config.directory)
  assert.equal(frames[0].server_origin, config.serverOrigin)
  assert.equal(frames[0].host_token, config.hostToken)
  assert.equal(frames[0].native_session_id, "native-1")
  assert.equal(frames[0].boot_id, "boot-1")
  assert.equal(frames[0].harness, "pi")
  const joined = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "pi", instance_file: "/tmp/s.json" }
  child.stdout.write(`${JSON.stringify({ id: 0, result: joined })}\n`)
  assert.deepEqual(await worker.ready, joined)
})

test("one request is in flight and a malformed reply fails it", async () => {
  const { child } = harness()
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" },
    { spawnImpl: () => child })
  const joined = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "pi", instance_file: "/tmp/s.json" }
  child.stdout.write(`${JSON.stringify({ id: 0, result: joined })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: { native_state: "idle", stopped: false, plan_mode: false } })
  await assert.rejects(worker.request("status"), { code: "CHAT_WORKER_BUSY" })
  child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`)
  assert.deepEqual(await heartbeat, { ok: true })
})

test("a worker error frame rejects with a fixed code", async () => {
  const { child } = harness()
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" },
    { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, error: { code: "BINDING_FILE_UNSAFE" } })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_WORKER_REFUSED", workerCode: "BINDING_FILE_UNSAFE" })
})

test("a malformed frame is refused and the worker is stopped", async () => {
  const { child } = harness()
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" },
    { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0 })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_PROTOCOL_INVALID" })
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

test("a request that outlives the parent-side deadline rejects with the core's REQUEST_UNCERTAIN", async t => {
  const clock = stubTimeouts(t)
  const { child } = harness()
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" },
    { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "pi", instance_file: "/tmp/s.json" } })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: { native_state: "idle", stopped: false, plan_mode: false } })
  clock.fire(22_000)
  await assert.rejects(heartbeat, { code: "REQUEST_UNCERTAIN", operation: "heartbeat" })
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
    const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" }, { spawnImpl }) // does not throw
    await assert.rejects(worker.ready, { code: "CHAT_WORKER_UNAVAILABLE", operation: "join" })
    await new Promise(resolve => setImmediate(resolve)) // the error event is emitted, and nothing is unhandled
    assert.equal(child.listenerCount("error"), 1)
    assert.deepEqual(await worker.closed, { code: null, signal: null, started: false }) // it settles: no `close` event will come
    await assert.rejects(worker.request("heartbeat", {}), { code: "CHAT_WORKER_CLOSED" })
    assert.deepEqual(await worker.stop(), { code: null, signal: null, started: false }) // nothing to end
  })
}

// Issue #130: sender receipts are two more operations of the same worker. A frame carries only the fields the worker
// reads, an answer comes back as the worker gave it (a refusal is an answer, not a failure) and the worker goes on serving.
test("the receipts operations are sent as the worker's frames and answer as the worker did", async () => {
  const { child, frames } = harness()
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" }, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "synthetic", instance_file: "/tmp/s.json" } })}\n`)
  await worker.ready
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"]
  const feed = worker.request("receipts")
  assert.deepEqual(frames.at(-1), { op: "receipts", id: 1 })
  child.stdout.write(`${JSON.stringify({ id: 1, result: { receipts: [], muted: false } })}\n`)
  assert.deepEqual(await feed, { receipts: [], muted: false })
  const mark = worker.request("receipts_delivered", { receipts: ids })
  assert.deepEqual(frames.at(-1), { op: "receipts_delivered", receipts: ids, id: 2 })
  child.stdout.write(`${JSON.stringify({ id: 2, result: { delivered: ids } })}\n`)
  assert.deepEqual(await mark, { delivered: ids })
  const refused = worker.request("receipts")
  child.stdout.write(`${JSON.stringify({ id: 3, result: { refused: "SERVICE_UNAVAILABLE" } })}\n`)
  assert.deepEqual(await refused, { refused: "SERVICE_UNAVAILABLE" })
  const next = worker.request("heartbeat", { state: { native_state: "busy", stopped: false, plan_mode: false } })
  child.stdout.write(`${JSON.stringify({ id: 4, result: {} })}\n`)
  assert.deepEqual(await next, {})
})

test("a failure of a receipts operation names the operation, and no other label", () => {
  for (const operation of ["receipts", "receipts_delivered"]) {
    assert.equal(describeFailure(Object.assign(new Error("x"), { code: "REQUEST_UNCERTAIN", operation })), `${operation}:REQUEST_UNCERTAIN`)
  }
  assert.equal(describeFailure(Object.assign(new Error("x"), { code: "REQUEST_UNCERTAIN", operation: "receipts; rm -rf" })), "REQUEST_UNCERTAIN")
})
