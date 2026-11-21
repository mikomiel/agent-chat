// The process-wide owner. OpenCode loads a plugin once per location, so one server process can run several plugin
// instances. Each instance is a member of one registry. Exactly one member, the owner, runs a manager: joins,
// heartbeats and deliveries come from one place, never twice for a session.
//
// EVENTS. Every member reads its own event stream and forwards each event to the registry. Nothing here assumes that
// one stream covers every location, or that each stream is a separate one, so the same event can arrive more than
// once: from several streams, or as a lagging stream's replay after a handoff. The registry orders events by the
// host's own sequence number. Evidence: upstream `anomalyco/opencode` at tag v2.3.2 (commit c0ad18b4), `packages/core`
// (`bus.ts`) and `packages/schema`, and the published `@opencode/*` 2.3.2 types.
//   - Every session event this plugin subscribes to is durable and carries `durable = { aggregateID, seq, version }`.
//     `aggregateID` is the session id. `seq` counts from 0 per session. The host assigns it in the commit transaction
//     under a per-session lock, so commit, publish and delivery order agree within one subscription.
//   - `seq` has gaps, because internal events use numbers too. It is an order, never a count: no check here asks for
//     `last + 1`. Event ids and timestamps are assigned before that lock and are not an order.
//   - The host never replays. A subscription sees only what happens after it starts, so an old event can only come
//     from another stream or from the plugin's own backlog.
// The registry keeps ONE process-wide high-water mark per session: the highest `seq` it has passed on to an owner. An
// event is passed on only when its `seq` is above the mark, and it raises the mark. A copy from another stream, a
// replay after a handoff and a delayed duplicate are at or below the mark and are dropped, whatever id they carry. An
// event that follows at once, such as a `started` right after a `succeeded`, has a higher `seq` and is applied. The
// marks live in the registry, so they outlive an owner promotion and a stream reset. An event that arrives while
// there is no owner is not recorded: nobody saw it, so its other copy is still new until a higher `seq` of the session
// is passed on.
// The mark alone would also drop a lower event that no stream had delivered yet, and a lost run end leaves the owner
// seeing a session as running. So the registry keeps, per session, `openStart`: the `seq` of the latest
// `session.execution.started` it passed on that no run end has closed. A run end (`succeeded`, `failed` or
// `interrupted`) at or below the mark is still passed on when `openStart` is set and its `seq` is above it: it ends the
// open run, clears `openStart`, and moves the mark neither up nor down. A run end below `openStart` belongs to an
// earlier run that a successor start replaced, and one with no open run is a copy of an end already passed on, or an
// end of a run the owner never saw start; both are dropped, so a stale end can never end a newer run. A run end above
// the mark follows the normal rule and clears `openStart` too. `openStart` lives next to the marks, so it also
// survives a promotion and a reset.
// An excepted end is applied after the newer events that moved the mark, so a late operator interrupt sets the stop
// latch again after a newer user prompt cleared it. The session then stays stopped until the next user prompt, which
// fails closed.
// What is still lost is a non-terminal event below the mark that no stream delivered first. Per type: a lost
// `execution.started` can only make the session look idle or unknown, never running, so it is never eligible; a lost
// user `inbox.enqueued` leaves the stop latch set; a lost `inbox.delivered` or `inbox.cancelled` settles a pending
// notice uncertain at its deadline; a lost compaction `ended` or `failed` leaves the gate closed until the next
// compaction event; losing both compaction events leaves a binding entry that the compaction removed unrepaired until
// the next gap. All of those fail closed or lose only function. Two cases fail open. A lost `agent.selected` that
// switches to Plan Mode leaves the owner with the older agent, so the session stays eligible until its next
// `agent.selected`. A lost compaction `started` leaves the gate open from the compaction's start until its `ended`
// arrives, which then owes the binding read-back.
// An event with no valid envelope is dropped, which fails closed: with no order it cannot be told from a stale copy.
// Valid means `durable.aggregateID` is the event's session and `durable.seq` is a non-negative integer. Every type in
// `EVENT_TYPES` is durable by schema, so a missing envelope is a malformed event, never an ephemeral one.
// A fork or a deletion is the exception, because it is idempotent and final: it is recorded from any event before the
// filter, and a session with that evidence needs no order, because the owner refuses it. A fork or a deletion drops
// the session's mark and `openStart`, and a deletion leaves a tombstone. Otherwise a mark is one number per session
// seen and is never evicted, so the maps grow by up to two entries for each session the process sees, until that
// session is forked or deleted.
//
// FAILOVER. When the owner's instance is torn down, the registry waits until that owner's workers have ended and
// only then promotes the next member. A session rejoins at its next event. Registry changes run one at a time.
// A member that leaves without being the owner is a continuity break for the owner, as a lost stream is.
//
// The registry holds members and their callbacks. The config, and with it the host token, lives only in the
// closures a member was built from; no property of the registry or of a member carries it.
import { EVENT_TYPES, createManager, deletedSessionOf, forkedSessionOf, sessionOf } from "./manager.js"

const REGISTRY_KEY = Symbol.for("agent-chat.opencode.registry.v1")
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RUN_START = "session.execution.started"
const RUN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

