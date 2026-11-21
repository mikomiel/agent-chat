// The DSH native half of one Agent Chat lifecycle: eligibility, the stop latch,
// Plan Mode, the optional native title and the delivery fence.
//
// THE FENCE. JavaScript is single-threaded and `steer` flips the agent to
// `running` and claims the inbox before it returns, so one synchronous block
// can check, steer and re-check:
//   1. refused states clear, status idle, nextStep and nextTurn both empty;
//   2. agent.steer with source `plugin:agent-chat` and a metadata-only payload;
//   3. post-check: status running, or the claim event for that id has fired;
//   4. otherwise agent.inbox.remove(id) and report deferred.
// `handed` comes only from the `agent/inbox/claimed` event for that message id.
// Idle status alone is not enough: `runMaintenance` reads `idle`, so a steer
// then parks and starts a surprise run after maintenance.
//
// Plan Mode is read from the client-visible `plan` projection, never from the
// `planMode` service: the Standard preset mounts that service in an isolated
// realm, so a plugin at the root scope sees `undefined` and would classify
// every agent as unclassifiable.
import { randomUUID } from "node:crypto"
import { CHAT_PREFIX, MAX_CONTEXT_BYTES } from "./channel.js"

export const CHAT_SOURCE_KIND = "plugin:agent-chat"
const HANDOFF_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 128
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const BIDI = /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

// agent_chat.models.Heartbeat: <=128 characters, <=512 UTF-8 bytes, no control
// or bidirectional characters, trimmed. An unusable advisory title is omitted.
export function normalizeTitle(value) {
  if (typeof value !== "string") return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(BIDI, "").replace(/\s+/g, " ").trim()
  if (!cleaned) return undefined
  let out = ""
  let characters = 0
  for (const character of cleaned) {
    if (characters >= 128 || Buffer.byteLength(out + character, "utf8") > 512) break
    out += character
    characters += 1
  }
  return out.trim() || undefined
}

