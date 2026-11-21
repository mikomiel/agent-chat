// The OpenCode native half of one Agent Chat lifecycle, for one session: what the session is doing, the stop latch,
// the Plan Mode heuristic, the binding context and the delivery.
//
// THE GATE. A plugin cannot check "idle" and enqueue in one atomic step, and it cannot withdraw an enqueued input.
// So this half delivers only to a session it has proved to be running, and only through a synthetic steer input
// admitted with `resume: false`: that call never starts a run. A steer input that finds no run to join would park in
// the inbox and drain into the next prompt, so the package never claims for an idle session. There is no idle wake.
//
// THE PROOF. Once `synthetic` is issued the input may exist, so every answer from then on is `handed` or `uncertain`.
// `handed` comes only from `session.inbox.delivered` for that exact inbox id. A run that ends first, a missed
// deadline, a throwing call and a lost event stream are all `uncertain`: the input may be parked and drain later, and
// a later `delivered` for it is ignored. Only `session.inbox.cancelled` for the id proves that nothing ran.
//
// A compaction may drop the binding entry, and a lost event stream may have hidden one. From a compaction signal and
// from a stream gap the gate stays closed until the entry has been read back (`verifyContext`). A read-back proves only
// that the entry exists at that moment, never that a compaction has ended: a compaction already seen running stays
// running across a gap, and only its own terminal event (`ended` or `failed`) lets a check start.
//
// A READ-BACK IS A REPAIR OWED UNTIL IT SUCCEEDS, NEVER A VERDICT. It puts the entry back when it is gone and reopens
// the gate. A host call that fails, an entry that cannot be confirmed and a check that was overtaken all leave the gate
// closed and the obligation owed, and the next event asks again. Nothing here turns chat off: a session whose entry
// cannot be restored stays closed, which refuses every claim, and heals when the host answers again. Only the join's
// own publish (`context()`) rejects, and its caller decides what a failed join means.
//
// ONE CURRENCY RULE. A read-back is for one obligation and one binding. It proves the binding only while chat is open and
// on, no compaction runs, no newer gap or compaction signal has been applied, and no `context()` call has withdrawn or
// replaced the binding. It asks that after every host call it awaits and before the next one, and before it proves. Before
// its first host call it also asks that the obligation is still owed: a check queued behind a publish that discharged it
// makes no call. A confirmed `context()` publish discharges the obligation under the same rule. With nothing published
// there is nothing to read, so the obligation stays owed until a publish is confirmed. A gap is over only when the
// stream has resumed for the session: a compaction can still end inside it and drop the entry after the put. So a publish
// that began before the first event after a gap does not discharge it.
//
// WHY A PUT AT THE WRONG TIME IS HARMLESS. A put is never the last word. Every signal that can invalidate the entry
// re-owes the obligation when it is applied: a gap (`reset`) and a compaction `started`, `ended` or `failed` each set
// `unverified` and move the epoch. So a put or a proof that landed just before such a signal was applied is owed again
// and read back after it. A withdrawn binding's removal runs on the same serial queue as every put, so it always lands
// behind a put that is already issued, and a check begun for a withdrawn binding makes no call at all.
//
// State is read from events only. A fact the events have not shown is unknown, and unknown never reads as idle.
import { BINDING_KEY, CHAT_PREFIX, CHAT_SOURCE, MAX_CONTEXT_BYTES, monotonicNow } from "./channel.js"

const MAX_ATTEMPTS = 128
const MAX_SEEN = 64
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
// The built-in agent that denies edits. A custom agent with the same limits is not detected.
const PLAN_AGENT = "plan"

const contextFailure = () => Object.assign(new Error("CHAT_CONTEXT_UNAVAILABLE"), { code: "CHAT_CONTEXT_UNAVAILABLE" })

