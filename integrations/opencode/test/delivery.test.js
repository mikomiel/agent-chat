import test from "node:test"
import assert from "node:assert/strict"
import { createDelivery } from "../lib/delivery.js"
import { BINDING_KEY, CHAT_PREFIX, CHAT_SOURCE, MAX_CONTEXT_BYTES } from "../lib/channel.js"

const SESSION = "ses_synthetic0001"
const ATTEMPT = "11111111-1111-4111-8111-111111111111"
const ATTEMPT_2 = "22222222-2222-4222-8222-222222222222"
const event = (type, data = {}) => ({ type, data: { sessionID: SESSION, ...data } })

// A double of the three plugin calls the delivery uses. `synthetic` answers through `answer`, so a test controls
// when the call resolves; instruction entries live in a map the double reads back.
function fakeCtx({ answer, putFails = false, listLies = false, removeFails = false } = {}) {
  const calls = { synthetic: [], put: [], remove: [], list: 0 }
  const entries = new Map()
  let counter = 0
  return {
    calls,
    entries,
    session: {
      synthetic(input) {
        calls.synthetic.push(input)
        return answer ? answer(input) : Promise.resolve({ id: `msg_${++counter}`, sessionID: SESSION })
      },
      instructions: {
        entry: {
          async put(input) {
            calls.put.push(input)
            if (putFails) throw new Error("unavailable")
            entries.set(input.key, input.value)
          },
          async list() {
            calls.list += 1
            if (listLies) return []
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove(input) {
            calls.remove.push(input)
            if (removeFails) throw new Error("unavailable")
            entries.delete(input.key)
          },
        },
      },
    },
  }
}

function timers() {
  const all = []
  return {
    all,
    setTimeoutImpl(fn, ms) { const timer = { fn, ms, cleared: false }; all.push(timer); return timer },
    clearTimeoutImpl(timer) { if (timer) timer.cleared = true },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

// A running, chat-eligible session: an operator prompt, an agent, a started run.
function running(ctx = fakeCtx(), extra = {}) {
  const clock = timers()
  const delivery = createDelivery(ctx, SESSION, { now: () => extra.now?.() ?? 1_000, ...clock })
  delivery.seed({ agent: "build" })
  delivery.observe(event("session.inbox.enqueued", { inboxID: "msg_user", item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  return { ctx, clock, delivery }
}

const batch = (attemptId = ATTEMPT) => ({ content: "peer notice", attemptId })

test("state: a new session is stopped, then unknown until an event shows the run", () => {
  const delivery = createDelivery(fakeCtx(), SESSION)
  assert.equal(delivery.state(), "stopped")
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  assert.equal(delivery.state(), "unknown") // no agent yet
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  assert.equal(delivery.state(), "unknown") // no run state yet
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), null)
})

test("state: the plan agent, an idle session, a compaction and a pending input block a claim", async () => {
  const { delivery } = running()
  delivery.observe(event("session.agent.selected", { agent: "plan" }))
  assert.equal(delivery.state(), "plan")
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  assert.equal(delivery.state(), null)
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  assert.equal(delivery.state(), "busy")
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.state(), "busy") // ended is not enough: the binding entry is read back first
  await delivery.verifyContext() // nothing is published here, so there is nothing to put back
  assert.equal(delivery.state(), null)
  delivery.observe(event("session.execution.succeeded"))
  // Idle is a known state, but this release never wakes an idle session; it must not be claimed for.
  assert.equal(delivery.state(), "unknown")
})

test("state: disabled and disposed are refused with their own reasons", () => {
  const first = running().delivery
  first.disable()
  assert.equal(first.state(), "offline")
  const second = running().delivery
  second.dispose()
  assert.equal(second.state(), "stale_binding")
})

test("heartbeat: busy, idle and unknown map to the core's three native states", () => {
  const { delivery } = running()
  assert.deepEqual(delivery.heartbeatState(), { native_state: "busy", stopped: false, plan_mode: false })
  delivery.observe(event("session.execution.succeeded"))
  assert.deepEqual(delivery.heartbeatState(), { native_state: "idle", stopped: false, plan_mode: false })
  delivery.reset()
  assert.deepEqual(delivery.heartbeatState(), { native_state: "unknown", stopped: true, plan_mode: false })
})

test("heartbeat: a session no event has described reports unknown and stopped, never idle", () => {
  const delivery = createDelivery(fakeCtx(), SESSION)
  assert.deepEqual(delivery.heartbeatState(), { native_state: "unknown", stopped: true, plan_mode: false })
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  // A run with no known agent cannot be classified for Plan Mode.
  assert.deepEqual(delivery.heartbeatState(), { native_state: "busy", stopped: true, plan_mode: false })
})

test("heartbeat: the plan agent reports plan mode, and a stopped or disabled session reports stopped", () => {
  const { delivery } = running()
  delivery.observe(event("session.agent.selected", { agent: "plan" }))
  assert.deepEqual(delivery.heartbeatState(), { native_state: "busy", stopped: false, plan_mode: true })
  delivery.observe(event("session.execution.interrupted", { reason: "user" }))
  assert.equal(delivery.heartbeatState().stopped, true)
  delivery.disable()
  assert.deepEqual(delivery.heartbeatState(), { native_state: "unknown", stopped: true, plan_mode: false })
})

test("an operator interrupt latches stop and only a user input clears it", () => {
  const { delivery } = running()
  for (const reason of ["shutdown", "superseded", "inactivity"]) {
    delivery.observe(event("session.execution.interrupted", { reason }))
    assert.notEqual(delivery.state(), "stopped", reason)
    delivery.observe(event("session.execution.started"))
  }
  delivery.observe(event("session.execution.interrupted", { reason: "user" }))
  assert.equal(delivery.state(), "stopped")
  delivery.observe(event("session.execution.started"))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "synthetic", payload: { metadata: { source: CHAT_SOURCE } } } }))
  assert.equal(delivery.state(), "stopped") // this adapter's own input is not a user prompt
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  assert.equal(delivery.state(), null)
})

