// One manager per OpenCode server process: it turns the plugin event stream into one binding context and one
// lifecycle per root session. The plugin joins and keeps the binding in place. It never sends input to a session.
//
// ROOT SESSIONS ONLY. A session joins only when `session.get` shows no `parentID` and no `fork`. A subagent runs
// only in a child session and a child has a `parentID`. Whether a fork sets `parentID` is not confirmed, so a fork
// is refused too: when in doubt a session stays out. A parent pointer is not trusted as a root test either way.
//
// THE FIRST EVENT OF A SESSION ONLY SAYS THAT IT EXISTS. The first event the manager handles for a session it has not
// seen, of any subscribed kind, starts the lookup and the join. It says nothing about what the session is doing, and
// nothing here keeps such a state.
//
// A GAP OWES A READ-BACK. The binding context owes it from the reset, and the manager asks for it at the next event the
// session handles. Something the gap hid can still change the entry after that read-back, so the lifecycle reads the
// entry back at every heartbeat tick as well. A read-back that fails or is overtaken leaves the obligation owed, and it
// never turns chat off.
//
// FORKS ARE PERMANENT. A `session.forked` event is evidence that outlives every cache: it is kept in its own set,
// never evicted, dropped only when the session is deleted, and shared with the next owner. A lookup that fails or
// answers later cannot undo it.
//
// A DELETION IS FENCED WHEN IT IS RECEIVED, as a fork is: it is not queued behind a lookup that is still running. The
// record is ended at once, so a lookup that answers afterwards finds its record dead and starts no worker and sends
// no join. The deletion is also a tombstone in its own set, like fork evidence: no cache evicts it, and the next owner
// receives it, so a late event for that session is never looked up again.
//
// A LOOKUP HOLDS NOTHING BACK. A record still in its eligibility lookup has no worker and no binding entry, so
// `stop()` ends it at once and waits only for the worker and entry cleanup of joined sessions. A lookup that never
// answers cannot keep the next owner waiting, and its late answer finds the manager inactive and starts nothing.
//
// ONE FAULT BOUNDARY PER SESSION. Events of one session run in order on that session's own chain, and a throw or
// rejection there disables chat for that session only. A deleted session never rejoins in this process. A session
// that faulted stays out while its refusal is in the bounded lookup cache, so a worker that is still ending is not
// raced by a second join until that entry is evicted.
import { describeFailure } from "./worker.js"

// The events the manager reads. Session events of other kinds, such as every tool call, are never subscribed to.
// Each kind shows that a session exists: the first event seen for a session starts its join, and any later one is a
// sign that the stream is up. No event is read as a state of the session. A compaction signal also owes the binding
// read-back.
export const EVENT_TYPES = Object.freeze([
  "session.created", "session.execution.started", "session.forked", "session.deleted",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
])

const RETRY_LOOKUP_MS = 60_000
const MAX_REFUSED = 1024

// A root session has no parent and no fork source. Anything else, and anything unreadable, is not a root.
export function isRootSession(info, sessionID) {
  if (info === null || typeof info !== "object" || info.id !== sessionID) return false
  return (info.parentID === undefined || info.parentID === null) && (info.fork === undefined || info.fork === null)
}

// The id of the session an event belongs to, or null when it names none.
export const sessionOf = event => (typeof event?.data?.sessionID === "string" && event.data.sessionID ? event.data.sessionID : null)

// The id of the session a `session.forked` event describes, or null for any other event.
export const forkedSessionOf = event => (event?.type === "session.forked" ? sessionOf(event) : null)

// The id of the session a `session.deleted` event describes, or null for any other event.
export const deletedSessionOf = event => (event?.type === "session.deleted" ? sessionOf(event) : null)

export function createManager(ctx, config, parts, {
  now = Date.now,
  notice = () => {},
  forked = new Set(), // fork evidence: session ids that are never roots; the registry hands every owner the same set
  deleted = new Set(), // deletion tombstones: ids of sessions that ended; never evicted, shared like `forked`
} = {}) {
  const records = new Map() // session id -> { id, context, lifecycle, chain, dead, closing }
  const refused = new Map() // session id -> time until which it is not looked up again (Infinity: never)
  const closings = new Set() // ends still in flight, so stop() also waits for a session that ended before it was called
  let active = true

  function refuse(id, until) {
    refused.delete(id)
    refused.set(id, until)
    while (refused.size > MAX_REFUSED) refused.delete(refused.keys().next().value)
  }

  function isRefused(id) {
    if (forked.has(id) || deleted.has(id)) return true
    const until = refused.get(id)
    if (until === undefined) return false
    if (until > now()) return true
    refused.delete(id)
    return false
  }

  // Ends one session's chat. The lifecycle stops first: it queues the removal of the binding entry and proves the
  // worker's end. The binding context is disposed afterwards, so a check still in flight proves and repairs nothing.
  function dispose(record) {
    if (record.closing) return record.closing
    record.dead = true
    records.delete(record.id)
    let ended
    try { ended = record.lifecycle ? Promise.resolve(record.lifecycle.stop()) : Promise.resolve({ code: 0 }) }
    catch { ended = Promise.resolve(null) }
    try { record.context?.dispose() } catch { /* the object is already latched */ }
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
    record.context = parts.createContext(ctx, record.id)
    record.lifecycle = parts.createLifecycle(bus, record.context, config, {
      startProcess: parts.startProcess,
      notice: text => notice(String(text)),
    })
    record.fire("session_start", { nativeSessionId: record.id })
  }

  // A compaction signal, or the first event since a gap, may have left the binding entry dropped. The binding context
  // owes that read-back, failed and overtaken ones included, and says when one may start. A check that fails or is
  // overtaken leaves the obligation owed, so the next event asks again. It never turns chat off and never rejects,
  // so nothing is awaited or handled here.
  function handle(record, event) {
    if (!active || record.dead || !record.context) return
    record.context.observe(event)
    void record.context.repair()
  }

  function feed(event) {
    if (!active) return
    const id = sessionOf(event)
    if (id === null) return
    if (event.type === "session.deleted") {
      // Fenced here, not on the record's chain: a lookup still in flight finds its record dead before it can join.
      // The tombstone refuses the id from now on, so a fork record for it is spent.
      deleted.add(id)
      forked.delete(id)
      const known = records.get(id)
      if (known) void dispose(known)
      return
    }
    if (event.type === "session.forked") {
      // A fork event that arrives after the deletion is late: the tombstone already refuses the id, and a fork record
      // for it would be one that no later event removes.
      if (deleted.has(id)) return
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
      record = { id, context: null, lifecycle: null, fire: null, chain: Promise.resolve(), dead: false, closing: null }
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
        if (record.dead || !record.context) return
        record.context.reset() // a read-back is owed now, and asked for at the next event or tick
      }).catch(error => isolate(record, error))
    }
  }

  // Ends every session, and waits for every end already in flight. Resolves true only when every worker end is proved.
  async function stop() {
    active = false
    // A record with no lifecycle is still in its lookup: no worker, no entry, so nothing to wait for. A joined session
    // waits for its chain, then for the cleanup its disposal starts.
    const pending = [...records.values()].map(record => (record.lifecycle
      ? record.chain.then(() => dispose(record), () => dispose(record))
      : dispose(record)))
    const results = await Promise.all([...pending, ...closings])
    return results.every(proved => proved === true)
  }

  return { feed, reset, stop, sessions: () => [...records.keys()] }
}
