import test from "node:test"
import assert from "node:assert/strict"
import { createLifecycle } from "../lib/lifecycle.js"
import { MAX_CONTEXT_BYTES } from "../lib/notice.js"

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
  harness: "deepseek",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const attempt = "44444444-4444-4444-8444-444444444444"
const message = {
  id: "55555555-5555-4555-8555-555555555555",
  kind: "question",
  room_id: joined.room_id,
  history_after: "history-cursor-1",
  body: "synthetic body",
  sender_session_id: "peer-1",
  created_at: "2026-01-01T00:00:00Z",
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const timers = { setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {} }

function fakeBus() {
  const handlers = new Map()
  return {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    fire(name, payload) { for (const fn of handlers.get(name) ?? []) fn(payload) },
  }
}

function fakeDelivery({ state = () => null, result = { outcome: "handed", reason: null }, throwOnDeliver = false } = {}) {
  const calls = { context: [], deliver: [], disable: 0 }
  return {
    calls,
    state,
    heartbeatState: () => ({ native_state: "idle", stopped: false, plan_mode: false }),
    context(text) { calls.context.push(text) },
    deliver(batch, deadline) {
      calls.deliver.push({ batch, deadline })
      if (throwOnDeliver) throw new Error("native send refused")
      return Promise.resolve(result)
    },
    disable() { calls.disable += 1 },
  }
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

function deliveryAnswer(op, row = message) {
  if (op === "pending") return { messages: [row.id] }
  if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: [row] }
  if (op === "status") return { muted: false }
  return {}
}

test("join, claim, native delivery and settlement run through the worker", async () => {
  const bus = fakeBus()
  const delivery = fakeDelivery()
  let pendingCalls = 0
  const worker = fakeWorker({
    answer: (op, fields) => {
      // The connect-time poll asks while the lifecycle is still stopped; the
      // explicit poll below is the one that may claim.
      if (op === "pending") return pendingCalls++ < 2 ? { messages: [message.id] } : { messages: [] }
      return deliveryAnswer(op)
    },
  })
  const lifecycle = createLifecycle(bus, delivery, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(worker.requests[0].op, "heartbeat")
  assert.equal(worker.requests[0].fields.state.native_state, "idle")
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  const claim = worker.requests.find(row => row.op === "claim")
  assert.deepEqual(claim.fields.messages, [message.id])
  assert.match(delivery.calls.context[0], /"instance_file":"\/tmp\/agent-chat-state\/boot-1\.json"/)
  assert.equal(delivery.calls.deliver.length, 1)
  assert.match(delivery.calls.deliver[0].batch.content, /"history_after":"history-cursor-1"/)
  assert.doesNotMatch(delivery.calls.deliver[0].batch.content, /synthetic body/)
  assert.equal(delivery.calls.deliver[0].batch.attemptId, attempt)
  const settle = worker.requests.find(row => row.op === "settle")
  assert.deepEqual(settle.fields.result, { outcome: "handed", reason: null })
  assert.match(lifecycle.context(), /"harness":"deepseek"/)
})

test("a throwing native delivery settles uncertain, never handed", async () => {
  const bus = fakeBus()
  const worker = fakeWorker({ answer: op => deliveryAnswer(op) })
  const lifecycle = createLifecycle(bus, fakeDelivery({ throwOnDeliver: true }), config,
    { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  const settle = worker.requests.find(row => row.op === "settle")
  assert.deepEqual(settle.fields.result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a bodies-mode maximum batch is handed over once inside the notice budget", async () => {
  const bus = fakeBus()
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ...message,
    id: `message-${index}`,
    history_after: `cursor-${index}`,
    body: "b".repeat(1200),
  }))
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: rows.map(row => row.id) }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: rows }
      if (op === "status") return { muted: false }
      return {}
    },
  })
  const delivery = fakeDelivery()
  const lifecycle = createLifecycle(bus, delivery, { ...config, noticeBodies: true },
    { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  assert.equal(delivery.calls.deliver.length, 1)
  assert.ok(Buffer.byteLength(delivery.calls.deliver[0].batch.content, "utf8") <= MAX_CONTEXT_BYTES)
  assert.match(delivery.calls.deliver[0].batch.content, /"history_after":"cursor-15"/)
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result,
    { outcome: "handed", reason: null })
})

test("a mute defers the batch without a native delivery", async () => {
  const bus = fakeBus()
  const worker = fakeWorker({ answer: op => op === "status" ? { muted: true } : deliveryAnswer(op) })
  const delivery = fakeDelivery()
  const lifecycle = createLifecycle(bus, delivery, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  assert.equal(delivery.calls.deliver.length, 0)
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result,
    { outcome: "deferred", reason: "muted" })
})