test("observe reports a state change only for events that change what a heartbeat shows", () => {
  const { delivery } = running()
  assert.equal(delivery.observe(event("session.execution.succeeded")), true)
  assert.equal(delivery.observe(event("session.agent.selected", { agent: "plan" })), true)
  assert.equal(delivery.observe(event("session.inbox.delivered", { inboxID: "msg_x" })), false)
  assert.equal(delivery.observe(event("session.viewed")), false)
  assert.equal(delivery.observe(null), false)
})

test("a delivery issues one steer input with resume false and is handed only by its delivered event", async () => {
  const { ctx, delivery } = running()
  const result = delivery.deliver(batch(), 5_000)
  await flush()
  assert.equal(ctx.calls.synthetic.length, 1)
  const call = ctx.calls.synthetic[0]
  assert.equal(call.sessionID, SESSION)
  assert.equal(call.delivery, "steer")
  assert.equal(call.resume, false)
  assert.equal(call.text, `${CHAT_PREFIX}peer notice`)
  assert.deepEqual(call.metadata, { source: CHAT_SOURCE })
  // Issued is not delivered: the promise stays open, and no second claim may start.
  assert.equal(delivery.state(), "busy")
  delivery.observe(event("session.inbox.delivered", { inboxID: "someone-else" }))
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" }))
  assert.deepEqual(await result, { outcome: "handed", reason: null })
  assert.equal(delivery.state(), null)
})

test("a delivered event that arrives before the call returns still hands over", async () => {
  let release
  const ctx = fakeCtx({ answer: () => new Promise(resolve => { release = resolve }) })
  const { delivery } = running(ctx)
  const result = delivery.deliver(batch(), 5_000)
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_early" }))
  release({ id: "msg_early" })
  assert.deepEqual(await result, { outcome: "handed", reason: null })
})

test("a cancelled input proves nothing ran: deferred, not handed", async () => {
  const { delivery } = running()
  const result = delivery.deliver(batch(), 5_000)
  await flush()
  delivery.observe(event("session.inbox.cancelled", { inboxID: "msg_1" }))
  assert.deepEqual(await result, { outcome: "deferred", reason: "stopped" })
})

