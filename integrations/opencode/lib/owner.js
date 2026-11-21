// The process-wide owner. OpenCode loads a plugin once per location, so one server process can run several plugin
// instances. Each instance is a member of one registry. Exactly one member, the owner, runs a manager: joins,
// heartbeats and deliveries come from one place, never twice for a session.
//
// EVENTS. Every member reads its own event stream and forwards each event to the registry. Nothing here assumes that
// one stream covers every location, or that each stream is a separate one. The published plugin and client types
// (2.3.2) document no order for event ids or for `durable.seq`, so a bounded memory of seen ids cannot promise to
// recognise a delayed duplicate: once an id is evicted, a late `execution.started` from a second stream could mark an
// idle session running. A session's events are therefore accepted from one stream only, the member that delivered it
// first: a stream delivers in order. Another member's copy of them is dropped. A fork or a deletion is the exception,
// because it is idempotent and final: it is recorded from any stream and passed on. The session is released when its
// stream is reset or its member leaves, and the next stream that delivers it takes it over. The registry also drops an
// event id it has already seen. The cost is a fail-open case: a holding stream that goes quiet for a session while
// another stream still delivers it leaves the owner with the last state it saw, until the holder is reset or leaves.
//
// FAILOVER. When the owner's instance is torn down, the registry waits until that owner's workers have ended and
// only then promotes the next member. A session rejoins at its next event. Registry changes run one at a time.
// A member that leaves without being the owner is a continuity break for the owner, as a lost stream is.
//
// The registry holds members and their callbacks. The config, and with it the host token, lives only in the
// closures a member was built from; no property of the registry or of a member carries it.
import { EVENT_TYPES, createManager, deletedSessionOf, forkedSessionOf, sessionOf } from "./manager.js"

const REGISTRY_KEY = Symbol.for("agent-chat.opencode.registry.v1")
const MAX_SEEN_EVENTS = 1024
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export function createRegistry() {
  const members = []
  const seen = new Set() // event ids, newest last, bounded
  const forks = new Set() // sessions known to be forks: every owner gets this set, so a promotion forgets none
  const deletions = new Set() // deletion tombstones: handed to every owner the same way
  const pins = new Map() // session id -> the member whose stream delivered it first
  let owner = null
  let turn = Promise.resolve()

  const later = work => { turn = turn.then(work).catch(() => {}); return turn }

  function promote() {
    owner = members[0] ?? null
    if (owner) owner.activate(forks, deletions)
  }

  // `member` is the one whose stream delivered the event; a caller that has none is not filtered.
  function dispatch(event, member) {
    // Recorded before the owner check and before the stream filter: a fork or deletion event between two owners, or
    // from a stream that does not hold the session, is kept for the next one.
    const forked = forkedSessionOf(event)
    if (forked !== null) forks.add(forked)
    const gone = deletedSessionOf(event)
    if (gone !== null) { deletions.add(gone); forks.delete(gone); pins.delete(gone) }
    if (!owner) return
    // Filtered before the id is remembered: a copy dropped here must not hide the same event from the stream that holds
    // the session. A session with fork or deletion evidence is final, so the owner refuses it whatever stream it came from.
    const session = sessionOf(event)
    if (member !== undefined && session !== null && !forks.has(session) && !deletions.has(session)) {
      const holder = pins.get(session)
      if (holder === undefined) pins.set(session, member)
      else if (holder !== member) return
    }
    const id = event?.id
    if (typeof id === "string" && id) {
      if (seen.has(id)) return
      seen.add(id)
      while (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.values().next().value)
    }
    try { owner.feed(event) } catch { /* one event must not stop the stream */ }
  }

  // Sessions a member held are released: its stream was lost or ended, so nothing orders what another stream delivers
  // next against what it delivered before. The next stream that delivers a session takes it.
  function release(member) {
    for (const [session, holder] of pins) if (holder === member) pins.delete(session)
  }

  function reset(member) {
    if (member !== undefined) release(member)
    try { owner?.reset() } catch { /* nothing to recover */ }
  }

  // Returns the cleanup the plugin hands back to OpenCode. It resolves once any ownership change it caused is done.
  function attach(member) {
    members.push(member)
    const stopPump = member.pump(event => dispatch(event, member), () => reset(member))
    void later(() => { if (owner === null) promote() })
    let detached = null
    return () => {
      detached ??= later(async () => {
        stopPump()
        release(member)
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
