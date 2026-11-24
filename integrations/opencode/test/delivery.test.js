import test from "node:test"
import assert from "node:assert/strict"
import { MAX_HOOK_DELIVERIES, createDelivery, inboxIDOf } from "../lib/delivery.js"

const flush = () => new Promise(resolve => setImmediate(resolve))
const HANDED = { outcome: "handed", reason: null }
const UNCERTAIN = { outcome: "uncertain", reason: "transport_ambiguous" }
const ATTEMPT = "11111111-2222-4333-8444-555555555555"
const OTHER = "99999999-2222-4333-8444-555555555555"

// A clock and timers the test moves by hand. `fire` is false for the tests that must prove a late event is refused by the
// deadline check and not by the timer: a timer callback can be delayed.
function fakeClock({ fire = true } = {}) {
  let time = 1000
  const timers = []
  return {
    now: () => time,
    setTimeoutImpl(fn, delay) {
      const timer = { at: time + delay, delay, fn, live: true, unref() { timer.unrefed = true } }
      timers.push(timer)
      return timer
    },
    clearTimeoutImpl(timer) { if (timer) timer.live = false },
    advance(ms) {
      time += ms
      if (!fire) return
      for (const timer of timers.filter(item => item.live && item.at <= time).sort((a, b) => a.at - b.at)) {
        timer.live = false
        timer.fn()
      }
    },
    timers,
  }
}

// The one result an attempt ends with, and whether it has ended.
function watch(attempt) {
  const seen = { results: [] }
  void attempt.done.then(result => seen.results.push(result))
  return seen
}

function opened(clock, sessionID = "ses_a", attemptID = ATTEMPT, window = 20_000) {
  const delivery = createDelivery(clock)
  const attempt = delivery.open(sessionID, { inboxID: inboxIDOf(attemptID), deadline: clock.now() + window })
  return { delivery, attempt, seen: watch(attempt), inboxID: inboxIDOf(attemptID) }
}

test("the inbox id is the msg_ prefix and the attempt's UUID without its dashes", () => {
  assert.equal(inboxIDOf(ATTEMPT), "msg_11111111222243338444555555555555")
  assert.match(inboxIDOf(ATTEMPT), /^msg_[0-9a-f]{32}$/)
})

test("handed only for the exact inbox id, before the deadline", async () => {
  const clock = fakeClock()
  const { delivery, seen, inboxID } = opened(clock)
  clock.advance(19_999)
  delivery.delivered("ses_a", inboxID)
  await flush()
  assert.deepEqual(seen.results, [HANDED])
})

test("an event for another inbox id changes nothing: only the exact id is proof, and it still settles handed", async () => {
  const clock = fakeClock()
  const { delivery, seen, inboxID } = opened(clock)
  delivery.delivered("ses_a", inboxIDOf(OTHER))
  await flush()
  assert.deepEqual(seen.results, [])
  delivery.delivered("ses_a", inboxID)
  await flush()
  assert.deepEqual(seen.results, [HANDED])
})

test("an event with no usable inbox id changes nothing", async () => {
  for (const unusable of [undefined, null, 7, "", {}, ["msg_x"]]) {
    const clock = fakeClock()
    const { delivery, seen, inboxID } = opened(clock)
    delivery.delivered("ses_a", unusable)
    await flush()
    assert.deepEqual(seen.results, [], JSON.stringify(unusable))
    delivery.delivered("ses_a", inboxID)
    await flush()
    assert.deepEqual(seen.results, [HANDED], JSON.stringify(unusable))
  }
})

test("an event for another session touches nothing", async () => {
  const clock = fakeClock()
  const { delivery, seen, inboxID } = opened(clock)
  delivery.delivered("ses_b", inboxID)
  await flush()
  assert.deepEqual(seen.results, [])
})

test("an exact event at or after the deadline is late, whether or not the timer has run", async () => {
  for (const wait of [20_000, 20_001, 60_000]) {
    const clock = fakeClock({ fire: false }) // the timer is delayed: only the deadline check can refuse the event
    const { delivery, seen, inboxID } = opened(clock)
    clock.advance(wait)
    delivery.delivered("ses_a", inboxID)
    await flush()
    assert.deepEqual(seen.results, [UNCERTAIN], `${wait}`)
  }
})

test("the deadline itself settles uncertain, and an exact event after it is ignored", async () => {
  const clock = fakeClock()
  const { delivery, seen, inboxID } = opened(clock)
  clock.advance(20_000)
  await flush()
  assert.deepEqual(seen.results, [UNCERTAIN])
  delivery.delivered("ses_a", inboxID)
  await flush()
  assert.deepEqual(seen.results, [UNCERTAIN]) // settled once
})

test("a repeat of the exact event after it settled handed settles nothing more", async () => {
  const clock = fakeClock()
  const { delivery, seen, inboxID } = opened(clock)
  delivery.delivered("ses_a", inboxID)
  delivery.delivered("ses_a", inboxID)
  await flush()
  assert.deepEqual(seen.results, [HANDED])
})

