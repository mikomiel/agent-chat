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
  await assert.rejects(delivery.verifyContext(), { code: "CHAT_CONTEXT_UNAVAILABLE" })
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
  await assert.rejects(delivery.verifyContext(), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  assert.equal(delivery.state(), "busy")
  assert.equal(ctx.calls.synthetic.length, 0)
})

// Review 6003407206, finding 1: a gap does not end a compaction that was already observed running.
test("a compaction that spans a gap keeps the gate closed even after a read-back, until its own end", async () => {
  const ctx = fakeCtx()
  const { delivery } = running(ctx)
  await delivery.context("binding")
  delivery.observe(event("session.compaction.started", { reason: "auto" }))
  delivery.reset() // the stream broke while the compaction ran
  assert.equal(delivery.isCompacting(), true) // the gap does not end it
  delivery.observe(event("session.agent.selected", { agent: "build" }))
  delivery.observe(event("session.inbox.enqueued", { item: { type: "user" } }))
  delivery.observe(event("session.execution.started"))
  await delivery.verifyContext() // proves the entry exists, not that the compaction ended
  assert.equal(delivery.state(), "busy")
  assert.deepEqual(await delivery.deliver(batch(), 5_000), { outcome: "deferred", reason: "busy" })
  assert.equal(ctx.calls.synthetic.length, 0)
  delivery.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(delivery.isCompacting(), false)
  assert.equal(delivery.state(), "busy") // the end is not enough: the entry is read back once more
  await delivery.verifyContext()
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
  delivery.observe(event("session.compaction.failed", { reason: "auto" }))
  assert.equal(delivery.isCompacting(), false)
  assert.equal(delivery.state(), "busy") // the gap's read-back is still owed
  await delivery.verifyContext()
  assert.equal(delivery.state(), null)
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
