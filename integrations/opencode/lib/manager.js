// One manager per OpenCode server process: it turns the plugin event stream into one delivery object and one
// lifecycle per root session.
//
// ROOT SESSIONS ONLY. A session joins only when `session.get` shows no `parentID` and no `fork`. A subagent runs
// only in a child session and a child has a `parentID`. Whether a fork sets `parentID` is not confirmed, so a fork
// is refused too: when in doubt a session stays out. A parent pointer is not trusted as a root test either way.
//
// A GAP IS READ BACK AT THE FIRST EVENT AFTER IT. The stream resets when it breaks, before it resumes, so a read-back
// run at the reset would end before the gap does. A session is marked stale at the reset instead, and its entry is
// read back at the first event it sees afterwards: the stream has resumed by then, so whatever it missed is over.
// The exception is a compaction already seen running: a read-back then proves only that the entry exists, so it waits
// for that compaction's own `ended` or `failed` event.
//
// FORKS ARE PERMANENT. A `session.forked` event is evidence that outlives every cache: it is kept in its own set,
// never evicted, dropped only when the session is deleted, and shared with the next owner. A lookup that fails or
// answers later cannot undo it.
//
// A DELETION IS FENCED WHEN IT IS RECEIVED, as a fork is: it is not queued behind a lookup that is still running. The
// record is ended and the session refused at once, so a lookup that answers afterwards finds its record dead and
// starts no worker and sends no join.
//
// ONE FAULT BOUNDARY PER SESSION. Events of one session run in order on that session's own chain, and a throw or
// rejection there disables chat for that session only. A session that faulted or was deleted never rejoins in this
// process, so a worker that is still ending is never raced by a second join.
import { describeFailure } from "./worker.js"

// The events the manager reads. Session events of other kinds, such as every tool call, are never subscribed to.
export const EVENT_TYPES = Object.freeze([
  "session.created", "session.deleted", "session.forked", "session.agent.selected",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
])

const RETRY_LOOKUP_MS = 60_000
const MAX_REFUSED = 1024

// A root session has no parent and no fork source. Anything else, and anything unreadable, is not a root.
export function isRootSession(info, sessionID) {
  if (info === null || typeof info !== "object" || info.id !== sessionID) return false
  return (info.parentID === undefined || info.parentID === null) && (info.fork === undefined || info.fork === null)
}

const sessionOf = event => (typeof event?.data?.sessionID === "string" && event.data.sessionID ? event.data.sessionID : null)

// The id of the session a `session.forked` event describes, or null for any other event.
export const forkedSessionOf = event => (event?.type === "session.forked" ? sessionOf(event) : null)

