// The binding context of one OpenCode session: the keyed instruction entry that carries the Agent Chat binding, and the
// repair that keeps it there. This object reads no session state and sends no input to the session. The session reads
// chat through the Agent Chat tools, on its own turns.
//
// A compaction may drop the binding entry, and a lost event stream may have hidden one. Every compaction signal
// (`started`, `ended`, `failed`) and every stream gap owes a read-back of the entry. An event can arrive twice or late;
// a repeat only owes an idempotent read-back again, so no order is kept.
//
// A READ-BACK IS A REPAIR OWED UNTIL IT SUCCEEDS, NEVER A VERDICT. It puts the entry back when it is gone. A host call
// that fails, an entry that cannot be confirmed and a check that was overtaken all leave the obligation owed. Whoever
// drives the repair asks again through `repair()`: the manager at each event of the session. Nothing here turns chat
// off: a session whose entry cannot be restored keeps the owed repair and heals when the host answers again.
//
// EVERY HEARTBEAT TICK READS THE ENTRY BACK (`refresh()`). An entry can change with no signal this object sees: a
// compaction that ends inside a stream gap, after a put; a removal or put that lands after its time limit, after this
// context closed; a host that answers again after a failed check. A tick owes the read-back again, without moving the
// epoch, so whatever happened to the entry gets a repair attempt at the next tick. It costs one list per tick, and a put
// only when the entry is wrong. Only the join's own publish (`context()`)
// rejects, and its caller decides what a failed join means.
//
// ONE CURRENCY RULE. A read-back is for one obligation and one binding. It proves the binding only while chat is open
// and on, no newer gap or compaction signal has been applied, and no `context()` call has withdrawn or replaced the
// binding. It asks that after every host call it awaits and before the next one, and before it proves. Before its first
// host call it also asks that the obligation is still owed: a check queued behind a publish that discharged it makes no
// call. A confirmed `context()` publish discharges the obligation under the same rule. With nothing published there is
// nothing to read, so the obligation stays owed until a publish is confirmed.
//
// EVERY HOST CALL HAS A TIME LIMIT (`CALL_TIMEOUT_MS`). A call that never answers would hold the serial queue for ever,
// and with it every later publish, repair and removal. A call that runs out of time counts as a failed call: a check
// proves nothing and stays owed, a publish rejects, and a removal is not an error. The host is not told to stop the
// call, so it may still land. While this context is open, a put or a removal that lands late owes the read-back again.
// Once it is closed or turned off, nothing here touches the entry again: a cleanup outside the queue would race the next
// owner's own publish. A removal that lands after the next owner's publish deletes that binding until the next owner's
// next tick puts it back. A put that lands after the removal that followed a failed join leaves a stale entry. A removal that lands after the next owner's publish deletes that binding until the
// next owner's next tick puts it back. The time limit trades a call that can hang for a call that can land late.
//
// WHY A PUT AT THE WRONG TIME IS HARMLESS. A put is never the last word. Every signal that can invalidate the entry
// owes the read-back again when it is applied (`owe`). So a put or a proof that landed just before such a signal was
// applied is owed again and read back after it. A withdrawn binding's removal runs on the same serial queue as every
// put, so it always lands behind a put that is already issued, and a check begun for a withdrawn binding makes no call
// at all.
import { BINDING_KEY } from "./channel.js"

const COMPACTION = new Set(["session.compaction.started", "session.compaction.ended", "session.compaction.failed"])

// The longest one instruction-entry call may take before it counts as failed.
export const CALL_TIMEOUT_MS = 10_000

const contextFailure = () => Object.assign(new Error("CHAT_CONTEXT_UNAVAILABLE"), { code: "CHAT_CONTEXT_UNAVAILABLE" })

