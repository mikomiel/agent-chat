import test from "node:test"
import assert from "node:assert/strict"
import { createMember, createRegistry, globalRegistry } from "../lib/owner.js"
import { EVENT_TYPES } from "../lib/manager.js"
import { createDelivery } from "../lib/delivery.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { monotonicNow } from "../lib/channel.js"

const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let index = 0; index < 8; index++) await tick() }
const event = (id, type = "session.execution.started", sessionID = "ses_a") => ({ id, type, data: { sessionID } })

function fakeMember(name, log, { feedThrows = false } = {}) {
  const member = {
    name,
    dispatch: null,
    resetStream: null,
    pump(dispatch, reset) {
      member.dispatch = dispatch
      member.resetStream = reset
      return () => log.push(`stop-pump ${name}`)
    },
    activate() { log.push(`activate ${name}`) },
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
  // An event read by any member goes to the owner, once.
  first.dispatch(event("e1"))
  second.dispatch(event("e1"))
  second.dispatch(event("e2", undefined, "ses_b")) // ses_a is read from the stream that delivered it first, so e2 is another session's
  assert.deepEqual(log.slice(1), ["feed first e1", "feed first e2"])
  second.resetStream()
  assert.equal(log.at(-1), "reset first")
})

test("an event without an id is passed on every time", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  member.dispatch({ type: "session.execution.started", data: { sessionID: "ses_a" } })
  member.dispatch({ type: "session.execution.started", data: { sessionID: "ses_a" } })
  assert.equal(log.filter(line => line.startsWith("feed")).length, 2)
})