export function createManager(ctx, config, parts, {
  now = Date.now,
  notice = () => {},
  forked = new Set(), // fork evidence: session ids that are never roots; the registry hands every owner the same set
} = {}) {
  const records = new Map() // session id -> { id, delivery, lifecycle, chain, dead, closing, stale }
  const refused = new Map() // session id -> time until which it is not looked up again (Infinity: never)
  const closings = new Set() // ends still in flight, so stop() also waits for a session that ended before it was called
  let active = true

  function refuse(id, until) {
    refused.delete(id)
    refused.set(id, until)
    while (refused.size > MAX_REFUSED) refused.delete(refused.keys().next().value)
  }

  function isRefused(id) {
    if (forked.has(id)) return true
    const until = refused.get(id)
    if (until === undefined) return false
    if (until > now()) return true
    refused.delete(id)
    return false
  }

  // Ends one session's chat. The lifecycle stops first: it queues the removal of the binding entry and proves the
  // worker's end. The delivery is disposed afterwards so a pending input settles as uncertain, never as handed.
  function dispose(record) {
    if (record.closing) return record.closing
    record.dead = true
    records.delete(record.id)
    let ended
    try { ended = record.lifecycle ? Promise.resolve(record.lifecycle.stop()) : Promise.resolve({ code: 0 }) }
    catch { ended = Promise.resolve(null) }
    try { record.delivery?.dispose() } catch { /* the object is already latched */ }
    record.closing = ended.then(result => result?.code === 0, () => false)
    closings.add(record.closing)
    void record.closing.then(() => closings.delete(record.closing))
    return record.closing
  }

  // One session's fault ends that session's chat, nothing else.
  function isolate(record, error) {
    refuse(record.id, Infinity)
    notice(`chat disabled for one session (${describeFailure(error)})`)
    void dispose(record)
  }

  async function start(record, first) {
    if (!active || record.dead) return
    if (first?.type === "session.created" && first.data?.parentID !== undefined && first.data?.parentID !== null) {
      refuse(record.id, Infinity)
      records.delete(record.id)
      record.dead = true
      return
    }
    let info
    try { info = await ctx.session.get({ sessionID: record.id }) }
    catch {
      // A record that was ended while the lookup ran (a fork, a deletion, a fault) keeps the refusal that ended it.
      if (!active || record.dead) return
      // A lookup that fails is not proof of a child: ask again later, not on every event.
      refuse(record.id, now() + RETRY_LOOKUP_MS)
      records.delete(record.id)
      record.dead = true
      return
    }
    if (!active || record.dead) return
    if (!isRootSession(info, record.id)) {
      refuse(record.id, Infinity)
      records.delete(record.id)
      record.dead = true
      return
    }
    const handlers = new Map()
    const bus = { on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) } }
    record.fire = (name, payload) => { for (const fn of handlers.get(name) ?? []) fn(payload) }
    record.delivery = parts.createDelivery(ctx, record.id)
    record.delivery.seed(info)
    record.lifecycle = parts.createLifecycle(bus, record.delivery, config, {
      startProcess: parts.startProcess,
      notice: text => notice(String(text)),
    })
    record.fire("session_start", { nativeSessionId: record.id })
  }

  function handle(record, event) {
    if (!active || record.dead || !record.delivery) return
    if (record.delivery.observe(event)) record.fire("state_changed", {})
    // A compaction ended, or this is the first event since a gap: either may have dropped the binding entry, so a
    // read-back is owed. It waits while a compaction seen running has not reached its own terminal event.
    if (event.type === "session.compaction.ended") record.stale = true
    if (record.stale && !record.delivery.isCompacting()) {
      record.stale = false
      readBack(record)
    }
  }

  // Put the binding entry back or turn this session's chat off: no entry, no chat. The delivery keeps its gate
  // closed until this succeeds.
  function readBack(record) {
    record.delivery.verifyContext().catch(error => {
      try { void record.lifecycle.disable(describeFailure(error)) } catch { /* already latched */ }
    })
  }

  function feed(event) {
    if (!active) return
    const id = sessionOf(event)
    if (id === null) return
    if (event.type === "session.deleted" && forked.delete(id)) return // the fork has ended: its evidence is spent
    if (event.type === "session.deleted") {
      // Fenced here, not on the record's chain: a lookup still in flight finds its record dead before it can join.
      refuse(id, Infinity)
      const known = records.get(id)
      if (known) void dispose(known)
      return
    }
    if (event.type === "session.forked") {
      // This session is a fork: never a root. Recorded before any refusal check, lookup or join, so a fork is not
      // dropped during a temporary lookup refusal, and a lookup still in flight finds its record dead.
      forked.add(id)
      const known = records.get(id)
      if (known) void dispose(known)
      return
    }
    if (isRefused(id)) return
    let record = records.get(id)
    if (!record) {
      record = { id, delivery: null, lifecycle: null, fire: null, chain: Promise.resolve(), dead: false, closing: null, stale: false }
      records.set(id, record)
      const first = event
      record.chain = record.chain.then(() => start(record, first)).catch(error => isolate(record, error))
    }
    const current = record
    current.chain = current.chain.then(() => handle(current, event)).catch(error => isolate(current, error))
  }

  // The event stream broke or restarted: events may be missing, so every observation is stale.
  function reset() {
    for (const record of [...records.values()]) {
      record.chain = record.chain.then(() => {
        if (record.dead || !record.delivery) return
        record.delivery.reset()
        record.stale = true // read back at the next event, once the stream has resumed
        record.fire("state_changed", {})
      }).catch(error => isolate(record, error))
    }
  }

  // Ends every session, and waits for every end already in flight. Resolves true only when every worker end is proved.
  async function stop() {
    active = false
    const pending = [...records.values()].map(record => record.chain.then(() => dispose(record), () => dispose(record)))
    const results = await Promise.all([...pending, ...closings])
    return results.every(proved => proved === true)
  }

  return { feed, reset, stop, sessions: () => [...records.keys()] }
}