export function createContext(ctx, sessionID, { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let closed = false
  let disabled = false
  let unverified = false // a compaction signal or a gap was applied, and the binding entry has not been read back since
  let compactions = 0 // signals and gaps applied so far: a read-back that began before the latest one proves nothing
  let verifying = null // the `compactions` value of the read-back queued or running now: one at a time per obligation
  let asks = 0 // heartbeat ticks so far: a check that a tick overlapped after its reads began asks once more
  let generation = 0 // `context()` calls so far: a read-back made for an earlier call is for a binding that is gone
  let published = null // the binding text the entry should hold now
  let contextQueue = Promise.resolve()

  // The entry may have changed behind any earlier proof. The read-back is owed, and the epoch moves so that a check
  // begun earlier proves nothing and `repair()` asks again.
  function owe() {
    unverified = true
    compactions += 1
  }

  // Context operations run one at a time, in order, so a clear never overtakes a publish.
  function queued(operation) {
    const run = contextQueue.then(operation, operation)
    contextQueue = run.catch(() => {})
    return run
  }

  // One instruction-entry call, with a time limit: a call that never answers must not hold the queue for ever. A call
  // that runs out of time counts as a failed call. The host is not told to stop it, so it may still land. A put or a
  // removal that lands late can overwrite or delete a newer binding, and the read-back is owed again. A read changes
  // nothing.
  function call(name, input) {
    return new Promise((resolve, reject) => {
      let over = false
      const timer = setTimeoutImpl(() => { over = true; reject(contextFailure()) }, CALL_TIMEOUT_MS)
      const answer = settle => value => {
        if (over) {
          if (name !== "list" && !closed && !disabled) owe()
          return
        }
        clearTimeoutImpl(timer)
        settle(value)
      }
      new Promise(begin => begin(ctx.session.instructions.entry[name](input))).then(answer(resolve), answer(reject))
    })
  }

  async function holds(text) {
    const entries = await call("list", { sessionID })
    return Array.isArray(entries) && entries.some(entry => entry?.key === BINDING_KEY && entry.value === text)
  }

  // The currency rule: is the work begun at epoch `mark` for binding `binding` still the work that is wanted? Everything
  // that can change across an await is in it: a compaction signal or a gap, a withdrawn or replaced binding, and a chat
  // that was closed or disabled.
  const currentAt = (mark, binding) => () => !closed && !disabled && compactions === mark && generation === binding

  // Put the entry and confirm it. `current` is asked after the put and before the confirming list: false stops there,
  // and the result is false. A put that left no entry throws: the caller decides what that means.
  // A put of an earlier owner that ran out of time can land between this put and its confirming list, so a confirmation
  // that finds other text puts once more before it fails.
  async function publish(text, current = () => true) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await call("put", { sessionID, key: BINDING_KEY, value: text })
      if (!current()) return false
      // The surface is experimental.
      if (await holds(text)) return true
    }
    throw contextFailure()
  }

  // Publish the binding text, replacing any earlier one under the same key; null removes it. Rejects when the
  // entry cannot be confirmed: the caller then turns this session's chat off. A removal that fails is not an error:
  // a stale entry names an instance file that is no longer valid, and the next publish replaces it.
  function context(text) {
    if (closed) return Promise.resolve()
    if (text === null) {
      published = null
      generation += 1
      return queued(() => call("remove", { sessionID, key: BINDING_KEY }).catch(() => {}))
    }
    if (typeof text !== "string" || !text) return Promise.reject(contextFailure())
    published = text
    generation += 1
    const binding = generation
    return queued(async () => {
      const current = currentAt(compactions, binding) // from the start of this publish to its confirmation
      try { await publish(text) } catch { throw contextFailure() }
      // A confirmed put is a read-back of this binding, when nothing has overlapped it.
      if (current()) unverified = false
    })
  }

  // A compaction signal owes the read-back.
  function observe(event) {
    if (closed || disabled || !event || typeof event !== "object") return
    if (COMPACTION.has(event.type)) owe()
  }

  // The event stream broke or restarted: events may be missing, so a compaction may have ended unseen. The read-back
  // is owed now. A compaction can still end inside the gap after the read-back; the next tick reads the entry again.
  function reset() {
    owe()
  }

  // True while a read-back is owed: a signal or a gap was applied, and no check or confirmed publish has proved the
  // entry since. It reads state only and starts nothing.
  const owed = () => unverified && !closed && !disabled

  // May a read-back start now? Never with nothing published, and one at a time per obligation.
  const askable = () => owed() && published !== null && verifying !== compactions

  // After a compaction signal or a gap: put the entry back when it is gone or changed. Asking when nothing is owed, or
  // while a check for this obligation is running, does nothing. Resolves, and never rejects, with true only when this
  // check proved the binding while it was still current. Every other end resolves false and leaves the obligation
  // owed: the next ask repeats it.
  function repair() {
    if (!askable()) return Promise.resolve(false)
    const mark = compactions
    const current = currentAt(mark, generation)
    const text = published
    verifying = mark // one check per obligation at a time
    const done = proved => {
      if (verifying === mark) verifying = null // ended: when still owed, the next ask repeats it
      return proved
    }
    let asked = null
    return queued(async () => {
      asked = asks
      if (!unverified || !current()) return done(false) // discharged or overtaken while it waited: no host call
      try {
        const found = await holds(text)
        if (!current()) return done(false) // asked before the put, which is made in the same step
        if (!found && !await publish(text, current)) return done(false)
      } catch {
        return done(false) // a failed call proves nothing either way, and turns nothing off
      }
      if (!current()) return done(false) // the last host call proves nothing about a binding that has since changed
      if (asks === asked) unverified = false // a tick that came after the reads began is not answered by them
      return done(true)
    }).then(proved => (asked !== null && asks !== asked && askable() ? repair() : proved))
  }

  // The heartbeat tick: owe the read-back again and ask for it. The epoch does not move, so a publish in flight still
  // proves. A check that is queued reads after the tick and answers it. A check whose reads already began does not: it
  // runs once more when it ends, so the entry is read after every tick.
  function refresh() {
    if (closed || disabled) return Promise.resolve(false)
    unverified = true
    asks += 1
    return repair()
  }

  function disable() {
    // Chat-only and per session: the session and the other sessions are untouched.
    disabled = true
  }

  // Disposal: the stale object can never prove or publish again.
  function dispose() {
    closed = true
  }

  return { context, observe, reset, repair, refresh, owed, disable, dispose }
}
