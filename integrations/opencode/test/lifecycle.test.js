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
  let idle = false
  const closed = new Promise(resolve => { close = resolve })
  return {
    ready, closed, requests,
    request(op, fields) { requests.push({ op, fields }); return Promise.resolve(answer(op, fields)) },
    stop() { close({ code: 0, signal: null }); return closed },
    // The worker's own idle expiry, as `lib/worker.js` reports it: it said it ends for idleness, then it exits.
    ending: () => (idle ? "idle" : null),
    expire() { idle = true; close({ code: 1, signal: null }) },
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

// Review 6005761762, finding 1: a session can be deleted while a rejoin waits, with no event seen. A retry asks the native
// half once, bounded, before it starts a replacement worker. The first join does not ask: the manager's lookup came first.
function retryRig({ probe }) {
  const bus = fakeBus()
  const native = { ...fakeNative(), probe: () => probe(rig) }
  const rig = { bus, native, starts: 0, retry: null, notices: [] }
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  rig.lifecycle = createLifecycle(bus, native, config, {
    ...timers,
    startProcess: () => { rig.starts += 1; return rig.starts === 1 ? fakeWorker({ ready: Promise.reject(failure) }) : fakeWorker() },
    now: () => 1000,
    random: () => 0,
    setTimeoutImpl: fn => { rig.retry = fn; return 1 },
    notice: text => rig.notices.push(text),
  })
  return rig
}

test("a retry waits for one probe before it starts a replacement worker, and the first join makes none", async () => {
  let probes = 0
  let release = null
  const rig = retryRig({ probe: () => { probes += 1; return new Promise(resolve => { release = resolve }) } })
  rig.bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(rig.starts, 1)
  assert.equal(probes, 0) // the first join asks nothing
  rig.retry()
  await flush()
  assert.equal(probes, 1)
  assert.equal(rig.starts, 1) // still waiting for the answer
  release()
  await flush()
  assert.equal(rig.starts, 2) // the answer says nothing against it: the retry goes on
  assert.equal(probes, 1)
})

for (const [how, end] of [
  ["stopped", rig => rig.lifecycle.stop()],
  ["shut down", rig => rig.bus.fire("session_shutdown")],
  ["disabled", rig => rig.lifecycle.disable("deleted")],
]) {
  test(`a retry whose probe found the lifecycle ${how} starts no replacement worker`, async () => {
    const rig = retryRig({ probe: async current => { end(current) } }) // what the owner does when the host says it is gone
    rig.bus.fire("session_start", { nativeSessionId: "native-1" })
    await flush()
    rig.retry()
    await flush()
    assert.equal(rig.starts, 1)
  })
}

test("a probe that rejects leaves the retry as it was", async () => {
  const rig = retryRig({ probe: () => Promise.reject(new Error("unavailable")) })
  rig.bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  rig.retry()
  await flush()
  assert.equal(rig.starts, 2)
})

test("a native half with no probe keeps the retry as it was", async () => {
  const bus = fakeBus()
  let retry = null
  let starts = 0
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  createLifecycle(bus, fakeNative(), config, {
    ...timers,
    startProcess: () => { starts += 1; return starts === 1 ? fakeWorker({ ready: Promise.reject(failure) }) : fakeWorker() },
    now: () => 1000, random: () => 0, setTimeoutImpl: fn => { retry = fn; return 1 },
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  retry()
  assert.equal(starts, 2) // started in the same turn: nothing was awaited
})

// Review 6005906094, finding 2: a worker that never started fails closed like any other worker-start failure.
test("a spawn that makes no pipes fails that session's chat closed, and its end settles", async () => {
  const bus = fakeBus()
  const notices = []
  const child = new EventEmitter()
  child.stdin = null
  child.stdout = null
  child.kill = () => {}
  const spawnImpl = () => { process.nextTick(() => child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }))); return child }
  const native = fakeNative()
  const lifecycle = createLifecycle(bus, native, config, {
    ...timers,
    startProcess: (workerConfig, identity) => startWorker(workerConfig, identity, { spawnImpl }),
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.match(notices.at(-1), /Agent Chat stopped \(join:CHAT_WORKER_UNAVAILABLE\)/)
  assert.equal(native.calls.disable, 1)
  assert.deepEqual(native.calls.context.filter(text => text !== null), []) // no binding for a worker that never joined
  await lifecycle.stop() // settles
})

// The closed watcher is registered as soon as the worker is ready, so a retryable failure of the first heartbeat must still
// win over the exit that follows it: the failure is handled, a rejoin is scheduled, and chat does not fail closed. These
// use the real worker module over an injected child. The child's replies are asynchronous on purpose: a real worker's
// reply crosses a pipe and arrives in a later turn, never inside the `write` that asked for it. A reply inside `write`
// would settle the request before `request()` returned its promise, so the exit would be seen first, an order no real
// worker can produce.
function childFailingFirstHeartbeat(code, closeInSameTurn) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = () => {}
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const frame = JSON.parse(line)
      if (frame.op === "join") setImmediate(() => child.stdout.write(`${JSON.stringify({ id: frame.id, result: joined })}\n`))
      if (frame.op === "heartbeat") setImmediate(() => child.stdout.write(`${JSON.stringify({ id: frame.id, error: { code } })}\n`))
    }
  })
  // Otherwise the process exits when it sees the end of its stdin, as the real worker does.
  if (!closeInSameTurn) child.stdin.on("end", () => setImmediate(() => child.emit("close", 0, null)))
  return child
}

