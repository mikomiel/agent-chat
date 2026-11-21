import test from "node:test"
import assert from "node:assert/strict"
import { createMember, createRegistry, globalRegistry } from "../lib/owner.js"
import { EVENT_TYPES } from "../lib/manager.js"
import { createContext } from "../lib/context.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { BINDING_KEY } from "../lib/channel.js"

const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let index = 0; index < 8; index++) await tick() }

const event = (id, type = "session.execution.started", sessionID = "ses_a") => ({ id, type, data: { sessionID } })
const fed = log => log.filter(line => line.startsWith("feed"))
const noTimers = { setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }

function fakeMember(name, log, { feedThrows = false } = {}) {
  const member = {
    name,
    dispatch: null,
    resetStream: null,
    sets: null,
    pump(dispatch, reset) {
      member.dispatch = dispatch
      member.resetStream = reset
      return () => log.push(`stop-pump ${name}`)
    },
    activate(forked, deleted) { member.sets = { forked, deleted }; log.push(`activate ${name}`) },
    async deactivate() {
      log.push(`deactivate-start ${name}`)
      await tick()
      log.push(`deactivate-end ${name}`)
      return true
    },
    feed(item) {
      if (feedThrows) throw new Error("boom")
      log.push(`feed ${name} ${item.id}`)
    },
    reset() { log.push(`reset ${name}`) },
  }
  return member
}

test("the first member owns the joins and the others stand by", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  assert.deepEqual(log, ["activate first"])
  assert.equal(registry.owner(), first)
  // An event read by any member goes to the owner.
  first.dispatch(event("e1"))
  second.dispatch(event("e2", undefined, "ses_b")) // another member's stream, another session
  assert.deepEqual(log.slice(1), ["feed first e1", "feed first e2"])
  second.resetStream()
  assert.equal(log.at(-1), "reset first")
})

// The registry keeps no order and drops nothing the owner can use: every event the manager acts on is safe to repeat.
test("a repeat of an event, from the same stream or another one, is passed on, and an event that names no session is not", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("e1"))
  first.dispatch(event("e1")) // a repeat
  second.dispatch(event("e1")) // the same host event from the second stream
  first.dispatch({ id: "e2", type: "session.execution.started", data: {} })
  first.dispatch({ id: "e3", type: "session.execution.started" })
  assert.deepEqual(fed(log), ["feed first e1", "feed first e1", "feed first e1"])
})

test("failover: the next owner starts only after the old owner's workers ended, and events in between are dropped", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  const detachFirst = registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  const closing = detachFirst()
  await tick()
  second.dispatch(event("during")) // nobody owns during the change
  await closing
  assert.deepEqual(log, ["stop-pump first", "deactivate-start first", "deactivate-end first", "activate second"])
  assert.equal(registry.owner(), second)
  second.dispatch(event("after"))
  assert.equal(log.at(-1), "feed second after")
})

test("a member that is not the owner leaves: the owner stays and its observations are reset", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  const detachSecond = registry.attach(second)
  await flush()
  log.length = 0
  await detachSecond()
  assert.deepEqual(log, ["stop-pump second", "reset first"])
  assert.equal(registry.owner(), first)
  assert.deepEqual(registry.members(), [first])
})

test("the last member leaving leaves no owner, and a later member becomes owner", async () => {
  const registry = createRegistry()
  const log = []
  const detach = registry.attach(fakeMember("first", log))
  await flush()
  await detach()
  assert.equal(registry.owner(), null)
  registry.attach(fakeMember("next", log))
  await flush()
  assert.equal(registry.owner().name, "next")
})

test("detach is idempotent and shares one result", async () => {
  const registry = createRegistry()
  const log = []
  const detach = registry.attach(fakeMember("only", log))
  await flush()
  const [one, two] = [detach(), detach()]
  assert.equal(one, two)
  await one
  assert.equal(log.filter(line => line === "deactivate-start only").length, 1)
})

test("an owner that throws on an event does not break the stream", async () => {
  const registry = createRegistry()
  const member = fakeMember("only", [], { feedThrows: true })
  registry.attach(member)
  await flush()
  assert.doesNotThrow(() => member.dispatch(event("e1")))
})

test("a member whose end fails still hands ownership on", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  first.deactivate = async () => { throw new Error("unproved") }
  const second = fakeMember("second", log)
  const detach = registry.attach(first)
  registry.attach(second)
  await flush()
  await detach()
  assert.equal(registry.owner(), second)
})

