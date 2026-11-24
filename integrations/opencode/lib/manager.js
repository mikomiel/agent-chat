// One manager per OpenCode server process: it turns the plugin event stream into one binding context and one
// lifecycle per root session. The plugin joins and keeps the binding in place. It sends input to a session in one place
// only, the idle hook (`idle`, below), and only when the config turns delivery on.
//
// ROOT SESSIONS ONLY. A session joins only when `session.get` shows no `parentID` and no `fork`. A subagent runs
// only in a child session and a child has a `parentID`. Whether a fork sets `parentID` is not confirmed, so a fork
// is refused too: when in doubt a session stays out. A parent pointer is not trusted as a root test either way.
//
// THE FIRST EVENT OF A SESSION ONLY SAYS THAT IT EXISTS. The first event the manager handles for a session it has not
// seen, of any subscribed kind but `session.inbox.delivered`, starts the lookup and the join. It says nothing about what the session is doing, and
// nothing here keeps such a state.
//
// A GAP OWES A READ-BACK. The binding context owes it from the reset, and the manager asks for it at the next event the
// session handles. A gap and a compaction signal are applied to a context that exists when they are received, so the
// proof is taken back at once; only the read-back waits on the session's chain (`applyNow`). Something the gap hid can still change the entry after that read-back, so the lifecycle reads the
// entry back at every heartbeat tick as well. A read-back that fails or is overtaken leaves the obligation owed. It
// turns chat off only when the host says the session is gone (below).
//
// FORKS AND CHILDREN ARE PERMANENT. A `session.forked` event, and a `session.created` event that names a parent, are
// evidence that outlives every cache: it is kept in its own set, never evicted, dropped only when the session is
// deleted, and shared with the next owner. It is fenced when it is received, whenever it arrives: a lookup still pending
// finds its record dead, and a session already joined ends its chat. A lookup that fails or answers later cannot undo it.
// A lookup answer for the session that names a fork or a parent is the same evidence and is kept the same way, so the
// next owner never asks again. An answer that is unreadable or for another session is not: it only refuses locally.
//
// DEFINITIVE EVIDENCE IS REPORTED WHENEVER IT LANDS. A not-found from an instruction-entry call or from the eligibility
// lookup, and a lookup answer that names a parent or a fork, are facts about the session, not about the call. Each goes
// to `reportDeleted` or `reportNotRoot`, which the registry sets to a received event, even when the answer comes after the
// call's time limit or after this record, context or manager ended. The time limit only releases the queue, and whether
// this record starts a worker is still decided by its own liveness.
//
// A DELETION IS FENCED WHEN IT IS RECEIVED, as a fork is: it is not queued behind a lookup that is still running. The
// record is ended at once, so a lookup that answers afterwards finds its record dead and starts no worker and sends
// no join. The deletion is also a tombstone in its own set, like fork evidence: no cache evicts it, and the next owner
// receives it, so a late event for that session is never looked up again. A lookup that answers also asks both shared
// sets once more, because the old owner can record a tombstone, or the registry a fork, while it runs.
//
// A DELETION CAN BE MISSED, AND THE TICK FINDS IT. The host has no replay and no cursor, so a `session.deleted` event
// can be lost with no gap marker, and nothing else would end that session's worker and binding. The heartbeat tick
// reads the binding entry, and every such read first reads the session: a deleted one fails it with the core's
// `Session.NotFoundError`. The binding context reports that answer (`onMissing`), and the manager passes it to
// `reportDeleted`. The registry sets that to a received `session.deleted` event: the tombstone, and the current owner's
// record, which may not be the one that asked. Alone, the manager ends its own record. A timeout, any other error and a
// session that is found change nothing. No host call is added for this.
//
// A LOOKUP HOLDS NOTHING BACK. A record still in its eligibility lookup has no worker and no binding entry, so
// `stop()` ends it at once and waits only for the worker and entry cleanup of joined sessions. A lookup that never
// answers cannot keep the next owner waiting, and its late answer finds the manager inactive and starts nothing. It
// also ends at the call time limit as a failed lookup, so the later events of its session are not queued behind it
// for ever: the cooldown below applies, and the next event after it asks afresh.
//
// THE IDLE HOOK DELIVERS, AND NOTHING ELSE DOES. `idle(sessionID)` is what OpenCode's `experimental.idle` hook calls when
// a session has finished model work and has no input left. It claims and admits only there, so no state of the session is
// kept from events: the hook asks the host about the session at that moment, and the worker's own reply decides the rest. An
// event is read only against the attempt the hook made (`session.inbox.delivered`, lib/delivery.js) or as a reset of the cap
// (`session.execution.started`). It never creates a record and never runs on a session's chain: it takes the lifecycle's turn
// at the worker, or claims nothing. Everything it awaits is under one budget, `IDLE_BUDGET_MS`: the host does not time a hook
// out, so a hook that did not return would stall the session's end of turn. The budget is a deadline on the monotonic clock,
// the hook's start plus the budget. A timer armed for what is left of it releases the hook, and the hook reads the clock
// itself as the last step before the claim and as the last step before the host call: a timer can run late. At the budget
// the hook returns and nothing moves forward from it. A grant held and not yet written to the session settles deferred, so
// the server offers it again. An admission still in flight settles uncertain. An input that the host has accepted is not the
// budget's: its delivered event or its own deadline settles it, whatever the hook's cleanup is doing.
//
// ONE FAULT BOUNDARY PER SESSION. Events of one session run in order on that session's own chain, and a throw or
// rejection there, or in a signal applied on receipt, disables chat for that session only. A deleted session never rejoins in this process. A session
// that faulted stays out while its refusal is in the bounded lookup cache, so a worker that is still ending is not
// raced by a second join until that entry is evicted.
import { CHAT_SOURCE, monotonicNow } from "./channel.js"
import { CALL_TIMEOUT_MS, isMissing } from "./context.js"
import { createDelivery, inboxIDOf } from "./delivery.js"
import { describeFailure } from "./worker.js"

