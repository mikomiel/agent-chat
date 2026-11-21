import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { createLifecycle } from "../lib/lifecycle.js"
import { createContext } from "../lib/context.js"
import { startWorker } from "../lib/worker.js"
import { BINDING_KEY } from "../lib/channel.js"

const config = {
  chatEnabled: true,
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  python: "/usr/bin/python3",
}
const joined = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "opencode",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const UNKNOWN = { native_state: "unknown", stopped: true, plan_mode: false }
const flush = () => new Promise(resolve => setImmediate(resolve))
const timers = { setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {} }

function fakeBus() {
  const handlers = new Map()
  return {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    fire(name, payload) { for (const fn of handlers.get(name) ?? []) fn(payload) },
  }
}

// The double of the native half: it records the binding text it is given, and it has nothing to repair.
function fakeNative() {
  const calls = { context: [], refresh: 0, disable: 0 }
  const native = {
    calls,
    context(text) { calls.context.push(text) },
    refresh() { calls.refresh += 1; return Promise.resolve(false) },
    disable() { calls.disable += 1 },
  }
  fakeNative.last = native
  return native
}

function fakeWorker({ ready = Promise.resolve(joined), answer = () => ({}) } = {}) {
  const requests = []
  let close
  const closed = new Promise(resolve => { close = resolve })
  return {
    ready, closed, requests,
    request(op, fields) { requests.push({ op, fields }); return Promise.resolve(answer(op, fields)) },
    stop() { close({ code: 0, signal: null }); return closed },
  }
}

test("join and heartbeat run through the worker: the binding is published, the state is unknown, nothing is claimed", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  const worker = fakeWorker()
  const lifecycle = createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(worker.requests[0].op, "heartbeat")
  assert.deepEqual(worker.requests[0].fields.state, UNKNOWN)
  assert.match(native.calls.context[0], /"instance_file":"\/tmp\/agent-chat-state\/boot-1\.json"/)
  assert.match(lifecycle.context(), /"harness":"opencode"/)
  await lifecycle.heartbeat()
  assert.deepEqual(worker.requests.map(row => row.op), ["heartbeat", "heartbeat"]) // no pending, claim, status or settle
  assert.deepEqual(worker.requests.at(-1).fields.state, UNKNOWN)
})

test("the binding is confirmed before the first heartbeat", async () => {
  const bus = fakeBus()
  const order = []
  const worker = fakeWorker({ answer: op => { order.push(op); return {} } })
  const native = fakeNative()
  native.context = async text => { order.push(text === null ? "context-clear" : "context-put"); await flush() }
  createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  await flush()
  assert.equal(order[0], "context-put")
  assert.ok(order.includes("heartbeat"))
})

test("no heartbeat is sent while the binding is being confirmed", async () => {
  const bus = fakeBus()
  const order = []
  let confirm
  const worker = fakeWorker({ answer: op => { order.push(op); return {} } })
  const native = fakeNative()
  native.context = () => new Promise(resolve => { confirm = resolve })
  const lifecycle = createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  await lifecycle.heartbeat() // the contract-test hook asks for one: nothing is confirmed yet
  assert.deepEqual(order, [])
  confirm()
  await flush()
  assert.equal(order[0], "heartbeat")
})