export function createDelivery(ctx, agent, {
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const binding = Object.freeze({ nativeSessionId: agent.id })
  let closed = false
  let disabled = false
  let stopped = true // every agent starts chat-stopped
  let generation = 0
  let pending = null // at most one in-flight steered message
  const attempts = new Map()

  function finish(outcome, reason = null) {
    const record = pending
    if (!record) return
    pending = null
    clearTimeoutImpl(record.timer)
    record.resolve({ outcome, reason })
  }

  // Take back an unclaimed steered message. Removable: it never runs, so the
  // refusal is definite (`deferred`). Not removable (claimed, gone, or the call
  // threw): the handover may have happened, so `uncertain`, never retried.
  // `pending` is cleared first so the discard event of our own removal is inert.
  function retract(reason) {
    const record = pending
    if (!record) return
    pending = null
    clearTimeoutImpl(record.timer)
    let removed = false
    try { removed = agent.inbox.remove(record.id) === true } catch { removed = false }
    record.resolve(removed
      ? { outcome: "deferred", reason }
      : { outcome: "uncertain", reason: "transport_ambiguous" })
  }

  // Invalidate every token captured so far.
  function fence() {
    generation += 1
    retract("stale_binding")
  }

  function latch() {
    stopped = true
    fence()
  }

  function live() {
    try { return ctx.agents.get(agent.id) === agent } catch { return false }
  }

  function current(token) {
    return !closed && token?.binding === binding && live()
  }

  function unchanged(token) {
    return current(token) && token.generation === generation
  }

  const capture = () => Object.freeze({ binding, generation })

  // Plan Mode is the client-visible `plan` projection: { active, pending }.
  // An absent registry, an unregistered unit, a read that throws and a
  // malformed value are unclassifiable, not "off".
  function inPlanMode() {
    const projections = ctx.get("sessionProjections")
    if (!projections || typeof projections.snapshot !== "function") throw new Error("session projections unavailable")
    const plan = projections.snapshot(agent.session, ["plan"]).values?.plan
    if (!plan) throw new Error("plan projection unavailable")
    if (typeof plan.active !== "boolean" || typeof plan.pending !== "boolean") throw new Error("plan projection unreadable")
    return plan.active || plan.pending
  }

  // The roster cannot tell an unclassifiable agent from a stopped one: both
  // report `stopped: true`, `native_state: "unknown"`. Name the cause. It cannot
  // repeat on its own: the `stopped` check returns before the classifier until
  // a Web prompt clears the latch.
  function warnUnclassifiable(error) {
    const cause = String(error?.message ?? error).slice(0, 120)
    try { ctx.logger?.warn?.(`agent-chat: chat stopped for one agent, state unclassifiable (${cause})`) } catch { /* advisory */ }
  }

  // null means "eligible right now". Any state this cannot classify sets the
  // stop latch, so only a later Web prompt can restore delivery.
  function state(token = capture()) {
    if (!unchanged(token)) return "stale_binding"
    if (disabled) return "offline"
    if (stopped) return "stopped"
    try {
      if (inPlanMode()) return "plan"
      const status = agent.status
      const { nextStep, nextTurn } = agent.inbox
      if (!["idle", "running"].includes(status) || !Array.isArray(nextStep) || !Array.isArray(nextTurn)) {
        throw new Error("agent state unclassifiable")
      }
      if (status === "running" || pending || nextStep.length > 0 || nextTurn.length > 0) return "busy"
      return null
    } catch (error) {
      latch()
      warnUnclassifiable(error)
      return "unknown"
    }
  }

  function heartbeatState() {
    // A blocked or unknown observation is conservative, never permission to
    // clear stop or Plan Mode remotely.
    const reason = state()
    let title
    try {
      const owner = ctx.get("sessionTitle")
      if (owner && typeof owner.get === "function") title = normalizeTitle(owner.get(agent.session)?.title)
    } catch { /* optional native metadata must not disable chat */ }
    return {
      ...(title === undefined ? {} : { title }),
      native_state: reason === null ? "idle" : reason === "busy" ? "busy" : "unknown",
      stopped: ![null, "busy", "plan"].includes(reason),
      plan_mode: reason === "plan",
    }
  }

  function disableChat() {
    // Chat-only and per agent: CI and the other agents are untouched.
    disabled = true
    retract("offline")
    attempts.clear()
  }

  // `agent/inbox/inserted`. A Web prompt (`source.kind === 'user'` with an
  // rpcId, the shape the Web controller stamps) is the only thing that clears
  // the stop latch. Returns whether it cleared.
  function onInserted(message) {
    const source = message?.source
    if (closed || source?.kind !== "user" || typeof source.rpcId !== "string" || !source.rpcId) return false
    stopped = false
    fence()
    return true
  }

  // `turn/end`: an operator Stop (`cancel({kind:'user'})`) latches.
  function onTurnEnd(reason) {
    if (closed) return
    if (reason?.kind === "aborted" && reason.reason?.kind === "user") latch()
  }

  // `agent/inbox/claimed`: the only source of `handed`.
  function onClaimed(message) {
    if (pending && message?.id === pending.id) finish("handed")
  }

  // `agent/inbox/discarded` for our id that we did not cause: a plain cancel
  // removed it before any claim, so nothing ran.
  function onDiscarded(message) {
    if (pending && message?.id === pending.id) finish("deferred", "stopped")
  }

  function sendChat(token, { content, attemptId, deadline, muted } = {}) {
    const settled = (outcome, reason) => Promise.resolve({ outcome, reason })
    if (disabled || closed) return settled("failed", "native_unavailable")
    const blocked = state(token)
    if (blocked) return settled("deferred", blocked)
    if (muted !== false) return settled("deferred", muted === true ? "muted" : "unknown")
    if (typeof content !== "string" || !content || Buffer.byteLength(CHAT_PREFIX + content, "utf8") > MAX_CONTEXT_BYTES ||
        typeof attemptId !== "string" || !UUID.test(attemptId) || !Number.isFinite(deadline)) {
      return settled("failed", "native_unavailable")
    }
    // A reservation that is already over proves nothing about a hand-over that
    // never ran; neither does a repeated attempt id.
    if (deadline <= now()) return settled("uncertain", "transport_ambiguous")
    for (const [id, expires] of attempts) if (expires <= now()) attempts.delete(id)
    if (attempts.has(attemptId)) return settled("uncertain", "transport_ambiguous")
    if (attempts.size >= MAX_ATTEMPTS) return settled("failed", "native_unavailable")
    attempts.set(attemptId, deadline)

    // From here to the end of the executor nothing awaits. `state` above is the
    // pre-check; the post-check below shares this synchronous block.
    return new Promise(resolve => {
      const record = { id: randomUUID(), resolve, timer: null }
      // Armed BEFORE steer: the claim event fires inside the call.
      pending = record
      let threw = false
      try {
        agent.steer({
          id: record.id,
          role: "user",
          source: { kind: CHAT_SOURCE_KIND },
          content: [{ type: "text", text: CHAT_PREFIX + content }],
        })
      } catch { threw = true }
      if (pending !== record) return // claimed (handed) or discarded inside the call
      if (threw) { retract("busy"); return }
      let running = false
      try { running = agent.status === "running" } catch { running = false }
      if (!running) { retract("busy"); return } // maintenance or any other non-start
      // Running but not yet claimed: wait for the claim event, bounded.
      record.timer = setTimeoutImpl(() => { if (pending === record) retract("busy") },
        Math.max(0, Math.min(HANDOFF_TIMEOUT_MS, deadline - now())))
    })
  }

  // The lifecycle calls this shape: one rendered notice and its attempt id.
  function deliver(batch, deadline) {
    const { content, attemptId } = batch ?? {}
    return sendChat(capture(), { content, attemptId, deadline, muted: false })
  }

  // Reload or disposal: the stale object can never deliver again.
  function dispose() {
    closed = true
    retract("stale_binding")
    attempts.clear()
  }

  return {
    capture,
    chatState: () => state(),
    state,
    heartbeatState,
    deliver,
    sendChat,
    onInserted,
    onTurnEnd,
    onClaimed,
    onDiscarded,
    disable: disableChat,
    dispose,
  }
}