test("HAZARD: a run that ends before delivery is uncertain, and a later delivered event is inert", async () => {
  for (const end of [
    event("session.execution.interrupted", { reason: "user" }),
    event("session.execution.interrupted", { reason: "shutdown" }),
    event("session.execution.succeeded"),
    event("session.execution.failed", { error: { type: "x", message: "y" } }),
  ]) {
    const { ctx, delivery } = running()
    const stale = delivery.deliver(batch(ATTEMPT), 5_000)
    await flush()
    delivery.observe(end)
    assert.deepEqual(await stale, { outcome: "uncertain", reason: "transport_ambiguous" }, end.type)
    // The parked input drains into a later, unrelated prompt: it must not turn the old attempt into a hand-over,
    // and it must not satisfy the next attempt.
    delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" }))
    delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
    delivery.observe(event("session.execution.started"))
    const next = delivery.deliver(batch(ATTEMPT_2), 5_000)
    await flush()
    assert.equal(ctx.calls.synthetic.length, 2)
    delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" })) // the stale id again
    delivery.observe(event("session.execution.succeeded"))
    assert.deepEqual(await next, { outcome: "uncertain", reason: "transport_ambiguous" }, `${end.type} next`)
  }
})

test("a run that ends while the call is still open is uncertain, and the late answer changes nothing", async () => {
  let release
  const ctx = fakeCtx({ answer: () => new Promise(resolve => { release = resolve }) })
  const { delivery } = running(ctx)
  const result = delivery.deliver(batch(), 5_000)
  delivery.observe(event("session.execution.succeeded"))
  assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" })
  release({ id: "msg_late" })
  await flush()
  assert.equal(delivery.state(), "unknown")
})

test("a throwing or rejecting call is uncertain: the input may exist", async () => {
  const rejecting = running(fakeCtx({ answer: () => Promise.reject(new Error("transport")) })).delivery
  assert.deepEqual(await rejecting.deliver(batch(), 5_000), { outcome: "uncertain", reason: "transport_ambiguous" })
  const ctx = fakeCtx({ answer: () => { throw new Error("sync") } })
  const throwing = running(ctx).delivery
  assert.deepEqual(await throwing.deliver(batch(), 5_000), { outcome: "uncertain", reason: "transport_ambiguous" })
  const malformed = running(fakeCtx({ answer: () => Promise.resolve({}) })).delivery
  assert.deepEqual(await malformed.deliver(batch(), 5_000), { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("no delivered event before the reservation deadline is uncertain", async () => {
  let current = 1_000
  const { clock, delivery } = running(fakeCtx(), { now: () => current })
  const result = delivery.deliver(batch(), 4_000)
  await flush()
  assert.equal(clock.all.length, 1)
  assert.equal(clock.all[0].ms, 3_000)
  current = 4_000
  clock.all[0].fn()
  assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(delivery.state(), null) // the pending slot is free again; a late delivered event is inert
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" }))
})

test("a refused state returns deferred with the state's reason and issues no call", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  delivery.observe(event("session.agent.selected", { agent: "plan" }))
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "deferred", reason: "plan" })
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.execution.succeeded")) // idle after the claim
  assert.deepEqual(await delivery.deliver(batch(ATTEMPT_2), 5_000), { outcome: "deferred", reason: "unknown" })
  assert.equal(ctx.calls.synthetic.length, 0)
})

test("bad input, a repeated attempt, a spent reservation and an oversized notice are refused before any call", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  assert.deepEqual(await delivery.deliver({ content: "", attemptId: ATTEMPT }, 5_000), { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(await delivery.deliver({ content: "x", attemptId: "not-a-uuid" }, 5_000), { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(await delivery.deliver({ content: "x", attemptId: ATTEMPT }, Number.NaN), { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(
    await delivery.deliver({ content: "x".repeat(MAX_CONTEXT_BYTES), attemptId: ATTEMPT }, 5_000),
    { outcome: "failed", reason: "native_unavailable" },
  )
  assert.deepEqual(await delivery.deliver(batch(), 1_000), { outcome: "uncertain", reason: "transport_ambiguous" }) // spent
  assert.equal(ctx.calls.synthetic.length, 0)
  const first = delivery.deliver(batch(), 5_000)
  await flush()
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" }))
  assert.equal((await first).outcome, "handed")
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "uncertain", reason: "transport_ambiguous" }) // replay
})

test("a lost event stream makes a pending input uncertain and the state stopped", async () => {
  const { delivery } = running()
  const result = delivery.deliver(batch(), 5_000)
  await flush()
  delivery.reset()
  assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(delivery.state(), "stopped")
  assert.equal(delivery.heartbeatState().native_state, "unknown")
})

test("disable and dispose settle a pending input as uncertain and latch the object", async () => {
  for (const close of ["disable", "dispose"]) {
    const { delivery } = running()
    const result = delivery.deliver(batch(), 5_000)
    await flush()
    delivery[close]()
    assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" }, close)
    assert.deepEqual(await delivery.deliver(batch(ATTEMPT_2), 5_000), { outcome: "failed", reason: "native_unavailable" }, close)
  }
})

test("context: the binding is put under one key, confirmed by a read-back, and replaced on a rejoin", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding one")
  assert.deepEqual(ctx.calls.put[0], { sessionID: SESSION, key: BINDING_KEY, value: "binding one" })
  assert.match(BINDING_KEY, /^[a-z0-9][a-z0-9._-]*$/)
  await delivery.context("binding two")
  assert.equal(ctx.calls.put.length, 2)
  assert.deepEqual([...ctx.entries], [[BINDING_KEY, "binding two"]]) // replaced, never appended
  await delivery.context(null)
  assert.equal(ctx.entries.size, 0)
  assert.deepEqual(ctx.calls.remove, [{ sessionID: SESSION, key: BINDING_KEY }])
})

test("context: an unavailable or unconfirmed entry rejects, so the session's chat can fail closed", async () => {
  await assert.rejects(running(fakeCtx({ putFails: true })).delivery.context("text"), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  await assert.rejects(running(fakeCtx({ listLies: true })).delivery.context("text"), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  await assert.rejects(running().delivery.context(""), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  await assert.rejects(running().delivery.context(42), { code: "CHAT_CONTEXT_UNAVAILABLE" })
})

test("context: a failing removal is not an error and a disposed object publishes nothing", async () => {
  const ctx = fakeCtx({ removeFails: true })
  const { delivery } = running(ctx)
  await delivery.context("text")
  await delivery.context(null)
  delivery.dispose()
  await delivery.context("after")
  assert.equal(ctx.calls.put.length, 1)
})

test("context: a compaction that dropped the entry is repaired, and an intact entry is left alone", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.verifyContext() // nothing published yet
  assert.equal(ctx.calls.put.length, 0)
  await delivery.context("binding")
  await delivery.verifyContext()
  assert.equal(ctx.calls.put.length, 1)
  ctx.entries.clear()
  await delivery.verifyContext()
  assert.equal(ctx.calls.put.length, 2)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  ctx.entries.set(BINDING_KEY, "stale")
  await delivery.verifyContext()
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
})

test("context: operations run in order, so a clear never overtakes a publish", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  const publish = delivery.context("binding")
  const clear = delivery.context(null)
  await Promise.all([publish, clear])
  assert.equal(ctx.entries.size, 0)
})

// Review 6003128773, finding 2: the gate stays closed from the compaction until the binding is read back.
test("a compaction keeps claims and native sends blocked until the binding read-back succeeds", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  let releaseList
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { await new Promise(resolve => { releaseList = resolve }); return list() }
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.state(), "busy") // ended is not proof that the entry survived
  const verifying = delivery.verifyContext()
  await flush()
  assert.equal(delivery.state(), "busy")
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "deferred", reason: "busy" })
  assert.equal(ctx.calls.synthetic.length, 0)
  releaseList()
  await verifying
  assert.equal(delivery.state(), null)
})