test("the shared registry is one object per process and no member property carries the config", () => {
  assert.equal(globalRegistry(), globalRegistry())
  assert.equal(globalThis[Symbol.for("agent-chat.opencode.registry.v1")], globalRegistry())
  const config = { hostToken: "synthetic-host-token" }
  const member = createMember({ event: { subscribe: async function* () {} } }, config, {})
  for (const [name, value] of [...Object.entries(member), ...Object.entries(globalRegistry())]) {
    assert.equal(typeof value, "function", name)
  }
  assert.doesNotMatch(JSON.stringify({ ...member }), /synthetic-host-token/)
})

// A fake plugin context whose stream runs the scripted rounds in order.
function streamCtx(rounds) {
  const calls = []
  return {
    calls,
    event: {
      subscribe(options) {
        calls.push(options)
        const round = rounds.shift() ?? { events: [], hold: true }
        return (async function* () {
          for (const item of round.events ?? []) yield item
          if (round.throws) throw new Error("stream broke")
          if (round.hold) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))
        })()
      },
    },
  }
}

test("a member forwards its stream, ignores the first connect and treats a later connect as lost events", async () => {
  const ctx = streamCtx([
    { events: [{ type: "server.connected" }, event("e1"), { type: "server.connected" }, event("e2")], hold: true },
  ])
  const member = createMember(ctx, {}, {})
  const seen = []
  const resets = []
  const stop = member.pump(item => seen.push(item.id), () => resets.push("reset"))
  await flush()
  stop()
  assert.deepEqual(seen, ["e1", "e2"])
  assert.deepEqual(resets, ["reset"]) // only the second connect
  assert.deepEqual(ctx.calls[0].types, [...EVENT_TYPES])
  assert.ok(ctx.calls[0].signal instanceof AbortSignal)
})

test("a stream that throws or ends is reset and read again, with a growing wait, until the member is torn down", async () => {
  const ctx = streamCtx([{ events: [event("a")], throws: true }, { events: [event("b")] }, { events: [event("c")], hold: true }])
  const waits = []
  const member = createMember(ctx, {}, {}, { sleep: async ms => { waits.push(ms) } })
  const seen = []
  let resets = 0
  const stop = member.pump(item => seen.push(item.id), () => { resets += 1 })
  await flush()
  stop()
  assert.deepEqual(seen, ["a", "b", "c"])
  assert.equal(resets, 2)
  assert.deepEqual(waits, [1_000, 2_000])
  assert.equal(ctx.calls.length, 3)
})

test("tearing a member down stops its stream for good", async () => {
  const ctx = streamCtx([{ events: [], hold: true }])
  const member = createMember(ctx, {}, {})
  const stop = member.pump(() => {}, () => {})
  await flush()
  stop()
  await flush()
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].signal.aborted, true)
})

// A binding context double for the tests that only need a session to join.
const idleContext = () => ({ observe() {}, reset() {}, repair: () => Promise.resolve(false), dispose() {} })

test("activate builds a manager that takes events, and deactivate stops it and proves the end", async () => {
  const lookups = []
  const ctx = { ...streamCtx([]), session: { get: async ({ sessionID }) => { lookups.push(sessionID); return { id: sessionID } } } }
  const stops = []
  const parts = {
    createContext: idleContext,
    createLifecycle: (bus) => { bus.on("session_start", () => {}); return { stop: () => { stops.push("stop"); return Promise.resolve({ code: 0 }) } } },
  }
  const member = createMember(ctx, {}, parts)
  member.feed(event("before")) // not active yet: nothing happens
  await flush()
  assert.deepEqual(lookups, [])
  member.activate()
  member.feed(event("e1"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"])
  assert.equal(await member.deactivate(), true)
  assert.deepEqual(stops, ["stop"])
  assert.equal(await member.deactivate(), true) // already ended
})

// A host double with a binding entry kept in a map, the instruction-entry calls of the real binding context, and a
// session lookup that answers with a root.
function entryHost(entries, removal) {
  return {
    get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }),
    instructions: {
      entry: {
        put: async ({ key, value }) => { entries.set(key, value) },
        list: async () => [...entries].map(([key, value]) => ({ key, value })),
        remove: removal ?? (async ({ key }) => { entries.delete(key) }),
      },
    },
  }
}

