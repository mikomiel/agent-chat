import test from "node:test"
import assert from "node:assert/strict"
import { EVENT_TYPES, createManager, isRootSession } from "../lib/manager.js"
import { createDelivery } from "../lib/delivery.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { BINDING_KEY } from "../lib/channel.js"

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
        id, seeded: null, seen: [], resets: 0, disposed: 0, owed: false,
        seed(info) { delivery.seeded = info },
        observe(item) {
          delivery.seen.push(item.type)
          if (item.type === "session.compaction.ended") delivery.owed = true
          return observe(id, item)
        },
        reset() { delivery.resets += 1; delivery.owed = true },
        needsReadBack: () => delivery.owed, // owed after a gap and after an end, and asked for once per ask
        // The delivery contract: it never rejects, never turns chat off, and resolves true only when it proved the
        // binding. A check that did not prove it leaves the obligation owed.
        verifyContext() { delivery.owed = false; return verify(id).then(() => true, () => { delivery.owed = true; return false }) },
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

test("a compaction whose binding cannot be restored leaves that session closed, not disabled, and its next event asks again", async () => {
  const asked = []
  const parts = stubParts({ verify: id => { asked.push(id); return id === "ses_bad" ? Promise.reject(Object.assign(new Error("x"), { code: "CHAT_CONTEXT_UNAVAILABLE" })) : Promise.resolve() } })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.compaction.ended", "ses_bad", { reason: "auto" }))
  manager.feed(event("session.compaction.ended", "ses_ok", { reason: "auto" }))
  await flush()
  assert.deepEqual(parts.lifecycles.get("ses_bad").disables, []) // a failed check turns nothing off
  assert.deepEqual(parts.lifecycles.get("ses_ok").disables, [])
  manager.feed(event("session.execution.started", "ses_bad"))
  manager.feed(event("session.execution.started", "ses_ok"))
  await flush()
  assert.deepEqual(asked.sort(), ["ses_bad", "ses_bad", "ses_ok"]) // the failed one is asked again, the proved one is not
  assert.deepEqual(parts.lifecycles.get("ses_bad").disables, [])
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

// Review 6003128773, finding 3: fork evidence is recorded before any lookup, join or refusal check.
test("a session whose first event is a fork is never looked up and never joins, whatever its record shows", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root) // a lookup would show root-shaped metadata
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.forked", "ses_fork", { parentID: "ses_source" }))
  manager.feed(event("session.execution.started", "ses_fork"))
  await flush()
  assert.deepEqual(ctx.lookups, [])
  assert.equal(parts.lifecycles.size, 0)
  assert.deepEqual(manager.sessions(), [])
})

test("a fork event that arrives during a temporary lookup refusal is kept for good", async () => {
  let clock = 1_000
  let answer = new Error("unavailable")
  const parts = stubParts()
  const ctx = fakeCtx(() => answer)
  const manager = createManager(ctx, config, parts, { now: () => clock })
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a"]) // refused for 60 seconds
  manager.feed(event("session.forked", "ses_a", { parentID: "ses_source" }))
  clock += 61_000
  answer = root("ses_a")
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a"]) // not looked up again
  assert.equal(parts.lifecycles.size, 0)
})

test("a fork event stops a lookup that is still in flight before it can join", async () => {
  let release
  const parts = stubParts()
  const ctx = { session: { get: () => new Promise(resolve => { release = resolve }) } }
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.feed(event("session.forked", "ses_a", { parentID: "ses_source" }))
  release(root("ses_a"))
  await flush()
  assert.equal(parts.lifecycles.size, 0)
  assert.deepEqual(manager.sessions(), [])
})