// Review 6003960841, finding 1: the registry keeps no event-id memory. A session's events come from one stream, and a
// repeat within one stream only follows a reconnect, which already resets the session.
test("the registry keeps no event-id memory: a repeat from the holding stream is passed on each time", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  member.dispatch(event("same"))
  member.dispatch(event("same"))
  assert.equal(log.filter(line => line === "feed only same").length, 2)
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

test("activate builds a manager that takes events, and deactivate stops it and proves the end", async () => {
  const lookups = []
  const ctx = { ...streamCtx([]), session: { get: async ({ sessionID }) => { lookups.push(sessionID); return { id: sessionID } } } }
  const stops = []
  const parts = {
    createDelivery: () => ({ seed() {}, observe: () => false, reset() {}, needsReadBack: () => false, verifyContext: () => Promise.resolve(), dispose() {} }),
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

// Review 6003128773, finding 1: a stream that is torn down hides events, and the registry cannot tell which
// sessions it covered, so the owner's whole state is stale from that moment.
test("a non-owner that leaves while a delivery is pending settles it uncertain, and a later delivered cannot hand over", async () => {
  const registry = createRegistry()
  const deliveries = []
  const noTimers = { setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }
  const ctx = {
    ...streamCtx([]),
    session: { get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }), synthetic: async () => ({ id: "msg_parked" }) },
  }
  const parts = {
    createDelivery: (hostCtx, id) => { const delivery = createDelivery(hostCtx, id, noTimers); deliveries.push(delivery); return delivery },
    createLifecycle: bus => { bus.on("session_start", () => {}); return { stop: () => Promise.resolve({ code: 0 }) } },
  }
  registry.attach(createMember(ctx, {}, parts))
  const detachStandby = registry.attach(createMember(streamCtx([]), {}, {}))
  await flush()
  const send = (id, type, data = {}) => registry.dispatch({ id, type, data: { sessionID: "ses_a", ...data } })
  send("e1", "session.inbox.enqueued", { item: { type: "user" } })
  send("e2", "session.execution.started")
  await flush()
  assert.equal(deliveries[0].state(), null)
  let settled = null
  void deliveries[0]
    .deliver({ content: "peer notice", attemptId: "11111111-1111-4111-8111-111111111111" }, monotonicNow() + 60_000)
    .then(result => { settled = result })
  await flush()
  assert.equal(settled, null) // issued, waiting for its delivered event
  await detachStandby()
  await flush()
  assert.deepEqual(settled, { outcome: "uncertain", reason: "transport_ambiguous" })
  send("e3", "session.inbox.delivered", { inboxID: "msg_parked" })
  await flush()
  assert.notEqual(deliveries[0].state(), null) // every observation is stale until fresh events show them again
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
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }),
      instructions: {
        entry: {
          put: async ({ key, value }) => { entries.set(key, value) },
          list: async () => [...entries].map(([key, value]) => ({ key, value })),
          remove: ({ key }) => new Promise(resolve => { removal.finish = () => { entries.delete(key); resolve() } }),
        },
      },
    },
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
  const noTimers = { setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }
  const parts = {
    createDelivery: (hostCtx, id) => createDelivery(hostCtx, id, noTimers),
    createLifecycle: (bus, delivery, config, options) => createLifecycle(bus, delivery, config, { ...options, ...noTimers, setIntervalImpl: () => 0, clearIntervalImpl: () => {} }),
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
    createDelivery: () => ({ seed() {}, observe: () => false, reset() {}, needsReadBack: () => false, verifyContext: () => Promise.resolve(), dispose() {} }),
    createLifecycle: bus => {
      bus.on("session_start", payload => started.push(payload.nativeSessionId))
      return { stop: () => Promise.resolve({ code: 0 }), disable: () => Promise.resolve(null) }
    },
  }
  return createMember(ctx, {}, parts)
}
const forkedEvent = (id, sessionID) => ({ id, type: "session.forked", data: { sessionID, parentID: "ses_source" } })
const startedEvent = (id, sessionID) => ({ id, type: "session.execution.started", data: { sessionID } })

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
test("a compaction that ends after the stream broke and before it resumed is read back before delivery resumes", async () => {
  const registry = createRegistry()
  const entries = new Map()
  const synthetic = []
  let hold = false
  let releaseList = null
  let delivery = null
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
          yield { id: "e2", type: "session.agent.selected", data: { sessionID: "ses_a", agent: "build" } }
          yield { id: "e3", type: "session.inbox.enqueued", data: { sessionID: "ses_a", item: { type: "user" } } }
          yield startedEvent("e4", "ses_a")
          await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))
        })()
      },
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }),
      synthetic: input => { synthetic.push(input); return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          put: async ({ key, value }) => { entries.set(key, value) },
          list: async () => {
            if (hold) await new Promise(resolve => { releaseList = resolve })
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          remove: async ({ key }) => { entries.delete(key) },
        },
      },
    },
  }
  const noTimers = { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }
  const parts = {
    createDelivery: (hostCtx, id) => { delivery = createDelivery(hostCtx, id, noTimers); return delivery },
    createLifecycle: bus => { bus.on("session_start", () => {}); return { stop: () => Promise.resolve({ code: 0 }), disable: () => Promise.resolve(null) } },
  }
  // The break happens first and the wait follows it. The read-back that the break triggers finishes first, and then a
  // compaction ends during the wait, so its event is lost.
  const sleep = async () => { await flush(); entries.clear(); hold = true }
  registry.attach(createMember(ctx, {}, parts, { sleep }))
  await flush()
  await delivery.context("binding text")
  assert.equal(entries.size, 1)
  breakStream()
  await flush()
  await flush() // the wait inside `sleep` takes one flush of its own
  assert.equal(rounds, 2) // the stream resumed
  assert.equal(entries.size, 0) // the entry is gone, and no event said so
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
})

// Review 6003650164, finding 3: a session's state events are accepted from one stream only. Ids are not documented
// as ordered and the host does not say that one stream covers a session, so no bounded id memory can promise that a
// delayed duplicate is recognised. The stream that delivered the session first is its ordered source.
test("a session's events are accepted from the stream that delivered it first, and a later stream's copy is dropped", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("e1"))
  second.dispatch(event("e2")) // ses_a belongs to the first stream now
  first.dispatch(event("e3"))
  second.dispatch(event("e4", undefined, "ses_b")) // a session that the second stream delivered first is its own
  first.dispatch(event("e5", undefined, "ses_b"))
  assert.deepEqual(log, ["feed first e1", "feed first e3", "feed first e4"])
})

test("a copy that the wrong stream delivered first does not hide the pinned stream's copy of the same event", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("e0"))
  second.dispatch(event("e1")) // dropped by the pin
  first.dispatch(event("e1"))
  assert.deepEqual(log, ["feed first e0", "feed first e1"])
})

test("a session is released when its stream is reset or its member leaves, and the next stream that delivers it takes it", async () => {
  const registry = createRegistry()
  const log = []
  const owner = fakeMember("owner", log)
  const one = fakeMember("one", log)
  const two = fakeMember("two", log)
  registry.attach(owner)
  registry.attach(one)
  const detachTwo = registry.attach(two)
  await flush()
  log.length = 0
  one.dispatch(event("e1"))
  two.dispatch(event("e2")) // dropped: the first stream holds ses_a
  one.resetStream() // its stream was lost, so the session is not tied to it any more
  assert.equal(log.at(-1), "reset owner")
  two.dispatch(event("e3"))
  one.dispatch(event("e4")) // the second stream holds it now
  await detachTwo()
  one.dispatch(event("e5")) // and a member that leaves releases what it held
  assert.deepEqual(log.filter(line => line.startsWith("feed")), ["feed owner e1", "feed owner e3", "feed owner e5"])
})