test("a compaction whose read-back fails never reopens the gate", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  ctx.entries.clear() // the compaction dropped the entry
  ctx.session.instructions.entry.put = async () => { throw new Error("unavailable") }
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.deepEqual(await readBack(delivery), { outcome: "failed", failures: ["CHAT_CONTEXT_UNAVAILABLE"] })
  assert.equal(delivery.state(), "busy")
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "deferred", reason: "busy" })
  assert.equal(ctx.calls.synthetic.length, 0)
})

test("a read-back that finishes after a second compaction ended does not reopen the gate", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  const releases = []
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { await new Promise(resolve => releases.push(resolve)); return list() }
  delivery.observe(event("session.compaction.ended"))
  const first = delivery.verifyContext()
  await flush()
  delivery.observe(event("session.compaction.started"))
  delivery.observe(event("session.compaction.ended"))
  const second = delivery.verifyContext()
  await flush()
  releases[0]()
  await first
  assert.equal(delivery.state(), "busy") // the second compaction has not been read back yet
  await flush() // the queue is serial: the second read-back starts only now
  releases[1]()
  await second
  assert.equal(delivery.state(), null)
})

// Finding 5: after a gap both the agent and the stop latch are only what the events last showed.
test("a stream gap makes the selected agent unknown again, so Plan Mode needs fresh evidence", async () => {
  const { delivery } = running()
  assert.equal(delivery.state(), null)
  delivery.reset()
  await delivery.verifyContext() // a gap also needs the binding read back; nothing is published here
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "unknown") // the old `build` selection is not carried over
  delivery.observe(event("session.agent.selected", { agent: "plan" }))
  assert.equal(delivery.state(), "plan")
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  assert.equal(delivery.state(), null)
})

