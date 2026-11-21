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
// A compaction may drop the binding entry, and a lost event stream may have hidden one. From `session.compaction.ended`
// and from a stream gap the gate stays closed until the entry has been read back (`verifyContext`); a read-back that
// fails keeps it closed, and the caller's `onFailed` then turns chat off. A read-back proves only that the entry exists
// at that moment, never that a compaction has ended: a compaction already seen running stays running across a gap, and
// only its own terminal event (`ended` or `failed`) clears it.
//
// ONE CURRENCY RULE. A read-back is for one obligation and one binding. It is current only while chat is open and on,
// no compaction runs, no newer gap, compaction start or end has come, and no `context()` call has withdrawn or
// replaced the binding. It asks that after every host call it awaits, before the next one, and again at the point
// where it would act on a failure or prove the binding. A check that is not current does nothing more and reports
// "stale": it neither puts, nor fails, nor proves, and the obligation stays owed for the next event. It reports
// "proved" or "failed" only in the step in which it was still current, and it calls `onFailed` in that same step.
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
  let compactions = 0 // compaction starts, endings and gaps so far: a read-back that began before the latest one proves nothing
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
        compacting = true
        compactions += 1 // a read-back that was already running overlapped this compaction, whatever ends it
        return true
      case "session.compaction.ended":
        compacting = false
        unverified = true
        compactions += 1
        return true
      case "session.compaction.failed":
        compacting = false
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

  // Put the entry and confirm it. `current` is asked after the put and before the confirming list: false stops there,
  // and the result is false. A put that left no entry means no binding context, which means chat off. A caller that
  // passes a `current` re-asks it for the failure this throws.
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
    return queued(async () => {
      try { await publish(text) } catch { throw contextFailure() }
    })
  }

  // A read-back is owed after a compaction ended and after a gap, until one that began while nothing was compacting
  // has succeeded. Whoever drives it asks here, so it is asked for once per obligation and never during a compaction.
  function needsReadBack() {
    return unverified && !compacting && !closed && !disabled && verifying !== compactions
  }

  // After a compaction or a gap: put the entry back when it is gone or changed, then reopen the gate. Only the latest
  // obligation's read-back reopens it. Resolves, and never rejects, with one of:
  //   "proved"  the entry is there and the read-back was current throughout; the gate may reopen
  //   "failed"  a host call failed while the read-back was current; `onFailed(error)` was called in that step
  //   "stale"   it stopped, or its failure was ignored, because it was no longer current; the obligation stays owed
  // Nothing published is trivially proved. `onFailed` may re-enter the delivery, so nothing is touched after it runs.
  function verifyContext(onFailed = () => {}) {
    const mark = compactions
    const binding = generation
    // Asked after every host call, and again for the failure and the proof. Everything that can change across an
    // await is here: a compaction or a gap, a withdrawn or replaced binding, and a chat that was closed or disabled.
    const current = () => !closed && !disabled && !compacting && compactions === mark && generation === binding
    if (closed) return Promise.resolve("stale")
    if (published === null) { unverified = false; return Promise.resolve("proved") }
    const text = published
    verifying = mark
    const stale = () => { if (verifying === mark) verifying = null; return "stale" }
    return queued(async () => {
      try {
        if (!current()) return stale() // the wait behind earlier context operations
        const found = await holds(text)
        if (!current()) return stale() // asked before the put, which is made in the same step
        if (!found && !await publish(text, current)) return stale()
      } catch {
        if (!current()) return stale() // a failure that overlapped a compaction, a newer gap or a new binding is no evidence
        try { onFailed(contextFailure()) } catch { /* the caller's handler is its own; the outcome stands */ }
        return "failed"
      }
      if (!current()) return stale() // the last host call proves nothing about a binding that has since changed
      unverified = false
      return "proved"
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
