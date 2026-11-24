// The settlement of the one input the idle hook admitted for a session, and the cap on how many inputs a hook may admit.
//
// THE ONE ATTEMPT. The hook admits a synthetic steer input and returns. The host promotes the input into the session's
// history after the hook has returned, so nothing can wait for it there: this object holds the attempt, `{ inboxID,
// deadline }`, and settles it later from the event stream. A session has at most one open attempt. A newer attempt ends
// the older one, because the table keeps one attempt per session and the older one's event is no longer read.
//
// HANDED IS PROVED, NEVER INFERRED. `session.inbox.delivered` for exactly this inbox id, before the deadline, is the only
// proof, and it means the input was promoted into the session's history, not that the model has read it. Every other end
// is `uncertain`: the deadline (the timer, or the exact event arriving at or after it), a rejected or throwing admission or
// a hook that ran out of time (`abandon`), a lost event stream (`reset`), the session's end (`forget`), and a newer attempt
// for the session. An input that is not proved delivered may still sit in the inbox and be promoted later, and it cannot be
// taken back, so it is never reported as not delivered.
//
// AN EVENT FOR ANOTHER ID CHANGES NOTHING. The host promotes every input of the session in the same execution, another
// plugin's among them, and a replay of an old event is noise. Neither says anything about this input, so the attempt stays
// open for its own event or its deadline. An event is read only against an attempt the hook made: it opens nothing and
// reads no state of the session.
//
// THE CAP. An input admitted by the hook joins the execution that is ending, which then runs again and ends again, and a
// hook runs again at that end. Two peers could keep each other going. So at most MAX_HOOK_DELIVERIES inputs are admitted per
// execution, and `restart` (`session.execution.started` for the session) clears the count. A restart the plugin
// never saw leaves the count where it was, so a missed one only reduces delivery. A restart that is seen twice, from two
// streams or as a replay, clears the count early.
import { monotonicNow } from "./channel.js"

export const MAX_HOOK_DELIVERIES = 3

const HANDED = Object.freeze({ outcome: "handed", reason: null })
// The closest code in the worker's vocabulary for an input that may or may not have arrived.
const UNCERTAIN = Object.freeze({ outcome: "uncertain", reason: "transport_ambiguous" })

// The inbox id of the input admitted for one claim attempt: the host needs the `msg_` prefix, and the attempt's own id
// (a UUID) makes the admission idempotent.
export const inboxIDOf = attemptID => `msg_${attemptID.replaceAll("-", "")}`

// `now` must be the lifecycle's clock: a deadline is an absolute time on it.
export function createDelivery({
  now = monotonicNow,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const attempts = new Map() // session id -> the open attempt
  const counts = new Map() // session id -> inputs admitted since the session's last execution start

  function finish(sessionID, attempt, result) {
    if (attempts.get(sessionID) !== attempt) return
    attempts.delete(sessionID)
    clearTimeoutImpl(attempt.timer)
    attempt.settle(result)
  }

  return {
    // May the hook admit another input for this session in this execution?
    allowed: sessionID => (counts.get(sessionID) ?? 0) < MAX_HOOK_DELIVERIES,

    // Opens the attempt, before the host is asked to admit the input: the call may be slow, and the deadline runs from
    // the claim. `done` resolves once, with the settlement the worker takes; it never rejects. `abandon` ends the attempt
    // as uncertain. Opening one counts toward the cap, whatever becomes of the input.
    open(sessionID, { inboxID, deadline }) {
      const earlier = attempts.get(sessionID)
      if (earlier) finish(sessionID, earlier, UNCERTAIN)
      counts.set(sessionID, (counts.get(sessionID) ?? 0) + 1)
      let settle
      const done = new Promise(resolve => { settle = resolve })
      const attempt = { inboxID, deadline, timer: null, settle }
      attempts.set(sessionID, attempt)
      attempt.timer = setTimeoutImpl(() => finish(sessionID, attempt, UNCERTAIN), Math.max(0, deadline - now()))
      attempt.timer?.unref?.() // an attempt that never ends must not keep a stopping process alive
      return { done, abandon: () => finish(sessionID, attempt, UNCERTAIN) }
    },

    // A `session.inbox.delivered` event. Only the exact id is read: another id is another input. Before the deadline the
    // exact id is handed. A delayed timer must not turn a late event into a definite answer, so the deadline is read here
    // and not left to the timer.
    delivered(sessionID, inboxID) {
      const attempt = attempts.get(sessionID)
      if (!attempt || inboxID !== attempt.inboxID) return
      finish(sessionID, attempt, now() < attempt.deadline ? HANDED : UNCERTAIN)
    },

    // `session.execution.started`: a new execution has its own allowance.
    restart: sessionID => { counts.delete(sessionID) },

    // The event stream broke or restarted: the delivered event may have been lost with it, so every open attempt ends.
    // The counts stay: only a restart the plugin saw clears one.
    reset() {
      for (const [sessionID, attempt] of [...attempts]) finish(sessionID, attempt, UNCERTAIN)
    },

    // The session's chat ended. Nothing is left to settle it, and the server ends an unsettled reservation itself.
    forget(sessionID) {
      const attempt = attempts.get(sessionID)
      if (attempt) finish(sessionID, attempt, UNCERTAIN)
      counts.delete(sessionID)
    },
  }
}
