// The process-wide owner. OpenCode loads a plugin once per location, so one server process can run several plugin
// instances. Each instance is a member of one registry. Exactly one member, the owner, runs a manager: joins,
// heartbeats and deliveries come from one place, never twice for a session.
//
// EVENTS. Every member reads its own event stream and forwards each event to the registry. The registry drops an
// event id it has already seen and hands the rest to the owner. Nothing here assumes that one stream covers every
// location, or that each stream is a separate one.
//
// FAILOVER. When the owner's instance is torn down, the registry waits until that owner's workers have ended and
// only then promotes the next member. A session rejoins at its next event. Registry changes run one at a time.
//
// The registry holds members and their callbacks. The config, and with it the host token, lives only in the
// closures a member was built from; no property of the registry or of a member carries it.
import { EVENT_TYPES, createManager } from "./manager.js"

const REGISTRY_KEY = Symbol.for("agent-chat.opencode.registry.v1")
const MAX_SEEN_EVENTS = 1024
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export function createRegistry() {
  const members = []
  const seen = new Set() // event ids, newest last, bounded
  let owner = null
  let turn = Promise.resolve()

  const later = work => { turn = turn.then(work).catch(() => {}); return turn }

  function promote() {
    owner = members[0] ?? null
    if (owner) owner.activate()
  }

  function dispatch(event) {
    if (!owner) return
    const id = event?.id
    if (typeof id === "string" && id) {
      if (seen.has(id)) return
      seen.add(id)
      while (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.values().next().value)
    }
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
        if (owner !== member) return
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
    activate() { manager = createManager(ctx, config, parts, managerOptions) },
    async deactivate() {
      const ending = manager
      manager = null
      return ending ? ending.stop() : true
    },
    feed(event) { manager?.feed(event) },
    reset() { manager?.reset() },
  }
}
