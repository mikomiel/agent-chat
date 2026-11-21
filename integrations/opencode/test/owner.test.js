import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createMember, createRegistry, globalRegistry } from "../lib/owner.js"
import { EVENT_TYPES } from "../lib/manager.js"
import { createDelivery } from "../lib/delivery.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { monotonicNow } from "../lib/channel.js"

const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let index = 0; index < 8; index++) await tick() }

// Every session event carries the host's `durable` envelope, and the registry orders by its `seq`. A test event takes
// the next `seq` of its session unless the caller names one. An id seen before for that session gets its earlier `seq`
// again: the same host event, delivered a second time by another stream.
const seqs = new Map()
const nextSeq = new Map()
beforeEach(() => { seqs.clear(); nextSeq.clear() })
function durableFor(id, sessionID, seq) {
  const key = `${sessionID}/${id}`
  if (seq === undefined && !seqs.has(key)) {
    seqs.set(key, nextSeq.get(sessionID) ?? 0)
    nextSeq.set(sessionID, seqs.get(key) + 1)
  }
  return { aggregateID: sessionID, seq: seq ?? seqs.get(key), version: 1 }
}
const durable = (sessionID, seq) => ({ aggregateID: sessionID, seq, version: 1 })
const fed = log => log.filter(line => line.startsWith("feed"))
const event = (id, type = "session.execution.started", sessionID = "ses_a", seq) => ({ id, type, data: { sessionID }, durable: durableFor(id, sessionID, seq) })

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
  second.dispatch(event("e1")) // the same host event from the second stream: its seq is not above the mark
  second.dispatch(event("e2", undefined, "ses_b")) // another session
  assert.deepEqual(log.slice(1), ["feed first e1", "feed first e2"])
  second.resetStream()
  assert.equal(log.at(-1), "reset first")
})

test("an event without an id is ordered by its seq alone", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  const bare = seq => ({ type: "session.execution.started", data: { sessionID: "ses_a" }, durable: durable("ses_a", seq) })
  member.dispatch(bare(0))
  member.dispatch(bare(1))
  member.dispatch(bare(1)) // a repeat
  assert.equal(log.filter(line => line.startsWith("feed")).length, 2)
})

// Review 6004544584, finding 1: the id plays no part. The registry keeps no id memory and orders by `durable.seq`.
test("a repeat of a seq is dropped whatever its id, and the same id with a higher seq is a new event", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  member.dispatch(event("same", undefined, "ses_a", 0))
  member.dispatch(event("same", undefined, "ses_a", 0)) // a repeat
  member.dispatch(event("other", undefined, "ses_a", 0)) // another id, the same seq
  member.dispatch(event("same", undefined, "ses_a", 1)) // the same id, a higher seq
  assert.deepEqual(log.filter(line => line.startsWith("feed")), ["feed only same", "feed only same"])
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
  const send = (id, type, data = {}) => registry.dispatch({ id, type, data: { sessionID: "ses_a", ...data }, durable: durableFor(id, "ses_a") })
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
const forkedEvent = (id, sessionID) => ({ id, type: "session.forked", data: { sessionID, parentID: "ses_source" }, durable: durableFor(id, sessionID) })
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

// Review 6003513413, finding 2: deletion tombstones are carried across a promotion, as fork evidence is.
const deletedEvent = (id, sessionID) => ({ id, type: "session.deleted", data: { sessionID }, durable: durableFor(id, sessionID) })

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
          yield { id: "e2", type: "session.agent.selected", data: { sessionID: "ses_a", agent: "build" }, durable: durableFor("e2", "ses_a") }
          yield { id: "e3", type: "session.inbox.enqueued", data: { sessionID: "ses_a", item: { type: "user" } }, durable: durableFor("e3", "ses_a") }
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

// Review 6004544584, finding 1: the registry orders a session's events by the host's own `durable.seq`, with one
// process-wide high-water mark per session. A stream, an id or a handoff plays no part: an event is passed on only
// when its `seq` is above the mark, and passing it on raises the mark.
test("two streams that take turns being ahead: each event reaches the owner once, in seq order, from whichever delivers it first", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  const [e0, e1, e2, e3, e4, e5] = [0, 1, 2, 3, 4, 5].map(seq => event(`e${seq}`, undefined, "ses_a", seq))
  first.dispatch(e0)
  second.dispatch(e0)
  second.dispatch(e1) // the first stream is quiet, and the second one is ahead
  second.dispatch(e2)
  first.dispatch(e1) // the first stream catches up on events that were applied already
  first.dispatch(e2)
  first.dispatch(e3) // and now it is ahead
  second.dispatch(e3)
  second.dispatch(e2) // an older event, late
  second.dispatch(e4)
  first.dispatch(e4)
  second.dispatch(e5) // the first stream never delivers this one
  assert.deepEqual(fed(log), ["feed first e0", "feed first e1", "feed first e2", "feed first e3", "feed first e4", "feed first e5"]) // the owner is `first`
})

