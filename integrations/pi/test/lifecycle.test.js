import test from "node:test"
import assert from "node:assert/strict"
import { createAgentChat } from "../lib/lifecycle.js"
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
  harness: "pi",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const attempt = "44444444-4444-4444-8444-444444444444"
const message = { id: "55555555-5555-4555-8555-555555555555", kind: "message", sender: { session_id: "peer-1" }, created_at: "2026-01-01T00:00:00Z" }

function fakePi({ throwOnSend = false } = {}) {
  const handlers = new Map()
  const sent = []
  const notices = []
  const commands = []
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    registerCommand(name, spec) { commands.push({ name, spec }) },
    sendMessage(payload, options) {
      if (throwOnSend) throw new Error("native send refused")
      sent.push({ payload, options })
      queueMicrotask(() => emit("message_start", { message: { ...payload, role: "custom" } }))
    },
  }
  function emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args) }
  const ctx = {
    mode: "tui", signal: undefined, isIdle: () => true,
    sessionManager: { getSessionId: () => "native-1", getSessionName: () => "synthetic" },
    ui: { notify: text => notices.push(text), setStatus: () => {} },
  }
  return { pi, emit, ctx, sent, notices, commands }
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

const flush = () => new Promise(resolve => setImmediate(resolve))
const timers = { setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {} }

test("join, delivery and settlement run through the worker", async () => {
  const { pi, emit, ctx, sent } = fakePi()
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return {
        dispatch: true, attempt_id: attempt, reservation_ms: 20_000,
        messages: [{ ...message, room_id: joined.room_id, history_after: "history-cursor-1", body: "synthetic body", sender_session_id: "peer-1", created_at: message.created_at }],
      }
      if (op === "status") return { muted: false }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  assert.equal(worker.requests[0].op, "heartbeat")
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  const claim = worker.requests.find(row => row.op === "claim")
  assert.deepEqual(claim.fields.messages, [message.id])
  const settle = worker.requests.find(row => row.op === "settle")
  assert.equal(settle.fields.result.outcome, "handed")
  assert.equal(sent.length, 1)
  assert.match(sent[0].payload.content, /Agent Chat message\(s\) delivered/)
  assert.match(sent[0].payload.content, /"history_after":"history-cursor-1"/)
  assert.match(sent[0].payload.content, new RegExp(`"room_id":"${joined.room_id}"`))
  assert.doesNotMatch(sent[0].payload.content, /synthetic body/)
  assert.equal(sent[0].options.triggerTurn, true)
})

test("the binding reaches the system prompt section", async () => {
  const { pi, emit, ctx } = fakePi()
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => fakeWorker(), now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  const event = { systemPromptOptions: { sections: {} } }
  emit("before_agent_start", event)
  assert.match(event.systemPromptOptions.sections.agent_chat, /"instance_file":"\/tmp\/agent-chat-state\/boot-1\.json"/)
  assert.equal(lifecycle.state(), "stopped")
})

test("a rejoinable join failure schedules one bounded retry", async () => {
  const { pi, emit, ctx, notices } = fakePi()
  let delay = null
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  createAgentChat(pi, config, {
    ...timers,
    startProcess: () => fakeWorker({ ready: Promise.reject(failure) }),
    now: () => 0,
    random: () => 0,
    setTimeoutImpl: (_fn, ms) => { delay = ms; return 1 },
  })
  emit("session_start", {}, ctx)
  await flush()
  assert.equal(delay, 2500)
  assert.match(notices.at(-1), /reconnecting/)
})

test("bodies mode carries the body and the sender field", async () => {
  const { pi, emit, ctx, sent } = fakePi()
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return {
        dispatch: true, attempt_id: attempt, reservation_ms: 20_000,
        messages: [{ ...message, room_id: joined.room_id, history_after: "history-cursor-1", body: "synthetic body", sender_session_id: "peer-1", created_at: message.created_at }],
      }
      if (op === "status") return { muted: false }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, { ...config, noticeBodies: true }, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  assert.equal(sent.length, 1)
  assert.match(sent[0].payload.content, /synthetic body/)
  assert.match(sent[0].payload.content, /"sender_session_id":"peer-1"/)
})

test("a maximum batch falls back to metadata and still hands over once", async () => {
  const { pi, emit, ctx, sent } = fakePi()
  const rows = Array.from({ length: 16 }, (_, index) => ({
    id: `message-${index}`, kind: "question", room_id: joined.room_id, history_after: `cursor-${index}`,
    body: "b".repeat(1200), sender_session_id: "peer-1", created_at: message.created_at,
  }))
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: rows.map(row => row.id) }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: rows }
      if (op === "status") return { muted: false }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, { ...config, noticeBodies: true }, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  assert.equal(sent.length, 1)
  assert.ok(Buffer.byteLength(sent[0].payload.content, "utf8") <= MAX_CONTEXT_BYTES)
  assert.match(sent[0].payload.content, /"history_after":"cursor-15"/)
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result, { outcome: "handed", reason: null })
})

test("a mute defers the batch without a native send", async () => {
  const { pi, emit, ctx, sent } = fakePi()
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: [message] }
      if (op === "status") return { muted: true }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  assert.equal(sent.length, 0)
  const settle = worker.requests.find(row => row.op === "settle")
  assert.deepEqual(settle.fields.result, { outcome: "deferred", reason: "muted" })
})