// Review 6003128773, finding 1: a stream that is torn down hides events, and the registry cannot tell which sessions it
// covered, so the owner's whole state is stale from that moment. That is a gap: the owner's binding is read back at the
// session's next event.
test("a non-owner that leaves is a gap for the owner: the binding is read back at the session's next event", async () => {
  const registry = createRegistry()
  const entries = new Map()
  let context = null
  const ctx = { ...streamCtx([]), session: entryHost(entries) }
  const parts = {
    createContext: (hostCtx, id) => { context = createContext(hostCtx, id, noTimers); return context },
    createLifecycle: bus => { bus.on("session_start", () => {}); return { stop: () => Promise.resolve({ code: 0 }) } },
  }
  registry.attach(createMember(ctx, {}, parts))
  const detachStandby = registry.attach(createMember(streamCtx([]), {}, {}))
  await flush()
  registry.dispatch(event("e1"))
  await flush()
  await context.context("binding text")
  entries.clear() // a compaction dropped the entry, and the standby's stream may have been the one that carried its events
  await detachStandby()
  await flush()
  assert.equal(entries.size, 0) // the gap is applied, but nothing is read before the stream shows the session again
  assert.equal(context.owed(), true)
  registry.dispatch(event("e2"))
  await flush()
  assert.equal(entries.get(BINDING_KEY), "binding text")
  assert.equal(context.owed(), false)
})

// Finding 4: the old owner's binding removal and the successor's put reach the same entry key.
// One real owner with a joined session, a worker that ends only when stopped, and a removal that stays in flight.
async function ownerWithSlowRemoval() {
  const registry = createRegistry()
  const log = []
  const entries = new Map()
  const removal = { finish: null }
  const ctx = {
    ...streamCtx([]),
    session: entryHost(entries, ({ key }) => new Promise(resolve => { removal.finish = () => { entries.delete(key); resolve() } })),
  }
  const joined = {
    session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
    room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "opencode",
    instance_file: "/tmp/agent-chat-state/boot-1.json",
  }
  let exit
  const worker = {
    ready: Promise.resolve(joined),
    closed: new Promise(resolve => { exit = resolve }), // the worker ends only when it is stopped
    request: async () => ({}),
    stop() { exit({ code: 0, signal: null }); return this.closed },
  }
  const parts = {
    createContext: (hostCtx, id) => createContext(hostCtx, id, noTimers),
    createLifecycle: (bus, context, config, options) => createLifecycle(bus, context, config, { ...options, ...noTimers, setIntervalImpl: () => 0, clearIntervalImpl: () => {} }),
    startProcess: () => worker,
  }
  const config = { chatEnabled: true, directory: "/tmp/agent-chat-state", serverOrigin: "https://chat.example", hostToken: "synthetic-host-token", python: "/usr/bin/python3" }
  const detachOwner = registry.attach(createMember(ctx, config, parts))
  registry.attach(fakeMember("second", log))
  await flush()
  registry.dispatch(event("e1"))
  await flush()
  assert.equal(entries.size, 1) // the old owner's binding is confirmed
  return { registry, log, entries, removal, detachOwner }
}

test("a successor is promoted only after the old owner's binding entry removal has finished", async () => {
  const { registry, log, entries, removal, detachOwner } = await ownerWithSlowRemoval()
  const closing = detachOwner()
  await flush()
  assert.equal(typeof removal.finish, "function") // the removal is in flight
  assert.deepEqual(log, [], "no successor while the removal is in flight")
  assert.equal(registry.owner(), null)
  removal.finish()
  await closing
  assert.deepEqual(log, ["activate second"])
  assert.equal(entries.size, 0)
})

test("a removal that a session ended before the teardown began still holds the successor back", async () => {
  const { registry, log, entries, removal, detachOwner } = await ownerWithSlowRemoval()
  // A fork event ends the joined session at once, so its record is gone before the owner is torn down.
  registry.dispatch({ id: "e2", type: "session.forked", data: { sessionID: "ses_a" } })
  await flush()
  assert.equal(typeof removal.finish, "function") // the removal is in flight
  const closing = detachOwner()
  await flush()
  assert.deepEqual(log, [], "no successor while that removal is in flight")
  assert.equal(registry.owner(), null)
  removal.finish()
  await closing
  assert.deepEqual(log, ["activate second"])
  assert.equal(entries.size, 0)
})