test("an event at or below the session's mark is dropped, whatever stream and id it comes with, and sessions are separate", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("a", undefined, "ses_a", 5))
  second.dispatch(event("b", undefined, "ses_a", 3)) // older, and this stream never delivered seq 5
  second.dispatch(event("c", undefined, "ses_a", 5)) // the same seq, another id
  first.dispatch(event("d", undefined, "ses_a", 6))
  second.dispatch(event("e", undefined, "ses_b", 0)) // another session has its own mark
  assert.deepEqual(fed(log), ["feed first a", "feed first d", "feed first e"])
})

test("a gap in seq is not a reason to drop: only a seq at or below the mark is stale", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  member.dispatch(event("first", undefined, "ses_a", 0)) // the host counts from 0
  member.dispatch(event("gap", undefined, "ses_a", 7)) // internal events used 1 to 6
  member.dispatch(event("next", undefined, "ses_a", 8))
  assert.deepEqual(fed(log), ["feed only first", "feed only gap", "feed only next"])
})

test("an event without a valid durable envelope is dropped and raises no mark", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  const base = { id: "x", type: "session.execution.started", data: { sessionID: "ses_a" } }
  const malformed = [
    base, // no envelope
    { ...base, durable: null },
    { ...base, durable: "ses_a" },
    { ...base, durable: { seq: 1 } }, // no aggregate
    { ...base, durable: durable("ses_b", 1) }, // another session's envelope
    { ...base, durable: durable("ses_a", -1) },
    { ...base, durable: durable("ses_a", 1.5) },
    { ...base, durable: durable("ses_a", "2") },
    { ...base, durable: durable("ses_a", Number.NaN) },
    { ...base, durable: durable("ses_a", undefined) },
    { ...base, durable: durable("ses_a", Number.MAX_SAFE_INTEGER + 1) }, // not an exact integer
    { ...base, data: {}, durable: durable("ses_a", 2) }, // no session
  ]
  for (const item of malformed) member.dispatch(item)
  assert.deepEqual(fed(log), [])
  member.dispatch({ ...base, id: "ok", durable: durable("ses_a", 0) }) // nothing above raised the mark
  assert.deepEqual(fed(log), ["feed only ok"])
})

test("a lost stream does not clear the marks, so a lagging stream's replay stays dropped", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("e5", undefined, "ses_a", 5))
  first.resetStream()
  second.dispatch(event("e5", undefined, "ses_a", 5)) // the replay
  second.dispatch(event("e4", undefined, "ses_a", 4))
  second.dispatch(event("e6", undefined, "ses_a", 6))
  assert.deepEqual(log, ["feed first e5", "reset first", "feed first e6"])
})

test("the marks survive an owner promotion", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  const detachFirst = registry.attach(first)
  registry.attach(second)
  await flush()
  first.dispatch(event("e5", undefined, "ses_a", 5))
  await detachFirst() // the second member owns now
  log.length = 0
  second.dispatch(event("e3", undefined, "ses_a", 3))
  second.dispatch(event("e5", undefined, "ses_a", 5))
  second.dispatch(event("e6", undefined, "ses_a", 6))
  assert.deepEqual(fed(log), ["feed second e6"])
})

test("an event that arrives while nobody owns is not recorded, so its other copy is still new", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  const detachFirst = registry.attach(first)
  registry.attach(second)
  await flush()
  const detaching = detachFirst()
  await tick()
  assert.equal(registry.owner(), null)
  second.dispatch(event("during", undefined, "ses_a", 4)) // nobody saw it
  await detaching
  log.length = 0
  second.dispatch(event("during", undefined, "ses_a", 4)) // the same event, now that an owner exists
  assert.deepEqual(fed(log), ["feed second during"])
})

test("a fork or a deletion needs no envelope and no order, from any stream", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  first.dispatch(event("e1", undefined, "ses_a", 5))
  first.dispatch(event("e2", undefined, "ses_b", 5))
  second.dispatch({ id: "e3", type: "session.deleted", data: { sessionID: "ses_a" } }) // no envelope
  second.dispatch({ ...forkedEvent("e4", "ses_b"), durable: durable("ses_b", 1) }) // below the mark
  // The owner refuses a session with that evidence, so what follows is passed on without an order to be refused.
  second.dispatch({ id: "e5", type: "session.execution.started", data: { sessionID: "ses_a" } })
  assert.deepEqual(fed(log), ["feed first e1", "feed first e2", "feed first e3", "feed first e4", "feed first e5"])
})

