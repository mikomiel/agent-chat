import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { cancelsReceipts, describeFailure, startWorker } from "../lib/worker.js"

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

// Issue #175: a receipts request is the only one a signal may end, and only a worker whose join reply lists the capability is
// signalled: one without the handler would die of SIGUSR1. A cancel signals at once and again every few milliseconds until
// the answer is read, and the answer comes back as any other frame, so a cancel changes nothing about what the module reads.
const CANCEL_JOINED = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "synthetic", instance_file: "/tmp/s.json", capabilities: ["receipts-cancel"] }
const CANCEL_BEAT = { state: { native_state: "idle", stopped: false, plan_mode: false } }
const CANCEL_MARK = { receipts: ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001"] }
const reply = (id, result) => `${JSON.stringify({ id, result })}\n`

// The repeat timers of a cancel, which the test fires by hand: `tick()` is one period.
function ticker() {
  const timers = new Map()
  let next = 1
  return {
    setIntervalImpl: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearIntervalImpl: id => { timers.delete(id) },
    live: () => [...timers.values()],
    tick: () => { for (const timer of [...timers.values()]) timer.fn() },
  }
}

// A joined worker whose child records the signals it is sent.
async function signalled(joined = CANCEL_JOINED) {
  const { child, frames } = harness()
  const kills = []
  const timers = ticker()
  child.kill = signal => { kills.push(signal) }
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" }, {
    spawnImpl: () => child, setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl,
  })
  child.stdout.write(reply(0, joined))
  assert.deepEqual(await worker.ready, joined, "the join reply is the worker's, whatever keys it carries")
  return { child, frames, kills, timers, worker }
}

test("a worker is signalled only when its join reply lists the capability", () => {
  assert.equal(cancelsReceipts({ capabilities: ["receipts-cancel"] }), true)
  assert.equal(cancelsReceipts({ capabilities: ["something-else", "receipts-cancel"] }), true)
  for (const joined of [undefined, null, {}, { capabilities: null }, { capabilities: [] }, { capabilities: ["something-else"] },
    { capabilities: "receipts-cancel" }, { capabilities: { "receipts-cancel": true } }]) {
    assert.equal(cancelsReceipts(joined), false, JSON.stringify(joined))
  }
})

test("cancel signals at once and starts one repeat for each receipts request in flight, and the answer is read as any other", async () => {
  const { child, kills, timers, worker } = await signalled()
  const feed = worker.request("receipts")
  worker.cancel()
  worker.cancel()
  assert.deepEqual(kills, ["SIGUSR1"], "one signal at once, however often it is asked")
  assert.equal(timers.live().length, 1, "and one repeat for the request")
  child.stdout.write(reply(1, { refused: "CLI_INTERRUPTED" }))
  assert.deepEqual(await feed, { refused: "CLI_INTERRUPTED" })
  assert.equal(timers.live().length, 0, "the answer ends the repeat")
  const mark = worker.request("receipts_delivered", CANCEL_MARK)
  worker.cancel()
  assert.deepEqual(kills, ["SIGUSR1", "SIGUSR1"], "the next receipts request is signalled on its own")
  child.stdout.write(reply(2, { refused: "CLI_INTERRUPTED" }))
  assert.deepEqual(await mark, { refused: "CLI_INTERRUPTED" })
  const next = worker.request("heartbeat", CANCEL_BEAT)
  worker.cancel()
  timers.tick()
  child.stdout.write(reply(3, {}))
  assert.deepEqual(await next, {})
  assert.equal(kills.length, 2, "the request that is not a receipts request was not signalled")
  assert.equal(timers.live().length, 0)
})

// Issue #183. The worker drops a signal that lands after it answered one receipts request and before it read the next: it
// cannot tell a late signal for the answered request from an early one for the next. A parent that writes a mark retry right
// after the answer to the mark before it, and cancels it at once, can land its signal there. So the signal is repeated every
// few milliseconds until the answer is read: the first one the worker takes after it reads the request ends it.
test("a cancel that the worker drops before it reads the request is repeated, and a repeat ends the request", async () => {
  const { child, kills, timers, worker } = await signalled()
  let read = false // the worker has read the retry: a signal from now on ends it
  child.kill = signal => {
    kills.push(signal)
    if (read) setImmediate(() => child.stdout.write(reply(2, { refused: "CLI_INTERRUPTED" })))
  }
  const first = worker.request("receipts_delivered", CANCEL_MARK)
  child.stdout.write(reply(1, { refused: "SERVICE_UNAVAILABLE" }))
  assert.deepEqual(await first, { refused: "SERVICE_UNAVAILABLE" })
  const retry = worker.request("receipts_delivered", CANCEL_MARK)
  worker.cancel() // before the worker reads the retry: dropped
  assert.deepEqual(kills, ["SIGUSR1"])
  assert.equal(timers.live().length, 1)
  assert.ok(timers.live()[0].ms > 0 && timers.live()[0].ms <= 10, "the repeat period is a few milliseconds")
  timers.tick() // still not read: dropped as well
  read = true
  timers.tick()
  assert.deepEqual(await retry, { refused: "CLI_INTERRUPTED" })
  assert.deepEqual(kills, ["SIGUSR1", "SIGUSR1", "SIGUSR1"])
  assert.equal(timers.live().length, 0, "the answer ends the repeat")
  const next = worker.request("receipts_delivered", CANCEL_MARK)
  timers.tick()
  assert.equal(kills.length, 3, "a request that is not cancelled is never signalled, the next mark included")
  child.stdout.write(reply(3, { delivered: CANCEL_MARK.receipts }))
  assert.deepEqual(await next, { delivered: CANCEL_MARK.receipts })
})