export function createDelivery(ctx, sessionID, {
  now = monotonicNow,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let closed = false
  let disabled = false
  let stopped = true // every session starts chat-stopped; an operator prompt clears it
  let executing = null // true, false, or null when no event has shown it
  let compacting = false
  let unverified = false // a compaction ended, or the stream broke, and the binding entry has not been read back since
  let resuming = false // the stream broke and no event has arrived since: a compaction may still end inside the gap
  let compactions = 0 // compaction signals and gaps applied so far: a read-back that began before the latest one proves nothing
  let verifying = null // the `compactions` value a queued read-back was asked for: one read per obligation
  let generation = 0 // `context()` calls so far: a read-back made for an earlier call is for a binding that is gone
  let agent = null
  let pending = null // at most one issued input: { id, resolve, timer, deadline }
  let published = null // the binding text the entry should hold now
  let contextQueue = Promise.resolve()
  const seen = new Map() // inbox id -> "delivered" | "cancelled", newest last, bounded
  const attempts = new Map()

  // A receipt that arrives at or after the absolute deadline is late whatever it says: the caller's reservation is
  // over, so it settles uncertain. A delayed timer callback must not turn a late receipt into a definite answer.
  function finish(record, outcome, reason = null) {
    if (pending !== record) return
    pending = null
    clearTimeoutImpl(record.timer)
    if (outcome !== "uncertain" && now() >= record.deadline) record.resolve({ outcome: "uncertain", reason: "transport_ambiguous" })
    else record.resolve({ outcome, reason })
  }

  // The input may exist and cannot be taken back: never a retryable answer.
  function abandon() {
    if (pending) finish(pending, "uncertain", "transport_ambiguous")
  }

  function remember(id, kind) {
    if (typeof id !== "string" || !id) return
    seen.delete(id)
    seen.set(id, kind)
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value)
  }

  // null means "may be handed over now". Every other value is a reason from the closed set the core accepts.
  // `executing === false` is a known state, but this release never wakes an idle session; "unknown" is the
  // closest reason in the set for "not proved running".
  function state() {
    if (closed) return "stale_binding"
    if (disabled) return "offline"
    if (stopped) return "stopped"
    if (agent === null) return "unknown"
    if (agent === PLAN_AGENT) return "plan"
    if (executing !== true) return "unknown"
    if (compacting || unverified || pending) return "busy"
    return null
  }

  function heartbeatState() {
    const live = !closed && !disabled
    return {
      native_state: live && executing === true ? "busy" : live && executing === false ? "idle" : "unknown",
      // An unclassifiable session reports stopped, never permission to clear stop or Plan Mode remotely.
      stopped: !live || stopped || executing === null || agent === null,
      plan_mode: live && agent === PLAN_AGENT,
    }
  }

  // The reporting state changed when this returns true; the caller publishes a heartbeat now.
  function observe(event) {
    if (closed || disabled || !event || typeof event !== "object") return false
    resuming = false // the first event after a gap: the stream has resumed, so whatever ended inside the gap is over
    const data = event.data ?? {}
    switch (event.type) {
      case "session.execution.started":
        executing = true
        return true
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        executing = false
        // Only an operator interrupt is a stop. Shutdown, supersession and inactivity are not.
        if (event.type === "session.execution.interrupted" && data.reason === "user") stopped = true
        abandon()
        return true
      case "session.agent.selected":
        agent = typeof data.agent === "string" && data.agent ? data.agent : null
        return true
      case "session.compaction.started":
      case "session.compaction.ended":
      case "session.compaction.failed":
        // Each one owes the binding read-back again and moves the epoch: a check that was already running overlapped
        // the compaction, and a proof from before it says nothing about the entry after it.
        compacting = event.type === "session.compaction.started"
        unverified = true
        compactions += 1
        return true
      case "session.inbox.enqueued":
        // A user input is the only thing that clears the stop latch. It cannot be told apart as an operator or an
        // API client; see Known limits.
        if (data.item?.type === "user") { stopped = false; return true }
        return false
      case "session.inbox.delivered":
        remember(data.inboxID, "delivered")
        if (pending && pending.id !== null && pending.id === data.inboxID) finish(pending, "handed")
        return false
      case "session.inbox.cancelled":
        remember(data.inboxID, "cancelled")
        // Cancelled before any delivery: nothing ran, so the refusal is definite.
        if (pending && pending.id !== null && pending.id === data.inboxID) finish(pending, "deferred", "stopped")
        return false
      default:
        return false
    }
  }

  // The session's own fields at the first sight of it. Nothing here proves a run state.
  function seed(info) {
    if (typeof info?.agent === "string" && info.agent) agent = info.agent
  }

  // The event stream broke or restarted: events may be missing, so every observation is stale. The selected agent
  // and the stop latch are observations too: a missed agent switch or operator interrupt must not stay hidden, so
  // both go back to their start values and only fresh events clear them. So is the binding proof: a compaction
  // may have ended inside the gap, so the entry counts as unverified until the next read-back. A compaction already
  // observed running is the exception: nothing in a gap proves it over, and a read-back would prove only that the
  // entry exists, so the manager waits. `compacting` stays set until the compaction's own terminal event, so one whose
  // terminal event fell inside the gap keeps the gate closed until a later compaction event (a known limit).
  function reset() {
    executing = null
    agent = null
    stopped = true
    unverified = true
    resuming = true
    compactions += 1
    abandon()
  }

  function sendChat({ content, attemptId, deadline } = {}) {
    const settled = (outcome, reason = null) => Promise.resolve({ outcome, reason })
    if (disabled || closed) return settled("failed", "native_unavailable")
    const blocked = state()
    if (blocked) return settled("deferred", blocked)
    if (typeof content !== "string" || !content || Buffer.byteLength(CHAT_PREFIX + content, "utf8") > MAX_CONTEXT_BYTES ||
        typeof attemptId !== "string" || !UUID.test(attemptId) || !Number.isFinite(deadline)) {
      return settled("failed", "native_unavailable")
    }
    // A reservation that is already over proves nothing about a hand-over that never ran; neither does a repeated id.
    if (deadline <= now()) return settled("uncertain", "transport_ambiguous")
    for (const [id, expires] of attempts) if (expires <= now()) attempts.delete(id)
    if (attempts.has(attemptId)) return settled("uncertain", "transport_ambiguous")
    if (attempts.size >= MAX_ATTEMPTS) return settled("failed", "native_unavailable")
    attempts.set(attemptId, deadline)

    return new Promise(resolve => {
      // Armed before the call: the events for the input can reach this object before the call returns.
      const record = { id: null, resolve, timer: null, deadline }
      pending = record
      record.timer = setTimeoutImpl(() => finish(record, "uncertain", "transport_ambiguous"), Math.max(0, deadline - now()))
      let call
      try {
        call = ctx.session.synthetic({
          sessionID,
          text: CHAT_PREFIX + content,
          description: "Agent Chat",
          metadata: { source: CHAT_SOURCE },
          delivery: "steer",
          resume: false,
        })
      } catch { finish(record, "uncertain", "transport_ambiguous"); return }
      Promise.resolve(call).then(item => {
        if (pending !== record) return
        const id = typeof item?.id === "string" && item.id ? item.id : null
        if (id === null) { finish(record, "uncertain", "transport_ambiguous"); return }
        record.id = id
        if (seen.get(id) === "delivered") finish(record, "handed")
        else if (seen.get(id) === "cancelled") finish(record, "deferred", "stopped")
      }, () => finish(record, "uncertain", "transport_ambiguous"))
    })
  }

  // The lifecycle calls this shape: one rendered notice and its attempt id.
  function deliver(batch, deadline) {
    const { content, attemptId } = batch ?? {}
    return sendChat({ content, attemptId, deadline })
  }

  // Context operations run one at a time, in order, so a clear never overtakes a publish.
  function queued(operation) {
    const run = contextQueue.then(operation, operation)
    contextQueue = run.catch(() => {})
    return run
  }

  async function holds(text) {
    const entries = await ctx.session.instructions.entry.list({ sessionID })
    return Array.isArray(entries) && entries.some(entry => entry?.key === BINDING_KEY && entry.value === text)
  }

  // The currency rule: is the work begun at epoch `mark` for binding `binding` still the work that is wanted? Everything
  // that can change across an await is in it: a compaction or a gap, a withdrawn or replaced binding, and a chat that
  // was closed or disabled.
  const currentAt = (mark, binding) => () => !closed && !disabled && !compacting && compactions === mark && generation === binding

  // Put the entry and confirm it. `current` is asked after the put and before the confirming list: false stops there,
  // and the result is false. A put that left no entry throws: the caller decides what that means.
  async function publish(text, current = () => true) {
    await ctx.session.instructions.entry.put({ sessionID, key: BINDING_KEY, value: text })
    if (!current()) return false
    // The surface is experimental.
    if (!await holds(text)) throw contextFailure()
    return true
  }

  // Publish the binding text, replacing any earlier one under the same key; null removes it. Rejects when the
  // entry cannot be confirmed: the caller then turns this session's chat off. A removal that fails is not an error:
  // a stale entry names an instance file that is no longer valid, and the next publish replaces it.
  function context(text) {
    if (closed) return Promise.resolve()
    if (text === null) {
      published = null
      generation += 1
      return queued(() => Promise.resolve(ctx.session.instructions.entry.remove({ sessionID, key: BINDING_KEY })).catch(() => {}))
    }
    if (typeof text !== "string" || !text) return Promise.reject(contextFailure())
    published = text
    generation += 1
    const binding = generation
    return queued(async () => {
      const current = currentAt(compactions, binding) // from the start of this publish to its confirmation
      const resumed = !resuming // a publish that began inside a gap is not a proof for it, whenever its put lands
      try { await publish(text) } catch { throw contextFailure() }
      // A confirmed put is a read-back of this binding, when nothing has overlapped it and the stream has resumed.
      if (current() && resumed) unverified = false
    })
  }

  // A read-back is owed after a compaction ended and after a gap, until one that began while nothing was compacting
  // has succeeded, or a confirmed `context()` publish has discharged it. Whoever drives it asks here, so it is asked
  // for once per obligation and never during a compaction.
  function needsReadBack() {
    return unverified && !compacting && !closed && !disabled && verifying !== compactions
  }

  // After a compaction or a gap: put the entry back when it is gone or changed, then reopen the gate. Resolves, and never
  // rejects, with true only when this check proved the binding while it was still current. Every other end resolves
  // false and leaves the obligation owed: the gate stays closed and the next event asks again.
  function verifyContext() {
    if (closed || published === null) return Promise.resolve(false) // nothing to read: a confirmed publish discharges it
    const mark = compactions
    const current = currentAt(mark, generation)
    const text = published
    verifying = mark // one check per obligation at a time
    const done = proved => {
      if (!proved && verifying === mark) verifying = null // still owed: the next event asks again
      return proved
    }
    return queued(async () => {
      if (!unverified || !current()) return done(false) // discharged or overtaken while it waited: no host call
      try {
        const found = await holds(text)
        if (!current()) return done(false) // asked before the put, which is made in the same step
        if (!found && !await publish(text, current)) return done(false)
      } catch {
        return done(false) // a failed call proves nothing either way, and turns nothing off
      }
      if (!current()) return done(false) // the last host call proves nothing about a binding that has since changed
      unverified = false
      return done(true)
    })
  }

  function disable() {
    // Chat-only and per session: the session and the other sessions are untouched.
    disabled = true
    abandon()
    attempts.clear()
  }

  // Disposal: the stale object can never deliver again.
  function dispose() {
    closed = true
    abandon()
    attempts.clear()
  }

  return { state, heartbeatState, observe, seed, reset, deliver, sendChat, context, needsReadBack, verifyContext, disable, dispose }
}
