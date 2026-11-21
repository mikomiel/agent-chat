import test from "node:test"
import assert from "node:assert/strict"
import { EVENT_TYPES, createManager, isRootSession } from "../lib/manager.js"
import { createContext, CALL_TIMEOUT_MS } from "../lib/context.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { BINDING_KEY } from "../lib/channel.js"

const config = { chatEnabled: true, directory: "/tmp/state", serverOrigin: "https://chat.example", hostToken: "synthetic-token", python: "/usr/bin/python3" }
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }
const event = (type, sessionID, data = {}) => ({ id: `${type}-${sessionID}-${Math.random()}`, type, data: { sessionID, ...data } })

// Doubles of the two parts the manager builds per session. They record what the manager does to them.
function stubParts({ onObserve = () => {}, verify = () => Promise.resolve(), stopResult = { code: 0, signal: null } } = {}) {
  const contexts = new Map()
  const lifecycles = new Map()
  return {
    contexts,
    lifecycles,
    createContext(_ctx, id) {
      const context = {
        id, seen: [], resets: 0, disposed: 0, owed: false,
        observe(item) {
          context.seen.push(item.type)
          if (item.type.startsWith("session.compaction.")) context.owed = true
          onObserve(id, item)
        },
        reset() { context.resets += 1; context.owed = true },
        // The context contract: a repair never rejects and turns nothing off, and it resolves true only when it proved the
        // binding. A check that did not prove it leaves the obligation owed.
        repair() {
          if (!context.owed) return Promise.resolve(false)
          context.owed = false
          return verify(id).then(() => true, () => { context.owed = true; return false })
        },
        dispose() { context.disposed += 1 },
      }
      contexts.set(id, context)
      return context
    },
    createLifecycle(bus, context, passedConfig, options) {
      const lifecycle = { context, passedConfig, options, started: [], stops: 0 }
      bus.on("session_start", payload => lifecycle.started.push(payload))
      lifecycle.stop = () => { lifecycle.stops += 1; return Promise.resolve(stopResult) }
      lifecycles.set(context.id, lifecycle)
      return lifecycle
    },
    startProcess: () => { throw new Error("not started by the manager") },
  }
}

// The real binding context in place of the stub, keyed by session id so that a test can publish the binding as the
// lifecycle would. Its host calls get timers that never fire, so no test waits for the clock.
const quiet = { setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} }
function withRealContext(parts) {
  const real = new Map()
  parts.createContext = (hostCtx, id, options) => {
    const context = Object.assign(createContext(hostCtx, id, { ...quiet, ...options }), { id })
    real.set(id, context)
    return context
  }
  return real
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

test("the subscribed event types are the seven the manager and the binding context read", () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [
    "session.compaction.ended", "session.compaction.failed", "session.compaction.started",
    "session.created", "session.deleted", "session.execution.started", "session.forked",
  ])
  // Nothing about what a session is doing is read, so no event that only reports it is subscribed.
  for (const type of [
    "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled", "session.agent.selected",
  ]) assert.equal(EVENT_TYPES.includes(type), false, type)
  assert.ok(Object.isFrozen(EVENT_TYPES))
})

test("a root session is looked up once, joins by its own id, and its events reach its binding context", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, parts)
  manager.feed(event("session.created", "ses_a"))
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a"])
  assert.deepEqual(parts.lifecycles.get("ses_a").started, [{ nativeSessionId: "ses_a" }])
  assert.deepEqual(parts.contexts.get("ses_a").seen, ["session.created", "session.execution.started"])
  assert.equal(parts.lifecycles.get("ses_a").context, parts.contexts.get("ses_a"))
  assert.equal(parts.lifecycles.get("ses_a").passedConfig, config)
})

