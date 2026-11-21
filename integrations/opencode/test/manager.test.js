import test from "node:test"
import assert from "node:assert/strict"
import { EVENT_TYPES, createManager, isRootSession } from "../lib/manager.js"

const config = { chatEnabled: true, directory: "/tmp/state", serverOrigin: "https://chat.example", hostToken: "synthetic-token", python: "/usr/bin/python3" }
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }
const event = (type, sessionID, data = {}) => ({ id: `${type}-${sessionID}-${Math.random()}`, type, data: { sessionID, ...data } })

// Doubles of the two parts the manager builds per session. They record what the manager does to them.
function stubParts({ observe = () => false, verify = () => Promise.resolve(), stopResult = { code: 0, signal: null } } = {}) {
  const deliveries = new Map()
  const lifecycles = new Map()
  return {
    deliveries,
    lifecycles,
    createDelivery(_ctx, id) {
      const delivery = {
        id, seeded: null, seen: [], resets: 0, disposed: 0,
        seed(info) { delivery.seeded = info },
        observe(item) { delivery.seen.push(item.type); return observe(id, item) },
        reset() { delivery.resets += 1 },
        verifyContext: () => verify(id),
        dispose() { delivery.disposed += 1 },
      }
      deliveries.set(id, delivery)
      return delivery
    },
    createLifecycle(bus, delivery, passedConfig, options) {
      const lifecycle = { delivery, passedConfig, options, started: [], changed: 0, stops: 0, disables: [] }
      bus.on("session_start", payload => lifecycle.started.push(payload))
      bus.on("state_changed", () => { lifecycle.changed += 1 })
      lifecycle.stop = () => { lifecycle.stops += 1; return Promise.resolve(stopResult) }
      lifecycle.disable = reason => { lifecycle.disables.push(reason); return Promise.resolve(null) }
      lifecycles.set(delivery.id, lifecycle)
      return lifecycle
    },
    startProcess: () => { throw new Error("not started by the manager") },
  }
}

function fakeCtx(infoOf) {
  const lookups = []
  return {
    lookups,
    session: {
      async get({ sessionID }) {
        lookups.push(sessionID)
        const info = infoOf(sessionID)
        if (info instanceof Error) throw info
        return info
      },
    },
  }
}

const root = id => ({ id, agent: "build" })

test("isRootSession: a parent or a fork source, or an unreadable record, is not a root", () => {
  assert.equal(isRootSession({ id: "ses_a" }, "ses_a"), true)
  assert.equal(isRootSession({ id: "ses_a", agent: "plan", parentID: null, fork: null }, "ses_a"), true)
  assert.equal(isRootSession({ id: "ses_a", parentID: "ses_p" }, "ses_a"), false)
  assert.equal(isRootSession({ id: "ses_a", fork: { sessionID: "ses_p", boundary: {} } }, "ses_a"), false)
  assert.equal(isRootSession({ id: "ses_other" }, "ses_a"), false)
  assert.equal(isRootSession(null, "ses_a"), false)
  assert.equal(isRootSession("ses_a", "ses_a"), false)
  assert.equal(isRootSession(undefined, "ses_a"), false)
})

test("the subscribed event types are the ones the delivery and the manager read", () => {
  for (const type of [
    "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled", "session.agent.selected",
    "session.deleted", "session.forked", "session.created",
  ]) assert.ok(EVENT_TYPES.includes(type), type)
  assert.ok(Object.isFrozen(EVENT_TYPES))
})