test("an unconfirmed binding turns this session's chat off before anything is reported", async () => {
  for (const context of [
    async () => { throw Object.assign(new Error("CHAT_CONTEXT_UNAVAILABLE"), { code: "CHAT_CONTEXT_UNAVAILABLE" }) },
    () => { throw new Error("sync") },
    undefined,
  ]) {
    const bus = fakeBus()
    const notices = []
    const worker = fakeWorker()
    const native = fakeNative()
    native.context = context
    createLifecycle(bus, native, config, {
      ...timers, startProcess: () => worker, now: () => 1000, notice: text => notices.push(text),
    })
    bus.fire("session_start", { nativeSessionId: "native-1" })
    await flush()
    await flush()
    assert.equal(native.calls.disable, 1)
    assert.deepEqual(worker.requests.filter(row => row.op === "heartbeat"), [])
    assert.match(notices.at(-1), /stopped \(.*CHAT_CONTEXT_UNAVAILABLE|stopped \(CHAT_LIFECYCLE_FAILED/)
  }
})

test("a rejoin publishes the new binding over the old one: clear, then put", async () => {
  const bus = fakeBus()
  const texts = []
  const native = fakeNative()
  native.context = async text => { texts.push(text) }
  let starts = 0
  let retry
  const failure = Object.assign(new Error("STALE_INSTANCE"), { code: "STALE_INSTANCE", operation: "heartbeat" })
  const first = fakeWorker({ answer: op => { if (op === "heartbeat") throw failure; return {} } })
  const second = fakeWorker({ ready: Promise.resolve({ ...joined, instance_file: "/tmp/agent-chat-state/boot-2.json" }) })
  const lifecycle = createLifecycle(bus, native, config, {
    ...timers,
    startProcess: () => (starts++ === 0 ? first : second),
    setTimeoutImpl: fn => { retry = fn; return 1 },
    random: () => 0,
    now: () => 1000,
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(texts.length >= 2, true)
  assert.match(texts[0], /boot-1\.json/)
  assert.equal(texts[1], null) // the old binding is cleared as the instance ends
  retry()
  await flush()
  await flush()
  assert.match(texts.at(-1), /boot-2\.json/)
  assert.match(lifecycle.context(), /boot-2\.json/)
  assert.doesNotMatch(lifecycle.context(), /boot-1\.json/)
})

// A STALE_INSTANCE rejoin whose publish waits behind the old binding's removal. The removal is issued and held, the
// replacement worker is ready and has handed its binding to the context, and nothing of that publish has run.
async function rejoinBehindSlowRemoval() {
  const bus = fakeBus()
  const entries = new Map()
  const puts = []
  const notices = []
  let removals = 0
  let release = null
  const host = {
    session: {
      instructions: {
        entry: {
          async put({ key, value }) { puts.push(value); entries.set(key, value) },
          async list() { return [...entries].map(([key, value]) => ({ key, value })) },
          async remove({ key }) { // the old binding's removal is the first, and it stays pending until released
            if (removals++ === 0) await new Promise(resolve => { release = resolve })
            entries.delete(key)
          },
        },
      },
    },
  }
  const context = createContext(host, "ses_synthetic0001", timers)
  const published = []
  const native = { ...context, context: text => { published.push(text); return context.context(text) } }
  let retry = null
  let starts = 0
  const stale = Object.assign(new Error("STALE_INSTANCE"), { code: "STALE_INSTANCE", operation: "heartbeat" })
  const first = fakeWorker({ answer: op => { if (op === "heartbeat") throw stale; return {} } })
  const second = fakeWorker({ ready: Promise.resolve({ ...joined, instance_file: "/tmp/agent-chat-state/boot-2.json" }) })
  const lifecycle = createLifecycle(bus, native, config, {
    ...timers,
    startProcess: () => (starts++ === 0 ? first : second),
    setTimeoutImpl: fn => { retry = fn; return 1 },
    random: () => 0,
    now: () => 1000,
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(removals, 1) // the stale instance's removal was issued and is pending
  assert.equal(typeof release, "function")
  retry()
  await flush()
  assert.equal(starts, 2) // the replacement joined
  assert.match(published.at(-1), /boot-2\.json/) // and handed its binding to the context, behind the removal
  assert.equal(puts.length, 1) // only the first instance's put: the replacement's publish has not run
  return { bus, context, lifecycle, entries, puts, notices, second, release: () => release() }
}

// Review 6005292356, finding 2: after STALE_INSTANCE the replacement's publish queues behind the old binding's removal.
test("a rejoin whose publish waits behind the old removal puts nothing once the lifecycle ended before the removal did", async () => {
  for (const end of ["stop", "shutdown"]) {
    const rig = await rejoinBehindSlowRemoval()
    if (end === "shutdown") rig.bus.fire("session_shutdown") // the bus event began the end, and stop() returns that same one
    const ended = rig.lifecycle.stop()
    rig.context.dispose() // after the lifecycle's stop, as the manager does it
    rig.release()
    assert.deepEqual(await ended, { code: 0, signal: null }, end)
    assert.equal(rig.puts.filter(text => /boot-2\.json/.test(text)).length, 0, end) // no put after the teardown
    assert.equal(rig.entries.has(BINDING_KEY), false, end)
  }
})

// Review 6005372163, finding 1: the worker is watched from its join, so an exit during the publish is seen at once.
test("a worker that exits while its binding waits behind the old removal fails closed and makes no put", async () => {
  const rig = await rejoinBehindSlowRemoval()
  void rig.second.stop() // the replacement worker is gone, and its publish has not started
  await flush()
  assert.match(rig.notices.at(-1), /Agent Chat stopped \(end:CHAT_WORKER_EXITED\)/) // as a worker exit anywhere else
  rig.release()
  await flush() // the queued publish gets its turn before anything else ends it
  assert.equal(rig.puts.filter(text => /boot-2\.json/.test(text)).length, 0) // no put for the instance that is gone
  assert.deepEqual(rig.second.requests, []) // and no heartbeat for it
  assert.deepEqual(await rig.lifecycle.stop(), { code: 0, signal: null })
  assert.equal(rig.entries.has(BINDING_KEY), false)
})

test("a rejoinable join failure schedules one bounded retry", async () => {
  const bus = fakeBus()
  let delay = null
  let starts = 0
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  const notices = []
  createLifecycle(bus, fakeNative(), config, {
    ...timers,
    startProcess: () => { starts += 1; return fakeWorker({ ready: Promise.reject(failure) }) },
    now: () => 0,
    random: () => 0,
    setTimeoutImpl: (_fn, ms) => { delay = ms; return 1 },
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(starts, 1)
  assert.equal(delay, 2500)
  assert.match(notices.at(-1), /reconnecting/)
})

test("a retry that executes after the episode expires fails closed", async () => {
  const bus = fakeBus()
  let retry = null
  let now = 0
  let starts = 0
  const notices = []
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  const startProcess = () => { starts += 1; return fakeWorker({ ready: Promise.reject(failure) }) }
  const native = fakeNative()
  createLifecycle(bus, native, config, {
    ...timers, startProcess, now: () => now, random: () => 0,
    setTimeoutImpl: fn => { retry = fn; return 1 },
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(typeof retry, "function")
  now = 7_200_000
  retry()
  await flush()
  assert.equal(starts, 1)
  assert.match(notices.at(-1), /stopped/)
  assert.equal(native.calls.disable, 1)
})

test("a wall-clock step does not end a rejoin episode: the default clock is monotonic", async t => {
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  // The stepped clock is in place before the lifecycle is built: a default of `Date.now` would capture it there, and a
  // clock that was swapped in later would not be seen by a lifecycle that already holds the real one.
  let step = 0
  Date.now = () => realNow() + step
  const bus = fakeBus()
  let retry = null
  let starts = 0
  const notices = []
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  const startProcess = () => { starts += 1; return fakeWorker({ ready: Promise.reject(failure) }) }
  createLifecycle(bus, fakeNative(), config, { // no `now`: the lifecycle's own clock
    ...timers, startProcess, random: () => 0,
    setTimeoutImpl: fn => { retry = fn; return 1 },
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(typeof retry, "function")
  step = 10 * 3_600_000 // the wall clock jumps ahead by more than the whole episode
  retry()
  await flush()
  assert.equal(starts, 2, "the retry ran: the episode is measured on the monotonic clock")
  assert.doesNotMatch(notices.join("\n"), /stopped/)
})

test("a non-transport join refusal fails closed", async () => {
  const bus = fakeBus()
  const notices = []
  const failure = Object.assign(new Error("BINDING_FILE_UNSAFE"), { code: "BINDING_FILE_UNSAFE", operation: "join" })
  const native = fakeNative()
  createLifecycle(bus, native, config, {
    ...timers, startProcess: () => fakeWorker({ ready: Promise.reject(failure) }), now: () => 0,
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(native.calls.disable, 1)
  assert.match(notices.at(-1), /stopped/)
})

test("a worker exit fails closed for that lifecycle", async () => {
  const bus = fakeBus()
  let close
  const closed = new Promise(resolve => { close = resolve })
  const worker = fakeWorker()
  worker.closed = closed
  worker.stop = () => { close({ code: 0, signal: null }); return closed }
  const native = fakeNative()
  const notices = []
  createLifecycle(bus, native, config, {
    ...timers, startProcess: () => worker, now: () => 1000, notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  close({ code: 1, signal: null })
  await flush()
  assert.equal(native.calls.disable, 1)
  assert.match(notices.at(-1), /stopped/)
})

test("disposal ends the worker, clears the heartbeat timer and reports the exit", async () => {
  const bus = fakeBus()
  let intervals = 0
  let cleared = 0
  const worker = fakeWorker()
  const native = fakeNative()
  const lifecycle = createLifecycle(bus, native, config, {
    startProcess: () => worker,
    now: () => 1000,
    setIntervalImpl: () => { intervals += 1; return intervals },
    clearIntervalImpl: () => { cleared += 1 },
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(intervals, 1) // the heartbeat: there is no poll
  const result = await lifecycle.stop()
  assert.deepEqual(result, { code: 0, signal: null })
  assert.equal(cleared, 1)
  assert.equal(native.calls.disable, 1)
})

test("session shutdown ends the worker and still proves the exit", async () => {
  const bus = fakeBus()
  let stops = 0
  const worker = fakeWorker()
  const originalStop = worker.stop
  worker.stop = () => { stops += 1; return originalStop() }
  const lifecycle = createLifecycle(bus, fakeNative(), config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("session_shutdown")
  await flush()
  assert.equal(stops, 1)
  const result = await lifecycle.stop()
  assert.deepEqual(result, { code: 0, signal: null })
})

test("disposal during a rejoin waits for the drained worker's exit proof", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  let release
  const closed = new Promise(resolve => { release = resolve })
  const worker = {
    ready: Promise.resolve(joined),
    closed,
    request: op => op === "heartbeat"
      ? Promise.reject(Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "heartbeat" }))
      : Promise.resolve({}),
    stop() { return closed },
  }
  let retry = null
  const lifecycle = createLifecycle(bus, native, config, {
    ...timers,
    startProcess: () => worker,
    now: () => 0,
    random: () => 0,
    setTimeoutImpl: (fn) => { retry = fn; return 1 },
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(typeof retry, "function")
  const stopping = lifecycle.stop()
  let settled = false
  void stopping.then(() => { settled = true })
  await flush()
  assert.equal(settled, false)
  release({ code: 0, signal: null })
  assert.deepEqual(await stopping, { code: 0, signal: null })
})

test("a signal-terminated worker exit is not a proved end", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  let release
  const closed = new Promise(resolve => { release = resolve })
  const worker = { ready: Promise.resolve(joined), closed, request: () => Promise.resolve({}), stop: () => closed }
  const lifecycle = createLifecycle(bus, native, config, { ...timers, startProcess: () => worker })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  const stopping = lifecycle.stop()
  release({ code: null, signal: "SIGKILL" })
  assert.deepEqual(await stopping, { code: 1, signal: null })
})

test("a fail-closed shutdown retains its exit proof for disposal", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  let release
  const closed = new Promise(resolve => { release = resolve })
  const worker = {
    ready: Promise.resolve(joined),
    closed,
    request: op => op === "heartbeat"
      ? Promise.reject(Object.assign(new Error("BINDING_FILE_UNSAFE"), { code: "BINDING_FILE_UNSAFE", operation: "heartbeat" }))
      : Promise.resolve({}),
    stop: () => closed,
  }
  const lifecycle = createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 0 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  const stopping = lifecycle.stop()
  let settled = false
  void stopping.then(() => { settled = true })
  await flush()
  assert.equal(settled, false)
  release({ code: 0, signal: null })
  assert.deepEqual(await stopping, { code: 0, signal: null })
})

test("a throwing worker shutdown is not converted into a proved end", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  const worker = {
    ready: Promise.resolve(joined),
    closed: new Promise(() => {}),
    request: op => op === "heartbeat"
      ? Promise.reject(Object.assign(new Error("BINDING_FILE_UNSAFE"), { code: "BINDING_FILE_UNSAFE", operation: "heartbeat" }))
      : Promise.resolve({}),
    stop() { throw new Error("shutdown refused") },
  }
  const lifecycle = createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 0 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.deepEqual(await lifecycle.stop(), { code: 1, signal: null })
})

// The removal of the binding entry is part of the end the caller waits for.
test("stop resolves only after the binding entry removal has finished", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  let finishRemoval
  native.context = text => {
    native.calls.context.push(text)
    if (text === null) return new Promise(resolve => { finishRemoval = resolve })
  }
  const worker = fakeWorker()
  const lifecycle = createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  let ended = null
  void lifecycle.stop().then(result => { ended = result })
  await flush()
  assert.equal(native.calls.context.at(-1), null)
  assert.equal(ended, null, "a removal that has not finished is not an end")
  finishRemoval()
  await flush()
  assert.deepEqual(ended, { code: 0, signal: null })
})

// A request that outlives the parent-side deadline must rejoin, as the core's own uncertain code does.
const stdioChild = () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = () => {}
  return child
}

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

test("a worker request that outlives its deadline takes the rejoin path through the real worker", async t => {
  const clock = stubTimeouts(t)
  const children = []
  const spawnImpl = () => { const child = stdioChild(); children.push(child); return child }
  const retries = []
  const notices = []
  const bus = fakeBus()
  createLifecycle(bus, fakeNative(), config, {
    startProcess: (workerConfig, identity) => startWorker(workerConfig, identity, { spawnImpl }),
    now: () => 0,
    random: () => 0,
    setTimeoutImpl: (fn, ms) => { retries.push({ fn, ms }); return retries.length },
    clearTimeoutImpl: () => {},
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => {},
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  children[0].stdout.write(`${JSON.stringify({ id: 0, result: joined })}\n`)
  await flush() // joined and bound; the first heartbeat is written and never answered
  clock.fire(22_000)
  await flush()
  assert.doesNotMatch(notices.join("\n"), /stopped/, "not a permanent disable")
  assert.match(notices.join("\n"), /reconnecting/)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].ms, 2500)
  retries[0].fn()
  await flush()
  assert.equal(children.length, 2, "a fresh worker joins after the back-off")
})

// The worker's nonterminal refusals keep the worker and the binding.
test("brief heartbeat refusals keep the worker and the binding and spend no rejoin budget", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  let refusal = null // the code the worker answers with, or null for a normal answer
  const worker = fakeWorker({ answer: op => (refusal && op === "heartbeat" ? { refused: refusal } : {}) })
  let starts = 0
  const retries = []
  const notices = []
  const lifecycle = createLifecycle(bus, native, config, {
    ...timers,
    startProcess: () => { starts += 1; return worker },
    now: () => 1000,
    random: () => 0,
    setTimeoutImpl: (fn, ms) => { retries.push({ fn, ms }); return retries.length },
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  const contextBefore = native.calls.context.length
  // Four brief outages, one more than the hourly rejoin budget allows.
  for (const code of ["SERVICE_UNAVAILABLE", "TRANSPORT_UNAVAILABLE", "REQUEST_UNCERTAIN", "SERVICE_UNAVAILABLE"]) {
    refusal = code
    await lifecycle.heartbeat()
  }
  assert.equal(starts, 1, "the same worker keeps serving")
  assert.deepEqual(retries, [], "no rejoin is scheduled")
  assert.doesNotMatch(notices.join("\n"), /reconnecting|stopped/)
  assert.equal(native.calls.disable, 0)
  assert.equal(native.calls.context.length, contextBefore, "the binding entry is not cleared")
  assert.equal(await Promise.race([worker.closed.then(() => "ended"), flush().then(() => "serving")]), "serving")
  refusal = null // the next tick is the retry
  const before = worker.requests.length
  await lifecycle.heartbeat()
  assert.equal(worker.requests.length, before + 1)
  assert.equal(worker.requests.at(-1).op, "heartbeat")
})

test("a terminal worker error on a heartbeat still rejoins, like the core's own code", async () => {
  const bus = fakeBus()
  const terminal = Object.assign(new Error("CHAT_WORKER_REFUSED"), { code: "CHAT_WORKER_REFUSED", workerCode: "SERVICE_UNAVAILABLE" })
  let failing = false
  const worker = fakeWorker({ answer: op => { if (failing && op === "heartbeat") throw terminal; return {} } })
  const retries = []
  const notices = []
  const lifecycle = createLifecycle(bus, fakeNative(), config, {
    ...timers, startProcess: () => worker, now: () => 1000, random: () => 0,
    setTimeoutImpl: (fn, ms) => { retries.push({ fn, ms }); return retries.length },
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  failing = true
  await lifecycle.heartbeat()
  assert.match(notices.join("\n"), /reconnecting/)
  assert.equal(retries.length, 1)
})

// Liveness. A session that raises no event of its own cannot ask for its binding repair, so the heartbeat tick asks.
test("each heartbeat tick asks the binding context to read itself back, and still sends its heartbeat", async () => {
  const bus = fakeBus()
  const native = fakeNative()
  const worker = fakeWorker()
  let tick = null
  const lifecycle = createLifecycle(bus, native, config, {
    ...timers, startProcess: () => worker, now: () => 1000, setIntervalImpl: fn => { tick = fn; return 1 },
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(typeof tick, "function")
  assert.equal(native.calls.refresh, 0) // the join's own publish was confirmed: nothing was asked for yet
  const beats = worker.requests.length
  tick()
  await flush()
  assert.equal(native.calls.refresh, 1)
  assert.equal(worker.requests.length, beats + 1)
  tick()
  await flush()
  assert.equal(native.calls.refresh, 2)
  await lifecycle.stop()
  tick() // a tick that fires after the end asks for nothing
  await flush()
  assert.equal(native.calls.refresh, 2)
})

test("a refresh that throws or rejects does not break the tick or its heartbeat", async () => {
  for (const failing of [() => { throw new Error("sync") }, () => Promise.reject(new Error("async"))]) {
    const bus = fakeBus()
    const native = fakeNative()
    native.refresh = failing
    const worker = fakeWorker()
    let tick = null
    createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 1000, setIntervalImpl: fn => { tick = fn; return 1 } })
    bus.fire("session_start", { nativeSessionId: "native-1" })
    await flush()
    const beats = worker.requests.length
    tick()
    await flush()
    assert.equal(worker.requests.length, beats + 1)
  }
})

test("a repair that failed is repeated by the next tick, with no event from the session, and an entry removed with no signal is put back", async () => {
  const bus = fakeBus()
  const entries = new Map()
  let listFails = false
  const host = {
    session: {
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() {
            if (listFails) throw new Error("unavailable")
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  const context = createContext(host, "ses_synthetic0001")
  let tick = null
  createLifecycle(bus, context, config, { ...timers, startProcess: () => fakeWorker(), now: () => 1000, setIntervalImpl: fn => { tick = fn; return 1 } })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  const binding = entries.get(BINDING_KEY)
  assert.match(binding, /boot-1\.json/)
  entries.clear() // a compaction dropped the entry
  context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  listFails = true
  assert.equal(await context.repair(), false) // the event's own repair failed and the obligation is still owed
  assert.equal(context.owed(), true)
  listFails = false // the host answers again, and the session raises no event
  tick()
  await flush()
  assert.equal(entries.get(BINDING_KEY), binding)
  assert.equal(context.owed(), false)
  entries.clear() // removed with no signal: a removal from another owner that landed after its time limit
  tick()
  await flush()
  assert.equal(entries.get(BINDING_KEY), binding)
})