// Review 6003305717, finding 1: fork evidence is permanent on every path.
test("a lookup that rejects after a fork event does not turn the permanent refusal into a cooldown", async () => {
  let clock = 1_000
  let fail
  const parts = stubParts()
  const lookups = []
  const ctx = { lookups, session: { get({ sessionID }) { lookups.push(sessionID); return new Promise((_resolve, reject) => { fail = reject }) } } }
  const manager = createManager(ctx, config, parts, { now: () => clock })
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.feed(event("session.forked", "ses_a", { parentID: "ses_source" }))
  fail(new Error("unavailable"))
  await flush()
  clock += 61_000 // past the 60 second cooldown that a rejected lookup would set
  ctx.session.get = async ({ sessionID }) => { lookups.push(sessionID); return root(sessionID) }
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"])
  assert.equal(parts.lifecycles.size, 0)
})

test("fork evidence survives the refusal cache evicting its oldest entries", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(id => (id === "ses_fork" ? root(id) : new Error("unavailable")))
  const manager = createManager(ctx, config, parts, { now: () => 1_000 })
  manager.feed(event("session.forked", "ses_fork", { parentID: "ses_source" }))
  // Each of these lookups fails and is refused for 60 seconds. More than the cache holds pushes out its oldest entry.
  for (let index = 0; index < 1_100; index++) manager.feed(event("session.execution.started", `ses_other_${index}`))
  await flush()
  manager.feed(event("session.execution.started", "ses_fork"))
  await flush()
  assert.equal(ctx.lookups.includes("ses_fork"), false)
  assert.equal(parts.lifecycles.has("ses_fork"), false)
})

test("fork evidence is kept in the set the manager is given, and a deleted session drops it", async () => {
  const forked = new Set()
  const manager = createManager(fakeCtx(root), config, stubParts(), { forked })
  manager.feed(event("session.forked", "ses_a", { parentID: "ses_source" }))
  assert.equal(forked.has("ses_a"), true)
  manager.feed(event("session.deleted", "ses_a"))
  await flush()
  assert.equal(forked.has("ses_a"), false) // the session has ended, so the set stays bounded by live forks
})

// Review 6003513413, finding 2: a deletion is a tombstone in its own set, like fork evidence, never in the refusal cache.
test("a deletion survives more refusals than the cache holds, and a later event triggers no lookup", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(id => (id === "ses_gone" ? root(id) : new Error("unavailable")))
  const manager = createManager(ctx, config, parts, { now: () => 1_000 })
  manager.feed(event("session.deleted", "ses_gone"))
  for (let index = 0; index < 1_100; index++) manager.feed(event("session.execution.started", `ses_other_${index}`))
  await flush()
  manager.feed(event("session.execution.started", "ses_gone"))
  await flush()
  assert.equal(ctx.lookups.includes("ses_gone"), false)
  assert.equal(parts.lifecycles.has("ses_gone"), false)
})

test("a deleted fork is tombstoned too, so a late event does not look it up", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root) // a lookup would show root-shaped metadata
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.forked", "ses_fork", { parentID: "ses_source" }))
  manager.feed(event("session.deleted", "ses_fork"))
  manager.feed(event("session.execution.started", "ses_fork"))
  await flush()
  assert.deepEqual(ctx.lookups, [])
  assert.equal(parts.lifecycles.size, 0)
})

test("deletion tombstones are kept in the set the manager is given", async () => {
  const deleted = new Set()
  const manager = createManager(fakeCtx(root), config, stubParts(), { deleted })
  manager.feed(event("session.deleted", "ses_a"))
  assert.equal(deleted.has("ses_a"), true)
})

// Review 6003513413, finding 3: a lookup has no worker and no binding, so a lookup that never answers holds nothing back.
test("a lookup that never answers does not hold back stop, which still ends the other sessions", async () => {
  const parts = stubParts()
  const ctx = { session: { get: ({ sessionID }) => (sessionID === "ses_stuck" ? new Promise(() => {}) : Promise.resolve(root(sessionID))) } }
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.execution.started", "ses_stuck"))
  manager.feed(event("session.execution.started", "ses_ok"))
  await flush()
  const outcome = await Promise.race([manager.stop(), new Promise(resolve => setTimeout(resolve, 300, "hung").unref())])
  assert.equal(outcome, true)
  assert.equal(parts.lifecycles.get("ses_ok").stops, 1)
  assert.equal(parts.lifecycles.has("ses_stuck"), false)
})