test("a reservation that expires before the native send settles uncertain", async () => {
  const { pi, emit, ctx, sent } = fakePi()
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 100, messages: [message] }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  assert.equal(sent.length, 0)
  const settle = worker.requests.find(row => row.op === "settle")
  assert.deepEqual(settle.fields.result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("non-interactive input latches the stop until local input", async () => {
  const { pi, emit, ctx } = fakePi()
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => fakeWorker(), now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  assert.equal(lifecycle.state(), null)
  emit("input", { source: "extension" }, ctx)
  assert.equal(lifecycle.state(), "stopped")
  emit("input", { source: "interactive" }, ctx)
  assert.equal(lifecycle.state(), null)
})

test("an unusable title never invalidates the heartbeat", async () => {
  const { pi, emit } = fakePi()
  const ctx = {
    mode: "tui", signal: undefined, isIdle: () => true,
    sessionManager: { getSessionId: () => "native-1", getSessionName: () => `${"a".repeat(127)} b\u0000\u202e` },
    ui: { notify: () => {}, setStatus: () => {} },
  }
  const worker = fakeWorker()
  createAgentChat(pi, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  const beat = worker.requests.find(row => row.op === "heartbeat")
  assert.equal(beat.fields.state.title.length, 127)
  assert.equal(beat.fields.state.title, "a".repeat(127))
  assert.doesNotMatch(beat.fields.state.title, /[\u0000-\u001f\u202e]|\s$/)
})

test("a mutating status request that consumes the reservation settles uncertain", async () => {
  const { pi, emit, ctx, sent } = fakePi()
  let clock = 1000
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: [message] }
      if (op === "status") { clock += 20_000; return { muted: false } }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => worker, now: () => clock })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  assert.equal(sent.length, 0)
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result,
    { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a throwing native sender settles uncertain, never handed", async () => {
  const { pi, emit, ctx } = fakePi({ throwOnSend: true })
  const worker = fakeWorker({
    answer: op => {
      if (op === "pending") return { messages: [message.id] }
      if (op === "claim") return { dispatch: true, attempt_id: attempt, reservation_ms: 20_000, messages: [message] }
      if (op === "status") return { muted: false }
      return {}
    },
  })
  const lifecycle = createAgentChat(pi, config, { ...timers, startProcess: () => worker, now: () => 1000 })
  emit("session_start", {}, ctx)
  await flush()
  emit("input", { source: "interactive" }, ctx)
  await lifecycle.poll()
  assert.deepEqual(worker.requests.find(row => row.op === "settle").fields.result,
    { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a worker code in the error envelope still enters the rejoin path", async () => {
  const { pi, emit, ctx, notices } = fakePi()
  let delay = null
  const failure = Object.assign(new Error("CHAT_WORKER_REFUSED"), {
    code: "CHAT_WORKER_REFUSED", workerCode: "SERVICE_UNAVAILABLE", operation: "join",
  })
  createAgentChat(pi, config, {
    ...timers, startProcess: () => fakeWorker({ ready: Promise.reject(failure) }), now: () => 0,
    random: () => 0, setTimeoutImpl: (_fn, ms) => { delay = ms; return 1 },
  })
  emit("session_start", {}, ctx)
  await flush()
  assert.equal(delay, 2500)
  assert.match(notices.at(-1), /reconnecting/)
})

test("a retry that executes after the episode expires fails closed", async () => {
  const { pi, emit, ctx, notices } = fakePi()
  let retry = null
  let now = 0
  let starts = 0
  const failure = Object.assign(new Error("TRANSPORT_UNAVAILABLE"), { code: "TRANSPORT_UNAVAILABLE", operation: "join" })
  const startProcess = () => { starts += 1; return fakeWorker({ ready: Promise.reject(failure) }) }
  createAgentChat(pi, config, {
    ...timers, startProcess, now: () => now, random: () => 0,
    setTimeoutImpl: (fn) => { retry = fn; return 1 },
  })
  emit("session_start", {}, ctx)
  await flush()
  assert.equal(typeof retry, "function")
  now = 7_200_000
  retry()
  await flush()
  assert.equal(starts, 1)
  assert.match(notices.at(-1), /stopped/)
  delete globalThis[Symbol.for("agent-chat.pi.disabled")]
})

test("a non-transport join refusal fails closed and latches", async () => {
  const { pi, emit, ctx, notices } = fakePi()
  const failure = Object.assign(new Error("BINDING_FILE_UNSAFE"), { code: "BINDING_FILE_UNSAFE", operation: "join" })
  const lifecycle = createAgentChat(pi, config, {
    ...timers, startProcess: () => fakeWorker({ ready: Promise.reject(failure) }), now: () => 0,
  })
  emit("session_start", {}, ctx)
  await flush()
  assert.match(notices.at(-1), /stopped/)
  assert.equal(lifecycle.state(), "offline")
  assert.equal(globalThis[Symbol.for("agent-chat.pi.disabled")], true)
  delete globalThis[Symbol.for("agent-chat.pi.disabled")]
})