// Review 6003305717, finding 1: fork evidence is carried across a promotion.
function realMember(lookups, started = [], { stuck = [] } = {}) {
  const ctx = {
    ...streamCtx([]),
    session: {
      get: ({ sessionID }) => {
        lookups.push(sessionID)
        return stuck.includes(sessionID) ? new Promise(() => {}) : Promise.resolve({ id: sessionID, agent: "build" })
      },
    },
  }
  const parts = {
    createContext: idleContext,
    createLifecycle: bus => {
      bus.on("session_start", payload => started.push(payload.nativeSessionId))
      return { stop: () => Promise.resolve({ code: 0 }), disable: () => Promise.resolve(null) }
    },
  }
  return createMember(ctx, {}, parts)
}
const forkedEvent = (id, sessionID) => ({ id, type: "session.forked", data: { sessionID, parentID: "ses_source" } })
const startedEvent = (id, sessionID) => event(id, "session.execution.started", sessionID)

test("a fork that one owner observed is still refused by the next owner", async () => {
  const registry = createRegistry()
  const lookupsFirst = []
  const lookupsNext = []
  const started = []
  const detachFirst = registry.attach(realMember(lookupsFirst))
  registry.attach(realMember(lookupsNext, started))
  await flush()
  registry.dispatch(forkedEvent("e1", "ses_fork"))
  await flush()
  await detachFirst() // the next member becomes the owner
  await flush()
  registry.dispatch(startedEvent("e2", "ses_fork"))
  await flush()
  assert.deepEqual(lookupsNext, [])
  assert.deepEqual(started, [])
})

test("a fork event that arrives between two owners is kept for the next one", async () => {
  const registry = createRegistry()
  const lookupsFirst = []
  const lookupsNext = []
  const started = []
  const first = realMember(lookupsFirst)
  let openGate
  const gate = new Promise(resolve => { openGate = resolve })
  const deactivate = first.deactivate
  first.deactivate = async () => { await gate; return deactivate() } // the old owner is still ending
  const detachFirst = registry.attach(first)
  registry.attach(realMember(lookupsNext, started))
  await flush()
  const detaching = detachFirst()
  await flush()
  assert.equal(registry.owner(), null)
  registry.dispatch(forkedEvent("e1", "ses_fork")) // no owner to take it
  openGate()
  await detaching
  await flush()
  registry.dispatch(startedEvent("e2", "ses_fork"))
  await flush()
  assert.deepEqual(lookupsNext, [])
  assert.deepEqual(started, [])
})

// Review 6005761762, finding 2: a created event that names a parent is fork evidence too, recorded from any event.
const childCreatedEvent = (id, sessionID) => ({ id, type: "session.created", data: { sessionID, parentID: "ses_parent" } })

test("a created event that names a parent, which one owner observed or that arrived between two owners, is kept for the next one", async () => {
  const registry = createRegistry()
  const lookupsNext = []
  const started = []
  const first = realMember([])
  let openGate
  const gate = new Promise(resolve => { openGate = resolve })
  const deactivate = first.deactivate
  first.deactivate = async () => { await gate; return deactivate() } // the old owner is still ending
  const detachFirst = registry.attach(first)
  registry.attach(realMember(lookupsNext, started))
  await flush()
  registry.dispatch(childCreatedEvent("e1", "ses_seen")) // the owner sees it
  const detaching = detachFirst()
  await flush()
  assert.equal(registry.owner(), null)
  registry.dispatch(childCreatedEvent("e2", "ses_between")) // no owner to take it
  openGate()
  await detaching
  await flush()
  registry.dispatch(startedEvent("e3", "ses_seen"))
  registry.dispatch(startedEvent("e4", "ses_between"))
  await flush()
  assert.deepEqual(lookupsNext, [])
  assert.deepEqual(started, [])
})

// Review 6003513413, finding 2: deletion tombstones are carried across a promotion, as fork evidence is.
const deletedEvent = (id, sessionID) => ({ id, type: "session.deleted", data: { sessionID } })

test("a deletion that one owner observed is still refused by the next owner", async () => {
  const registry = createRegistry()
  const lookupsNext = []
  const started = []
  const detachFirst = registry.attach(realMember([]))
  registry.attach(realMember(lookupsNext, started))
  await flush()
  registry.dispatch(deletedEvent("e1", "ses_gone"))
  await flush()
  await detachFirst() // the next member becomes the owner
  await flush()
  registry.dispatch(startedEvent("e2", "ses_gone"))
  await flush()
  assert.deepEqual(lookupsNext, [])
  assert.deepEqual(started, [])
})