test("an old id replayed while a newer attempt is open does not touch the newer one", async () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  const first = delivery.open("ses_a", { inboxID: inboxIDOf(ATTEMPT), deadline: clock.now() + 20_000 })
  delivery.delivered("ses_a", inboxIDOf(ATTEMPT))
  const second = delivery.open("ses_a", { inboxID: inboxIDOf(OTHER), deadline: clock.now() + 20_000 })
  const seen = watch(second)
  delivery.delivered("ses_a", inboxIDOf(ATTEMPT)) // a duplicate of the first event, from a second stream
  await flush()
  assert.deepEqual(await first.done, HANDED)
  assert.deepEqual(seen.results, [])
  delivery.delivered("ses_a", inboxIDOf(OTHER))
  await flush()
  assert.deepEqual(seen.results, [HANDED])
})

test("a session has one open attempt: a newer one ends the older as uncertain", async () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  const first = delivery.open("ses_a", { inboxID: inboxIDOf(ATTEMPT), deadline: clock.now() + 20_000 })
  const older = watch(first)
  const second = delivery.open("ses_a", { inboxID: inboxIDOf(OTHER), deadline: clock.now() + 20_000 })
  const newer = watch(second)
  await flush()
  assert.deepEqual(older.results, [UNCERTAIN])
  assert.deepEqual(newer.results, [])
  delivery.delivered("ses_a", inboxIDOf(OTHER))
  await flush()
  assert.deepEqual(newer.results, [HANDED])
})

test("sessions are independent: an event settles only its own session's attempt", async () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  const a = watch(delivery.open("ses_a", { inboxID: inboxIDOf(ATTEMPT), deadline: clock.now() + 20_000 }))
  const b = watch(delivery.open("ses_b", { inboxID: inboxIDOf(OTHER), deadline: clock.now() + 20_000 }))
  delivery.delivered("ses_b", inboxIDOf(OTHER))
  await flush()
  assert.deepEqual(a.results, [])
  assert.deepEqual(b.results, [HANDED])
})

test("abandon, reset and forget each settle an open attempt uncertain, once", async () => {
  for (const end of [
    ({ attempt }) => attempt.abandon(),
    ({ delivery }) => delivery.reset(),
    ({ delivery }) => delivery.forget("ses_a"),
  ]) {
    const clock = fakeClock()
    const context = opened(clock)
    end(context)
    end(context)
    context.delivery.delivered("ses_a", context.inboxID)
    await flush()
    assert.deepEqual(context.seen.results, [UNCERTAIN])
  }
})

test("an abandon after handed changes nothing", async () => {
  const clock = fakeClock()
  const { delivery, attempt, seen, inboxID } = opened(clock)
  delivery.delivered("ses_a", inboxID)
  attempt.abandon()
  await flush()
  assert.deepEqual(seen.results, [HANDED])
})

test("the deadline timer runs for the rest of the reservation, is cleared when the attempt ends, and does not hold the process", async () => {
  const clock = fakeClock()
  const { delivery, inboxID } = opened(clock, "ses_a", ATTEMPT, 12_000)
  assert.equal(clock.timers.length, 1)
  assert.equal(clock.timers[0].delay, 12_000)
  assert.equal(clock.timers[0].unrefed, true)
  delivery.delivered("ses_a", inboxID)
  assert.equal(clock.timers[0].live, false)
})

test("a deadline already over arms a timer that runs at once", async () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  const seen = watch(delivery.open("ses_a", { inboxID: inboxIDOf(ATTEMPT), deadline: clock.now() - 5 }))
  assert.equal(clock.timers[0].delay, 0)
  clock.advance(0)
  await flush()
  assert.deepEqual(seen.results, [UNCERTAIN])
})

test("the cap is three inputs per execution and a restart clears it", () => {
  assert.equal(MAX_HOOK_DELIVERIES, 3)
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  const admit = n => delivery.open("ses_a", { inboxID: `msg_${n}`, deadline: clock.now() + 20_000 })
  for (let n = 1; n <= 3; n++) {
    assert.equal(delivery.allowed("ses_a"), true, `delivery ${n}`)
    admit(n)
  }
  assert.equal(delivery.allowed("ses_a"), false)
  assert.equal(delivery.allowed("ses_b"), true) // another session has its own allowance
  delivery.restart("ses_b") // another session's restart changes nothing here
  assert.equal(delivery.allowed("ses_a"), false)
  delivery.restart("ses_a")
  assert.equal(delivery.allowed("ses_a"), true)
})

test("an opened attempt counts toward the cap whatever becomes of the input", () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  for (let n = 1; n <= 3; n++) delivery.open("ses_a", { inboxID: `msg_${n}`, deadline: clock.now() + 20_000 }).abandon()
  assert.equal(delivery.allowed("ses_a"), false)
})

test("a stream gap ends the open attempts and keeps the count: only a restart the plugin saw clears it", () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  for (let n = 1; n <= 3; n++) delivery.open("ses_a", { inboxID: `msg_${n}`, deadline: clock.now() + 20_000 })
  delivery.reset()
  assert.equal(delivery.allowed("ses_a"), false)
})

test("a session that ended is forgotten, so the table does not grow with the sessions the process has seen", () => {
  const clock = fakeClock()
  const delivery = createDelivery(clock)
  for (let n = 1; n <= 3; n++) delivery.open("ses_a", { inboxID: `msg_${n}`, deadline: clock.now() + 20_000 })
  delivery.forget("ses_a")
  assert.equal(delivery.allowed("ses_a"), true)
})
