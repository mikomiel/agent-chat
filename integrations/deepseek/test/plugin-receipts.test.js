import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentChat } from "../extensions/agent-chat.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { createDelivery } from "../lib/delivery.js"
import { MAX_CONTEXT_BYTES } from "../lib/channel.js"
import { renderReceiptNotice } from "../lib/notice.js"
import { POLL_MS } from "../lib/receipts.js"

// Sender receipts in the DeepSeek Harness plugin (#130): the `agent/pre-step` append and the `session/event` confirmation.
// The lifecycle's own rules are in lifecycle-receipts.test.js. Part one drives the plugin with a scripted lifecycle, so it
// pins exactly what the plugin does with a notice; part two drives the real lifecycle through the plugin, so it pins the
// handshake between the two: the id the plugin appends is the id that confirms the notice.

const config = {
  chatEnabled: true,
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  python: "/usr/bin/python3",
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const RECEIPTS_KIND = "plugin:agent-chat-receipts"
const CONTEXT_KIND = "plugin:agent-chat-context"
const flush = () => new Promise(resolve => setImmediate(resolve))
const tail = (base, n) => `00000000-0000-4000-8000-${String(base + n).padStart(12, "0")}`
const row = n => ({
  id: tail(1000, n), message_id: tail(2000, n), state: n % 2 ? "handed" : "acked", recipient_session_id: tail(3000, n),
  recipient_harness: "claude-code", recipient_host: "synthetic-host", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}+00:00`,
})

function configFile() {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-plugin-receipts-"))
  const file = join(dir, "chat.json")
  writeFileSync(file, JSON.stringify(config))
  chmodSync(file, 0o600)
  return { dir, file }
}

// The web context of the host: `fire` for events, `waterfall` for `agent/pre-step`, where the first listener is the
// outermost and `next` runs the rest and then the host's own decision, as DSH's dispatch does.
function fakeWebCtx() {
  const handlers = new Map()
  const agents = new Map()
  const webCtx = {
    agents: { roots: () => [...agents.values()], get: id => agents.get(id), isOwnedBy: () => false },
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn])
      return () => handlers.set(name, (handlers.get(name) ?? []).filter(entry => entry !== fn))
    },
  }
  const fire = (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) }
  const waterfall = (name, payload, base) => {
    const list = handlers.get(name) ?? []
    const run = index => (index >= list.length ? Promise.resolve(base) : list[index](payload, () => run(index + 1)))
    return run(0)
  }
  return { webCtx, fire, waterfall, agents }
}

function nativeAgent(id = "native-1") {
  const steers = []
  const removed = []
  return {
    id, session: { id, header: {} }, status: "running",
    steer: (...args) => { steers.push(args) },
    inbox: { remove: (...args) => { removed.push(args); return true }, nextStep: [], nextTurn: [] },
    steers, removed,
  }
}

async function adopt({ loadParts }) {
  const { dir, file } = configFile()
  const logs = []
  const ctx = {
    logger: { info: message => logs.push({ level: "info", message }), warn: message => logs.push({ level: "warn", message }) },
    inject(deps, callback) { ctx.callback = callback; return {} },
  }
  createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts })(ctx)
  const web = fakeWebCtx()
  const disposer = ctx.callback(web.webCtx)
  const agent = nativeAgent()
  web.agents.set(agent.id, agent)
  web.fire("agent/created", { agent })
  await flush()
  await flush()
  return {
    ...web, agent, logs, disposer,
    preStep: (step, messages = []) => web.waterfall("agent/pre-step", { agent, turn: 1, step, messages: [], signal: undefined }, { kind: "enter", messages }),
    cleanup() { disposer(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// Part one: a scripted lifecycle that records what the plugin asks of it.
function scripted() {
  const record = { notice: null, taken: 0, confirmed: [], events: [], stops: 0, throwOnNotice: false, throwOnConfirm: false, binding: "synthetic binding metadata" }
  const loadParts = async () => ({
    createDelivery: () => ({
      state: () => "busy", dispose() {}, onInserted: () => false, onClaimed() {}, onDiscarded() {}, onTurnEnd() {},
    }),
    createLifecycle(bus) {
      for (const name of ["agent_start", "agent_settled", "session_info_changed"]) bus.on(name, () => record.events.push(name))
      return {
        context: () => record.binding,
        receiptsNotice() {
          record.taken += 1
          if (record.throwOnNotice) throw new Error("receipts notice unavailable")
          const notice = record.notice
          record.notice = null
          return notice
        },
        receiptsConfirmed(id) {
          record.confirmed.push(id)
          if (record.throwOnConfirm) throw new Error("receipts confirmation unavailable")
        },
        stop() { record.stops += 1; return Promise.resolve({ code: 0, signal: null }) },
      }
    },
    startProcess() { throw new Error("this test starts no worker") },
  })
  return { record, loadParts }
}

const ID_A = tail(9000, 1)
const ID_B = tail(9000, 2)

test("a staged notice is appended after the binding as one more user message, carrying the id the lifecycle chose", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    record.notice = { id: ID_A, text: "Receipts for your earlier messages:\nsynthetic" }
    const first = await s.preStep(2)
    assert.equal(first.kind, "enter")
    assert.equal(first.messages.length, 2)
    const [binding, receipt] = first.messages
    assert.equal(binding.source.kind, CONTEXT_KIND)
    assert.match(binding.id, UUID)
    assert.deepEqual(receipt, {
      id: ID_A, role: "user", source: { kind: RECEIPTS_KIND }, content: [{ type: "text", text: "Receipts for your earlier messages:\nsynthetic" }],
    })
    // The binding is published once; a later notice is the only addition.
    record.notice = { id: ID_B, text: "second" }
    const second = await s.preStep(3, [{ id: "peer-1", role: "user" }])
    assert.deepEqual(second.messages.map(message => message.id), ["peer-1", ID_B], "after the messages the step already carries")
    assert.equal(record.taken, 2)
  } finally { s.cleanup() }
})

test("with no notice staged the pre-step is what it was before receipts: the binding once, then the decision untouched", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    const first = await s.preStep(2)
    assert.deepEqual(first.messages.map(message => [message.source.kind, message.content[0].text]), [[CONTEXT_KIND, "synthetic binding metadata"]])
    const base = { kind: "enter", messages: [] }
    const second = await s.waterfall("agent/pre-step", { agent: s.agent, turn: 1, step: 3 }, base)
    assert.equal(second, base, "the very decision object, not a copy")
  } finally { s.cleanup() }
})

test("the binding message is the same with a notice staged and with none", async () => {
  const messages = []
  for (const staged of [false, true]) {
    const { record, loadParts } = scripted()
    const s = await adopt({ loadParts })
    try {
      if (staged) record.notice = { id: ID_A, text: "synthetic" }
      const decision = await s.preStep(2)
      const [binding] = decision.messages
      messages.push({ ...binding, id: "<id>" })
    } finally { s.cleanup() }
  }
  assert.deepEqual(messages[1], messages[0])
})

test("a first step whose decision is empty never takes the notice: DSH would spend no model call, and a notice is not a reason for one", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    await s.preStep(2) // the binding goes out here, so the next decisions show the notice alone
    record.notice = { id: ID_A, text: "synthetic" }
    const base = { kind: "enter", messages: [] }
    const taken = record.taken
    assert.equal(await s.waterfall("agent/pre-step", { agent: s.agent, turn: 1, step: 1 }, base), base, "step 1, nothing else to send: untouched")
    assert.equal(record.taken, taken, "the lifecycle was not even asked")
    assert.deepEqual(record.notice, { id: ID_A, text: "synthetic" }, "and the notice is still staged")
    const withMessage = await s.preStep(1, [{ id: "peer-1", role: "user" }])
    assert.deepEqual(withMessage.messages.map(message => message.id), ["peer-1", ID_A], "step 1 with a message of its own carries it")
    record.notice = { id: ID_B, text: "later" }
    const later = await s.preStep(2)
    assert.deepEqual(later.messages.map(message => message.id), [ID_B], "step 2 with nothing else carries it: the step runs anyway")
  } finally { s.cleanup() }
})

test("a decision that is not an enter is returned as it is, and no notice is taken", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    record.notice = { id: ID_A, text: "synthetic" }
    const reject = { kind: "reject", reason: "synthetic" }
    assert.equal(await s.waterfall("agent/pre-step", { agent: s.agent, turn: 1, step: 2 }, reject), reject)
    assert.equal(record.taken, 0)
    const stranger = nativeAgent("native-2")
    assert.deepEqual(await s.waterfall("agent/pre-step", { agent: stranger, turn: 1, step: 2 }, { kind: "enter", messages: [] }), { kind: "enter", messages: [] }, "an agent the plugin does not serve")
    assert.equal(record.taken, 0)
  } finally { s.cleanup() }
})

test("the user message that carries a notice's id reaches the lifecycle, and only a user message of this session", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: ID_A } })
    assert.deepEqual(record.confirmed, [ID_A])
    s.fire("session/event", s.agent.session, { type: "assistant/message", data: { id: ID_B } })
    s.fire("session/event", s.agent.session, { type: "tool/result", data: { id: ID_B } })
    s.fire("session/event", { id: "native-1" }, { type: "user/message", data: { id: ID_B } }) // another session object
    s.fire("session/event", { id: "native-9" }, { type: "user/message", data: { id: ID_B } }) // an agent the plugin does not know
    assert.deepEqual(record.confirmed, [ID_A], "no other event confirms anything")
    s.fire("session/event", s.agent.session, { type: "user/message", data: {} })
    s.fire("session/event", s.agent.session, { type: "user/message" })
    assert.deepEqual(record.confirmed, [ID_A, undefined, undefined], "a message without an id is passed on as no id, for the lifecycle to ignore")
  } finally { s.cleanup() }
})

test("a user message does not stand in for the turn events: the turn end still settles the lifecycle", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: ID_A } })
    assert.deepEqual(record.events, [])
    s.fire("session/event", s.agent.session, { type: "turn/end", data: { reason: { kind: "completed" } } })
    assert.deepEqual(record.events, ["agent_settled"])
    s.fire("session/event", s.agent.session, { type: "session/title", data: {} })
    assert.deepEqual(record.events, ["agent_settled", "session_info_changed"])
  } finally { s.cleanup() }
})

test("a lifecycle that throws on receipts costs the notice only: the step goes on and chat stays on", async () => {
  const { record, loadParts } = scripted()
  const s = await adopt({ loadParts })
  try {
    record.throwOnNotice = true
    record.throwOnConfirm = true
    const first = await s.preStep(2)
    assert.deepEqual(first.messages.map(message => message.source.kind), [CONTEXT_KIND], "the binding is still appended")
    const second = await s.preStep(3)
    assert.equal(second.messages.length, 0)
    assert.doesNotThrow(() => s.fire("session/event", s.agent.session, { type: "user/message", data: { id: ID_A } }))
    s.fire("agent/status", { agent: s.agent, status: "running" })
    s.fire("session/event", s.agent.session, { type: "turn/end", data: { reason: { kind: "completed" } } })
    await flush()
    assert.equal(record.stops, 0, "the lifecycle was never stopped")
    assert.deepEqual(record.events, ["agent_start", "agent_settled"], "and later events still reach it")
    assert.equal(s.logs.filter(entry => /chat disabled/.test(entry.message)).length, 0)
    record.throwOnNotice = false
    record.notice = { id: ID_A, text: "synthetic" }
    assert.deepEqual((await s.preStep(4)).messages.map(message => message.id), [ID_A], "and the next notice is still served")
  } finally { s.cleanup() }
})

// Part two: the real lifecycle, a scripted worker and a native half that reports busy or idle.
async function integrated({ rows = [], native = { state: "busy" } } = {}) {
  const joined = {
    session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
    room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "deepseek", instance_file: "/tmp/agent-chat-state/boot-1.json",
    capabilities: ["receipts-cancel"], // the worker that is asked for receipts: its join reply names the cancel
  }
  const clock = { t: 5_000_000 }
  const server = { rows, muted: false }
  const requests = []
  const delivered = []
  let lifecycle = null
  let close
  const closed = new Promise(resolve => { close = resolve })
  const worker = {
    ready: Promise.resolve(joined),
    closed,
    request(op, fields) {
      requests.push({ op, fields })
      if (op === "receipts") return Promise.resolve({ receipts: server.rows, muted: server.muted })
      if (op === "receipts_delivered") return Promise.resolve({ delivered: fields.receipts })
      if (op === "pending") return Promise.resolve({ messages: [] })
      return Promise.resolve({})
    },
    stop() { close({ code: 0, signal: null }); return closed },
  }
  const loadParts = async () => ({
    createDelivery: () => ({
      state: () => native.state,
      peek: () => native.state,
      heartbeatState: () => ({ native_state: native.state === "busy" ? "busy" : "idle", stopped: false, plan_mode: false }),
      deliver(batch) { delivered.push(batch); return Promise.resolve({ outcome: "handed", reason: null }) },
      dispose() {},
      onInserted: message => message?.source?.kind === "user" && typeof message.source.rpcId === "string",
      onClaimed() {}, onDiscarded() {}, onTurnEnd() {}, disable() {},
    }),
    createLifecycle(bus, delivery, received, options) {
      lifecycle = createLifecycle(bus, delivery, received, {
        ...options, startProcess: () => worker, now: () => clock.t, random: () => 0,
        setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {},
      })
      return lifecycle
    },
    startProcess: () => worker,
  })
  const s = await adopt({ loadParts })
  // A Web prompt clears the stop latch, as it does for a real agent.
  s.fire("agent/inbox/inserted", { agent: s.agent, message: { source: { kind: "user", rpcId: "rpc-1" } } })
  await flush()
  return {
    ...s, native, server, requests, delivered, clock,
    async tick(seconds = POLL_MS / 1000) { clock.t += seconds * 1000; await lifecycle.poll(); await flush() },
    count: op => requests.filter(entry => entry.op === op).length,
    marks: () => requests.filter(entry => entry.op === "receipts_delivered").map(entry => entry.fields),
  }
}

const receiptOf = decision => decision.messages.find(message => message.source.kind === RECEIPTS_KIND)

test("end to end: the notice is staged while a turn runs, appended by the pre-step and marked once its own id is logged", async () => {
  const feed = [row(1), row(2)]
  const s = await integrated({ rows: feed })
  try {
    await s.tick(0)
    assert.equal(s.count("receipts"), 1)
    const decision = await s.preStep(2)
    const receipt = receiptOf(decision)
    assert.ok(receipt, "a receipts message was appended")
    assert.equal(receipt.text ?? receipt.content[0].text, renderReceiptNotice(feed, MAX_CONTEXT_BYTES).text)
    assert.match(receipt.id, UUID)
    assert.equal(receipt.role, "user")
    assert.ok(Buffer.byteLength(receipt.content[0].text, "utf8") <= MAX_CONTEXT_BYTES)
    assert.equal((await s.preStep(3)).messages.length, 0, "taken once: the next step carries nothing")

    await s.tick()
    assert.equal(s.count("receipts_delivered"), 0, "appended but not logged: no mark")
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: tail(9999, 1) } })
    await s.tick()
    assert.equal(s.count("receipts_delivered"), 0, "another message's id confirms nothing")
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: receipt.id } })
    await s.tick()
    assert.deepEqual(s.marks(), [{ receipts: feed.map(entry => entry.id) }], "exactly the ids shown")
  } finally { s.cleanup() }
})

test("end to end: a notice whose step never logged it is released when the turn ends, never marked, and offered again", async () => {
  const feed = [row(1)]
  const s = await integrated({ rows: feed })
  try {
    await s.tick(0)
    const first = receiptOf(await s.preStep(2))
    assert.ok(first)
    s.fire("agent/status", { agent: s.agent, status: "idle" }) // the turn ended: the step was aborted before it logged anything
    s.fire("agent/status", { agent: s.agent, status: "running" })
    await s.tick()
    assert.equal(s.count("receipts_delivered"), 0)
    assert.equal(s.count("receipts"), 2)
    const again = receiptOf(await s.preStep(2))
    assert.ok(again && again.content[0].text.includes(feed[0].message_id))
    assert.notEqual(again.id, first.id)
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: first.id } })
    await s.tick()
    assert.equal(s.count("receipts_delivered"), 0, "the first, released notice cannot confirm the second")
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: again.id } })
    await s.tick()
    assert.deepEqual(s.marks(), [{ receipts: [feed[0].id] }])
  } finally { s.cleanup() }
})

test("end to end: nothing is staged for an idle agent, and a muted agent keeps its receipts waiting", async () => {
  const s = await integrated({ rows: [row(1)], native: { state: null } })
  try {
    await s.tick(0)
    await s.tick()
    assert.equal(s.count("receipts"), 0, "idle: no poll")
    assert.equal(receiptOf(await s.preStep(2)), undefined)
    s.native.state = "busy"
    s.server.muted = true
    await s.tick()
    assert.equal(s.count("receipts"), 1)
    assert.equal(receiptOf(await s.preStep(3)), undefined, "muted: held")
    s.server.muted = false
    await s.tick()
    assert.ok(receiptOf(await s.preStep(4)), "unmuted: staged and appended")
  } finally { s.cleanup() }
})

test("end to end: receipts never steer, never go through the delivery object and never touch the inbox", async () => {
  const s = await integrated({ rows: [row(1), row(2), row(3)] })
  try {
    await s.tick(0)
    const receipt = receiptOf(await s.preStep(2))
    s.fire("session/event", s.agent.session, { type: "user/message", data: { id: receipt.id } })
    await s.tick()
    await s.tick()
    assert.equal(s.count("receipts_delivered"), 1, "the receipts path ran to its mark")
    assert.deepEqual(s.agent.steers, [], "no steer")
    assert.deepEqual(s.agent.removed, [], "no inbox removal")
    assert.deepEqual(s.delivered, [], "nothing was handed to the native sender")
    assert.equal(s.count("claim"), 0)
    assert.equal(s.count("settle"), 0)
  } finally { s.cleanup() }
})

test("end to end: the binding the pre-step appends is the same with receipts pending and with none", async () => {
  const bindings = []
  for (const rows of [[], [row(1), row(2)]]) {
    const s = await integrated({ rows })
    try {
      await s.tick(0)
      const decision = await s.preStep(2)
      const binding = decision.messages.find(message => message.source.kind === CONTEXT_KIND)
      bindings.push({ ...binding, id: "<id>" })
      assert.equal(decision.messages.indexOf(binding), 0, "the binding comes first")
    } finally { s.cleanup() }
  }
  assert.deepEqual(bindings[1], bindings[0])
})

test("end to end: a notice that went stale or met Plan Mode before its step is not appended, and the row is offered again", async () => {
  const feed = [row(1)]
  for (const [name, spoil] of [
    ["stale", s => { s.clock.t += POLL_MS + 1 }],
    ["Plan Mode", s => { s.native.state = "plan" }],
  ]) {
    const s = await integrated({ rows: feed })
    try {
      await s.tick(0)
      spoil(s)
      assert.equal(receiptOf(await s.preStep(2)), undefined, `${name}: not appended`)
      s.native.state = "busy"
      await s.tick()
      const again = receiptOf(await s.preStep(3))
      assert.ok(again, `${name}: the row is staged again and appended`)
      assert.ok(again.content[0].text.includes(feed[0].message_id))
    } finally { s.cleanup() }
  }
})

// Part three: the real native half too. The delivery counts an idle agent with a parked inbox item as busy, so that it starts
// no second turn; the receipts ask whether a turn runs, and such an agent runs none. DSH parks a Web prompt that arrives
// while a maintenance task runs: the agent stays idle and the prompt waits in the inbox until maintenance ends.
test("end to end: an idle agent with a parked Web prompt is asked for no receipts and shown none; a running turn is", async () => {
  const joined = {
    session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
    room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "deepseek", instance_file: "/tmp/agent-chat-state/boot-1.json",
    capabilities: ["receipts-cancel"],
  }
  const clock = { t: 5_000_000 }
  const requests = []
  let lifecycle = null
  let delivery = null
  let close
  const closed = new Promise(resolve => { close = resolve })
  const worker = {
    ready: Promise.resolve(joined),
    closed,
    request(op, fields) {
      requests.push({ op, fields })
      if (op === "receipts") return Promise.resolve({ receipts: [row(1)], muted: false })
      if (op === "pending") return Promise.resolve({ messages: [] })
      return Promise.resolve({})
    },
    stop() { close({ code: 0, signal: null }); return closed },
  }
  const plan = { snapshot: () => ({ values: { plan: { active: false, pending: false } } }) }
  const loadParts = async () => ({
    createDelivery(ctx, agent) {
      delivery = createDelivery({ ...ctx, get: name => (name === "sessionProjections" ? plan : ctx.get(name)) }, agent)
      return delivery
    },
    createLifecycle(bus, native, received, options) {
      lifecycle = createLifecycle(bus, native, received, {
        ...options, startProcess: () => worker, now: () => clock.t, random: () => 0,
        setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {},
      })
      return lifecycle
    },
    startProcess: () => worker,
  })
  const s = await adopt({ loadParts })
  const count = op => requests.filter(entry => entry.op === op).length
  const tick = async (seconds = POLL_MS / 1000) => { clock.t += seconds * 1000; await lifecycle.poll(); await flush() }
  try {
    s.agent.status = "idle" // a maintenance task runs: the agent is idle, and the Web prompt below is parked
    const prompt = { source: { kind: "user", rpcId: "rpc-1" } }
    s.agent.inbox.nextTurn.push(prompt)
    s.fire("agent/inbox/inserted", { agent: s.agent, message: prompt })
    await flush()
    assert.equal(delivery.state(), "busy", "the delivery still counts the parked prompt as busy, and starts no turn")
    await tick(0)
    await tick()
    assert.equal(count("receipts"), 0, "no turn runs: no receipts request")
    assert.equal(receiptOf(await s.preStep(2)), undefined, "and nothing is appended")
    assert.deepEqual(s.agent.steers, [], "nothing was steered")
    s.agent.inbox.nextTurn.length = 0 // maintenance ended, and the parked prompt started its turn
    s.agent.status = "running"
    await tick()
    assert.equal(count("receipts"), 1, "a running turn is asked")
    assert.ok(receiptOf(await s.preStep(3)), "and its step carries the notice")
  } finally { s.cleanup() }
})