// Finding 2: a gap invalidates the binding proof, and the manager reads the binding back.
test("a stream gap reads the binding back for every live session, at its first event after the gap", async () => {
  const verified = []
  const parts = stubParts({ verify: id => { verified.push(id); return Promise.resolve() } })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  manager.feed(event("session.execution.started", "ses_b"))
  await flush()
  manager.reset()
  await flush()
  assert.deepEqual(verified, []) // the stream has not resumed yet, so a read-back now would end before the gap does
  manager.feed(event("session.agent.selected", "ses_a", { agent: "build" }))
  await flush()
  assert.deepEqual(verified, ["ses_a"]) // only the session that has heard from the new stream
  manager.feed(event("session.execution.started", "ses_b"))
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(verified.sort(), ["ses_a", "ses_b"]) // once per gap, not once per event
})

test("a read-back that fails after a gap does not turn chat off: each later event asks again until one proves", async () => {
  let asked = 0
  const parts = stubParts({ verify: () => (++asked <= 2 ? Promise.reject(Object.assign(new Error("x"), { code: "CHAT_CONTEXT_UNAVAILABLE" })) : Promise.resolve()) })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.reset()
  for (let event_ = 1; event_ <= 5; event_++) {
    manager.feed(event("session.execution.started", "ses_a"))
    await flush()
    assert.deepEqual(parts.lifecycles.get("ses_a").disables, [], `event ${event_}`)
  }
  assert.equal(asked, 3) // two failed asks, one that proved, then nothing is owed
})

// Review 6003407206, finding 2: a deletion is fenced when it is received, not queued behind the lookup.
test("a deletion that arrives during the lookup stops it before a worker starts or a join is sent", async () => {
  let release
  const lookups = []
  const parts = stubParts()
  const ctx = { session: { get: ({ sessionID }) => { lookups.push(sessionID); return new Promise(resolve => { release = resolve }) } } }
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.feed(event("session.deleted", "ses_a")) // received while `session.get` is still pending
  release(root("ses_a")) // the lookup resolves after the deletion, root-shaped
  await flush()
  assert.equal(parts.lifecycles.size, 0) // no lifecycle: no worker starts and no join is sent
  assert.equal(parts.deliveries.size, 0)
  assert.deepEqual(manager.sessions(), [])
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"]) // the deleted session is not looked up again
  assert.equal(parts.lifecycles.size, 0)
})

test("a deletion for a session that was never seen is refused without a lookup", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.deleted", "ses_a"))
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, [])
  assert.equal(parts.lifecycles.size, 0)
  assert.deepEqual(manager.sessions(), [])
})

// Review 6003407206, finding 1: a compaction already observed running is not ended by the gap that follows it, and
// the binding is read back only once its own terminal event has arrived.
async function compactionAcrossGap() {
  const entries = new Map()
  const synthetic = []
  const lists = { count: 0 }
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      synthetic(input) { synthetic.push(input); return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() { lists.count += 1; return [...entries].map(([key, value]) => ({ key, value })) },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  let delivery = null
  const parts = stubParts()
  parts.createDelivery = (hostCtx, id) => {
    delivery = createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} })
    return delivery
  }
  const manager = createManager(ctx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  await delivery.context("binding text")
  send("session.compaction.started", { reason: "auto" })
  await flush()
  manager.reset() // the stream gaps while the compaction runs
  await flush()
  const before = lists.count
  send("session.agent.selected", { agent: "build" }) // the stream resumes
  send("session.inbox.enqueued", { item: { type: "user" } })
  send("session.execution.started")
  await flush()
  const batch = { content: "peer notice", attemptId: "11111111-1111-4111-8111-111111111111" }
  let refusal = null
  void delivery.deliver(batch, 5_000).then(result => { refusal = result })
  await flush()
  return { send, delivery, entries, synthetic, batch, refusal: () => refusal, listsSince: () => lists.count - before }
}

