import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { LEASE_SECONDS, createLease } from "../lib/lease.js"

const models = readFileSync(new URL("../../../agent_chat/models.py", import.meta.url), "utf8")
const constant = name => Number(models.match(new RegExp(`^${name} = ([0-9.]+)$`, "m"))?.[1])

test("the lease length matches the product core", () => {
  assert.equal(LEASE_SECONDS, constant("LEASE_SECONDS"))
})

// A monotonic clock, a wall clock and timers that move only when the test moves them. The two clocks tick together: the wall
// clock reads epoch milliseconds, far from the monotonic reading, and jumpWall() moves it alone, as a suspend or a clock step
// does. advance() runs the timers that fall due, in order, with the clocks set to the moment each one was due; set() moves
// both clocks without running a timer and fire() runs the next timer where it stands.
function fakeTime() {
  let now = 0
  let skew = 1_700_000_000_000
  let next = 1
  const timers = new Map()
  return {
    clock: () => now,
    wall: () => now + skew,
    jumpWall: ms => { skew += ms },
    setTimeoutImpl: (fn, ms) => { timers.set(next, { fn, at: now + ms, ms }); return next++ },
    clearTimeoutImpl: id => { timers.delete(id) },
    timers,
    set: value => { now = value },
    fire() { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn() },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = target
    },
  }
}

function tracker() {
  const time = fakeTime()
  const changes = [] // the clock reading at each onChange
  const lease = createLease({
    clock: time.clock, wall: time.wall, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl,
    onChange: () => changes.push(time.clock()),
  })
  return { time, lease, changes }
}

test("a confirmed request runs the lease to its send time plus the lease length, not to its reply", () => {
  const { time, lease } = tracker()
  const stamp = lease.stamp() // sent at 0
  time.advance(40_000) // and answered 40 s later
  lease.confirm(stamp)
  time.advance(49_999)
  assert.equal(lease.expired(), false, "89.999 s after the send")
  time.advance(1)
  assert.equal(lease.expired(), true, "90 s after the send")
})

test("one timer sits on the deadline and reports the lapse once", () => {
  const { time, lease, changes } = tracker()
  lease.confirm(lease.stamp())
  assert.deepEqual([...time.timers.values()].map(timer => timer.ms), [LEASE_SECONDS * 1000])
  time.advance(89_999)
  assert.deepEqual(changes, [])
  time.advance(1)
  assert.deepEqual(changes, [90_000])
  time.advance(600_000)
  assert.deepEqual(changes, [90_000], "reported once")
  assert.equal(time.timers.size, 0)
})

test("a later confirm renews the deadline, and one after the lapse restores the lease and reports it", () => {
  const { time, lease, changes } = tracker()
  lease.confirm(lease.stamp())
  time.advance(30_000)
  lease.confirm(lease.stamp()) // a renewal: the timer moves to the new deadline
  assert.equal(time.timers.size, 1)
  time.advance(89_999)
  assert.equal(lease.expired(), false)
  time.advance(1)
  assert.deepEqual(changes, [120_000])
  assert.equal(lease.expired(), true)
  lease.confirm(lease.stamp())
  assert.equal(lease.expired(), false)
  assert.deepEqual(changes, [120_000, 120_000], "the restore is reported too")
  time.advance(89_999)
  assert.equal(lease.expired(), false)
  time.advance(1)
  assert.deepEqual(changes, [120_000, 120_000, 210_000])
})

test("a stamp taken before reset renews nothing, and reset leaves no lapse and no timer", () => {
  const { time, lease, changes } = tracker()
  const stale = lease.stamp()
  lease.confirm(lease.stamp())
  assert.equal(time.timers.size, 1)
  lease.reset()
  assert.equal(lease.expired(), false)
  assert.equal(time.timers.size, 0)
  lease.confirm(stale) // the reply to a request that the old instance sent
  assert.equal(lease.expired(), false)
  assert.equal(time.timers.size, 0)
  time.advance(1_000_000)
  assert.deepEqual(changes, [])
  lease.confirm(lease.stamp()) // the next instance's own request renews
  assert.equal(time.timers.size, 1)
})