// The run-end exception to the mark: a run end at or below the mark still reaches the owner when it ends the open run,
// the run whose start was passed on last and has not been closed. Every other event at or below the mark is dropped.
const RUN_ENDS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]

async function twoMembers() {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  const detachFirst = registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  return { log, first, second, detachFirst }
}

test("a run end below the mark ends the open run, whichever way the run ended, and does not move the mark", async () => {
  for (const type of RUN_ENDS) {
    const { log, first, second } = await twoMembers()
    first.dispatch(event("run", "session.execution.started", "ses_a", 2))
    second.dispatch(event("later", "session.agent.selected", "ses_a", 4)) // another stream is ahead
    first.dispatch(event("end", type, "ses_a", 3)) // the end, late
    second.dispatch(event("dup", type, "ses_a", 3)) // the same end from the other stream: the run is closed
    second.dispatch(event("same", "session.agent.selected", "ses_a", 4)) // the mark is still 4
    first.dispatch(event("next", "session.agent.selected", "ses_a", 5))
    assert.deepEqual(fed(log), ["feed first run", "feed first later", "feed first end", "feed first next"], type)
  }
})

test("a run end below a successor's start is dropped, and so is an end with no open run", async () => {
  const { log, first, second } = await twoMembers()
  first.dispatch(event("run1", "session.execution.started", "ses_a", 2))
  second.dispatch(event("run2", "session.execution.started", "ses_a", 4)) // the successor replaces the open run
  first.dispatch(event("old-end", "session.execution.succeeded", "ses_a", 3)) // the first run's end
  second.dispatch(event("end2", "session.execution.succeeded", "ses_a", 5)) // above the mark: the normal rule
  second.dispatch(event("sel", "session.agent.selected", "ses_b", 4)) // another session, never seen started
  first.dispatch(event("orphan-end", "session.execution.failed", "ses_b", 3))
  assert.deepEqual(fed(log), ["feed first run1", "feed first run2", "feed first end2", "feed first sel"])
})

test("an end that was already passed on is not passed on again, not even after a reset", async () => {
  const { log, first, second } = await twoMembers()
  first.dispatch(event("run", "session.execution.started", "ses_a", 2))
  first.dispatch(event("end", "session.execution.succeeded", "ses_a", 3)) // above the mark: closes the run
  first.resetStream()
  second.dispatch(event("end", "session.execution.succeeded", "ses_a", 3)) // the lagging stream's copy
  assert.deepEqual(log, ["feed first run", "feed first end", "reset first"])
})

test("every other event below the mark is dropped, even while a run is open", async () => {
  const { log, first, second } = await twoMembers()
  first.dispatch(event("run", "session.execution.started", "ses_a", 2))
  second.dispatch(event("later", "session.agent.selected", "ses_a", 6))
  second.dispatch(event("delivered", "session.inbox.delivered", "ses_a", 3))
  second.dispatch(event("selected", "session.agent.selected", "ses_a", 1))
  second.dispatch(event("run2", "session.execution.started", "ses_a", 5)) // a start below the mark does not replace the open run
  second.dispatch(event("end", "session.execution.succeeded", "ses_a", 4)) // above the first run's start: it ends that run
  assert.deepEqual(fed(log), ["feed first run", "feed first later", "feed first end"])
})

test("the open run survives a stream reset and an owner promotion", async () => {
  for (const how of ["reset", "promotion"]) {
    const { log, first, second, detachFirst } = await twoMembers()
    first.dispatch(event("run", "session.execution.started", "ses_a", 2))
    second.dispatch(event("later", "session.agent.selected", "ses_a", 4))
    if (how === "reset") first.resetStream()
    else await detachFirst() // the second member owns now
    log.length = 0
    second.dispatch(event("end", "session.execution.succeeded", "ses_a", 3))
    assert.equal(fed(log).length, 1, how)
    assert.match(fed(log)[0], / end$/, how)
  }
})

// Two real members whose streams the test drives by hand, and one real delivery for `ses_a` behind the owner. The
// owner's context keeps the binding entry in a map and records every synthetic input.
async function handDrivenStreams() {
  const registry = createRegistry()
  let delivery = null
  const entries = new Map()
  const synthetic = []
  const ctx = {
    ...streamCtx([]),
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }),
      synthetic: input => { synthetic.push(input); return Promise.resolve({ id: "msg_1" }) },
      instructions: {
        entry: {
          put: async ({ key, value }) => { entries.set(key, value) },
          list: async () => [...entries].map(([key, value]) => ({ key, value })),
          remove: async ({ key }) => { entries.delete(key) },
        },
      },
    },
  }
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
    synthetic,
  }
}
const userItem = (id, sessionID = "ses_a", seq) => ({ id, type: "session.inbox.enqueued", data: { sessionID, item: { type: "user" } }, durable: durableFor(id, sessionID, seq) })
const selected = (id, seq, sessionID = "ses_a") => ({ ...event(id, "session.agent.selected", sessionID, seq), data: { sessionID, agent: "build" } })