test("a compaction that spans a gap is read back only after its own end, and then reopens the gate", async () => {
  const run = await compactionAcrossGap()
  assert.deepEqual(run.refusal(), { outcome: "deferred", reason: "busy" }) // no compaction end has been seen
  assert.equal(run.synthetic.length, 0)
  assert.equal(run.listsSince(), 0) // no read-back while the compaction is still running
  run.send("session.compaction.ended", { reason: "auto" })
  await flush()
  assert.equal(run.listsSince(), 1) // one read-back, after the end
  assert.equal(run.entries.size, 1)
  assert.equal(run.delivery.state(), null)
  const sent = run.delivery.deliver(run.batch, 5_000)
  await flush()
  assert.equal(run.synthetic.length, 1)
  void sent
})

test("a compaction that spans a gap and then fails is read back after the failure, not before", async () => {
  const run = await compactionAcrossGap()
  assert.equal(run.listsSince(), 0)
  run.send("session.compaction.failed", { reason: "auto" })
  await flush()
  assert.equal(run.listsSince(), 1) // the gap's read-back was owed, and it runs now
  assert.equal(run.delivery.state(), null)
  assert.equal(run.synthetic.length, 0)
})

// Review 6003513413, finding 1: an owed read-back that was queued before a compaction began must not read during it.
test("an owed read-back queued behind an earlier operation does not read or disable chat once a compaction begins", async () => {
  const entries = new Map()
  let lists = 0
  let heldCall = 0
  let releaseList = null
  let failFrom = Infinity
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      synthetic() { return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() {
            const call = ++lists
            if (call === heldCall) await new Promise(resolve => { releaseList = resolve })
            if (call >= failFrom) throw new Error("unavailable")
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  let delivery = null
  const parts = stubParts()
  parts.createDelivery = (hostCtx, id) => {
    // The stub lifecycle is keyed by the delivery's id.
    delivery = Object.assign(createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }), { id })
    return delivery
  }
  const manager = createManager(ctx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  await delivery.context("binding text")
  heldCall = lists + 1
  const earlier = delivery.context("binding text") // its own check is held, so later context operations queue behind it
  await flush()
  assert.equal(typeof releaseList, "function")
  manager.reset()
  await flush()
  send("session.agent.selected", { agent: "build" }) // the first event after the gap: a read-back is owed and queued
  send("session.inbox.enqueued", { item: { type: "user" } })
  send("session.execution.started")
  await flush()
  send("session.compaction.started", { reason: "auto" }) // begins before the queued read can
  await flush()
  const before = lists
  failFrom = lists + 1 // a read from here on would be rejected
  releaseList()
  await earlier
  await flush()
  assert.equal(lists, before) // no entry.list during the compaction
  assert.deepEqual(parts.lifecycles.get("ses_a").disables, []) // and chat is still on
  failFrom = Infinity
  send("session.compaction.ended", { reason: "auto" })
  await flush()
  assert.equal(lists, before + 1) // the owed read-back runs after the end
  assert.deepEqual(parts.lifecycles.get("ses_a").disables, [])
  assert.equal(delivery.state(), null)
})

// Review 6003597565, finding 2: a check superseded by a newer gap does no I/O, and its failure does not turn chat off.
test("a read-back queued before a newer gap does not disable chat, and the newest gap schedules its own", async () => {
  const entries = new Map()
  let lists = 0
  let heldCall = 0
  let releaseList = null
  let failFrom = Infinity
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      synthetic() { return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() {
            const call = ++lists
            if (call === heldCall) await new Promise(resolve => { releaseList = resolve })
            if (call >= failFrom) throw new Error("unavailable")
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  let delivery = null
  const parts = stubParts()
  parts.createDelivery = (hostCtx, id) => {
    delivery = Object.assign(createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }), { id })
    return delivery
  }
  const manager = createManager(ctx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  await delivery.context("binding text")
  heldCall = lists + 1
  const earlier = delivery.context("binding text") // its own check is held, so later context operations queue behind it
  await flush()
  manager.reset()
  await flush()
  send("session.agent.selected", { agent: "build" }) // the first event after the first gap: a check is queued
  await flush()
  manager.reset() // a newer gap supersedes that check
  await flush()
  const before = lists
  failFrom = lists + 1 // a read from here on would be rejected
  releaseList()
  await earlier
  await flush()
  assert.equal(lists, before) // the superseded check read nothing
  assert.deepEqual(parts.lifecycles.get("ses_a").disables, []) // and chat is still on
  failFrom = Infinity
  send("session.agent.selected", { agent: "build" }) // the first event after the newest gap schedules its own check
  send("session.inbox.enqueued", { item: { type: "user" } })
  send("session.execution.started")
  await flush()
  assert.equal(lists, before + 1)
  assert.deepEqual(parts.lifecycles.get("ses_a").disables, [])
  assert.equal(delivery.state(), null)
})

test("a compaction whose end is lost in a gap cannot reach synthetic before the binding is read back", async () => {
  const entries = new Map()
  const synthetic = []
  let hold = false
  let releaseList = null
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      synthetic(input) { synthetic.push(input); return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() {
            if (hold) await new Promise(resolve => { releaseList = resolve })
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  let delivery = null
  const parts = stubParts()
  parts.createDelivery = (hostCtx, id) => {
    delivery = createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} })
    return delivery
  }
  const manager = createManager(ctx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  await delivery.context("binding text")
  assert.equal(entries.size, 1)
  entries.clear() // a compaction dropped the entry, and the event that ends it falls into the gap
  hold = true // the read-back stays in flight until the test lets it finish
  manager.reset()
  await flush()
  send("session.agent.selected", { agent: "build" })
  send("session.inbox.enqueued", { item: { type: "user" } })
  send("session.execution.started")
  await flush()
  const batch = { content: "peer notice", attemptId: "11111111-1111-4111-8111-111111111111" }
  let refusal = null
  void delivery.deliver(batch, 5_000).then(result => { refusal = result })
  await flush()
  assert.deepEqual(refusal, { outcome: "deferred", reason: "busy" })
  assert.equal(synthetic.length, 0)
  hold = false
  releaseList()
  await flush()
  assert.equal(entries.size, 1) // the entry is back
  assert.equal(delivery.state(), null)
  const sent = delivery.deliver(batch, 5_000)
  await flush()
  assert.equal(synthetic.length, 1)
  void sent
})

// Review 6003650164, findings 1 and 2: a read-back is acted on only while it is still current, and the decision to
// disable chat is made in the same step as the check that it is.
// A host double whose next `list` waits until the test settles it.
function holdableCtx() {
  const entries = new Map()
  const puts = []
  const held = { next: false, entered: false, settle: null }
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      synthetic() { return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          async put({ key, value }) { puts.push(value); entries.set(key, value) },
          async list() {
            if (held.next) {
              held.next = false
              held.entered = true
              await new Promise((resolve, reject) => { held.settle = { resolve, reject } })
            }
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  return { ctx, entries, puts, held }
}

const tickAfter = async count => { for (let tick = 0; tick < count; tick++) await Promise.resolve() }

// A real manager, delivery and lifecycle around a worker double. The first heartbeat after the join waits for the test.
async function staleInstanceRun(answer) {
  const rig = holdableCtx()
  const notices = []
  let delivery = null
  let lifecycle = null
  let retry = null
  let starts = 0
  const heartbeat = { reject: null }
  const joinedFor = number => ({
    session_id: "11111111-1111-4111-8111-111111111111", instance_id: `2222222${number}-2222-4222-8222-222222222222`,
    room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "opencode",
    instance_file: `/tmp/agent-chat-state/boot-${number}.json`,
  })
  const workerFor = number => ({
    ready: Promise.resolve(joinedFor(number)),
    closed: new Promise(() => {}),
    request: operation => (operation === "heartbeat" && heartbeat.reject === "armed"
      ? new Promise((_resolve, reject) => { heartbeat.reject = reject })
      : Promise.resolve({})),
    stop: async () => ({ code: 0, signal: null }),
  })
  const parts = {
    createDelivery: (hostCtx, id) => {
      delivery = createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} })
      return delivery
    },
    createLifecycle: (bus, ownDelivery, passedConfig, options) => {
      lifecycle = createLifecycle(bus, ownDelivery, passedConfig, {
        ...options,
        now: () => 1_000,
        random: () => 0,
        setTimeoutImpl: fn => { retry = fn; return 1 },
        clearTimeoutImpl: () => {},
        setIntervalImpl: () => 0,
        clearIntervalImpl: () => {},
      })
      return lifecycle
    },
    startProcess: () => workerFor(++starts),
  }
  const manager = createManager(rig.ctx, config, parts, { notice: text => notices.push(text) })
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  assert.match(rig.entries.get(BINDING_KEY), /boot-1\.json/) // the first binding is confirmed
  rig.entries.clear() // a compaction dropped the entry
  rig.held.next = true
  heartbeat.reject = "armed" // the next heartbeat is the one that answers STALE_INSTANCE
  manager.reset() // a gap: the state change drives a heartbeat, which waits
  await flush()
  send("session.agent.selected", { agent: "build" }) // the first event after the gap: the read-back's list is held
  send("session.inbox.enqueued", { item: { type: "user" } })
  send("session.execution.started")
  await flush()
  assert.equal(rig.held.entered, true)
  const firstPuts = rig.puts.length
  heartbeat.reject(Object.assign(new Error("STALE_INSTANCE"), { code: "STALE_INSTANCE", operation: "heartbeat" }))
  await flush() // the lifecycle withdrew the binding and scheduled its rejoin; the read-back's list is still pending
  assert.equal(typeof retry, "function")
  if (answer === "resolve") rig.held.settle.resolve()
  else rig.held.settle.reject(new Error("unavailable"))
  await flush()
  return { rig, notices, send, firstPuts, retry: () => retry(), lifecycle: () => lifecycle, delivery: () => delivery, starts: () => starts }
}

for (const answer of ["resolve", "reject"]) {
  test(`STALE_INSTANCE while the read-back's list is pending (${answer}): the withdrawn binding is not put back, chat stays on, and the rejoin goes on`, async () => {
    const run = await staleInstanceRun(answer)
    assert.equal(run.rig.puts.length, run.firstPuts) // no put of the withdrawn text
    assert.equal(run.rig.entries.has(BINDING_KEY), false)
    assert.notEqual(run.lifecycle().state(), "offline") // chat is not disabled
    assert.equal(run.notices.some(text => /stopped/.test(text)), false)
    run.retry() // the backoff ends: the rejoin
    await flush()
    await flush()
    assert.equal(run.starts(), 2)
    assert.match(run.rig.entries.get(BINDING_KEY), /boot-2\.json/) // the new binding is published
    assert.notEqual(run.lifecycle().state(), "offline")
    // The old check proved nothing, so the obligation is still owed: the next event reads the new binding back.
    run.send("session.execution.started")
    await flush()
    assert.equal(run.delivery().needsReadBack(), false)
    assert.equal(run.delivery().state(), null)
  })
}

// A real delivery behind a manager, with a read-back whose first list is held. `order` records the host calls and the
// decisions that follow a signal: "put", "disable", and the "signal" the test sends.
async function pendingCheck() {
  const rig = holdableCtx()
  const order = []
  const put = rig.ctx.session.instructions.entry.put
  rig.ctx.session.instructions.entry.put = async input => { order.push("put"); return put(input) }
  let delivery = null
  const parts = stubParts()
  parts.createDelivery = (hostCtx, id) => {
    delivery = Object.assign(createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }), { id })
    return delivery
  }
  const manager = createManager(rig.ctx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  await delivery.context("binding text")
  const lifecycle = parts.lifecycles.get("ses_a")
  const disable = lifecycle.disable
  lifecycle.disable = reason => { order.push("disable"); return disable(reason) }
  order.length = 0
  rig.entries.clear() // a compaction dropped the entry
  rig.held.next = true
  manager.reset()
  await flush()
  send("session.agent.selected", { agent: "build" }) // the first event after the gap: the read-back starts and its list is held
  send("session.inbox.enqueued", { item: { type: "user" } })
  send("session.execution.started")
  await flush()
  assert.equal(rig.held.entered, true)
  const resume = () => {
    send("session.agent.selected", { agent: "build" })
    send("session.inbox.enqueued", { item: { type: "user" } })
    send("session.execution.started")
  }
  const signals = {
    reset: () => { order.push("signal"); manager.reset() },
    compaction: () => { order.push("signal"); send("session.compaction.started", { reason: "auto" }) },
  }
  const answer = how => (how === "resolve" ? rig.held.settle.resolve() : rig.held.settle.reject(new Error("unavailable")))
  return { rig, order, send, resume, signals, answer, delivery, lifecycle, parts, manager }
}