test("a stamp that is already older than the lease reports the lapse at once and sets no timer", () => {
  const { time, lease, changes } = tracker()
  const stamp = lease.stamp()
  time.advance(100_000)
  lease.confirm(stamp)
  assert.equal(lease.expired(), true)
  assert.deepEqual(changes, [100_000])
  assert.equal(time.timers.size, 0)
})

test("a timer that fires before the clock reads the deadline waits out the rest", () => {
  const { time, lease, changes } = tracker()
  lease.confirm(lease.stamp())
  time.set(89_999.5)
  time.fire()
  assert.deepEqual(changes, [])
  assert.equal(lease.expired(), false)
  assert.deepEqual([...time.timers.values()].map(timer => timer.ms), [0.5])
  time.advance(1)
  assert.deepEqual(changes, [90_000])
})

test("the timer is unreferenced where the runtime supports it, so the lease never keeps a process alive", () => {
  let unrefs = 0
  const lease = createLease({ setTimeoutImpl: () => ({ unref: () => { unrefs += 1 } }), clearTimeoutImpl: () => {} })
  lease.confirm(lease.stamp())
  assert.equal(unrefs, 1)
  lease.reset()
})

// A suspend stops the monotonic clock and its timer while the server's lease runs on. A wall clock that is set back cannot
// postpone the monotonic deadline; one that is set forward may lapse the lease early, which is the safe side.
test("a suspend lapses the lease on the wall clock alone, and a confirmed request after it restores the lease and reports it", () => {
  const { time, lease, changes } = tracker()
  lease.confirm(lease.stamp())
  time.jumpWall(91_000) // the host slept for 91 s: the monotonic clock and its timer stood still
  assert.equal(lease.expired(), true)
  lease.confirm(lease.stamp()) // the first heartbeat after the resume is answered
  assert.equal(lease.expired(), false)
  assert.deepEqual(changes, [0], "the restore is reported")
  time.jumpWall(89_999)
  assert.equal(lease.expired(), false, "the new lease counts on the wall clock from that request")
  time.jumpWall(1)
  assert.equal(lease.expired(), true)
})

test("each clock lapses the lease on its own, at the lease length from the send", () => {
  const wallOnly = tracker()
  wallOnly.lease.confirm(wallOnly.lease.stamp())
  wallOnly.time.jumpWall(89_999)
  assert.equal(wallOnly.lease.expired(), false, "89.999 s on the wall clock")
  wallOnly.time.jumpWall(1)
  assert.equal(wallOnly.lease.expired(), true, "90 s on the wall clock")

  const monotonicOnly = tracker()
  monotonicOnly.lease.confirm(monotonicOnly.lease.stamp())
  monotonicOnly.time.jumpWall(-1_000_000) // the wall clock was set back
  monotonicOnly.time.advance(89_999)
  assert.equal(monotonicOnly.lease.expired(), false, "89.999 s on the monotonic clock")
  monotonicOnly.time.advance(1)
  assert.equal(monotonicOnly.lease.expired(), true, "90 s on the monotonic clock")
})

test("a wall clock that is set back cannot keep a lapsed monotonic lease live", () => {
  const { time, lease, changes } = tracker()
  lease.confirm(lease.stamp())
  time.advance(90_000)
  assert.deepEqual(changes, [90_000], "the timer reported the lapse")
  time.jumpWall(-3_600_000) // an hour back: the wall clock now reads less than it did at the send
  assert.equal(lease.expired(), true)
  time.advance(60_000)
  assert.equal(lease.expired(), true, "and it stays over")
  lease.confirm(lease.stamp())
  assert.equal(lease.expired(), false, "only a confirmed request restores it")
})