for (const closeInSameTurn of [true, false]) {
  for (const code of ["STALE_INSTANCE", "TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_UNCERTAIN"]) {
    test(`a first heartbeat that fails with ${code}, then a worker exit (${closeInSameTurn ? "same turn" : "later turn"}), schedules a rejoin`, async () => {
      const bus = fakeBus()
      const native = fakeNative()
      const notices = []
      let spawns = 0
      let retry = null
      const startProcess = (workerConfig, identity) => {
        spawns += 1
        const child = childFailingFirstHeartbeat(code, closeInSameTurn)
        const worker = startWorker(workerConfig, identity, { spawnImpl: () => child })
        // Added after the worker's own listener, so the close follows the rejection of the pending request in that turn.
        if (closeInSameTurn) child.stdout.on("data", chunk => { if (chunk.toString().includes('"error"')) child.emit("close", 0, null) })
        return worker
      }
      createLifecycle(bus, native, config, {
        ...timers,
        setTimeoutImpl: fn => { retry = fn; return 1 },
        startProcess,
        now: () => 1000,
        random: () => 0,
        notice: text => notices.push(text),
      })
      bus.fire("session_start", { nativeSessionId: "native-1" })
      for (let turn = 0; turn < 8; turn++) await flush()
      assert.equal(spawns, 1)
      assert.equal(typeof retry, "function", notices.join(" | ")) // a rejoin is scheduled
      assert.ok(notices.some(text => text.includes(`reconnecting (${code})`)), notices.join(" | "))
      assert.equal(notices.some(text => /stopped/.test(text)), false, notices.join(" | ")) // and chat did not fail closed
      assert.equal(native.calls.disable, 0)
    })
  }
}

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