// A publish confirmed in a gap does not discharge the gap's obligation: a compaction that ends in the rest of the gap
// drops the entry after it, and the first event after the gap must still read it back.
test("a publish confirmed before the first event after a gap does not skip that event's read-back", async () => {
  const rig = holdableCtx()
  let delivery = null
  const parts = stubParts()
  parts.createDelivery = (hostCtx, id) => {
    delivery = Object.assign(createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }), { id })
    return delivery
  }
  const manager = createManager(rig.ctx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  await delivery.context("binding text")
  manager.reset()
  await flush()
  await delivery.context("binding text") // a rejoin's publish, confirmed inside the gap
  rig.entries.clear() // and a compaction that ended in the rest of the gap dropped the entry
  const puts = rig.puts.length
  send("session.agent.selected", { agent: "build" }) // the first event after the gap
  await flush()
  assert.equal(rig.puts.length, puts + 1) // its read-back found the entry gone and put it back
  assert.match(rig.entries.get(BINDING_KEY), /binding text/)
})

// Round 8: a read-back never disables chat. A failed one is asked for again at the next event.
test("a transient list rejection leaves the gate closed and chat on, and the next event's check proves and reopens", async () => {
  const run = await pendingCheck()
  run.answer("reject")
  await flush()
  assert.deepEqual(run.lifecycle.disables, []) // chat is still on
  assert.equal(run.delivery.state(), "busy") // and the gate is closed
  assert.equal(run.delivery.needsReadBack(), true) // owed: the next event asks again
  run.send("session.execution.started") // the next event
  await flush()
  assert.equal(run.delivery.state(), null)
  assert.match(run.rig.entries.get(BINDING_KEY), /binding text/) // the entry is back
  assert.deepEqual(run.lifecycle.disables, [])
})