// A lapse is latched, whichever clock showed it. One that only the wall clock showed, as after a suspend, must not clear when the
// wall clock is set back to before its deadline while the monotonic deadline is still ahead: the footer keeps the text until a
// request is confirmed. The tracker below holds such a lapse.
function wallLapse() {
  const state = tracker()
  state.lease.confirm(state.lease.stamp())
  state.time.jumpWall(91_000) // the host slept for 91 s: the monotonic clock and its timer stood still
  assert.equal(state.lease.expired(), true)
  state.time.jumpWall(-91_000) // the wall clock is set back to where it was; the monotonic deadline is 90 s ahead
  return state
}

test("a lapse that only the wall clock showed holds when the wall clock is set back before the monotonic deadline", () => {
  const { time, lease } = wallLapse()
  assert.equal(lease.expired(), true)
  time.advance(30_000)
  assert.equal(lease.expired(), true, "and it stays over while the monotonic deadline is still ahead")
  time.advance(60_000)
  assert.equal(lease.expired(), true, "and once that deadline has passed too")
})

test("a confirmed request of the current epoch ends a latched lapse and reports the restore", () => {
  const { time, lease, changes } = wallLapse()
  lease.confirm(lease.stamp())
  assert.equal(lease.expired(), false)
  assert.deepEqual(changes, [0], "the restore is reported")
  time.advance(89_999)
  assert.equal(lease.expired(), false, "the new lease counts from that request, and no latch is left over")
  time.advance(1)
  assert.equal(lease.expired(), true)
})

test("a confirm with a stamp of an ended epoch does not end a latched lapse", () => {
  const { time, lease, changes } = tracker()
  const stale = lease.stamp() // taken by an instance that has since ended
  lease.reset()
  lease.confirm(lease.stamp()) // the next instance's own join
  time.jumpWall(91_000)
  assert.equal(lease.expired(), true)
  time.jumpWall(-91_000)
  lease.confirm(stale)
  assert.equal(lease.expired(), true, "the reply of an ended instance restores nothing")
  assert.deepEqual(changes, [])
  lease.confirm(lease.stamp())
  assert.equal(lease.expired(), false, "a request of this epoch does")
})

test("reset ends a latched lapse, and the next epoch starts with none", () => {
  const { time, lease, changes } = wallLapse()
  lease.reset()
  assert.equal(lease.expired(), false, "no instance is held, so nothing is expired")
  lease.confirm(lease.stamp())
  assert.equal(lease.expired(), false, "the next instance starts unlatched")
  assert.deepEqual(changes, [])
  time.advance(89_999)
  assert.equal(lease.expired(), false)
  time.advance(1)
  assert.equal(lease.expired(), true)
})

test("the wall deadline runs from the send, not from the reply", () => {
  const { time, lease } = tracker()
  const stamp = lease.stamp() // sent at wall second 0
  time.jumpWall(40_000)
  lease.confirm(stamp) // answered at wall second 40
  time.jumpWall(49_999)
  assert.equal(lease.expired(), false, "89.999 s after the send")
  time.jumpWall(1)
  assert.equal(lease.expired(), true, "90 s after the send")
})

test("a reply that is read after a suspend lapses the lease at once: its request is older than the lease on the wall clock", () => {
  const { time, lease, changes } = tracker()
  const stamp = lease.stamp()
  time.jumpWall(100_000) // the host slept, and the reply is read after it woke
  lease.confirm(stamp)
  assert.equal(lease.expired(), true)
  assert.deepEqual(changes, [0], "reported at once")
})

test("by default the clocks are the runtime's monotonic and wall clocks, and the timers are its own", () => {
  const before = { monotonic: performance.now(), wall: Date.now() }
  const lease = createLease()
  const stamp = lease.stamp()
  assert.ok(Math.abs(stamp.at - before.monotonic) < 60_000, "the monotonic reading")
  assert.ok(Math.abs(stamp.wallAt - before.wall) < 60_000, "the wall reading, in epoch milliseconds")
  lease.confirm(stamp)
  assert.equal(lease.expired(), false)
  lease.reset() // clears the real timer
})
