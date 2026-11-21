import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createPlugin } from "../plugin/agent-chat.js"
import { createRegistry, globalRegistry } from "../lib/owner.js"
import { EVENT_TYPES } from "../lib/manager.js"
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
const UNKNOWN = { native_state: "unknown", stopped: true, plan_mode: false }

function configFile(value = base) {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-opencode-"))
  const file = join(dir, "chat.json")
  writeFileSync(file, JSON.stringify(value))
  chmodSync(file, 0o600)
  return { dir, env: { AGENT_CHAT_OPENCODE_CONFIG: file } }
}

// A double of the plugin context: a stream the test pushes events into, session.get and the keyed instruction entries,
// which it keeps per session.
// It also has the two ways to put input into a session, `synthetic` and `prompt`, and records every use: the plugin
// must never call either. `order` records every call in sequence across the context and the worker.
function liveCtx(infoOf, order) {
  const queue = []
  const state = { wake: null }
  const entries = new Map()
  const calls = { subscribe: 0, options: [], synthetic: [], prompt: [], get: [], put: 0, remove: 0 }
  const ctx = {
    calls,
    entries,
    push(item) { queue.push(item); state.wake?.() },
    event: {
      subscribe(options) {
        calls.subscribe += 1
        calls.options.push(options)
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
      async synthetic(input) { order.push("synthetic"); calls.synthetic.push(input); return { id: "msg_unexpected" } },
      async prompt(input) { order.push("prompt"); calls.prompt.push(input); return { id: "msg_unexpected" } },
      instructions: {
        entry: {
          async put(input) { order.push("put"); calls.put += 1; entries.set(`${input.sessionID}/${input.key}`, input.value) },
          async list({ sessionID }) {
            return [...entries]
              .filter(([id]) => id.startsWith(`${sessionID}/`))
              .map(([id, value]) => ({ key: id.slice(sessionID.length + 1), value }))
          },
          async remove(input) { order.push("remove"); calls.remove += 1; entries.delete(`${input.sessionID}/${input.key}`) },
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
      return Promise.resolve({})
    },
    stop() { close({ code: 0, signal: null }); return closed },
  }
}

async function realParts(startProcess) {
  const [{ createLifecycle }, { createContext }, owner] = await Promise.all([
    import("../lib/lifecycle.js"), import("../lib/context.js"), import("../lib/owner.js"),
  ])
  return { createLifecycle, createContext, startProcess, createMember: owner.createMember, registry: owner.globalRegistry }
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

test("a root session is joined and bound, reports the unknown state, and is sent nothing", async () => {
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
    // A run starts while the join is still in flight. A child session is in the same stream.
    ctx.push(ev("session.execution.started", "ses_child"))
    ctx.push(ev("session.execution.started", "ses_root"))
    await flush()
    assert.equal(workers.length, 1) // the child never started a worker
    assert.deepEqual(identities.map(item => item.nativeSessionId), ["ses_root"])
    assert.equal(typeof identities[0].bootId, "string")
    assert.deepEqual(ctx.calls.get.sort(), ["ses_child", "ses_root"])
    release()
    await flush()
    // Binding first, then presence. Nothing is offered, claimed, read or settled.
    assert.deepEqual(order, ["put", "heartbeat"])
    assert.match(ctx.entries.get(`ses_root/${BINDING_KEY}`), /"instance_file":"\/tmp\/agent-chat-state\/boot-1\.json"/)
    assert.deepEqual(workers[0].requests, [{ op: "heartbeat", fields: { state: UNKNOWN } }])
    assert.deepEqual(ctx.calls.synthetic, [])
    assert.deepEqual(ctx.calls.prompt, [])
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(ctx.entries.size, 0) // the binding entry is removed as the session's chat ends
  assert.equal(await workers[0].closed.then(result => result.code), 0)
  assert.deepEqual(ctx.calls.synthetic, [])
  assert.deepEqual(ctx.calls.prompt, [])
})

test("the plugin subscribes to the seven session events only, and reads no state of any session", async () => {
  const { dir, env } = configFile()
  const order = []
  const ctx = liveCtx(id => ({ id, agent: id === "ses_plan" ? "plan" : "build" }), order)
  const workers = []
  const parts = await realParts(() => { const worker = fakeWorker(order); workers.push(worker); return worker })
  const cleanup = await createPlugin({ env, registry: createRegistry(), loadParts: async () => parts }).setup(ctx)
  try {
    ctx.push(ev("session.created", "ses_idle"))
    ctx.push(ev("session.execution.started", "ses_busy"))
    ctx.push(ev("session.execution.started", "ses_plan"))
    await flush()
    assert.deepEqual(ctx.calls.options[0].types, [...EVENT_TYPES])
    assert.equal(EVENT_TYPES.length, 7)
    assert.equal(workers.length, 3)
    // Whatever a session is doing and whichever agent it runs, it is joined alike and reports the same unknown state.
    for (const worker of workers) assert.deepEqual(worker.requests, [{ op: "heartbeat", fields: { state: UNKNOWN } }])
    assert.deepEqual(ctx.calls.synthetic, [])
    assert.deepEqual(ctx.calls.prompt, [])
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unconfirmed binding entry keeps a session out of chat before anything is reported", async () => {
  const { dir, env } = configFile()
  const order = []
  const ctx = liveCtx(id => ({ id, agent: "build" }), order)
  ctx.session.instructions.entry.put = async () => { throw new Error("entries unavailable on this release") }
  const workers = []
  const parts = await realParts(() => { const worker = fakeWorker(order); workers.push(worker); return worker })
  const cleanup = await createPlugin({ env, registry: createRegistry(), loadParts: async () => parts }).setup(ctx)
  try {
    ctx.push(ev("session.execution.started", "ses_root"))
    await flush()
    assert.equal(workers.length, 1)
    assert.deepEqual(workers[0].requests, [])
    assert.deepEqual(ctx.calls.synthetic, [])
    assert.deepEqual(ctx.calls.prompt, [])
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
    // The same event read by both streams reaches the owner twice, and a repeat joins nothing again.
    const shared = ev("session.execution.started", "ses_root")
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