test("a stream gap latches stop again, so a missed operator interrupt cannot stay hidden", async () => {
  const { delivery } = running()
  delivery.reset()
  await delivery.verifyContext() // a gap also needs the binding read back; nothing is published here
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "stopped") // the cleared latch is not carried over
  assert.equal(delivery.heartbeatState().stopped, true)
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  assert.equal(delivery.state(), null)
})

// Finding 6: the absolute deadline is checked when a receipt arrives, not only when the timer runs.
test("a delivered event after the absolute deadline is uncertain even when the timer has not run", async () => {
  let current = 1_000
  const { clock, delivery } = running(fakeCtx(), { now: () => current })
  const result = delivery.deliver(batch(), 4_000)
  await flush()
  current = 4_500 // past the deadline; the delayed timer callback has not run
  assert.equal(clock.all[0].cleared, false)
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" }))
  assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a cancelled event after the absolute deadline is uncertain, not a definite refusal", async () => {
  let current = 1_000
  const { delivery } = running(fakeCtx(), { now: () => current })
  const result = delivery.deliver(batch(), 4_000)
  await flush()
  current = 4_000 // the deadline itself is already late
  delivery.observe(event("session.inbox.cancelled", { inboxID: "msg_1" }))
  assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a synthetic result after the absolute deadline is uncertain although its delivered event was seen", async () => {
  let current = 1_000
  let release
  const ctx = fakeCtx({ answer: () => new Promise(resolve => { release = resolve }) })
  const { delivery } = running(ctx, { now: () => current })
  const result = delivery.deliver(batch(), 4_000)
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_early" })) // before the call returned
  current = 4_200
  release({ id: "msg_early" })
  assert.deepEqual(await result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a receipt before the absolute deadline is still handed", async () => {
  let current = 1_000
  const { delivery } = running(fakeCtx(), { now: () => current })
  const result = delivery.deliver(batch(), 4_000)
  await flush()
  current = 3_999
  delivery.observe(event("session.inbox.delivered", { inboxID: "msg_1" }))
  assert.deepEqual(await result, { outcome: "handed", reason: null })
})

// Review 6003305717, finding 2: a gap invalidates the binding proof.
test("a stream gap closes the gate until the binding is read back, whatever fresh events follow", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  ctx.entries.clear() // a compaction removed the entry, and the event that ends it fell into the gap
  delivery.reset()
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "busy")
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "deferred", reason: "busy" })
  assert.equal(ctx.calls.synthetic.length, 0)
  await delivery.verifyContext()
  assert.equal(ctx.entries.get(BINDING_KEY), "binding") // put back
  assert.equal(delivery.state(), null)
})

test("a read-back that began before a gap does not reopen the gate", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  const releases = []
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { await new Promise(resolve => releases.push(resolve)); return list() }
  delivery.reset()
  const first = delivery.verifyContext()
  await flush()
  delivery.reset() // the stream broke again while the first read-back was running
  const second = delivery.verifyContext()
  releases[0]()
  await first
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "busy") // the second gap has not been read back yet
  await flush()
  releases[1]()
  await second
  assert.equal(delivery.state(), null)
})

test("a read-back that fails after a gap keeps the gate closed", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  ctx.entries.clear()
  ctx.session.instructions.entry.put = async () => { throw new Error("unavailable") }
  delivery.reset()
  assert.deepEqual(await readBack(delivery), { outcome: "failed", failures: ["CHAT_CONTEXT_UNAVAILABLE"] })
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "busy")
  assert.equal(ctx.calls.synthetic.length, 0)
})