// The session of the finding: started and finished on one stream, then a delayed duplicate of the start arrives from
// another stream long after, with many other events in between. The registry holds no id memory to run out of: the
// duplicate's seq is at or below the session's mark.
test("a delayed duplicate start from another stream does not mark an idle session running, however many events came between", async () => {
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
  rig.send("b", event("e1", "session.execution.started")) // the delayed duplicate
  await flush()
  assert.equal(delivery.heartbeatState().native_state, "idle") // still idle
  assert.notEqual(delivery.state(), null) // so no notice can be handed over
})

// Review 6004544584, finding 1. A session ended on the first stream. The first stream is lost, and a lagging stream
// replays the same events and pauses before the run end. The replay is at or below the session's mark, so it is dropped:
// it cannot make the ended session look busy, and with a published binding no notice can be claimed for it.
test("after a handoff a lagging stream's replay is dropped, so an ended session stays unclaimable even with a published binding", async () => {
  const rig = await handDrivenStreams()
  const replay = [selected("sel"), userItem("usr"), event("run", "session.execution.started")]
  const end = event("end", "session.execution.succeeded")
  for (const item of replay) rig.send("a", item)
  await flush()
  const delivery = rig.delivery()
  assert.equal(delivery.state(), null) // running with a known agent: a notice could be handed over
  rig.send("a", end)
  await flush()
  assert.equal(delivery.heartbeatState().native_state, "idle")
  await delivery.context("binding text") // the binding is published and confirmed
  rig.lose("a") // the first stream is lost: nothing is known about the session now
  await flush()
  for (const item of replay) rig.send("b", item) // the lagging stream replays up to the run start
  await flush()
  await delivery.context("binding text") // a publish after the replay
  await flush()
  assert.equal(delivery.heartbeatState().native_state, "unknown") // nothing was applied: the session is not busy
  assert.notEqual(delivery.state(), null) // so no claim
  const batch = { content: "peer notice", attemptId: "11111111-1111-4111-8111-111111111111" }
  assert.deepEqual(await delivery.deliver(batch, 5_000), { outcome: "deferred", reason: "stopped" })
  assert.equal(rig.synthetic.length, 0)
})

test("a run that starts right after another ended has a higher seq and is applied, and the old end is not", async () => {
  const rig = await handDrivenStreams()
  const end = event("end", "session.execution.succeeded")
  for (const item of [event("sel", "session.agent.selected"), userItem("usr"), event("run1", "session.execution.started"), end]) rig.send("a", item)
  rig.send("a", event("run2", "session.execution.started")) // no idle event between the two
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "busy")
  rig.send("b", end) // the first run's end, delayed on the other stream
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "busy") // it is not applied over the second run
})

// The finding's own sequence: b delivers a newer event of the session before a delivers the run end. The end is below
// the mark and ends the open run, so the session does not stay running and eligible.
test("a run end that arrives below another stream's newer event still ends the run, so the session is no longer eligible", async () => {
  const rig = await handDrivenStreams()
  rig.send("a", selected("sel", 0))
  rig.send("a", userItem("usr", "ses_a", 1))
  rig.send("a", event("run", "session.execution.started", "ses_a", 2))
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "busy")
  assert.equal(rig.delivery().state(), null) // running with a known agent: eligible
  rig.send("b", selected("again", 4)) // the other stream is ahead
  rig.send("a", event("end", "session.execution.succeeded", "ses_a", 3))
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "idle")
  assert.notEqual(rig.delivery().state(), null)
})

test("a successor started at 4 keeps the session running when the first run's end at 3 arrives late", async () => {
  const rig = await handDrivenStreams()
  rig.send("a", selected("sel", 0))
  rig.send("a", userItem("usr", "ses_a", 1))
  rig.send("a", event("run1", "session.execution.started", "ses_a", 2))
  rig.send("b", event("run2", "session.execution.started", "ses_a", 4)) // no end of the first run between them
  rig.send("a", event("end1", "session.execution.succeeded", "ses_a", 3)) // the first run's end, late
  await flush()
  assert.equal(rig.delivery().heartbeatState().native_state, "busy")
  assert.equal(rig.delivery().state(), null)
})