test("a child session never joins and is not looked up again", async () => {
  const parts = stubParts()
  const ctx = fakeCtx(id => ({ id, parentID: "ses_parent" }))
  const manager = createManager(ctx, config, parts)
  for (let index = 0; index < 5; index++) manager.feed(event("session.execution.started", "ses_child"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_child"])
  assert.equal(parts.contexts.size, 0)
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

// Review 6005761762, finding 2: a created event that names a parent is fenced when it is received, whenever it arrives.
test("a created event that names a parent, received while the lookup is pending, stops it before a worker starts", async () => {
  let release
  const lookups = []
  const forked = new Set()
  const parts = stubParts()
  const ctx = { session: { get: ({ sessionID }) => { lookups.push(sessionID); return new Promise(resolve => { release = resolve }) } } }
  const manager = createManager(ctx, config, parts, { forked })
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.feed(event("session.created", "ses_a", { parentID: "ses_parent" })) // received while `session.get` is pending
  release(root("ses_a")) // the lookup then answers root-shaped
  await flush()
  assert.equal(parts.lifecycles.size, 0) // no worker starts and no join is sent
  assert.equal(parts.contexts.size, 0)
  assert.deepEqual(manager.sessions(), [])
  assert.equal(forked.has("ses_a"), true) // fork evidence, kept for good and shared with the next owner
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"]) // never looked up again
})

test("a created event that names a parent, received after the join, ends that session's chat for good", async () => {
  const forked = new Set()
  const parts = stubParts()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, parts, { forked })
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(manager.sessions(), ["ses_a"])
  manager.feed(event("session.created", "ses_a", { parentID: null })) // no parent: nothing changes
  await flush()
  assert.deepEqual(manager.sessions(), ["ses_a"])
  manager.feed(event("session.created", "ses_a", { parentID: "ses_parent" }))
  await flush()
  assert.deepEqual(manager.sessions(), [])
  assert.equal(parts.lifecycles.get("ses_a").stops, 1) // its worker and binding are ended
  assert.equal(parts.contexts.get("ses_a").disposed, 1)
  assert.equal(forked.has("ses_a"), true)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, ["ses_a"]) // it does not rejoin
  assert.equal(parts.lifecycles.size, 1)
})

test("a created event that names a parent after the deletion adds no fork record", async () => {
  const forked = new Set()
  const manager = createManager(fakeCtx(root), config, stubParts(), { forked })
  manager.feed(event("session.deleted", "ses_a"))
  manager.feed(event("session.created", "ses_a", { parentID: "ses_parent" })) // late: the tombstone already refuses the id
  assert.equal(forked.has("ses_a"), false)
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
  assert.equal(parts.contexts.get("ses_late").disposed, 1)
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

// Review 6005292356, finding 3: a lookup that never settles must not hold its session's later events for ever.
test("a lookup that never settles times out into the cooldown, a later event looks up again, and the late answer starts nothing", async () => {
  let clock = 1_000
  const limits = [] // injected timers: the test fires the lookup's time limit by hand, and no test waits for the clock
  const answers = []
  const parts = stubParts()
  const ctx = { session: { get: ({ sessionID }) => new Promise(resolve => { answers.push({ sessionID, resolve }) }) } }
  const manager = createManager(ctx, config, parts, {
    now: () => clock,
    setTimeoutImpl(fn, ms) { const timer = { fn, ms, cleared: false }; limits.push(timer); return timer },
    clearTimeoutImpl(timer) { timer.cleared = true },
  })
  manager.feed(event("session.execution.started", "ses_a"))
  manager.feed(event("session.execution.started", "ses_a")) // queued behind the lookup on the session's chain
  await flush()
  assert.equal(answers.length, 1)
  assert.deepEqual(limits.map(timer => timer.ms), [CALL_TIMEOUT_MS]) // the lookup has the same limit as a host call
  limits[0].fn()
  await flush()
  assert.deepEqual(manager.sessions(), []) // a failed lookup: the record is gone
  clock += 30_000
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(answers.length, 1) // inside the cooldown: not looked up again
  clock += 31_000 // past the 60 second cooldown
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(answers.length, 2) // a fresh lookup, which the stuck one no longer blocks
  answers[0].resolve(root("ses_a")) // the original lookup answers late, root-shaped
  await flush()
  assert.equal(parts.lifecycles.size, 0) // and starts no worker
  assert.deepEqual(manager.sessions(), ["ses_a"]) // only the fresh record exists
  answers[1].resolve(root("ses_a"))
  await flush()
  assert.equal(parts.lifecycles.size, 1) // the fresh lookup joins once
  assert.equal(parts.lifecycles.get("ses_a").started.length, 1)
  assert.equal(limits[1].cleared, true) // an answer in time clears its own timer
})

test("one session's fault disables that session only", async () => {
  const parts = stubParts({ onObserve: (id, item) => { if (id === "ses_bad" && item.type === "session.execution.started") throw new Error("boom") } })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.created", "ses_good", {}))
  manager.feed(event("session.created", "ses_bad", {}))
  await flush()
  manager.feed(event("session.execution.started", "ses_bad"))
  manager.feed(event("session.execution.started", "ses_good"))
  await flush()
  assert.equal(parts.lifecycles.get("ses_bad").stops, 1)
  assert.equal(parts.contexts.get("ses_bad").disposed, 1)
  assert.equal(parts.lifecycles.get("ses_good").stops, 0)
  assert.deepEqual(parts.contexts.get("ses_good").seen, ["session.created", "session.execution.started"])
  assert.deepEqual(manager.sessions(), ["ses_good"])
  manager.feed(event("session.execution.started", "ses_bad"))
  await flush()
  assert.equal(parts.lifecycles.size, 2) // the faulted session does not rejoin in this process
})

test("a part that throws while it is built faults that session only", async () => {
  const parts = stubParts()
  const original = parts.createLifecycle
  parts.createLifecycle = (bus, context, ...rest) => {
    if (context.id === "ses_bad") throw new Error("broken part")
    return original(bus, context, ...rest)
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

test("a lost event stream resets the binding context of every session", async () => {
  const parts = stubParts()
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  manager.feed(event("session.execution.started", "ses_b"))
  await flush()
  manager.reset()
  await flush()
  for (const id of ["ses_a", "ses_b"]) assert.equal(parts.contexts.get(id).resets, 1, id)
})

test("a compaction whose binding cannot be restored does not end that session, and its next event asks again", async () => {
  const asked = []
  const parts = stubParts({ verify: id => { asked.push(id); return id === "ses_bad" ? Promise.reject(Object.assign(new Error("x"), { code: "CHAT_CONTEXT_UNAVAILABLE" })) : Promise.resolve() } })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.compaction.ended", "ses_bad", { reason: "auto" }))
  manager.feed(event("session.compaction.ended", "ses_ok", { reason: "auto" }))
  await flush()
  assert.deepEqual(manager.sessions().sort(), ["ses_bad", "ses_ok"]) // a failed check turns nothing off
  manager.feed(event("session.execution.started", "ses_bad"))
  manager.feed(event("session.execution.started", "ses_ok"))
  await flush()
  assert.deepEqual(asked.sort(), ["ses_bad", "ses_bad", "ses_ok"]) // the failed one is asked again, the proved one is not
  assert.equal(parts.lifecycles.get("ses_bad").stops, 0)
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
    assert.equal(clean.contexts.get(id).disposed, 1, id)
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

// A deleted session is tombstoned, so a fork event that arrives after the deletion has nothing left to say: it must not
// put a fork record back that no later event would ever remove.
test("a late fork event for a deleted session leaves no fork record behind", async () => {
  const forked = new Set()
  const deleted = new Set()
  const ctx = fakeCtx(root)
  const manager = createManager(ctx, config, stubParts(), { forked, deleted })
  manager.feed(event("session.deleted", "ses_a"))
  manager.feed(event("session.forked", "ses_a", { parentID: "ses_source" }))
  await flush()
  assert.equal(deleted.has("ses_a"), true)
  assert.equal(forked.has("ses_a"), false)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(ctx.lookups, []) // the tombstone still refuses the session
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

// A gap invalidates the binding proof, and the manager asks for the read-back at the first event after it.
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
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(verified, ["ses_a"]) // only the session that has heard from the new stream
  manager.feed(event("session.execution.started", "ses_b"))
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(verified.sort(), ["ses_a", "ses_b"]) // once per gap, not once per event
})

test("a read-back that fails after a gap is asked again at each later event until one proves", async () => {
  let asked = 0
  const parts = stubParts({ verify: () => (++asked <= 2 ? Promise.reject(Object.assign(new Error("x"), { code: "CHAT_CONTEXT_UNAVAILABLE" })) : Promise.resolve()) })
  const manager = createManager(fakeCtx(root), config, parts)
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  manager.reset()
  for (let event_ = 1; event_ <= 5; event_++) {
    manager.feed(event("session.execution.started", "ses_a"))
    await flush()
    assert.deepEqual(manager.sessions(), ["ses_a"], `event ${event_}`) // the session is never ended
  }
  assert.equal(asked, 3) // two failed asks, one that proved, then nothing is owed
  assert.equal(parts.lifecycles.get("ses_a").stops, 0)
})

// Review 6005506743, finding 1: the host has no replay and no cursor, so a deletion can be lost with no gap marker. The
// heartbeat tick reads each joined session's entry, and a session the host no longer has fails that read.
test("a heartbeat tick that finds its session gone ends that session's chat, and no other answer does", async () => {
  const how = new Map() // what the entry read does for a session now: "ok" (the default), "missing", "error" or "silent"
  const entries = new Map()
  const intervals = new Map()
  const workers = new Map()
  const deleted = new Set()
  const lookups = []
  const missing = sessionID => Object.assign(new Error("not found"), { _tag: "Session.NotFoundError", sessionID })
  const ctx = {
    session: {
      get: async ({ sessionID }) => { lookups.push(sessionID); return root(sessionID) },
      instructions: {
        entry: {
          async put({ sessionID, key, value }) { entries.set(`${sessionID}/${key}`, value) },
          list({ sessionID }) {
            const answer = how.get(sessionID) ?? "ok"
            if (answer === "missing") return Promise.reject(missing(sessionID))
            if (answer === "wrong-session") return Promise.reject(missing("ses_other")) // another session's answer
            if (answer === "error") return Promise.reject(new Error("unavailable"))
            if (answer === "silent") return new Promise(() => {})
            return Promise.resolve([...entries].filter(([name]) => name.startsWith(`${sessionID}/`))
              .map(([name, value]) => ({ key: name.slice(sessionID.length + 1), value })))
          },
          async remove({ sessionID, key }) { entries.delete(`${sessionID}/${key}`) },
        },
      },
    },
  }
  const parts = stubParts()
  withRealContext(parts)
  parts.createLifecycle = (bus, context, passedConfig, options) => createLifecycle(bus, context, passedConfig, {
    ...options,
    now: () => 1_000,
    random: () => 0,
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    setIntervalImpl: fn => { const timer = { fn, cleared: false }; intervals.set(context.id, timer); return timer },
    clearIntervalImpl: timer => { if (timer) timer.cleared = true },
  })
  parts.startProcess = (_config, { nativeSessionId }) => {
    let close
    const closed = new Promise(resolve => { close = resolve })
    const worker = {
      stopped: false,
      ready: Promise.resolve({
        session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
        room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "opencode",
        instance_file: `/tmp/agent-chat-state/${nativeSessionId}.json`,
      }),
      closed,
      request: () => Promise.resolve({}),
      stop: () => { worker.stopped = true; close({ code: 0, signal: null }); return closed },
    }
    workers.set(nativeSessionId, worker)
    return worker
  }
  const manager = createManager(ctx, config, parts, { deleted })
  const ids = ["ses_gone", "ses_ok", "ses_error", "ses_silent", "ses_wrong"]
  for (const id of ids) manager.feed(event("session.execution.started", id))
  await flush()
  assert.deepEqual(manager.sessions().sort(), [...ids].sort()) // all joined, each with a heartbeat timer and a binding entry
  for (const id of ids) {
    assert.equal(intervals.get(id).cleared, false, id)
    assert.equal(entries.has(`${id}/${BINDING_KEY}`), true, id)
  }
  for (const id of ids) intervals.get(id).fn() // a tick while every session exists changes nothing
  await flush()
  assert.deepEqual(manager.sessions().sort(), [...ids].sort())
  assert.deepEqual([...deleted], [])
  // No event for any of them: the deletion, and every other answer, reach the manager through the tick alone.
  how.set("ses_gone", "missing")
  how.set("ses_error", "error")
  how.set("ses_silent", "silent")
  how.set("ses_wrong", "wrong-session")
  const asked = lookups.length
  for (const id of ids) intervals.get(id).fn() // one tick
  await flush()
  assert.deepEqual(manager.sessions().sort(), ["ses_error", "ses_ok", "ses_silent", "ses_wrong"]) // only the one that is gone
  assert.deepEqual([...deleted], ["ses_gone"]) // through the deletion path: tombstoned
  assert.equal(intervals.get("ses_gone").cleared, true) // its heartbeats end
  assert.equal(workers.get("ses_gone").stopped, true)
  assert.equal(entries.has(`ses_gone/${BINDING_KEY}`), false) // and its binding is withdrawn
  for (const id of ["ses_ok", "ses_error", "ses_silent", "ses_wrong"]) {
    assert.equal(intervals.get(id).cleared, false, id) // the others keep running
    assert.equal(workers.get(id).stopped, false, id)
    assert.equal(entries.has(`${id}/${BINDING_KEY}`), true, id)
  }
  assert.equal(lookups.length, asked) // the tick asked the host nothing new, and a deleted session is not looked up again
  manager.feed(event("session.execution.started", "ses_gone"))
  await flush()
  assert.equal(lookups.length, asked)
  assert.equal(workers.get("ses_gone").stopped, true)
})

// Review 6005761762, finding 1: a deletion during a rejoin backoff, with no event seen. The retry asks the host once,
// bounded, before it starts a replacement worker. The session's own not-found takes the deletion path and starts no worker.
// One joined session on the real context and lifecycle, with the heartbeat tick and the retry timer in the test's hands.
async function backoffRig() {
  const entries = new Map()
  const deleted = new Set()
  const forked = new Set()
  const callTimers = []
  const workers = []
  const rig = { entries, deleted, forked, workers, gone: false, next: null, retry: null, tick: null, answerList: null }
  const missing = Object.assign(new Error("not found"), { _tag: "Session.NotFoundError", sessionID: "ses_a" })
  const stale = Object.assign(new Error("STALE_INSTANCE"), { code: "STALE_INSTANCE" })
  const gone = () => (rig.gone ? Promise.reject(missing) : null)
  const ctx = {
    session: {
      get: async ({ sessionID }) => root(sessionID),
      instructions: {
        entry: {
          put: ({ key, value }) => gone() ?? Promise.resolve(entries.set(key, value)),
          remove: ({ key }) => gone() ?? Promise.resolve(entries.delete(key)),
          list() { // `next` is the answer to the next list only: the probe's
            const answer = rig.next
            rig.next = null
            if (rig.gone) return Promise.reject(missing)
            if (answer === "error") return Promise.reject(new Error("unavailable"))
            if (answer === "silent") return new Promise(() => {})
            if (answer === "held") return new Promise((resolve, reject) => { rig.answerList = { resolve, reject } })
            return Promise.resolve([...entries].map(([key, value]) => ({ key, value })))
          },
        },
      },
    },
  }
  const parts = stubParts()
  parts.createContext = (hostCtx, id, options) => createContext(hostCtx, id, {
    ...options,
    setTimeoutImpl: (fn, ms) => { const timer = { fn, ms, cleared: false }; callTimers.push(timer); return timer },
    clearTimeoutImpl: timer => { if (timer) timer.cleared = true },
  })
  parts.createLifecycle = (bus, context, passedConfig, options) => createLifecycle(bus, context, passedConfig, {
    ...options,
    now: () => 1_000,
    random: () => 0,
    setTimeoutImpl: fn => { rig.retry = fn; return 1 },
    clearTimeoutImpl: () => {},
    setIntervalImpl: fn => { rig.tick = fn; return 1 },
    clearIntervalImpl: () => {},
  })
  parts.startProcess = (_config, { nativeSessionId }) => {
    let close
    const closed = new Promise(resolve => { close = resolve })
    const worker = {
      stopped: false,
      ready: Promise.resolve({
        session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
        room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "opencode",
        instance_file: `/tmp/agent-chat-state/${nativeSessionId}-${workers.length}.json`,
      }),
      closed,
      // The first instance's heartbeat is refused as stale, which starts a backoff. A later one answers.
      request: op => (op === "heartbeat" && workers.length === 1 && rig.stale ? Promise.reject(stale) : Promise.resolve({})),
      stop: () => { worker.stopped = true; close({ code: 0, signal: null }); return closed },
    }
    workers.push(worker)
    return worker
  }
  rig.manager = createManager(ctx, config, parts, { deleted, forked })
  rig.armed = () => callTimers.filter(timer => !timer.cleared && timer.ms === CALL_TIMEOUT_MS)
  rig.manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(workers.length, 1) // joined
  rig.stale = true
  rig.tick() // the heartbeat is refused as stale: the worker ends and a retry is scheduled
  await flush()
  assert.equal(workers[0].stopped, true)
  assert.equal(typeof rig.retry, "function") // in backoff, with no worker
  return rig
}

test("a session deleted during a rejoin backoff, with no event seen, starts no replacement worker and is tombstoned", async () => {
  const rig = await backoffRig()
  rig.gone = true // deleted during the wait: no event
  rig.retry()
  await flush()
  assert.equal(rig.workers.length, 1) // no replacement
  assert.deepEqual([...rig.deleted], ["ses_a"]) // through the deletion path
  assert.deepEqual(rig.manager.sessions(), [])
  rig.manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.equal(rig.workers.length, 1) // and it does not rejoin
})

test("a retry whose probe fails with another error goes on and starts the replacement", async () => {
  const rig = await backoffRig()
  rig.next = "error"
  rig.retry()
  await flush()
  assert.equal(rig.workers.length, 2)
  assert.deepEqual([...rig.deleted], [])
  assert.deepEqual(rig.manager.sessions(), ["ses_a"])
})

test("a retry whose probe runs out of time goes on after the limit and starts the replacement", async () => {
  const rig = await backoffRig()
  rig.next = "silent"
  rig.retry()
  await flush()
  assert.equal(rig.workers.length, 1) // waiting for the bounded probe
  assert.equal(rig.armed().length, 1)
  rig.armed()[0].fn() // the time limit passes
  await flush()
  assert.equal(rig.workers.length, 2)
  assert.deepEqual([...rig.deleted], [])
  assert.deepEqual(rig.manager.sessions(), ["ses_a"])
})

test("a retry whose session still exists starts the replacement", async () => {
  const rig = await backoffRig()
  rig.retry()
  await flush()
  assert.equal(rig.workers.length, 2)
  assert.deepEqual([...rig.deleted], [])
})

// Review 6005906094, finding 1: the sets are shared by every owner. Evidence that another owner records while a lookup runs
// is not fed to this manager, so the lookup checks both sets again when it answers.
test("a tombstone that the old owner records during a handoff stops the successor's lookup before a worker starts", async () => {
  const rig = await backoffRig()
  rig.next = "held"
  rig.retry() // the old owner's retry asks the host, and the answer is pending
  await flush()
  assert.equal(typeof rig.answerList?.reject, "function")
  const ending = rig.manager.stop() // the old owner is torn down
  let release
  const lookups = []
  const parts = stubParts()
  const ctx = { session: { get: ({ sessionID }) => { lookups.push(sessionID); return new Promise(resolve => { release = resolve }) } } }
  const successor = createManager(ctx, config, parts, { deleted: rig.deleted, forked: rig.forked })
  successor.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"]) // the successor's lookup is pending
  rig.answerList.reject(Object.assign(new Error("not found"), { _tag: "Session.NotFoundError", sessionID: "ses_a" }))
  await flush()
  assert.deepEqual([...rig.deleted], ["ses_a"]) // the old owner's last call recorded the tombstone
  release(root("ses_a")) // the successor's lookup then answers root-shaped
  await flush()
  await ending
  assert.equal(parts.lifecycles.size, 0) // no worker starts, and no join is sent
  assert.equal(parts.contexts.size, 0)
  assert.deepEqual(successor.sessions(), [])
  assert.equal(rig.workers.length, 1) // and the old owner started none either
  successor.feed(event("session.execution.started", "ses_a"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"]) // it is refused from now on
})

for (const [kind, shared] of [["a tombstone", "deleted"], ["fork evidence", "forked"]]) {
  test(`${kind} in the shared set when the lookup answers, with no event fed to this manager, starts no worker`, async () => {
    let release
    const sets = { deleted: new Set(), forked: new Set() }
    const parts = stubParts()
    const ctx = { session: { get: () => new Promise(resolve => { release = resolve }) } }
    const manager = createManager(ctx, config, parts, sets)
    manager.feed(event("session.execution.started", "ses_a"))
    await flush()
    sets[shared].add("ses_a") // recorded by the registry or another owner, not fed here
    release(root("ses_a"))
    await flush()
    assert.equal(parts.lifecycles.size, 0)
    assert.deepEqual(manager.sessions(), [])
  })
}

// Review 6006011023, finding 2: a lookup answer that names a parent or a fork is explicit evidence, as the feed's events
// are. It is shared, so the next owner never asks again, and a later answer that is root-shaped cannot make it a root.
for (const [kind, answer] of [
  ["a parent", { id: "ses_a", parentID: "ses_parent" }],
  ["a fork source", { id: "ses_a", fork: { sessionID: "ses_source", boundary: {} } }],
]) {
  test(`a lookup answer that names ${kind} is shared: the next owner never looks the session up or joins it`, async () => {
    const sets = { deleted: new Set(), forked: new Set() }
    const first = createManager(fakeCtx(() => answer), config, stubParts(), sets)
    first.feed(event("session.execution.started", "ses_a"))
    await flush()
    assert.deepEqual([...sets.forked], ["ses_a"])
    const parts = stubParts()
    const ctx = fakeCtx(root) // a later lookup would answer root-shaped
    const successor = createManager(ctx, config, parts, sets)
    successor.feed(event("session.execution.started", "ses_a"))
    await flush()
    assert.deepEqual(ctx.lookups, [])
    assert.equal(parts.lifecycles.size, 0)
    assert.deepEqual(successor.sessions(), [])
  })
}

// An answer that proves nothing about this session only refuses it in this owner's own cache.
for (const [kind, answer] of [
  ["another session's", { id: "ses_other", parentID: "ses_parent" }],
  ["one without an id", { parentID: "ses_parent" }],
  ["a null", null],
  ["a string", "ses_a"],
]) {
  test(`a lookup answer that is ${kind} stays an owner-local refusal and adds no fork evidence`, async () => {
    const sets = { deleted: new Set(), forked: new Set() }
    const firstCtx = fakeCtx(() => answer)
    const first = createManager(firstCtx, config, stubParts(), sets)
    first.feed(event("session.execution.started", "ses_a"))
    first.feed(event("session.execution.started", "ses_a"))
    await flush()
    assert.deepEqual(firstCtx.lookups, ["ses_a"]) // refused here from now on
    assert.deepEqual([...sets.forked], [])
    const parts = stubParts()
    const ctx = fakeCtx(root)
    const successor = createManager(ctx, config, parts, sets)
    successor.feed(event("session.execution.started", "ses_a"))
    await flush()
    assert.deepEqual(ctx.lookups, ["ses_a"]) // the next owner asks for itself
    assert.deepEqual(successor.sessions(), ["ses_a"])
  })
}

// Review 6006011023, finding 1: a missing-session answer is reported to the owner of the process, which decides. The manager
// ends nothing itself: the report reaches it as a received `session.deleted` event, as the registry sends it.
test("a missing-session answer is passed to the injected report and the manager does not end the record on its own", async () => {
  const reported = []
  const parts = stubParts()
  const createContextStub = parts.createContext
  let options = null
  parts.createContext = (hostCtx, id, passed) => { options = passed; return createContextStub(hostCtx, id) }
  const sets = { deleted: new Set(), forked: new Set() }
  const manager = createManager(fakeCtx(root), config, parts, { ...sets, reportDeleted: id => reported.push(id) })
  manager.feed(event("session.execution.started", "ses_a"))
  await flush()
  options.onMissing()
  assert.deepEqual(reported, ["ses_a"])
  assert.deepEqual([...sets.deleted], [])
  assert.deepEqual(manager.sessions(), ["ses_a"])
  manager.feed(event("session.deleted", "ses_a")) // the registry's dispatch of the same report
  await flush()
  assert.deepEqual(manager.sessions(), [])
  assert.equal(parts.lifecycles.get("ses_a").stops, 1)
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
  assert.equal(parts.contexts.size, 0)
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

// The tests below put the real binding context behind the manager: the manager observes each event, asks for the repair,
// and the context repairs the entry through the host's three instruction-entry calls.
// A host double whose lists and puts are counted, and whose next `list` waits until the test settles it.
function holdableCtx() {
  const entries = new Map()
  const puts = []
  const lists = { count: 0 }
  const held = { next: false, entered: false, settle: null }
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      instructions: {
        entry: {
          async put({ key, value }) { puts.push(value); entries.set(key, value) },
          async list() {
            lists.count += 1
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
  return { ctx, entries, puts, lists, held }
}

// A host double whose list calls are numbered: the test holds one until it settles it, and fails every call from a number on.
function scriptedCtx() {
  const entries = new Map()
  const script = { lists: 0, held: 0, release: null, failFrom: Infinity }
  const ctx = {
    session: {
      async get({ sessionID }) { return root(sessionID) },
      instructions: {
        entry: {
          async put({ key, value }) { entries.set(key, value) },
          async list() {
            const call = ++script.lists
            if (call === script.held) await new Promise(resolve => { script.release = resolve })
            if (call >= script.failFrom) throw new Error("unavailable")
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove({ key }) { entries.delete(key) },
        },
      },
    },
  }
  return { ctx, entries, script }
}

// A manager over the real binding context for one session, which has published its binding.
async function boundSession(hostCtx) {
  const parts = stubParts()
  const real = withRealContext(parts)
  const manager = createManager(hostCtx, config, parts)
  const send = (type, data = {}) => manager.feed(event(type, "ses_a", data))
  send("session.execution.started")
  await flush()
  const context = real.get("ses_a")
  await context.context("binding text")
  return { manager, send, context, parts }
}

test("a compaction whose end is lost in a gap: the first event after the gap puts the dropped entry back", async () => {
  const rig = holdableCtx()
  const { manager, send, context } = await boundSession(rig.ctx)
  assert.equal(rig.entries.size, 1)
  rig.entries.clear() // a compaction dropped the entry, and the event that ends it falls into the gap
  manager.reset()
  await flush()
  assert.equal(rig.entries.size, 0) // the stream has not resumed, so nothing is read yet
  assert.equal(context.owed(), true)
  send("session.execution.started") // the stream resumes
  await flush()
  assert.equal(rig.entries.get(BINDING_KEY), "binding text") // the entry is back
  assert.equal(context.owed(), false)
})

// A compaction that is still running holds nothing back: each signal owes a read-back, and the end of the compaction
// owes another, so a read that runs during it cannot be the last word.
test("a compaction that spans a gap holds no read-back back: each signal and the first event after the gap read the entry", async () => {
  const rig = holdableCtx()
  const { manager, send, context } = await boundSession(rig.ctx)
  const base = rig.lists.count
  send("session.compaction.started", { reason: "auto" })
  await flush()
  assert.equal(rig.lists.count, base + 1) // read at once, while the compaction runs
  manager.reset() // the stream gaps while the compaction runs
  await flush()
  assert.equal(rig.lists.count, base + 1) // nothing is read inside the gap
  rig.entries.clear() // the compaction dropped the entry
  send("session.execution.started") // the stream resumes
  await flush()
  assert.equal(rig.lists.count, base + 3) // the read found it gone, and put it back and confirmed it
  assert.equal(rig.entries.get(BINDING_KEY), "binding text")
  send("session.compaction.ended", { reason: "auto" })
  await flush()
  assert.equal(rig.lists.count, base + 4) // the end owes one more read
  assert.equal(context.owed(), false)
})

// Review 6003513413, finding 1: a read-back queued before a newer signal must not read on that signal's account.
test("a read-back that a compaction signal overtook makes no host call, and the one that failed is asked again at the next event", async () => {
  const { ctx, script } = scriptedCtx()
  const { manager, send, context } = await boundSession(ctx)
  script.held = script.lists + 1
  const earlier = context.context("binding text") // its confirming list is held, so later context operations queue behind it
  await flush()
  assert.equal(typeof script.release, "function")
  manager.reset()
  await flush()
  send("session.execution.started") // the first event after the gap: a read-back is owed, asked for and queued
  await flush()
  send("session.compaction.started", { reason: "auto" }) // a newer signal: the queued read-back is overtaken
  await flush()
  const before = script.lists
  script.failFrom = before + 1 // a read from here on is rejected
  script.release()
  await earlier
  await flush()
  assert.equal(script.lists, before + 1) // the overtaken check made no call, and the new check's one read failed
  assert.equal(context.owed(), true) // still owed, and nothing was turned off
  script.failFrom = Infinity
  send("session.execution.started") // the next event asks again
  await flush()
  assert.equal(script.lists, before + 2)
  assert.equal(context.owed(), false)
})

// Review 6003597565, finding 2: a check superseded by a newer gap does no I/O, and its failure turns nothing off.
test("a read-back queued before a newer gap makes no host call, and the first event after the newest gap asks for its own", async () => {
  const { ctx, script } = scriptedCtx()
  const { manager, send, context } = await boundSession(ctx)
  script.held = script.lists + 1
  const earlier = context.context("binding text")
  await flush()
  manager.reset()
  await flush()
  send("session.execution.started") // the first event after the first gap: a check is queued
  await flush()
  manager.reset() // a newer gap supersedes that check
  await flush()
  const before = script.lists
  script.failFrom = before + 1 // a read from here on would be rejected
  script.release()
  await earlier
  await flush()
  assert.equal(script.lists, before) // the superseded check read nothing
  assert.equal(context.owed(), true)
  script.failFrom = Infinity
  send("session.execution.started") // the first event after the newest gap schedules its own check
  await flush()
  assert.equal(script.lists, before + 1)
  assert.equal(context.owed(), false)
})

// A manager, binding context and lifecycle around a worker double. The test arms one heartbeat, and it waits.
async function staleInstanceRun(answer) {
  const rig = holdableCtx()
  const notices = []
  let context = null
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
    createContext: (hostCtx, id) => {
      context = createContext(hostCtx, id, quiet)
      return context
    },
    createLifecycle: (bus, ownContext, passedConfig, options) => {
      lifecycle = createLifecycle(bus, ownContext, passedConfig, {
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
  manager.reset() // a gap
  await flush()
  send("session.execution.started") // the first event after the gap: the read-back's list is held
  await flush()
  assert.equal(rig.held.entered, true)
  void lifecycle.heartbeat() // the heartbeat waits for its answer
  await flush()
  assert.equal(typeof heartbeat.reject, "function")
  const firstPuts = rig.puts.length
  heartbeat.reject(Object.assign(new Error("STALE_INSTANCE"), { code: "STALE_INSTANCE", operation: "heartbeat" }))
  await flush() // the lifecycle withdrew the binding and scheduled its rejoin; the read-back's list is still pending
  assert.equal(typeof retry, "function")
  if (answer === "resolve") rig.held.settle.resolve()
  else rig.held.settle.reject(new Error("unavailable"))
  await flush()
  return { rig, notices, send, firstPuts, retry: () => retry(), context: () => context, starts: () => starts }
}

for (const answer of ["resolve", "reject"]) {
  test(`STALE_INSTANCE while the read-back's list is pending (${answer}): the withdrawn binding is not put back, chat stays on, and the rejoin goes on`, async () => {
    const run = await staleInstanceRun(answer)
    assert.equal(run.rig.puts.length, run.firstPuts) // no put of the withdrawn text
    assert.equal(run.rig.entries.has(BINDING_KEY), false)
    assert.equal(run.notices.some(text => /stopped/.test(text)), false) // chat is not turned off
    run.retry() // the backoff ends: the rejoin
    await flush()
    await flush()
    assert.equal(run.starts(), 2)
    assert.match(run.rig.entries.get(BINDING_KEY), /boot-2\.json/) // the new binding is published
    assert.equal(run.notices.some(text => /stopped/.test(text)), false)
    // The old check proved nothing, but the rejoin's own confirmed publish is a read-back of the new binding.
    run.send("session.execution.started")
    await flush()
    assert.equal(run.context().owed(), false)
    assert.match(run.rig.entries.get(BINDING_KEY), /boot-2\.json/)
  })
}

// A real binding context behind a manager, with a read-back whose first list is held. `order` records the host puts and
// the signals the test sends, so a test can tell a put that came after a signal was received.
async function pendingCheck() {
  const rig = holdableCtx()
  const order = []
  const put = rig.ctx.session.instructions.entry.put
  rig.ctx.session.instructions.entry.put = async input => { order.push("put"); return put(input) }
  const { manager, send, context } = await boundSession(rig.ctx)
  order.length = 0
  rig.entries.clear() // a compaction dropped the entry
  rig.held.next = true
  manager.reset()
  await flush()
  send("session.execution.started") // the first event after the gap: the read-back starts and its list is held
  await flush()
  assert.equal(rig.held.entered, true)
  const signals = {
    reset: () => { order.push("signal"); manager.reset() },
    compaction: () => { order.push("signal"); send("session.compaction.started", { reason: "auto" }) },
  }
  const answer = how => (how === "resolve" ? rig.held.settle.resolve() : rig.held.settle.reject(new Error("unavailable")))
  return { rig, order, send, signals, answer, context, manager }
}

const tickAfter = async count => { for (let tick = 0; tick < count; tick++) await Promise.resolve() }

// A read-back never turns chat off. A failed one is asked for again at the next event.
test("a transient list rejection leaves the obligation owed and the session on, and the next event's check proves it", async () => {
  const run = await pendingCheck()
  run.answer("reject")
  await flush()
  assert.equal(run.context.owed(), true) // owed: the next event asks again
  assert.deepEqual(run.manager.sessions(), ["ses_a"]) // and the session is still joined
  run.send("session.execution.started") // the next event
  await flush()
  assert.equal(run.context.owed(), false)
  assert.match(run.rig.entries.get(BINDING_KEY), /binding text/) // the entry is back
})

// A check that is in flight when a signal is received can still put the entry back before the signal is applied: that
// put is at the wrong time and harmless, because the applied signal owes the read-back again and the next check proves.
// The sweep completes the held list after 0..10 microtask ticks, so it reaches both sides of the signal's turn.
for (const signal of ["reset", "compaction"]) {
  test(`a ${signal} received while a check's host call is pending: a put at the wrong time is harmless, and the next event's check proves`, async () => {
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
        if (signal === "reset") run.send("session.execution.started")
        else run.send("session.compaction.ended", { reason: "auto" })
        await flush()
        if (!/binding text/.test(run.rig.entries.get(BINDING_KEY) ?? "")) problems.push(`${label}: no entry`)
        if (run.context.owed()) problems.push(`${label}: still owed`)
      }
    }
    assert.deepEqual(problems, [])
    // Positive control: the sweep does reach a put after the signal was received, or an empty result would prove nothing.
    assert.equal(wrongTime.size > 0, true)
  })
}
