// The process-wide owner. OpenCode loads a plugin once per location, so one server process can run several plugin
// instances. Each instance is a member of one registry. Exactly one member, the owner, runs a manager: joins and
// heartbeats come from one place, never twice for a session.
//
// EVENTS. Every member reads its own event stream and forwards each event to the registry. Nothing here assumes that
// one stream covers every location, or that each stream is a separate one, so the same event can arrive more than
// once: from several streams, or as a lagging stream's replay after a handoff. The registry keeps no order and drops
// nothing, because every event the manager acts on is safe to repeat. A `session.created` or `session.execution.started`
// for a session already joined only shows that the stream is up. A compaction signal, early, late or twice, only owes
// an idempotent read-back again. A fork or a deletion is final and is recorded once per session.
// An event that arrives while there is no owner is lost: nobody saw it. A session that it would have joined joins at
// its next event.
// A fork, a child's `session.created` or a deletion is recorded from any event, before the owner check. A deletion
// leaves a tombstone. Both sets are handed to every owner, so a promotion forgets none. A tombstone is final: a
// `session.forked` or child `session.created` event that arrives after it adds no fork record, because the tombstone
// already refuses the id. A fork record is dropped when its session is deleted, so `forks` holds the forks and child
// sessions that are not deleted yet. `deletions` holds one id for each deleted session. These two sets are the only
// state that grows with the sessions the process sees.
//
// FAILOVER. When the owner's instance is torn down, the registry waits until that owner's workers have ended and
// only then promotes the next member. A session rejoins at its next event. Registry changes run one at a time.
// A member that leaves without being the owner is a continuity break for the owner, as a lost stream is.
//
// The registry holds members and their callbacks. The config, and with it the host token, lives only in the
// closures a member was built from; no property of the registry or of a member carries it.
import { EVENT_TYPES, createManager, deletedSessionOf, notRootSessionOf, sessionOf } from "./manager.js"

const REGISTRY_KEY = Symbol.for("agent-chat.opencode.registry.v1")
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export function createRegistry() {
  const members = []
  const forks = new Set() // sessions known to be forks: every owner gets this set, so a promotion forgets none
  const deletions = new Set() // deletion tombstones: handed to every owner the same way
  let owner = null
  let turn = Promise.resolve()

  const later = work => { turn = turn.then(work).catch(() => {}); return turn }

  function promote() {
    owner = members[0] ?? null
    if (owner) owner.activate(forks, deletions)
  }

  function dispatch(event) {
    // Recorded before the owner check: a fork or deletion event between two owners is kept for the next one.
    const notRoot = notRootSessionOf(event)
    if (notRoot !== null && !deletions.has(notRoot)) forks.add(notRoot)
    const gone = deletedSessionOf(event)
    if (gone !== null) { deletions.add(gone); forks.delete(gone) }
    if (!owner || sessionOf(event) === null) return
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