// Review 6003407206, finding 1: a gap does not end a compaction that was already observed running.
test("a compaction that spans a gap keeps the gate closed and the read-back owed, until its own end", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.reset() // the stream broke while the compaction ran
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.needsReadBack(), false) // owed, but not while the compaction runs: the gap did not end it
  const lists = ctx.calls.list
  await delivery.verifyContext() // asked for anyway: it reads nothing and proves nothing
  assert.equal(ctx.calls.list, lists)
  assert.equal(delivery.state(), "busy")
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "deferred", reason: "busy" })
  assert.equal(ctx.calls.synthetic.length, 0)
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.state(), "busy") // the end is not enough: the entry is read back first
  assert.equal(delivery.needsReadBack(), true)
  await delivery.verifyContext()
  assert.equal(ctx.calls.list, lists + 1)
  assert.equal(delivery.needsReadBack(), false)
  assert.equal(delivery.state(), null)
})

test("a compaction that fails after a gap clears with its terminal event, and the gap's read-back reopens the gate", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.reset()
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "busy")
  assert.equal(delivery.needsReadBack(), false)
  delivery.observe(event("session.compaction.failed", { reason: "auto" }))
  assert.equal(delivery.needsReadBack(), true) // the gap's read-back was owed all along, and may start now
  assert.equal(delivery.state(), "busy") // and it is still owed
  await delivery.verifyContext()
  assert.equal(delivery.state(), null)
})

// Review 6003513413, finding 1: whether a compaction runs is checked where the read would start, not when it is asked for.
test("a read-back queued behind an earlier operation does not read once a compaction began, and stays owed", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  const list = ctx.session.instructions.entry.list
  let lists = 0
  let releaseList = null
  ctx.session.instructions.entry.list = async () => {
    lists += 1
    if (lists === 1) await new Promise(resolve => { releaseList = resolve }) // the earlier operation's own check
    return list()
  }
  const earlier = delivery.context("binding")
  await flush()
  assert.equal(typeof releaseList, "function")
  delivery.reset() // a read-back is owed
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  const read = delivery.verifyContext() // queued behind the earlier operation
  delivery.observe(event("session.compaction.started", { reason: "auto" })) // begins before the read can
  releaseList()
  await earlier
  await read
  assert.equal(lists, 1) // no read began mid-compaction
  assert.equal(delivery.state(), "busy")
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.state(), "busy") // still owed: the skipped read proved nothing
  await delivery.verifyContext()
  assert.equal(lists, 2) // the read runs once the compaction has ended
  assert.equal(delivery.state(), null)
})

test("a read-back is asked for once per obligation, and again after a newer one", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  assert.equal(delivery.needsReadBack(), false) // nothing is owed
  delivery.reset()
  assert.equal(delivery.needsReadBack(), true)
  const first = delivery.verifyContext()
  assert.equal(delivery.needsReadBack(), false) // queued for this gap already
  delivery.reset() // a second gap makes the queued read prove nothing
  assert.equal(delivery.needsReadBack(), true)
  await first
  assert.equal(delivery.needsReadBack(), true)
  await delivery.verifyContext()
  assert.equal(delivery.needsReadBack(), false)
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.needsReadBack(), true)
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.deepEqual(await readBack(delivery), { outcome: "failed", failures: ["CHAT_CONTEXT_UNAVAILABLE"] })
  assert.equal(delivery.needsReadBack(), false) // a read that failed is not asked for again in the same epoch
})

// Review 6003597565, findings 1 and 2: every host call of a read-back is made only while the read-back may still touch the host.
// Wraps one host call so that its first invocation waits until the test settles it.
function holdFirst(target, name) {
  const original = target[name]
  const held = { entered: false, settle: null }
  target[name] = async (...args) => {
    if (held.entered) return original(...args)
    held.entered = true
    await new Promise((resolve, reject) => { held.settle = { resolve, reject } })
    return original(...args)
  }
  return held
}

// A session that has just had a gap: the entry is gone, a read-back is owed, and fresh events show a running session.
async function gapped() {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  ctx.entries.clear() // a compaction dropped the entry
  delivery.reset()
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  return { ctx, delivery, calls: { lists: ctx.calls.list, puts: ctx.calls.put.length } }
}

test("a compaction that begins while the first list is pending stops the repair before any put", async () => {
  const { ctx, delivery, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = delivery.verifyContext()
  await flush()
  assert.equal(held.entered, true)
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  held.settle.resolve() // the list answers: no binding
  await read // resolves: nothing failed
  assert.equal(ctx.calls.put.length, calls.puts) // no put
  assert.equal(ctx.calls.list, calls.lists + 1) // and no second list
  assert.equal(delivery.state(), "busy")
  assert.equal(delivery.needsReadBack(), false) // still owed, but not while it compacts
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.needsReadBack(), true)
  await delivery.verifyContext()
  assert.equal(ctx.entries.get(BINDING_KEY), "binding") // the repair runs after the end
  assert.equal(delivery.state(), null)
})