test("a root session is looked up once, joins by its own id, and its first event reaches the delivery", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  manager.feed(event("session.execution.succeeded", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a"])
  assert.deepEqual(parts.lifecycles.get("ses_a").started, [{ nativeSessionId: "ses_a" }])
  assert.deepEqual(parts.deliveries.get("ses_a").seeded, root("ses_a"))
  assert.deepEqual(parts.deliveries.get("ses_a").seen, ["session.execution.started", "session.execution.succeeded"])
  assert.equal(parts.lifecycles.get("ses_a").passedConfig, config)
})

test("a child session never joins and is not looked up again", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(id => ({ id, parentID: "ses_parent" }))
  const manager = createManager(ctx, config, parts)
  for (let index = 0; index < 5; index++) manager.feed(event("session.execution.started", "ses_child"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_child"])
  assert.equal(parts.deliveries.size, 0)
  assert.equal(parts.lifecycles.size, 0)
  assert.deepEqual(manager.sessions(), [])
})

test("a created event that names a parent is refused without a lookup", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.created", "ses_child", { parentID: "ses_parent" }))
  manager.feed(event("session.execution.started", "ses_child"))
  await flush()
  assert.deepEqual(ctx.lookups, [])
  assert.equal(parts.lifecycles.size, 0)
})

test("a fork never joins, and a fork event ends a session that was taken for a root", async () => {
  const forkParts = stubParts()
  const forkCtx = fakeCtx(id => ({ id, fork: { sessionID: "ses_source", boundary: {} } }))
  const forkManager = createManager(forkCtx, config, forkParts)
  forkManager.feed(event("session.execution.started", "ses_fork"))
  await flush()
  assert.equal(forkParts.lifecycles.size, 0)

  const parts = stubParts()
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_late"))
  await flush()
  assert.equal(parts.lifecycles.get("ses_late").stops, 0)
  manager.feed(event("session.forked", "ses_late", { parentID: "ses_source" }))
  await flush()
  assert.equal(parts.lifecycles.get("ses_late").stops, 1)
  assert.equal(parts.deliveries.get("ses_late").disposed, 1)
  manager.feed(event("session.execution.started", "ses_late"))
  await flush()
  assert.equal(parts.lifecycles.size, 1) // never rejoined
})

test("a lookup that fails is retried later, not on every event and not as a refusal for good", async () => {
  let clock = 1_000
  let answer = new Error("unavailable")
  const parts = stubParts()
  const ctx = fakeCtx(() => answer)
  const manager = createManager(ctx, config, parts, { now: () => clock })
  manager.feed(event("session.execution.started", "ses_a"))
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a"])
  assert.equal(parts.lifecycles.size, 0)
  clock += 61_000
  answer = root("ses_a")
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a", "ses_a"])
  assert.equal(parts.lifecycles.size, 1)
})

test("a state change publishes a heartbeat now, an unchanged one does not", async () => {
  const parts = stubParts({ observe: (_id, item) => item.type === "session.execution.started" })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.inbox.delivered", "ses_a", { inboxID: "msg_1" }))
  await flush()
  assert.equal(parts.lifecycles.get("ses_a").changed, 0)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(parts.lifecycles.get("ses_a").changed, 1)
})

test("one session's fault disables that session only", async () => {
  const parts = stubParts({ observe: (id, item) => { if (id === "ses_bad" && item.type === "session.execution.started") throw new Error("boom") ; return false } })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.inbox.delivered", "ses_good", {}))
  manager.feed(event("session.inbox.delivered", "ses_bad", {}))
  await flush()
  manager.feed(event("session.execution.started", "ses_bad"))
  manager.feed(event("session.execution.started", "ses_good"))
  await flush()
  assert.equal(parts.lifecycles.get("ses_bad").stops, 1)
  assert.equal(parts.deliveries.get("ses_bad").disposed, 1)
  assert.equal(parts.lifecycles.get("ses_good").stops, 0)
  assert.deepEqual(parts.deliveries.get("ses_good").seen, ["session.inbox.delivered", "session.execution.started"])
  assert.deepEqual(manager.sessions(), ["ses_good"])
  manager.feed(event("session.execution.started", "ses_bad"))
  await flush()
  assert.equal(parts.lifecycles.size, 2) // the faulted session does not rejoin in this process
})

test("a part that throws while it is built faults that session only", async () => {
  const parts = stubParts()
  const original = parts.createLifecycle
  parts.createLifecycle = (bus, delivery, ...rest) => {
    if (delivery.id === "ses_bad") throw new Error("broken part")
    return original(bus, delivery, ...rest)
  }
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_bad"))
  manager.feed(event("session.execution.started", "ses_good"))
  await flush()
  assert.deepEqual(manager.sessions(), ["ses_good"])
  assert.equal(parts.lifecycles.get("ses_good").started.length, 1)
})

test("a deleted session ends its chat and never rejoins", async () => {
  const parts = stubParts()
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.feed(event("session.deleted", "ses_a"))
  await flush()
  assert.equal(parts.lifecycles.get("ses_a").stops, 1)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(parts.lifecycles.size, 1)
  assert.deepEqual(manager.sessions(), [])
})

test("a lost event stream resets every session and publishes the unknown state", async () => {
  const parts = stubParts()
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  manager.feed(event("session.execution.started", "ses_b"))
  await flush()
  manager.reset()
  await flush()
  for (const id of ["ses_a", "ses_b"]) {
    assert.equal(parts.deliveries.get(id).resets, 1, id)
    assert.ok(parts.lifecycles.get(id).changed >= 1, id)
  }
})

test("a compaction that cannot restore the binding turns that session's chat off", async () => {
  const parts = stubParts({ verify: id => (id === "ses_bad" ? Promise.reject(Object.assign(new Error("x"), { code: "CHAT_CONTEXT_UNAVAILABLE" })) : Promise.resolve()) })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.compaction.ended", "ses_bad", { reason: "auto" }))
  manager.feed(event("session.compaction.ended", "ses_ok", { reason: "auto" }))
  await flush()
  assert.deepEqual(parts.lifecycles.get("ses_bad").disables, ["CHAT_CONTEXT_UNAVAILABLE"])
  assert.deepEqual(parts.lifecycles.get("ses_ok").disables, [])
})

test("events without a session id are ignored", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, parts)
  manager.feed({ type: "session.execution.started", data: {} })
  manager.feed({ type: "session.execution.started" })
  manager.feed(null)
  manager.feed({ type: "session.execution.started", data: { sessionID: "" } })
  await flush()
  assert.deepEqual(ctx.lookups, [])
})

test("stop ends every session and proves the end only when every worker ended cleanly", async () => {
  const clean = stubParts()
  const first = createManager(fakeCtx(root), config, clean)
  first.feed(event("session.execution.started", "ses_a"))
  first.feed(event("session.execution.started", "ses_b"))
  await flush()
  assert.equal(await first.stop(), true)
  for (const id of ["ses_a", "ses_b"]) {
    assert.equal(clean.lifecycles.get(id).stops, 1, id)
    assert.equal(clean.deliveries.get(id).disposed, 1, id)
  }
  first.feed(event("session.execution.started", "ses_c"))
  await flush()
  assert.equal(clean.lifecycles.size, 2) // a stopped manager takes no more events

  const killed = stubParts({ stopResult: { code: null, signal: "SIGKILL" } })
  const second = createManager(fakeCtx(root), config, killed)
  second.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(await second.stop(), false)
})

test("a stop that races a lookup in flight joins nothing", async () => {
  let release
  const parts = stubParts()
  const ctx = { session: { get: () => new Promise(resolve => { release = resolve }) } }
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  const stopped = manager.stop()
  release(root("ses_a"))
  assert.equal(await stopped, true)
  await flush()
  assert.equal(parts.lifecycles.size, 0)
})