// The events the manager reads. Session events of other kinds, such as every tool call, are never subscribed to.
// Each kind shows that a session exists: the first event seen for a session starts its join, and any later one is a
// sign that the stream is up. No event is read as a state of the session. A compaction signal also owes the binding
// read-back.
export const EVENT_TYPES = Object.freeze([
  "session.created", "session.execution.started", "session.forked", "session.deleted",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
])

// The event of an input promoted into a session's history. Subscribed only when the config turns delivery on, and read only
// against an attempt the idle hook made. Not one of EVENT_TYPES: none of those is read as a state of the session.
export const DELIVERY_EVENT = "session.inbox.delivered"

// Every await of one idle hook runs under this budget, from the first host call to the admission.
export const IDLE_BUDGET_MS = 1_500
// The built-in agent that denies edits. A custom agent with the same limits is not detected.
const PLAN_AGENT = "plan"

const RETRY_LOOKUP_MS = 60_000
const MAX_REFUSED = 1024

// A root session has no parent and no fork source. Anything else, and anything unreadable, is not a root.
export function isRootSession(info, sessionID) {
  if (info === null || typeof info !== "object" || info.id !== sessionID) return false
  return (info.parentID === undefined || info.parentID === null) && (info.fork === undefined || info.fork === null)
}

// An answer for this session that names a parent or a fork source.
const namesParent = (info, sessionID) => info !== null && typeof info === "object" && info.id === sessionID
  && ((info.parentID !== undefined && info.parentID !== null) || (info.fork !== undefined && info.fork !== null))

// The id of the session an event belongs to, or null when it names none.
export const sessionOf = event => (typeof event?.data?.sessionID === "string" && event.data.sessionID ? event.data.sessionID : null)

// The id of the session that an event shows is never a root, or null for any other event: a `session.forked` event, and
// a `session.created` event that names a parent. The `parentID` test is the one `start()` used on a first event.
export const notRootSessionOf = event => {
  if (event?.type === "session.forked") return sessionOf(event)
  if (event?.type !== "session.created") return null
  return event.data?.parentID !== undefined && event.data?.parentID !== null ? sessionOf(event) : null
}

// The id of the session a `session.deleted` event describes, or null for any other event.
export const deletedSessionOf = event => (event?.type === "session.deleted" ? sessionOf(event) : null)