// A check that is in flight when a signal is received can still put the entry back before the signal is applied: that
// put is at the wrong time and harmless, because the applied signal owes the read-back again and the next check proves.
// The sweep completes the held list after 0..10 microtask ticks, so it reaches both sides of the signal's turn.
for (const signal of ["reset", "compaction"]) {
  test(`a ${signal} received while a check's host call is pending: a put at the wrong time is harmless, chat is never disabled, and the next event's check proves`, async () => {
    const problems = []
    const wrongTime = new Set()
    for (const how of ["resolve", "reject"]) {
      for (let offset = 0; offset <= 10; offset++) {
        const label = `${how}@${offset}`
        const run = await pendingCheck()
        run.answer(how)
        await tickAfter(offset)
        run.signals[signal]()
        await flush()
        if (run.order.join(">").includes("signal>put")) wrongTime.add(label) // the put came after the signal was received
        if (signal === "reset") run.resume()
        else run.send("session.compaction.ended", { reason: "auto" })
        await flush()
        if (run.lifecycle.disables.length) problems.push(`${label}: chat disabled`)
        if (!/binding text/.test(run.rig.entries.get(BINDING_KEY) ?? "")) problems.push(`${label}: no entry`)
        if (run.delivery.state() !== null) problems.push(`${label}: gate ${run.delivery.state()}`)
      }
    }
    assert.deepEqual(problems, [])
    // Positive control: the sweep does reach a put after the signal was received, or an empty result would prove nothing.
    assert.equal(wrongTime.size > 0, true)
  })
}
