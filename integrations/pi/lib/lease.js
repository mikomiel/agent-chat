// The product core's instance lease, mirrored for the footer of one Pi process. An instance is online while its last
// heartbeat is younger than LEASE_SECONDS (`agent_chat/models.py`); `test/lease.test.js` reads the constant back from
// there, so drift fails CI instead of changing the footer silently.
//
// The server counts that age on the wall clock, and a monotonic clock stops while the host is suspended. The tracker reads
// both and is expired when either has counted LEASE_SECONDS: a suspend lapses it, and a wall clock set back cannot keep a
// lapsed monotonic lease live. A wall clock set forward may show `no live instance` early, which is the safe side.
//
// The tracker is footer-only. It starts no rejoin episode, withdraws no binding and raises no fault; a refusal or an
// error of the worker keeps its own path to those. It imports nothing, reads two clocks that a test injects, and owns one
// timer, set on the monotonic deadline and not on the poll tick, whose only effect is `onChange`. A lapse that only the wall
// clock shows has no timer: the owner reads `expired()` on its poll tick.
export const LEASE_SECONDS = 90

export function createLease({
  clock = () => performance.now(), // monotonic: it stops while the host is suspended
  wall = Date.now, // the clock the server's lease runs on
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onChange = () => {},
} = {}) {
  let epoch = 0 // reset() ends an epoch: a reply to a request that was sent before it renews nothing
  let deadline = null // monotonic clock time at which the lease is over; null while no instance is held
  let wallDeadline = null // the same moment on the wall clock
  let timer = null

  const expired = () => deadline !== null && (clock() >= deadline || wall() >= wallDeadline)

  function cancel() {
    clearTimeoutImpl(timer)
    timer = null
  }

  // One timer, on the monotonic deadline. A timer can fire a hair before the monotonic clock reads the deadline: it then
  // waits out the rest, so that onChange never runs while the lease still counts as live.
  function arm() {
    cancel()
    const remaining = deadline - clock()
    if (remaining <= 0) return // already over: confirm() reports it
    timer = setTimeoutImpl(() => {
      timer = null
      if (expired()) onChange()
      else if (deadline !== null) arm()
    }, remaining)
    timer?.unref?.() // the lease never keeps a process alive
  }

  return {
    // Take it right before a join or a heartbeat request is written, never after its reply.
    stamp: () => ({ at: clock(), wallAt: wall(), epoch }),
    // A reply that carries no `refused`: the lease runs to LEASE_SECONDS after the request was sent, on each clock. A
    // refused reply, a thrown error and a request with no answer are not confirmed and do not come here.
    confirm(stamp) {
      if (stamp?.epoch !== epoch) return
      const was = expired()
      deadline = stamp.at + LEASE_SECONDS * 1000
      wallDeadline = stamp.wallAt + LEASE_SECONDS * 1000
      arm()
      if (was !== expired()) onChange()
    },
    // No instance is held: the old one ended or was replaced. Nothing is expired, and no timer is left.
    reset() {
      epoch += 1
      deadline = null
      wallDeadline = null
      cancel()
    },
    expired,
  }
}