test("the repeat ends however the request ends: a protocol failure, a stop or the worker's exit", async () => {
  for (const end of ["protocol", "stop", "exit"]) {
    const { child, kills, timers, worker } = await signalled()
    const feed = worker.request("receipts")
    const outcome = feed.then(() => null, error => error)
    worker.cancel()
    assert.equal(timers.live().length, 1, end)
    if (end === "protocol") child.stdout.write(reply(7, {}))
    else if (end === "stop") void worker.stop()
    else child.emit("close", 1, null)
    assert.ok((await outcome) instanceof Error, end)
    assert.equal(timers.live().length, 0, end)
    timers.tick()
    assert.deepEqual(kills, ["SIGUSR1"], end)
  }
})

test("cancel signals nothing while no request is in flight, during the join, or for a request that is not a receipts request", async () => {
  const { child } = harness()
  const kills = []
  child.kill = signal => { kills.push(signal) }
  const worker = startWorker(config, { nativeSessionId: "native-1", bootId: "boot-1" }, { spawnImpl: () => child })
  worker.cancel() // the join is in flight, and no capability is known yet
  assert.deepEqual(kills, [])
  child.stdout.write(reply(0, CANCEL_JOINED))
  await worker.ready
  worker.cancel() // nothing in flight
  let id = 1
  for (const [op, fields] of [["heartbeat", CANCEL_BEAT], ["status", {}], ["pending", {}], ["claim", { messages: [] }],
    ["settle", { result: { outcome: "handed" } }], ["end", {}]]) {
    const request = worker.request(op, fields)
    worker.cancel()
    child.stdout.write(reply(id, {}))
    id += 1
    await request
  }
  assert.deepEqual(kills, [])
})

test("cancel signals nothing once the answer has been read", async () => {
  const { child, kills, worker } = await signalled()
  const feed = worker.request("receipts")
  child.stdout.write(reply(1, { receipts: [], muted: false }))
  await feed
  worker.cancel()
  assert.deepEqual(kills, [])
})

for (const [name, capabilities] of [["no capabilities", undefined], ["an empty list", []], ["another name", ["something-else"]],
  ["a string", "receipts-cancel"], ["null", null]]) {
  test(`a worker whose join reply has ${name} is never signalled: it would die of the signal`, async () => {
    const joined = { ...CANCEL_JOINED, capabilities }
    if (capabilities === undefined) delete joined.capabilities
    const { child, kills, worker } = await signalled(joined)
    const feed = worker.request("receipts")
    worker.cancel()
    assert.deepEqual(kills, [])
    child.stdout.write(reply(1, { receipts: [], muted: false }))
    assert.deepEqual(await feed, { receipts: [], muted: false })
  })
}

test("a cancel while the answer is read in pieces changes nothing: one frame answers the request, and the next is served", async () => {
  const { child, kills, timers, worker } = await signalled()
  const feed = worker.request("receipts")
  const frame = reply(1, { refused: "CLI_INTERRUPTED" })
  child.stdout.write(frame.slice(0, 9))
  worker.cancel()
  child.stdout.write(frame.slice(9, 24))
  worker.cancel()
  child.stdout.write(frame.slice(24))
  assert.deepEqual(await feed, { refused: "CLI_INTERRUPTED" })
  assert.deepEqual(kills, ["SIGUSR1"])
  assert.equal(timers.live().length, 0, "the whole frame ended the repeat")
  const next = worker.request("heartbeat", CANCEL_BEAT)
  child.stdout.write(reply(2, {}))
  assert.deepEqual(await next, {})
})

test("a signal that cannot be delivered is not a failure of the worker or of the request", async () => {
  const { child, worker } = await signalled()
  child.kill = () => { throw new Error("gone") }
  const feed = worker.request("receipts")
  worker.cancel()
  child.stdout.write(reply(1, { refused: "CLI_INTERRUPTED" }))
  assert.deepEqual(await feed, { refused: "CLI_INTERRUPTED" })
})

test("cancel signals nothing to a worker that is stopping", async () => {
  const { child, kills, worker } = await signalled()
  const feed = worker.request("receipts")
  const outcome = feed.then(() => null, error => error)
  const stopping = worker.stop()
  worker.cancel()
  assert.deepEqual(kills, [])
  assert.equal((await outcome).code, "CHAT_REQUEST_UNCERTAIN")
  child.emit("close", 0, null)
  await stopping
  worker.cancel()
  assert.deepEqual(kills, [])
})