export function createRegistry() {
  const members = []
  const forks = new Set() // sessions known to be forks: every owner gets this set, so a promotion forgets none
  const deletions = new Set() // deletion tombstones: handed to every owner the same way
  const highWater = new Map() // session id -> the highest `durable.seq` passed on to an owner
  const openStart = new Map() // session id -> the `seq` of its latest passed-on run start that no run end has closed
  let owner = null
  let turn = Promise.resolve()

  const later = work => { turn = turn.then(work).catch(() => {}); return turn }

  function promote() {
    owner = members[0] ?? null
    if (owner) owner.activate(forks, deletions)
  }

  // The host's order for one session: null when the envelope is missing, is another session's, or has no integer `seq`.
  // The host counts from 0, so a session with no mark takes seq 0 and a negative seq is never above the mark.
  function seqOf(event, session) {
    const { aggregateID, seq } = event.durable ?? {}
    return aggregateID === session && Number.isSafeInteger(seq) ? seq : null
  }

  // Is this event of a session without fork or deletion evidence to be passed on? See the header for the rule.
  function inOrder(event, session) {
    const seq = seqOf(event, session)
    if (seq === null) return false
    const ends = RUN_ENDS.has(event.type)
    if (seq > (highWater.get(session) ?? -1)) {
      highWater.set(session, seq)
      if (event.type === RUN_START) openStart.set(session, seq)
      else if (ends) openStart.delete(session) // the mark was at or above `openStart`, so this end is above it
      return true
    }
    const start = openStart.get(session)
    if (!ends || start === undefined || seq <= start) return false
    openStart.delete(session) // the end of the open run: the mark stays
    return true
  }

  function dispatch(event) {
    // Recorded before the owner check and before the order filter: a fork or deletion event between two owners is
    // kept for the next one.
    const forked = forkedSessionOf(event)
    if (forked !== null) { forks.add(forked); highWater.delete(forked); openStart.delete(forked) }
    const gone = deletedSessionOf(event)
    if (gone !== null) { deletions.add(gone); forks.delete(gone); highWater.delete(gone); openStart.delete(gone) }
    if (!owner) return
    const session = sessionOf(event)
    if (session === null) return
    // A session with fork or deletion evidence is final, so the owner refuses it and its events need no order.
    if (!forks.has(session) && !deletions.has(session) && !inOrder(event, session)) return
    try { owner.feed(event) } catch { /* one event must not stop the stream */ }
  }

  function reset() {
    try { owner?.reset() } catch { /* nothing to recover */ }
  }

  // Returns the cleanup the plugin hands back to OpenCode. It resolves once any ownership change it caused is done.
  function attach(member) {
    members.push(member)
    const stopPump = member.pump(dispatch, reset)
    void later(() => { if (owner === null) promote() })
    let detached = null
    return () => {
      detached ??= later(async () => {
        stopPump()
        const index = members.indexOf(member)
        if (index >= 0) members.splice(index, 1)
        if (owner !== member) {
          // This member's stream may have been the only one covering some of the owner's sessions. Events it would
          // have carried are lost now, so the owner's observations are stale: the same continuity break as a lost stream.
          reset()
          return
        }
        owner = null
        // The previous owner's workers end before the next owner can join the same sessions.
        try { await member.deactivate() } catch { /* a failed end is the manager's to report */ }
        promote()
      })
      return detached
    }
  }

  return { attach, dispatch, owner: () => owner, members: () => [...members] }
}

export function globalRegistry() {
  return (globalThis[REGISTRY_KEY] ??= createRegistry())
}

const abortable = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
  signal.addEventListener("abort", done, { once: true })
})

// One plugin instance. `activate` starts the manager when the registry makes this member the owner.
export function createMember(ctx, config, parts, { managerOptions = {}, sleep = abortable } = {}) {
  let manager = null
  const controller = new AbortController()

  // Reads this instance's stream until it is torn down. A stream that ends or throws is lost events: every
  // observation is stale, so the owner resets. The first connect of a stream is not a loss; a later one is.
  async function pump(dispatch, reset) {
    const { signal } = controller
    let connected = false
    let wait = RECONNECT_MIN_MS
    while (!signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ types: [...EVENT_TYPES], signal })) {
          if (signal.aborted) return
          if (event?.type === "server.connected") {
            if (connected) reset()
            connected = true
            wait = RECONNECT_MIN_MS
            continue
          }
          dispatch(event)
        }
      } catch { /* fall through: reset and reconnect */ }
      if (signal.aborted) return
      reset()
      await sleep(wait, signal)
      wait = Math.min(wait * 2, RECONNECT_MAX_MS)
    }
  }

  return {
    pump(dispatch, reset) {
      void pump(dispatch, reset).catch(() => {})
      return () => controller.abort()
    },
    activate(forked, deleted) { manager = createManager(ctx, config, parts, { ...managerOptions, forked, deleted }) },
    async deactivate() {
      const ending = manager
      manager = null
      return ending ? ending.stop() : true
    },
    feed(event) { manager?.feed(event) },
    reset() { manager?.reset() },
  }
}
