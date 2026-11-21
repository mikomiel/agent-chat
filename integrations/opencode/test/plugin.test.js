import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createPlugin } from "../plugin/agent-chat.js"
import { createRegistry, globalRegistry } from "../lib/owner.js"
import { BINDING_KEY } from "../lib/channel.js"

const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let index = 0; index < 12; index++) await tick() }

const base = {
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
const ATTEMPT = "44444444-4444-4444-8444-444444444444"
const MESSAGE = {
  id: "55555555-5555-4555-8555-555555555555",
  kind: "question",
  room_id: joined.room_id,
  history_after: "7",
}

function configFile(value = base) {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-opencode-"))
  const file = join(dir, "chat.json")
  writeFileSync(file, JSON.stringify(value))
  chmodSync(file, 0o600)
  return { dir, env: { AGENT_CHAT_OPENCODE_CONFIG: file } }
}

// A double of the plugin context: a stream the test pushes events into, session.get, synthetic and the keyed
// instruction entries. `order` records every call in sequence across the context and the worker.
function liveCtx(infoOf, order) {
  const queue = []
  const state = { wake: null }
  const entries = new Map()
  const calls = { subscribe: 0, synthetic: [], get: [], put: 0, remove: 0 }
  let counter = 0
  const ctx = {
    calls,
    entries,
    push(item) { queue.push(item); state.wake?.() },
    event: {
      subscribe(options) {
        calls.subscribe += 1
        return (async function* () {
          yield { type: "server.connected" }
          while (!options.signal.aborted) {
            if (queue.length) { yield queue.shift(); continue }
            await new Promise(resolve => { state.wake = resolve; options.signal.addEventListener("abort", resolve, { once: true }) })
          }
        })()
      },
    },
    session: {
      async get({ sessionID }) { calls.get.push(sessionID); return infoOf(sessionID) },
      async synthetic(input) { order.push("synthetic"); calls.synthetic.push(input); return { id: `msg_${++counter}` } },
      instructions: {
        entry: {
          async put(input) { order.push("put"); calls.put += 1; entries.set(input.key, input.value) },
          async list() { return [...entries].map(([key, value]) => ({ key, value })) },
          async remove(input) { order.push("remove"); calls.remove += 1; entries.delete(input.key) },
        },
      },
    },
  }
  return ctx
}

function fakeWorker(order, { gate } = {}) {
  const requests = []
  let close
  const closed = new Promise(resolve => { close = resolve })
  return {
    requests,
    closed,
    ready: gate ? gate.then(() => joined) : Promise.resolve(joined),
    request(op, fields) {
      order.push(op)
      requests.push({ op, fields })
      if (op === "pending") return Promise.resolve({ messages: [MESSAGE.id] })
      if (op === "claim") return Promise.resolve({ dispatch: true, attempt_id: ATTEMPT, reservation_ms: 20_000, messages: [MESSAGE] })
      if (op === "status") return Promise.resolve({ muted: false })
      return Promise.resolve({})
    },
    stop() { close({ code: 0, signal: null }); return closed },
  }
}

async function realParts(startProcess) {
  const [{ createLifecycle }, { createDelivery }, owner] = await Promise.all([
    import("../lib/lifecycle.js"), import("../lib/delivery.js"), import("../lib/owner.js"),
  ])
  return { createLifecycle, createDelivery, startProcess, createMember: owner.createMember, registry: owner.globalRegistry }
}

const ev = (type, sessionID, data = {}) => ({ id: `${type}-${sessionID}-${Math.random()}`, type, data: { sessionID, ...data } })

test("the default export has the shape OpenCode's loader checks: an id and a setup function, nothing else", () => {
  assert.deepEqual(Object.keys(plugin).sort(), ["id", "setup"])
  assert.equal(typeof plugin.id, "string")
  assert.ok(plugin.id)
  assert.equal(typeof plugin.setup, "function")
})

test("without an opt-in nothing is registered: no stream, no member, no process", async () => {
  const registry = createRegistry()
  const order = []
  const ctx = liveCtx(() => ({}), order)
  let loaded = 0
  const off = createPlugin({ env: {}, registry, loadParts: async () => { loaded += 1; return null } })
  assert.equal(await off.setup(ctx), undefined)
  assert.equal(ctx.calls.subscribe, 0)
  assert.deepEqual(registry.members(), [])
  assert.equal(loaded, 0)
})

test("a delegated child registers nothing even when it inherited the variable", async () => {
  const { dir, env } = configFile()
  try {
    const registry = createRegistry()
    const ctx = liveCtx(() => ({}), [])
    const child = createPlugin({ env: { ...env, AGENT_CHAT_DELEGATED_CHILD: "1" }, registry, loadParts: async () => { throw new Error("must not load") } })
    assert.equal(await child.setup(ctx), undefined)
    assert.equal(ctx.calls.subscribe, 0)
    assert.deepEqual(registry.members(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a broken part or a refused load turns chat off and never throws into OpenCode", async () => {
  const { dir, env } = configFile()
  try {
    const registry = createRegistry()
    for (const loadParts of [async () => { throw new Error("broken file") }, async () => null, () => { throw new Error("sync") }]) {
      const ctx = liveCtx(() => ({}), [])
      const broken = createPlugin({ env, registry, loadParts })
      assert.equal(await broken.setup(ctx), undefined)
      assert.equal(ctx.calls.subscribe, 0)
    }
    assert.deepEqual(registry.members(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the default load path wires the real parts: one stream, a cleanup, and nothing joined without a session", async () => {
  const { dir, env } = configFile()
  const ctx = liveCtx(id => ({ id, agent: "build" }), [])
  // No loadParts and no registry: this is the path OpenCode takes, with the real libraries and the shared registry.
  const cleanup = await createPlugin({ env }).setup(ctx)
  try {
    assert.equal(typeof cleanup, "function")
    await flush()
    assert.equal(ctx.calls.subscribe, 1)
    assert.equal(globalRegistry().members().length, 1)
    assert.ok(globalRegistry().owner())
    assert.deepEqual(ctx.calls.get, [])
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(globalRegistry().members().length, 0)
  assert.equal(globalRegistry().owner(), null)
})

test("a busy root session is joined, bound, claimed for, delivered to and settled handed on the delivered event", async () => {
  const { dir, env } = configFile()
  const order = []
  const ctx = liveCtx(id => (id === "ses_root" ? { id, agent: "build" } : { id, parentID: "ses_root" }), order)
  const registry = createRegistry()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const workers = []
  const identities = []
  const parts = await realParts((_config, identity) => { identities.push(identity); const worker = fakeWorker(order, { gate }); workers.push(worker); return worker })
  const cleanup = await createPlugin({ env, registry, loadParts: async () => parts }).setup(ctx)
  try {
    assert.equal(typeof cleanup, "function")
    // The operator prompts and a run starts while the join is still in flight. A child session is in the same stream.
    ctx.push(ev("session.inbox.enqueued", "ses_root", { inboxID: "msg_user", item: { type: "user" } }))
    ctx.push(ev("session.execution.started", "ses_child"))
    ctx.push(ev("session.execution.started", "ses_root"))
    await flush()
    assert.equal(workers.length, 1) // the child never started a worker
    assert.deepEqual(identities.map(item => item.nativeSessionId), ["ses_root"])
    assert.equal(typeof identities[0].bootId, "string")
    assert.deepEqual(ctx.calls.get.sort(), ["ses_child", "ses_root"])
    release()
    await flush()
    // Binding first, then presence, then the offer, the claim, the status read and the native delivery.
    assert.deepEqual(order.slice(0, 6), ["put", "heartbeat", "pending", "claim", "status", "synthetic"])
    assert.match(ctx.entries.get(BINDING_KEY), /"instance_file":"\/tmp\/agent-chat-state\/boot-1\.json"/)
    const beat = workers[0].requests.find(row => row.op === "heartbeat")
    assert.deepEqual(beat.fields.state, { native_state: "busy", stopped: false, plan_mode: false })
    assert.equal(ctx.calls.synthetic.length, 1)
    assert.equal(ctx.calls.synthetic[0].delivery, "steer")
    assert.equal(ctx.calls.synthetic[0].resume, false)
    assert.match(ctx.calls.synthetic[0].text, /history_after/)
    // Issued is not delivered: nothing is settled until the delivered event.
    assert.equal(workers[0].requests.some(row => row.op === "settle"), false)
    ctx.push(ev("session.inbox.delivered", "ses_root", { inboxID: "msg_1" }))
    await flush()
    const settle = workers[0].requests.find(row => row.op === "settle")
    assert.deepEqual(settle.fields.result, { outcome: "handed", reason: null })
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(ctx.entries.size, 0) // the binding entry is removed as the session's chat ends
  assert.equal(await workers[0].closed.then(result => result.code), 0)
})

test("a run that ends before the delivered event settles uncertain, and the late event changes nothing", async () => {
  const { dir, env } = configFile()
  const order = []
  const ctx = liveCtx(id => ({ id, agent: "build" }), order)
  const workers = []
  const parts = await realParts(() => { const worker = fakeWorker(order); workers.push(worker); return worker })
  const cleanup = await createPlugin({ env, registry: createRegistry(), loadParts: async () => parts }).setup(ctx)
  try {
    ctx.push(ev("session.inbox.enqueued", "ses_root", { item: { type: "user" } }))
    ctx.push(ev("session.execution.started", "ses_root"))
    await flush()
    assert.equal(ctx.calls.synthetic.length, 1)
    ctx.push(ev("session.execution.interrupted", "ses_root", { reason: "user" }))
    await flush()
    const results = workers[0].requests.filter(row => row.op === "settle").map(row => row.fields.result)
    assert.deepEqual(results, [{ outcome: "uncertain", reason: "transport_ambiguous" }])
    ctx.push(ev("session.inbox.delivered", "ses_root", { inboxID: "msg_1" }))
    await flush()
    assert.equal(workers[0].requests.filter(row => row.op === "settle").length, 1)
    assert.equal(workers[0].requests.filter(row => row.op === "claim").length, 1)
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an idle session and a plan session are never claimed for", async () => {
  const { dir, env } = configFile()
  const order = []
  const ctx = liveCtx(id => ({ id, agent: "build" }), order)
  const workers = []
  const parts = await realParts(() => { const worker = fakeWorker(order); workers.push(worker); return worker })
  const cleanup = await createPlugin({ env, registry: createRegistry(), loadParts: async () => parts }).setup(ctx)
  try {
    ctx.push(ev("session.inbox.enqueued", "ses_idle", { item: { type: "user" } }))
    ctx.push(ev("session.execution.started", "ses_idle"))
    ctx.push(ev("session.execution.succeeded", "ses_idle"))
    await flush()
    ctx.push(ev("session.agent.selected", "ses_plan", { agent: "plan" }))
    ctx.push(ev("session.inbox.enqueued", "ses_plan", { item: { type: "user" } }))
    ctx.push(ev("session.execution.started", "ses_plan"))
    await flush()
    assert.equal(workers.length, 2)
    assert.equal(workers.flatMap(worker => worker.requests).some(row => row.op === "claim"), false)
    assert.equal(ctx.calls.synthetic.length, 0)
    const states = workers.map(worker => worker.requests.filter(row => row.op === "heartbeat").at(-1).fields.state)
    assert.deepEqual(states[0], { native_state: "idle", stopped: false, plan_mode: false })
    assert.deepEqual(states[1], { native_state: "busy", stopped: false, plan_mode: true })
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unconfirmed binding entry keeps a session out of chat before anything is offered", async () => {
  const { dir, env } = configFile()
  const order = []
  const ctx = liveCtx(id => ({ id, agent: "build" }), order)
  ctx.session.instructions.entry.put = async () => { throw new Error("entries unavailable on this release") }
  const workers = []
  const parts = await realParts(() => { const worker = fakeWorker(order); workers.push(worker); return worker })
  const cleanup = await createPlugin({ env, registry: createRegistry(), loadParts: async () => parts }).setup(ctx)
  try {
    ctx.push(ev("session.inbox.enqueued", "ses_root", { item: { type: "user" } }))
    ctx.push(ev("session.execution.started", "ses_root"))
    await flush()
    assert.equal(workers.length, 1)
    assert.deepEqual(workers[0].requests.map(row => row.op).filter(op => op !== "settle"), [])
    assert.equal(ctx.calls.synthetic.length, 0)
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two plugin instances in one server run one owner, and the second takes over when the first is torn down", async () => {
  const { dir, env } = configFile()
  const order = []
  const registry = createRegistry()
  const first = liveCtx(id => ({ id, agent: "build" }), order)
  const second = liveCtx(id => ({ id, agent: "build" }), order)
  const workers = []
  const parts = await realParts(() => { const worker = fakeWorker(order); workers.push(worker); return worker })
  const plugin_ = createPlugin({ env, registry, loadParts: async () => parts })
  const stopFirst = await plugin_.setup(first)
  const stopSecond = await plugin_.setup(second)
  try {
    await flush()
    // The same event read by both streams is one event.
    const shared = ev("session.inbox.enqueued", "ses_root", { item: { type: "user" } })
    first.push(shared)
    second.push(shared)
    await flush()
    assert.deepEqual(first.calls.get, ["ses_root"])
    assert.deepEqual(second.calls.get, [])
    assert.equal(workers.length, 1)
    await stopFirst()
    assert.equal(await workers[0].closed.then(result => result.code), 0) // the old owner's worker ended first
    second.push(ev("session.execution.started", "ses_root"))
    await flush()
    assert.deepEqual(second.calls.get, ["ses_root"]) // the new owner rejoins at the session's next event
    assert.equal(workers.length, 2)
  } finally {
    await stopSecond()
    rmSync(dir, { recursive: true, force: true })
  }
})