export function createManager(ctx, config, parts, {
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  notice = () => {},
  forked = new Set(), // fork evidence: session ids that are never roots; the registry hands every owner the same set
  deleted = new Set(), // deletion tombstones: ids of sessions that ended; never evicted, shared like `forked`
  // Where definitive evidence this manager learned from the host goes: a deleted session, a child or fork. The registry
  // sets both, so the evidence reaches the current owner, which may not be this one. Alone, the manager acts on its own.
  reportDeleted = null,
  reportNotRoot = null,
  idleBudgetMs = IDLE_BUDGET_MS,
  // The clock of the hook's own deadline, the hook's start plus the budget. Monotonic, so a wall-clock step cannot move it.
  monotonic = monotonicNow,
  // The open attempt of each session and the cap. Its clock is the lifecycle's, not `now` above: a deadline is on that one.
  delivery = createDelivery(),
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
    delivery.forget(record.id)
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

  // The eligibility lookup has the same time limit as one instruction-entry call: a lookup that never answers would hold
  // its session's chain, and every later event of that session, for ever. A lookup that runs out of time is a failed
  // lookup. The host is not told to stop it, and its late answer settles a promise that already ended, so it creates
  // nothing: only `start` can create a worker, and it has moved on. An answer that names a parent or a fork, and a
  // rejection with the session's own not-found, are evidence about the session, not about this lookup, so each is
  // reported whenever it lands: late, or after this manager stopped.
  function lookup(sessionID) {
    return new Promise((resolve, reject) => {
      const timer = setTimeoutImpl(() => reject(new Error("LOOKUP_TIMEOUT")), CALL_TIMEOUT_MS)
      timer?.unref?.() // a lookup that is never answered must not keep a stopping process alive for the limit
      const answer = settle => value => { clearTimeoutImpl(timer); settle(value) }
      new Promise(begin => begin(ctx.session.get({ sessionID }))).then(info => {
        if (namesParent(info, sessionID)) { try { (reportNotRoot ?? markNotRoot)(sessionID) } catch { /* advisory */ } }
        answer(resolve)(info)
      }, error => {
        // The session's own not-found is the same host evidence as at an entry call. Any other failure is a failed lookup.
        if (isMissing(error, sessionID)) { try { (reportDeleted ?? markDeleted)(sessionID) } catch { /* advisory */ } }
        answer(reject)(error)
      })
    })
  }

  async function start(record) {
    if (!active || record.dead) return
    let info
    try { info = await lookup(record.id) }
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
    // Both sets are shared with the other owners. Evidence that another owner recorded while this lookup ran, such as a
    // tombstone from the old owner's last call as it ended, reaches this record only here: it is not fed to this manager.
    if (deleted.has(record.id) || forked.has(record.id)) {
      records.delete(record.id)
      record.dead = true
      return
    }
    if (!isRootSession(info, record.id)) {
      // An answer that names this session's parent or fork was reported when it landed. An unreadable answer, or one for
      // another session, proves nothing: only this owner's cache refuses it.
      refuse(record.id, Infinity)
      records.delete(record.id)
      record.dead = true
      return
    }
    const handlers = new Map()
    const bus = { on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) } }
    record.fire = (name, payload) => { for (const fn of handlers.get(name) ?? []) fn(payload) }
    record.context = parts.createContext(ctx, record.id, { onMissing: () => (reportDeleted ?? markDeleted)(record.id) })
    record.lifecycle = parts.createLifecycle(bus, record.context, config, {
      startProcess: parts.startProcess,
      notice: text => notice(String(text)),
    })
    record.fire("session_start", { nativeSessionId: record.id })
  }

  // A compaction signal, or the first event since a gap, may have left the binding entry dropped. The binding context
  // owes that read-back, failed and overtaken ones included, and says when one may start. A check that fails or is
  // overtaken leaves the obligation owed, so the next event asks again. It never rejects, so nothing is awaited or
  // handled here, and only a session the host reports gone ends (`onMissing`). An event that `applyNow` already gave to
  // the context is not given again: only the repair waits for the chain.
  function handle(record, event, applied) {
    if (!active || record.dead || !record.context) return
    if (!applied) record.context.observe(event)
    void record.context.repair()
  }

  // A signal or a gap takes the binding's proof back when it is received, not when the session's chain reaches it: the
  // lifecycle asks for the proof synchronously when it sends a join's first heartbeat, and a continuation already queued
  // can run before the chain does. A session whose context does not exist yet gets the event on the chain, after its
  // lookup, as before. True when the context took it now. A throw is that session's fault, as on its chain.
  function applyNow(record, apply) {
    if (!active || record.dead || !record.context) return false
    try { apply(record.context) } catch (error) { isolate(record, error) }
    return true
  }

  // Fenced here, not on the record's chain: a lookup still in flight finds its record dead before it can join. The
  // tombstone refuses the id from now on, so a fork record for it is spent.
  function markDeleted(id) {
    deleted.add(id)
    forked.delete(id)
    const known = records.get(id)
    if (known) void dispose(known)
  }

  // This session is a fork or a child: never a root. Recorded before any refusal check, lookup or join, so it is not
  // dropped during a temporary lookup refusal, and a lookup still in flight, or a join already made, ends with it. After
  // the deletion it is late: the tombstone already refuses the id, and a fork record for it would never be removed.
  function markNotRoot(id) {
    if (deleted.has(id)) return
    forked.add(id)
    const known = records.get(id)
    if (known) void dispose(known)
  }

  function feed(event) {
    if (!active) return
    const id = sessionOf(event)
    if (id === null) return
    // An input promoted into a session settles the attempt the hook made for it, and nothing else. It opens no record.
    if (event.type === DELIVERY_EVENT) {
      delivery.delivered(id, event.data?.inboxID)
      return
    }
    // A new execution has its own allowance of hook deliveries.
    if (event.type === "session.execution.started") delivery.restart(id)
    if (event.type === "session.deleted") {
      markDeleted(id)
      return
    }
    if (notRootSessionOf(event) !== null) {
      markNotRoot(id)
      return
    }
    if (isRefused(id)) return
    let record = records.get(id)
    if (!record) {
      record = { id, context: null, lifecycle: null, fire: null, chain: Promise.resolve(), dead: false, closing: null }
      records.set(id, record)
      record.chain = record.chain.then(() => start(record)).catch(error => isolate(record, error))
    }
    const current = record
    const applied = applyNow(current, context => context.observe(event))
    current.chain = current.chain.then(() => handle(current, event, applied)).catch(error => isolate(current, error))
  }

  // The event stream broke or restarted: events may be missing, so every observation is stale. A read-back is owed now,
  // and asked for at the next event or tick.
  function reset() {
    delivery.reset() // a delivered event may have been lost with the stream: an open attempt can no longer be proved
    for (const record of [...records.values()]) {
      if (applyNow(record, context => context.reset())) continue
      record.chain = record.chain.then(() => {
        if (record.dead || !record.context) return
        record.context.reset()
      }).catch(error => isolate(record, error))
    }
  }

  // The function the lifecycle calls to admit the rendered notice. The attempt is opened before the host is asked, so an event
  // that arrives early finds it, and the call is not awaited past the attempt's own end: a call that never answers ends with
  // the hook's budget. The input is a steer input admitted with `resume: false`: it joins a run that is going on and never
  // starts one, which is the only way a plugin can hand input to a session it has just proved to be between model turns. A
  // rejection or a throw leaves the attempt uncertain: the input may exist already, and it cannot be taken back. A call that
  // returns hands the attempt over to its own event and deadline: from then on the budget does not end it, because the host
  // has accepted the input and its delivered event can still come in time. The caller's time is asked once more as the last
  // step before the host call, after the attempt is open and its timer armed, and nothing runs between that check and the
  // call. A caller that is out of time makes no call: it closes the attempt, and answers that nothing was written.
  function admitter(record, turn, open) {
    return async ({ text, attemptID, deadline }) => {
      const inboxID = inboxIDOf(attemptID)
      const attempt = delivery.open(record.id, { inboxID, deadline })
      turn.admitting = attempt
      const input = {
        id: inboxID,
        sessionID: record.id,
        text,
        description: "Agent Chat",
        metadata: { source: CHAT_SOURCE },
        delivery: "steer",
        resume: false,
      }
      if (!open()) {
        turn.admitting = null
        attempt.abandon()
        return { written: false }
      }
      let call
      try {
        call = Promise.resolve(ctx.session.synthetic(input))
      } catch {
        attempt.abandon()
        return attempt
      }
      call.then(() => { turn.admitting = null }, () => attempt.abandon())
      await Promise.race([call.then(undefined, () => {}), attempt.done])
      return attempt
    }
  }

  // One hook's work, up to the lifecycle's own sequence. Every host answer is checked against the turn before the next step.
  // The turn is over when the budget's timer has run, and also when the clock is at the deadline: a timer can run late, and
  // a reply can be read before it does.
  async function deliver(record, turn) {
    const open = () => !turn.over && active && !record.dead && monotonic() < turn.until
    // The same lookup as a join, so a session the host no longer has, or one that is a child or a fork, is reported as always.
    const info = await lookup(record.id)
    if (!open() || !isRootSession(info, record.id) || info.agent === PLAN_AGENT) return
    if (!(await record.context.held()) || !open()) return
    await record.lifecycle.idle(admitter(record, turn, open), open)
  }

  // `experimental.idle`. Returns undefined, with nothing awaited, when there is nothing to do: delivery is off, the manager
  // is stopped, the session has no joined record (a child, a fork, an unseen or a refused session), its chat is off, or it has
  // used its allowance for this execution. Otherwise a promise that never rejects and settles within the budget.
  function idle(sessionID) {
    if (!active || config?.delivery !== true || typeof sessionID !== "string" || !sessionID || isRefused(sessionID)) return undefined
    const record = records.get(sessionID)
    if (!record || record.dead || !record.context || !record.lifecycle?.ready?.() || !delivery.allowed(sessionID)) return undefined
    const turn = { over: false, admitting: null, until: monotonic() + idleBudgetMs }
    let timer
    const expired = new Promise(resolve => {
      // For what is left of the deadline, not for a fresh budget: time that passed since the deadline was taken is not given back.
      timer = setTimeoutImpl(() => {
        turn.over = true
        turn.admitting?.abandon() // a call still in flight may land the input: it is uncertain, whatever the host answers later
        resolve()
      }, Math.max(0, turn.until - monotonic()))
      timer?.unref?.() // the hook returns at the budget; the timer must not outlive it
    })
    const finished = deliver(record, turn).catch(() => { /* a failed read or step claims nothing */ })
    return Promise.race([finished, expired]).then(() => { clearTimeoutImpl(timer) })
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

  return { feed, reset, idle, stop, sessions: () => [...records.keys()] }
}