// Review 6006147517, finding 2, and review 6006216828: a heartbeat is sent only while the binding is proved, and that is
// asked at the send. The join's confirming list captures the entry, a compaction signal is applied, and then the old
// answer arrives: that read proves nothing about the binding now, so the gate stays shut until a read-back that proves it.
// `rig.negative` makes the captured answer one without the entry.
function overtakenJoin() {
  const bus = fakeBus()
  const entries = new Map()
  const held = { entered: false, release: null }
  const rig = { entries, held, listFails: false, negative: false, putFails: false, gate: null, tick: null, retry: null, starts: 0, notices: [] }
  const host = {
    session: {
      instructions: {
        entry: {
          async put({ key, value }) {
            if (rig.putFails) throw new Error("unavailable")
            entries.set(key, value)
          },
          async list() {
            if (rig.listFails) throw new Error("unavailable")
            const snapshot = rig.negative ? [] : [...entries].map(([key, value]) => ({ key, value })) // captured when the host answers
            if (!held.entered) {
              held.entered = true
              await new Promise(resolve => { held.release = resolve })
            } else if (rig.gate) await rig.gate // the next list waits here, when a test set a gate
            return snapshot
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  rig.worker = fakeWorker()
  rig.context = createContext(host, "ses_synthetic0001")
  rig.beats = () => rig.worker.requests.filter(row => row.op === "heartbeat").length
  createLifecycle(bus, rig.context, config, {
    ...timers,
    startProcess: () => {
      rig.starts += 1
      if (rig.starts > 1) rig.worker = fakeWorker() // a rejoin starts a new worker
      return rig.worker
    },
    now: () => 1000,
    random: () => 0,
    setTimeoutImpl: fn => { rig.retry = fn; return 1 },
    setIntervalImpl: fn => { rig.tick = fn; return 1 },
    notice: text => rig.notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  return rig
}

test("a join whose confirming read a compaction signal overtook sends no first heartbeat until a read-back proves the binding", async () => {
  const rig = overtakenJoin()
  await flush()
  assert.equal(rig.held.entered, true) // the confirming list is pending
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  const repair = rig.context.repair() // the manager's own ask at that event, queued behind the publish
  rig.held.release() // the old answer arrives
  await flush()
  assert.equal(rig.beats(), 0) // an overtaken confirmation does not open the gate
  assert.equal(typeof rig.tick, "function") // the tick is armed: it carries the next read-back
  assert.equal(await repair, true) // the existing repair ran and proved the binding
  assert.equal(rig.beats(), 0) // nothing is sent between ticks: the next send asks for the proof
  rig.tick()
  await flush()
  assert.equal(rig.beats(), 1) // the gate opens, and the first heartbeat follows at once
  rig.tick()
  await flush()
  assert.equal(rig.beats(), 2) // and runs as any bound join does
})

test("a join whose confirming read was overtaken stays shut while the read-back fails, and opens at the first tick that proves", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.listFails = true // the host cannot be read, so nothing is proved
  rig.held.release()
  await flush()
  rig.tick()
  await flush()
  rig.tick()
  await flush()
  assert.equal(rig.beats(), 0)
  assert.equal(rig.context.owed(), true)
  rig.listFails = false
  rig.tick()
  await flush()
  assert.equal(rig.beats(), 1)
})

test("a confirmation that nothing overtook still opens the gate at once, as before", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.held.release() // no signal came
  await flush()
  assert.equal(rig.beats(), 1)
})

// Review 6006216828: a proof by anyone counts, and it is asked at the send. A repair that the manager started proved the
// binding before the tick, so the tick's own heartbeat goes out at the tick, with no wait for its read-back.
test("a tick whose proof came from a manager-started repair sends its heartbeat at that tick", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  const repair = rig.context.repair() // the manager's own ask at that event
  rig.held.release()
  await flush()
  assert.equal(await repair, true)
  assert.equal(rig.beats(), 0)
  rig.tick()
  assert.equal(rig.beats(), 1) // synchronously: nothing waited for the tick's own read-back
  await flush()
  assert.equal(rig.beats(), 1) // and the read-back did not send a second one
})

test("a tick that proves afterwards sends the first heartbeat once, and a tick after it sends once, at the tick", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.held.release() // the join's confirmation was overtaken: the gate is shut
  await flush()
  assert.equal(rig.beats(), 0)
  rig.tick() // shut at the tick: its own read-back proves the binding, and the heartbeat follows it
  assert.equal(rig.beats(), 0)
  await flush()
  assert.equal(rig.beats(), 1)
  rig.tick() // the gate is open: the heartbeat goes out at the tick, and the read-back sends no second one
  assert.equal(rig.beats(), 2)
  await flush()
  assert.equal(rig.beats(), 2)
})

// The gate guards a join's first heartbeat only: after it opened, a signal that takes the proof back does not stop the
// heartbeat, and the tick's read-back heals it, as before the gate.
test("after the gate opened, a compaction signal does not stop the next heartbeat", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.held.release() // nothing overtook the join's confirmation: the first heartbeat is sent
  await flush()
  assert.equal(rig.beats(), 1)
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.listFails = true // and the host cannot be read, so nothing proves the binding again
  assert.equal(rig.context.proved(), false)
  rig.tick()
  assert.equal(rig.beats(), 2) // sent at the tick, with no proof
  await flush()
  assert.equal(rig.beats(), 2) // and not sent again
  assert.equal(rig.context.owed(), true) // the read-back is still owed
  rig.listFails = false
  rig.tick() // the next tick heals it, and the heartbeat goes on
  await flush()
  assert.equal(rig.beats(), 3)
  assert.equal(rig.context.owed(), false)
})

// A confirmation that goes stale between the moment it resolves and the moment the heartbeat is sent proves nothing: the
// signal lands in that gap, after the context resolved and before the lifecycle continues.
test("a confirmation that goes stale between its resolve and the send sends no heartbeat", async () => {
  const bus = fakeBus()
  const entries = new Map()
  const host = {
    session: {
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() { return [...entries].map(([key, value]) => ({ key, value })) },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  const context = createContext(host, "ses_synthetic0001")
  const native = {
    context: text => context.context(text).then(() => {
      context.observe({ type: "session.compaction.started", data: { sessionID: "ses_synthetic0001" } }) // lands in the gap
    }),
    proved: () => context.proved(),
    refresh: () => context.refresh(),
  }
  const worker = fakeWorker()
  let tick = null
  createLifecycle(bus, native, config, { ...timers, startProcess: () => worker, now: () => 1000, setIntervalImpl: fn => { tick = fn; return 1 } })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(worker.requests.filter(row => row.op === "heartbeat").length, 0) // the confirmation was stale at the send
  assert.equal(typeof tick, "function")
  tick() // the read-back proves the binding, and the heartbeat follows
  await flush()
  assert.equal(worker.requests.filter(row => row.op === "heartbeat").length, 1)
})

// Review 6006216828, finding 2: a confirming list that a newer signal overtook is a stale read, not a failed join. The
// session stays joined with the repair owed, the tick is armed, and the repair puts the entry back.
test("an overtaken negative confirmation leaves the session joined with the repair owed, and the repair heals it", async () => {
  const rig = overtakenJoin()
  rig.negative = true // the confirming list answers without the entry
  await flush()
  assert.equal(rig.held.entered, true)
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.held.release()
  await flush()
  assert.equal(typeof rig.tick, "function") // joined: the timer is armed
  assert.equal(rig.context.owed(), true) // and not turned off, which would clear the obligation
  assert.equal(rig.entries.has(BINDING_KEY), true) // the join's own put is there; it was only never confirmed
  assert.equal(rig.beats(), 0)
  rig.negative = false // the host answers truthfully again
  rig.entries.clear() // a compaction dropped it for real
  rig.tick() // the heartbeat finds no proof, and the tick's read-back puts the entry back and proves it
  await flush()
  assert.match(rig.entries.get(BINDING_KEY), /boot-1\.json/)
  assert.equal(rig.context.owed(), false)
  assert.equal(rig.beats(), 1)
})

// Review 6006555010, finding 1: a read-back proves the binding, then a follow-up that an overlapping tick caused reads the
// entry again, finds it missing and cannot put it back. A current read that misses the entry withdraws the proof, so the
// first heartbeat that was deferred behind that read-back sends nothing.
test("a follow-up read that finds the entry missing and cannot restore it withdraws the proof, so the deferred first heartbeat sends nothing", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.held.release() // the join's confirmation was overtaken: the gate is shut
  await flush()
  assert.equal(rig.beats(), 0)
  let open = null
  rig.gate = new Promise(resolve => { open = resolve }) // the next list waits
  rig.tick() // its read-back lists the entry, which is there, and waits
  await flush()
  rig.tick() // an overlapping tick: the read-back that is running is not answered by it, so it runs once more when it ends
  await flush()
  rig.gate = null
  rig.negative = true // the follow-up's list finds no entry
  rig.putFails = true // and its put cannot restore it
  open()
  await flush()
  assert.equal(rig.context.proved(), false) // the first read proved the binding, and the follow-up withdrew that
  assert.equal(rig.context.owed(), true)
  assert.equal(rig.beats(), 0) // the first heartbeat that was deferred behind them sends nothing
})

// Review 6006555010, finding 2: the worker idles out at the server lease while the gate waits for its first proof. That is
// a lapsed instance, so the join is retried through the rejoin path, with the host asked first. Nothing is sent meanwhile.
test("a worker that exits while the first proof is pending rejoins, and the new join opens its gate once the host answers", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.listFails = true // the host cannot be read, so nothing is proved
  rig.held.release() // the join's confirmation was overtaken: the gate is shut
  await flush()
  rig.tick()
  await flush()
  rig.tick()
  await flush()
  const first = rig.worker
  assert.equal(rig.beats(), 0)
  first.expire() // the worker ran out of its idle time without a heartbeat
  await flush()
  assert.equal(typeof rig.retry, "function") // a rejoin is scheduled
  assert.ok(rig.notices.some(text => /reconnecting \(STALE_INSTANCE\)/.test(text)), rig.notices.join(" | "))
  assert.equal(rig.notices.some(text => /stopped/.test(text)), false, rig.notices.join(" | ")) // and chat is still on
  assert.equal(first.requests.length, 0) // nothing was ever sent for the first instance
  rig.listFails = false // the host answers again
  rig.retry()
  await flush()
  assert.equal(rig.starts, 2)
  assert.equal(rig.beats(), 1) // the new join confirmed its binding and opened its gate
  assert.notEqual(rig.worker, first)
})

test("a worker that exits after the gate opened fails closed, as before", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.held.release() // nothing overtook the join's confirmation: the first heartbeat is sent
  await flush()
  assert.equal(rig.beats(), 1)
  void rig.worker.stop()
  await flush()
  assert.match(rig.notices.at(-1), /Agent Chat stopped \(end:CHAT_WORKER_EXITED\)/)
  assert.equal(rig.retry, null)
  assert.equal(rig.starts, 1)
})

// Review 6006715460, findings 1 and 2. The real worker module over a child double, with the gate shut: the publish settled
// and the binding is not proved, so no first heartbeat went out. Only the worker's own idle expiry (its idle frame, then
// its exit) is an expected end there, and it rejoins. Every other end fails closed.
function gatedRig() {
  const bus = fakeBus()
  const rig = { bus, proof: false, refreshes: [], disabled: 0, notices: [], children: [], tick: null, retry: null }
  rig.native = {
    context() {},
    proved: () => rig.proof,
    refresh: () => new Promise(resolve => { rig.refreshes.push(resolve) }),
    disable() { rig.disabled += 1 },
  }
  const startProcess = (workerConfig, identity) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.kill = () => {}
    child.frames = []
    child.stdin.on("data", chunk => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const frame = JSON.parse(line)
        child.frames.push(frame)
        if (frame.op === "join") setImmediate(() => child.stdout.write(`${JSON.stringify({ id: frame.id, result: joined })}\n`))
      }
    })
    child.say = frame => child.stdout.write(typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`)
    rig.children.push(child)
    return startWorker(workerConfig, identity, { spawnImpl: () => child })
  }
  createLifecycle(bus, rig.native, config, {
    ...timers,
    startProcess,
    now: () => 1000,
    random: () => 0,
    setTimeoutImpl: fn => { rig.retry = fn; return 1 },
    setIntervalImpl: fn => { rig.tick = fn; return 1 },
    notice: text => rig.notices.push(text),
  })
  rig.beats = child => child.frames.filter(frame => frame.op === "heartbeat").length
  bus.fire("session_start", { nativeSessionId: "native-1" })
  return rig
}

const settle = async () => { for (let turn = 0; turn < 8; turn++) await flush() }
const IDLE_FRAME = { id: 1, error: { code: "REQUEST_UNCERTAIN" } } // the request id the parent would send next

const gatedEnds = {
  "its idle frame, then its exit": { rejoins: true, run: child => { child.say(IDLE_FRAME); child.emit("close", 1, null) } },
  "an unsolicited frame that is not the idle frame": { rejoins: false, run: child => { child.say({ id: 1, result: {} }); child.emit("close", 1, null) } },
  "an idle code under the join's id": { rejoins: false, run: child => { child.say({ id: 0, error: { code: "REQUEST_UNCERTAIN" } }); child.emit("close", 1, null) } },
  "a frame that is not JSON": { rejoins: false, run: child => { child.say("{\n"); child.emit("close", 1, null) } },
  "a crash with no frame": { rejoins: false, run: child => child.emit("close", 1, null) },
  "a kill by a signal": { rejoins: false, run: child => child.emit("close", null, "SIGKILL") },
  "a clean exit with no frame": { rejoins: false, run: child => child.emit("close", 0, null) },
}

for (const [label, { rejoins, run }] of Object.entries(gatedEnds)) {
  test(`a worker end while the first proof is pending (${label}) ${rejoins ? "rejoins" : "fails closed"}`, async () => {
    const rig = gatedRig()
    await settle()
    const [child] = rig.children
    assert.equal(typeof rig.tick, "function") // the publish settled
    assert.equal(rig.beats(child), 0) // and the gate is shut
    run(child)
    await settle()
    assert.equal(rig.beats(child), 0)
    if (rejoins) {
      assert.equal(typeof rig.retry, "function", rig.notices.join(" | "))
      assert.ok(rig.notices.some(text => /reconnecting \(STALE_INSTANCE\)/.test(text)), rig.notices.join(" | "))
      assert.equal(rig.disabled, 0)
    } else {
      assert.equal(rig.retry, null, rig.notices.join(" | "))
      assert.equal(rig.disabled, 1)
      assert.match(rig.notices.at(-1), /Agent Chat stopped \(end:CHAT_WORKER_EXITED\)/)
    }
  })
}

// Finding 2: the worker said it ends for idleness, and then a read-back proves the binding before the child closes. The
// heartbeat that waited for that read-back is not attempted on the ending worker and does not open the gate, so the exit
// still takes the rejoin path.
test("a proof that lands between the worker's idle frame and its exit sends no first heartbeat, and the exit rejoins", async () => {
  const rig = gatedRig()
  await settle()
  const [child] = rig.children
  rig.tick() // the gate is shut, so the heartbeat waits for this tick's read-back
  await settle()
  assert.equal(rig.refreshes.length, 1)
  child.say(IDLE_FRAME) // the worker's idle time ran out
  await settle()
  rig.proof = true // the read-back proves the binding
  rig.refreshes[0]()
  await settle()
  assert.equal(rig.beats(child), 0) // no heartbeat for the ending worker
  assert.equal(rig.disabled, 0)
  rig.tick() // a tick in the same window attempts nothing either
  rig.refreshes.at(-1)()
  await settle()
  assert.equal(rig.beats(child), 0)
  child.emit("close", 1, null)
  await settle()
  assert.equal(rig.disabled, 0)
  assert.equal(typeof rig.retry, "function", rig.notices.join(" | ")) // a rejoin is scheduled
  assert.ok(rig.notices.some(text => /reconnecting \(STALE_INSTANCE\)/.test(text)), rig.notices.join(" | "))
  assert.equal(rig.notices.some(text => /stopped/.test(text)), false, rig.notices.join(" | "))
})

// The changed trigger of "a worker that exits while the first proof is pending rejoins" has its twin without the signal.
test("a worker that exits while the first proof is pending without saying it is idle fails closed", async () => {
  const rig = overtakenJoin()
  await flush()
  rig.context.observe({ type: "session.compaction.ended", data: { sessionID: "ses_synthetic0001" } })
  rig.listFails = true
  rig.held.release() // the gate is shut
  await flush()
  assert.equal(rig.beats(), 0)
  void rig.worker.stop() // an exit with no idle frame
  await flush()
  assert.equal(rig.retry, null)
  assert.match(rig.notices.at(-1), /Agent Chat stopped \(end:CHAT_WORKER_EXITED\)/)
  assert.equal(rig.starts, 1)
})

// The same window when the worker ends for any other reason: it is stopping, so no first heartbeat is attempted on it either,
// and its exit fails closed as an exit, not as a heartbeat refused by a closed worker.
test("a proof that lands between another unsolicited frame and the exit sends no first heartbeat, and the exit fails closed", async () => {
  const rig = gatedRig()
  await settle()
  const [child] = rig.children
  rig.tick()
  await settle()
  child.say({ id: 1, result: {} }) // not the idle frame: the worker is stopped
  await settle()
  rig.proof = true
  rig.refreshes[0]()
  await settle()
  assert.equal(rig.beats(child), 0)
  assert.equal(rig.disabled, 0)
  child.emit("close", 1, null)
  await settle()
  assert.equal(rig.disabled, 1)
  assert.equal(rig.retry, null)
  assert.match(rig.notices.at(-1), /Agent Chat stopped \(end:CHAT_WORKER_EXITED\)/)
})