test("a reservation that expires before the native delivery settles uncertain", async () => {
  const bus = fakeBus()
  const worker = fakeWorker({
    answer: op => op === "claim" ? { dispatch: true, attempt_id: attempt, reservation_ms: 100, messages: [message] } : deliveryAnswer(op),
  })
  const delivery = fakeDelivery()
  const lifecycle = createLifecycle(bus, delivery, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  assert.equal(delivery.calls.deliver.length, 0)
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result,
    { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a status round trip that consumes the reservation settles uncertain", async () => {
  const bus = fakeBus()
  let clock = 1000
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: [message] }
      if (op === "status") { clock += 20_000; return { muted: false } }
      return {}
    },
  })
  const delivery = fakeDelivery()
  const lifecycle = createLifecycle(bus, delivery, config,
    { ...timers, startProcess: () => worker, now: () => clock })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  assert.equal(delivery.calls.deliver.length, 0)
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result,
    { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a busy native state skips the claim", async () => {
  const bus = fakeBus()
  const worker = fakeWorker({ answer: op => deliveryAnswer(op) })
  const lifecycle = createLifecycle(bus, fakeDelivery({ state: () => "busy" }), config,
    { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("input", { source: "local" })
  await lifecycle.poll()
  assert.equal(worker.requests.some(row => row.op === "claim"), false)
})

test("local input clears the lifecycle stop latch; any other source sets it", async () => {
  const bus = fakeBus()
  const worker = fakeWorker()
  const lifecycle = createLifecycle(bus, fakeDelivery(), config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(lifecycle.state(), "stopped")
  bus.fire("input", { source: "local" })
  assert.equal(lifecycle.state(), null)
  bus.fire("input", { source: "remote" })
  assert.equal(lifecycle.state(), "stopped")
  bus.fire("input", { source: "local" })
  bus.fire("agent_settled", { aborted: true })
  assert.equal(lifecycle.state(), "stopped")
})

test("a rejoinable join failure schedules one bounded retry", async () => {
  const bus = fakeBus()
  let delay = null
  let starts = 0
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  const notices = []
  createLifecycle(bus, fakeDelivery(), config, {
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
  const lifecycle = createLifecycle(bus, fakeDelivery(), config, {
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
  assert.equal(lifecycle.state(), "offline")
})

test("a non-transport join refusal fails closed", async () => {
  const bus = fakeBus()
  const notices = []
  const failure = Object.assign(new Error("BINDING_FILE_UNSAFE"), { code: "BINDING_FILE_UNSAFE", operation: "join" })
  const delivery = fakeDelivery()
  const lifecycle = createLifecycle(bus, delivery, config, {
    ...timers, startProcess: () => fakeWorker({ ready: Promise.reject(failure) }), now: () => 0,
    notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(delivery.calls.disable, 1)
  assert.match(notices.at(-1), /stopped/)
  assert.equal(lifecycle.state(), "offline")
})

test("a worker exit fails closed for that lifecycle", async () => {
  const bus = fakeBus()
  let close
  const closed = new Promise(resolve => { close = resolve })
  const worker = fakeWorker()
  worker.closed = closed
  worker.stop = () => { close({ code: 0, signal: null }); return closed }
  const delivery = fakeDelivery()
  const notices = []
  const lifecycle = createLifecycle(bus, delivery, config, {
    ...timers, startProcess: () => worker, now: () => 1000, notice: text => notices.push(text),
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  close({ code: 1, signal: null })
  await flush()
  assert.equal(delivery.calls.disable, 1)
  assert.match(notices.at(-1), /stopped/)
  assert.equal(lifecycle.state(), "offline")
})

test("disposal ends the worker, clears timers and reports the exit", async () => {
  const bus = fakeBus()
  let intervals = 0
  let cleared = 0
  const worker = fakeWorker()
  const delivery = fakeDelivery()
  const lifecycle = createLifecycle(bus, delivery, config, {
    startProcess: () => worker,
    now: () => 1000,
    setIntervalImpl: () => { intervals += 1; return intervals },
    clearIntervalImpl: () => { cleared += 1 },
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
  })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  assert.equal(intervals, 2)
  const result = await lifecycle.stop()
  assert.deepEqual(result, { code: 0, signal: null })
  assert.equal(cleared, 2)
  assert.equal(delivery.calls.disable, 1)
  assert.equal(lifecycle.state(), "offline")
})

test("session shutdown ends the worker and still proves the exit", async () => {
  const bus = fakeBus()
  let stops = 0
  const worker = fakeWorker()
  const originalStop = worker.stop
  worker.stop = () => { stops += 1; return originalStop() }
  const lifecycle = createLifecycle(bus, fakeDelivery(), config, { ...timers, startProcess: () => worker, now: () => 1000 })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  bus.fire("session_shutdown")
  await flush()
  assert.equal(stops, 1)
  assert.equal(lifecycle.state(), "offline")
  const result = await lifecycle.stop()
  assert.deepEqual(result, { code: 0, signal: null })
})

test("disposal during a rejoin waits for the drained worker's exit proof", async () => {
  const bus = fakeBus()
  const delivery = fakeDelivery()
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
  const lifecycle = createLifecycle(bus, delivery, config, {
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
  const delivery = fakeDelivery()
  let release
  const closed = new Promise(resolve => { release = resolve })
  const worker = { ready: Promise.resolve(joined), closed, request: () => Promise.resolve({}), stop: () => closed }
  const lifecycle = createLifecycle(bus, delivery, config, { ...timers, startProcess: () => worker })
  bus.fire("session_start", { nativeSessionId: "native-1" })
  await flush()
  const stopping = lifecycle.stop()
  release({ code: null, signal: "SIGKILL" })
  assert.deepEqual(await stopping, { code: 1, signal: null })
})

test("a fail-closed shutdown retains its exit proof for disposal", async () => {
  const bus = fakeBus()
  const delivery = fakeDelivery()
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
  const lifecycle = createLifecycle(bus, delivery, config, { ...timers, startProcess: () => worker, now: () => 0 })
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