test("a fork or a deletion is passed on from any stream, not only from the one that holds the session", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("e1"))
  first.dispatch(event("e2", undefined, "ses_b"))
  second.dispatch(deletedEvent("e3", "ses_a"))
  second.dispatch(forkedEvent("e4", "ses_b"))
  assert.deepEqual(log, ["feed first e1", "feed first e2", "feed first e3", "feed first e4"])
})

// Two real members whose streams the test drives by hand, and one real delivery for `ses_a` behind the owner.
async function handDrivenStreams() {
  const registry = createRegistry()
  let delivery = null
  const ctx = { ...streamCtx([]), session: { get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }) } }
  const parts = {
    createDelivery: (hostCtx, id) => {
      if (id !== "ses_a") return { seed() {}, observe: () => false, reset() {}, needsReadBack: () => false, verifyContext: () => Promise.resolve("proved"), dispose() {} }
      delivery = createDelivery(hostCtx, id, { now: () => 1_000, setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} })
      return delivery
    },
    createLifecycle: bus => { bus.on("session_start", () => {}); return { stop: () => Promise.resolve({ code: 0 }), disable: () => Promise.resolve(null) } },
  }
  const streams = {}
  const attach = name => {
    const member = createMember(name === "a" ? ctx : streamCtx([]), {}, parts)
    return Object.assign(member, { pump(dispatch, reset) { streams[name] = { dispatch, reset }; return () => {} } })
  }
  registry.attach(attach("a"))
  registry.attach(attach("b"))
  await flush()
  return {
    send: (name, item) => streams[name].dispatch(item),
    lose: name => streams[name].reset(),
    delivery: () => delivery,
  }
}
const userItem = (id, sessionID = "ses_a") => ({ id, type: "session.inbox.enqueued", data: { sessionID, item: { type: "user" } } })

// The session of the finding: started and finished on one stream, then a delayed duplicate of the start arrives from
// another stream after the first stream's ids have long left the bounded memory.
test("a delayed duplicate start from another stream does not mark an idle session running once its id was evicted", async () => {
  const rig = await handDrivenStreams()
  rig.send("a", event("e0", "session.agent.selected"))
  rig.send("a", userItem("e0b"))
  rig.send("a", event("e1", "session.execution.started"))
  rig.send("a", event("e2", "session.execution.succeeded"))
  await flush()
  const delivery = rig.delivery()
  assert.notEqual(delivery, null)
  assert.equal(delivery.heartbeatState().native_state, "idle") // started and finished
  assert.notEqual(delivery.state(), null)
  for (let index = 0; index < 1100; index++) rig.send("a", event(`filler-${index}`, "session.execution.started", `ses_other_${index}`))
  rig.send("b", event("e1", "session.execution.started")) // the delayed duplicate: its id was evicted long ago
  await flush()
  assert.equal(delivery.heartbeatState().native_state, "idle") // still idle
  assert.notEqual(delivery.state(), null) // so no notice can be handed over
})

// Review 6003960841, finding 1: a handoff replays a session's events from a lagging stream. The registry keeps no id
// memory, so the whole replay is applied in order, and the run end is not dropped as already seen.
test("after a handoff the new holder's replay is applied in full, so a session that had ended ends again", async () => {
  const rig = await handDrivenStreams()
  const replay = [event("sel", "session.agent.selected"), userItem("usr"), event("run", "session.execution.started")]
  const end = event("end", "session.execution.succeeded")
  for (const item of replay) rig.send("a", item)
  // The first three ids leave any bounded memory of 1,024 ids; the end stays in it.
  for (let index = 0; index < 1100; index++) rig.send("a", event(`filler-${index}`, "session.execution.started", `ses_other_${index}`))
  rig.send("a", end)
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "idle")
  rig.lose("a") // the first stream is lost: the session is released
  for (const item of [...replay, end]) rig.send("b", item) // the lagging stream takes it and replays all four
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "idle") // the run end was applied, not dropped
  assert.notEqual(rig.delivery().state(), null)
})