test("a compaction that begins while the repair put is pending stops the read-back before the confirming list", async () => {
  const { ctx, delivery, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "put")
  const read = delivery.verifyContext()
  await flush()
  assert.equal(held.entered, true)
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  held.settle.resolve()
  await read
  assert.equal(ctx.calls.list, calls.lists + 1) // only the first list: the confirming one was not made
  assert.equal(delivery.state(), "busy")
  assert.equal(delivery.needsReadBack(), false)
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  await delivery.verifyContext()
  assert.equal(ctx.calls.list, calls.lists + 2) // the read-back runs again after the end
  assert.equal(delivery.state(), null)
})

test("a read that fails while a compaction began during it is ignored, and the check stays owed", async () => {
  const { ctx, delivery } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = delivery.verifyContext()
  await flush()
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  held.settle.reject(new Error("unavailable"))
  await read // not a context failure: the check overlapped a compaction
  assert.equal(delivery.state(), "busy")
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.needsReadBack(), true)
  await delivery.verifyContext()
  assert.equal(delivery.state(), null)
})

test("a read that overlapped a compaction that began and failed inside one host call is ignored too", async () => {
  const { ctx, delivery } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = delivery.verifyContext()
  await flush()
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.observe(event("session.compaction.failed", { reason: "auto" })) // nothing is compacting again when the call fails
  held.settle.reject(new Error("unavailable"))
  await read // not a context failure: the compaction overlapped the call
  assert.equal(delivery.state(), "busy")
  assert.equal(delivery.needsReadBack(), true) // still owed, and may start again now
  await delivery.verifyContext()
  assert.equal(delivery.state(), null)
})

test("a read that succeeds across a compaction that began and failed does not clear the obligation", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  delivery.reset()
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = delivery.verifyContext()
  await flush()
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.observe(event("session.compaction.failed", { reason: "auto" }))
  held.settle.resolve() // the entry is there, but the read overlapped a compaction
  await read
  assert.equal(delivery.state(), "busy")
  assert.equal(delivery.needsReadBack(), true)
  await delivery.verifyContext()
  assert.equal(delivery.state(), null)
})

test("a read that fails with no compaction and no newer gap is a context failure", async () => {
  const { ctx, delivery } = await gapped()
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.deepEqual(await readBack(delivery), { outcome: "failed", failures: ["CHAT_CONTEXT_UNAVAILABLE"] })
})

test("a read-back queued behind an earlier operation does no I/O after a newer gap, and its failure is ignored", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  const entry = ctx.session.instructions.entry
  const base = entry.list
  let attempts = 0
  entry.list = async (...args) => { attempts += 1; if (attempts > 1) throw new Error("unavailable"); return base(...args) }
  const held = holdFirst(entry, "list")
  const earlier = delivery.context("binding") // its own check is held, so later context operations queue behind it
  await flush()
  assert.equal(held.entered, true)
  delivery.reset()
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  const stale = delivery.verifyContext() // queued behind the earlier operation
  delivery.reset() // a newer gap supersedes it
  held.settle.resolve()
  await earlier
  await stale // resolves: a superseded check neither reads nor fails
  assert.equal(attempts, 1) // only the earlier operation's own list
  assert.equal(delivery.needsReadBack(), true) // the newest gap still owes its own check
  entry.list = base
  await delivery.verifyContext()
  assert.equal(delivery.needsReadBack(), false)
})

// Review 6003650164, findings 1 and 2: one currency rule. A read-back asks, after every host call it awaits and before it
// acts on a failure, whether it is still the check this obligation and this binding call for. It never rejects: it
// reports "proved", "stale" or "failed", and it calls `onFailed` itself, in the same step as that decision.
async function readBack(delivery) {
  const failures = []
  const outcome = await delivery.verifyContext(error => failures.push(error.code))
  return { outcome, failures }
}