test("a deletion event that arrives between two owners is kept for the next one", async () => {
  const registry = createRegistry()
  const lookupsNext = []
  const started = []
  const first = realMember([])
  let openGate
  const gate = new Promise(resolve => { openGate = resolve })
  const deactivate = first.deactivate
  first.deactivate = async () => { await gate; return deactivate() } // the old owner is still ending
  const detachFirst = registry.attach(first)
  registry.attach(realMember(lookupsNext, started))
  await flush()
  const detaching = detachFirst()
  await flush()
  assert.equal(registry.owner(), null)
  registry.dispatch(deletedEvent("e1", "ses_gone")) // no owner to take it
  openGate()
  await detaching
  await flush()
  registry.dispatch(startedEvent("e2", "ses_gone"))
  await flush()
  assert.deepEqual(lookupsNext, [])
  assert.deepEqual(started, [])
})

// A tombstone is final. A `session.forked` event that arrives after the deletion adds no fork record: the tombstone
// already refuses the id, and nothing would ever remove the record again.
test("a late fork event for a deleted session adds no fork record, with an owner and between two owners", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  const detachFirst = registry.attach(first)
  registry.attach(second)
  await flush()
  first.dispatch(deletedEvent("d1", "ses_a"))
  first.dispatch(forkedEvent("f1", "ses_a")) // late, with an owner
  assert.equal(first.sets.deleted.has("ses_a"), true)
  assert.equal(first.sets.forked.has("ses_a"), false)
  const detaching = detachFirst()
  await tick()
  assert.equal(registry.owner(), null)
  second.dispatch(deletedEvent("d2", "ses_b"))
  second.dispatch(forkedEvent("f2", "ses_b")) // late, with no owner to take it
  await detaching
  assert.equal(second.sets.deleted.has("ses_a"), true) // carried to the next owner
  assert.equal(second.sets.deleted.has("ses_b"), true)
  assert.equal(second.sets.forked.has("ses_a"), false)
  assert.equal(second.sets.forked.has("ses_b"), false)
})

test("a fork record is dropped with its session, and a fork before the deletion still leaves a tombstone only", async () => {
  const registry = createRegistry()
  const first = fakeMember("first", [])
  registry.attach(first)
  await flush()
  first.dispatch(forkedEvent("f1", "ses_a"))
  assert.equal(first.sets.forked.has("ses_a"), true)
  first.dispatch(deletedEvent("d1", "ses_a"))
  assert.equal(first.sets.forked.has("ses_a"), false)
  assert.equal(first.sets.deleted.has("ses_a"), true)
})

// Review 6003513413, finding 3: a pending eligibility lookup must not keep the registry ownerless.
test("a lookup that never answers does not hold back failover, and the standby serves other sessions", async () => {
  const registry = createRegistry()
  const lookupsFirst = []
  const started = []
  const detachFirst = registry.attach(realMember(lookupsFirst, [], { stuck: ["ses_stuck"] }))
  registry.attach(realMember([], started))
  await flush()
  registry.dispatch(startedEvent("e1", "ses_stuck"))
  await flush()
  assert.deepEqual(lookupsFirst, ["ses_stuck"]) // the lookup is pending for good
  const outcome = await Promise.race([detachFirst().then(() => "promoted"), new Promise(resolve => setTimeout(resolve, 300, "hung").unref())])
  assert.equal(outcome, "promoted")
  registry.dispatch(startedEvent("e2", "ses_other"))
  await flush()
  assert.deepEqual(started, ["ses_other"])
})

// Review 6003305717, finding 2, ordering: `pump` resets when the stream breaks, before the wait and the resubscribe.
// A compaction can still end after the break and before the stream resumes, and no event reports it.
test("a compaction that ends after the stream broke and before it resumed is read back at the first event after the gap", async () => {
  const registry = createRegistry()
  const entries = new Map()
  let context = null
  let rounds = 0
  let breakStream
  const broken = new Promise(resolve => { breakStream = resolve })
  const ctx = {
    event: {
      subscribe(options) {
        const round = ++rounds
        return (async function* () {
          if (round === 1) {
            yield startedEvent("e1", "ses_a")
            await broken
            throw new Error("stream broke")
          }
          // The stream resumed with no `server.connected`: only the session's own events.
          yield startedEvent("e2", "ses_a")
          await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))
        })()
      },
    },
    session: entryHost(entries),
  }
  const parts = {
    createContext: (hostCtx, id) => { context = createContext(hostCtx, id, noTimers); return context },
    createLifecycle: bus => { bus.on("session_start", () => {}); return { stop: () => Promise.resolve({ code: 0 }) } },
  }
  // The break happens first and the wait follows it. The reset that the break triggers is applied first, and then a
  // compaction ends during the wait, so its event is lost and the entry is gone.
  const sleep = async () => { await flush(); entries.clear() }
  registry.attach(createMember(ctx, {}, parts, { sleep }))
  await flush()
  await context.context("binding text")
  assert.equal(entries.size, 1)
  breakStream()
  await flush()
  await flush() // the wait inside `sleep` takes one flush of its own
  assert.equal(rounds, 2) // the stream resumed, and its first event asked for the read-back
  assert.equal(entries.get(BINDING_KEY), "binding text") // the entry is back
  assert.equal(context.owed(), false)
})