test("a read-back whose check holds proves the binding, and one that fails reports failed through its callback", async () => {
  const { ctx, delivery } = await gapped()
  assert.deepEqual(await readBack(delivery), { outcome: "proved", failures: [] })
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  delivery.reset()
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.deepEqual(await readBack(delivery), { outcome: "failed", failures: ["CHAT_CONTEXT_UNAVAILABLE"] })
  assert.notEqual(delivery.state(), null) // the gate stays closed
  assert.equal(delivery.needsReadBack(), false) // and a failed read is not asked for again in the same epoch
})

test("a read-back whose failure callback throws still resolves with its outcome", async () => {
  const { ctx, delivery } = await gapped()
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.equal(await delivery.verifyContext(() => { throw new Error("handler broke") }), "failed")
})

test("a withdrawn binding is not put back: the binding is cleared while the first list is pending", async () => {
  const { ctx, delivery, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const failures = []
  const read = delivery.verifyContext(error => failures.push(error.code))
  await flush()
  assert.equal(held.entered, true)
  const cleared = delivery.context(null) // a heartbeat answered STALE_INSTANCE: the binding is withdrawn, the entry removed
  held.settle.resolve() // the list answers: no entry
  assert.equal(await read, "stale")
  await cleared
  assert.equal(ctx.calls.put.length, calls.puts) // the withdrawn text was never put
  assert.equal(ctx.calls.list, calls.lists + 1) // and nothing was read after it
  assert.deepEqual(failures, [])
  assert.equal(ctx.entries.has(BINDING_KEY), false)
  // The rejoin publishes its new binding. The obligation is still owed: the next event asks again, and until that
  // check proves the new binding the gate stays closed.
  await delivery.context("binding two")
  assert.equal(ctx.entries.get(BINDING_KEY), "binding two")
  assert.equal(delivery.state(), "busy")
  assert.equal(delivery.needsReadBack(), true)
  assert.deepEqual(await readBack(delivery), { outcome: "proved", failures: [] })
  assert.equal(delivery.state(), null)
})

test("a failed list is not a failure once the binding it was for is withdrawn", async () => {
  const { ctx, delivery } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const failures = []
  const read = delivery.verifyContext(error => failures.push(error.code))
  await flush()
  void delivery.context(null)
  held.settle.reject(new Error("unavailable"))
  assert.equal(await read, "stale")
  assert.deepEqual(failures, []) // chat stays on, and the rejoin goes on
  await delivery.context("binding two")
  assert.deepEqual(await readBack(delivery), { outcome: "proved", failures: [] })
})

test("a replaced binding with the same text is still a different binding", async () => {
  const { ctx, delivery, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = delivery.verifyContext()
  await flush()
  const replaced = delivery.context("binding") // the same text, published again by a rejoin: the old check is not for this binding
  held.settle.resolve()
  assert.equal(await read, "stale")
  await replaced
  assert.equal(ctx.calls.put.length, calls.puts + 1) // only the new call's own put
  assert.equal(delivery.needsReadBack(), true)
})

test("a confirming list that answers after the binding was withdrawn proves nothing", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  delivery.reset() // a gap: the entry is still there
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = delivery.verifyContext()
  await flush()
  void delivery.context(null)
  held.settle.resolve() // the entry is there, but the binding it names is withdrawn
  assert.equal(await read, "stale")
  assert.equal(delivery.needsReadBack(), true) // the obligation is still owed
})

test("a read-back that is closed or disabled while a host call is pending does not act on its failure", async () => {
  for (const end of ["disable", "dispose"]) {
    const { ctx, delivery } = await gapped()
    const held = holdFirst(ctx.session.instructions.entry, "list")
    const failures = []
    const read = delivery.verifyContext(error => failures.push(error.code))
    await flush()
    delivery[end]()
    held.settle.reject(new Error("unavailable"))
    assert.equal(await read, "stale", end)
    assert.deepEqual(failures, [], end)
  }
})

// Finding 4 (non-blocking): reservation arithmetic and receipt checks share one monotonic clock.
test("the default clock is monotonic: a wall-clock step cannot decide whether a reservation is over", async t => {
  const realNow = Date.now
  Date.now = () => 0 // the wall clock reads 0, whatever the monotonic clock says
  t.after(() => { Date.now = realNow })
  const ctx = fakeCtx()
  const delivery = createDelivery(ctx, SESSION)
  delivery.seed({ agent: "build" })
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  const result = await delivery.deliver(batch(), performance.now() - 1) // already over on the monotonic clock
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(ctx.calls.synthetic.length, 0)
})