// Review 6005506743, finding 1: the host has no replay and no cursor, so a stream that comes back with no marker can hide
// a deletion that no later event reports. A check tied to the break or the reconnect leaves a window after it. The
// heartbeat tick reads the session's entry, so the deletion is found within one tick, wherever it happened.
test("a session deleted while the stream was down, with a reconnect that marks nothing, is ended by the next heartbeat tick", async () => {
  const registry = createRegistry()
  const lookups = []
  const entries = new Map()
  const workers = []
  let tickBeat = null
  let heartbeats = null
  let gone = false
  let rounds = 0
  let breakStream
  const broken = new Promise(resolve => { breakStream = resolve })
  const missing = Object.assign(new Error("not found"), { _tag: "Session.NotFoundError", sessionID: "ses_a" })
  const answer = value => (gone ? Promise.reject(missing) : Promise.resolve(value))
  const ctx = {
    event: {
      subscribe(options) {
        const round = ++rounds
        return (async function* () {
          if (round === 1) {
            yield startedEvent("e1", "ses_a")
            await broken
            throw new Error("stream broke")
          }
          // The stream resumed with no `server.connected` and no event of the session: nothing says what happened.
          await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))
        })()
      },
    },
    session: {
      get: async ({ sessionID }) => { lookups.push(sessionID); return { id: sessionID, agent: "build" } },
      instructions: {
        entry: {
          put: ({ key, value }) => answer(entries.set(key, value)),
          list: () => answer([...entries].map(([key, value]) => ({ key, value }))),
          remove: ({ key }) => answer(entries.delete(key)),
        },
      },
    },
  }
  const parts = {
    createContext: (hostCtx, id, options) => createContext(hostCtx, id, { ...noTimers, ...options }),
    createLifecycle: (bus, context, passedConfig, options) => createLifecycle(bus, context, passedConfig, {
      ...options,
      now: () => 1_000,
      random: () => 0,
      setTimeoutImpl: () => 0,
      clearTimeoutImpl: () => {},
      setIntervalImpl: fn => { tickBeat = fn; heartbeats = { cleared: false }; return heartbeats },
      clearIntervalImpl: timer => { if (timer) timer.cleared = true },
    }),
    startProcess: () => {
      let close
      const closed = new Promise(resolve => { close = resolve })
      const worker = {
        stopped: false,
        ready: Promise.resolve({
          session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
          room_id: "33333333-3333-4333-8333-333333333333", host: "synthetic-host", harness: "opencode",
          instance_file: "/tmp/agent-chat-state/ses_a.json",
        }),
        closed,
        request: () => Promise.resolve({}),
        stop: () => { worker.stopped = true; close({ code: 0, signal: null }); return closed },
      }
      workers.push(worker)
      return worker
    },
  }
  const config = { chatEnabled: true, directory: "/tmp/state", serverOrigin: "https://chat.example", hostToken: "synthetic-token", python: "/usr/bin/python3" }
  // The break happens first and the wait follows it. The session is deleted during the wait, and its event is lost.
  const sleep = async () => { await flush(); gone = true }
  registry.attach(createMember(ctx, config, parts, { sleep }))
  await flush()
  assert.equal(workers.length, 1) // joined, with a binding and a heartbeat
  assert.equal(entries.size, 1)
  tickBeat() // a tick while the session exists changes nothing
  await flush()
  assert.equal(workers[0].stopped, false)
  breakStream()
  await flush()
  await flush() // the wait inside `sleep` takes one flush of its own
  assert.equal(rounds, 2) // reconnected, and no event of the session came with it
  assert.equal(workers[0].stopped, false) // nothing has told the plugin yet
  tickBeat() // one tick
  await flush()
  assert.equal(workers[0].stopped, true) // the chat of the deleted session ended
  assert.equal(heartbeats.cleared, true)
  const asked = lookups.length
  registry.dispatch(startedEvent("e2", "ses_a")) // a late event for it is refused: the deletion is a tombstone
  await flush()
  assert.equal(lookups.length, asked)
  assert.equal(workers.length, 1)
})
