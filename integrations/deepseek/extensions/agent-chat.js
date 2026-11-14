/**
 * agent-chat — opt-in Agent Chat delivery to idle root agents of the DeepSeek
 * Harness (DSH) Web process. Default off.
 *
 * A SEPARATE PLUGIN FROM ANY CI GATE. A fault here must never stop CI, so this
 * file shares no state with another extension and registers nothing unless one
 * private config file opts the process in (AGENT_CHAT_DEEPSEEK_CONFIG). Off, it
 * adds no listener, no timer and no process.
 *
 * WEB PROFILE ONLY. Composition alone does not limit the profile: the Home
 * patch also reaches `dsh --profile headless`. The plugin waits for the
 * `webServer` service with ctx.inject, so where no Web server exists the
 * callback never runs.
 *
 * ONE DELIVERY OBJECT PER ROOT AGENT. `agent/created` creates it,
 * `agent/disposed` disposes it. Every handler is wrapped: `agent/created` is a
 * serial event whose listener throw or rejection FAILS AGENT CREATION, and
 * emit is stop-on-throw. A fault disables chat for that one agent only.
 *
 * Event vocabulary, read from @deepseek-ai 0.2.2-rc.1: agent/created,
 * agent/disposed, agent/status, agent/inbox/inserted, agent/inbox/claimed,
 * agent/inbox/discarded, agent/pre-step (waterfall), session/event `turn/end`
 * with `data.reason = { kind: 'aborted', reason: { kind: 'user' } }`, Plan Mode
 * through the `plan` unit of ctx.sessionProjections, the optional
 * ctx.sessionTitle service and agent.steer / agent.inbox.remove.
 */
import { randomUUID } from "node:crypto"
import { loadConfig } from "../lib/config.js"

const HARNESS = "deepseek"

// Mirror of the host's own ownership rule: `origin === 'subagent'`, or a
// `parentSession` the agent is actually owned by. `parentSession` alone is NOT a
// child test: a fork root carries one. A root listener sees child events.
export function isSubagentChild(ctx, agent) {
  const header = agent.session.header
  if (header?.origin === "subagent") return true
  const parentId = header?.parentSession
  if (parentId === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

// Top-level agent that is not a subagent child. A throw means "not eligible".
export function isChatEligibleAgent(ctx, agent) {
  return ctx.agents.roots().includes(agent) && !isSubagentChild(ctx, agent)
}

// The lifecycle and the native half are loaded lazily: when chat is off, or a
// library file is broken, nothing here may keep the Web process from booting.
async function defaultLoadParts() {
  const [{ createLifecycle }, { createDelivery }, { startWorker }] = await Promise.all([
    import("../lib/lifecycle.js"),
    import("../lib/delivery.js"),
    import("../lib/worker.js"),
  ])
  return {
    createLifecycle,
    createDelivery,
    startProcess: (config, identity) => startWorker(config, { ...identity, harness: HARNESS }),
  }
}

// Agent Chat messages are coordination data, never authorization.
const CONTEXT_SOURCE_KIND = "plugin:agent-chat-context"

/**
 * The plugin, as a factory so node:test can inject the environment and the
 * lifecycle parts. Cordis calls the default export with (ctx).
 */
export function createAgentChat({ env = process.env, loadParts = defaultLoadParts } = {}) {
  function agentChat(ctx) {
    const log = (level, message) => {
      try { ctx.logger?.[level]?.(`agent-chat: ${message}`) } catch { /* a logger that throws must not take the session with it */ }
    }
    // Off by default, and off for a delegated child. Nothing is registered.
    const config = loadConfig(env)
    if (config === null) return

    function register(webCtx) {
      const states = new Map() // agent -> { delivery, lifecycle, bootstrap, closing, fire }
      const retiring = new Map() // native session id -> proof of its previous end
      const disposed = new WeakSet()
      let active = true
      let parts = null
      try { parts = Promise.resolve(loadParts()).catch(() => null) } catch { parts = Promise.resolve(null) }

      function eligible(agent) {
        try { return isChatEligibleAgent(webCtx, agent) } catch { return false }
      }

      // One agent's fault ends that agent's chat, nothing else.
      function isolate(agent, error) {
        log("warn", `chat disabled for one agent (${error?.code ?? error?.name ?? "fault"}); CI is unchanged`)
        const state = states.get(agent)
        states.delete(agent)
        disposed.add(agent)
        if (state) void dispose(agent, state)
      }

      function route(agent, fn) {
        const state = states.get(agent)
        if (!state || !state.delivery) return
        try { fn(state) } catch (error) { isolate(agent, error) }
      }

      function dispose(agent, state) {
        if (state.closing) return state.closing
        try { state.delivery?.dispose?.() } catch { /* the fence is already closed */ }
        let ended
        try { ended = state.lifecycle?.stop ? state.lifecycle.stop() : Promise.resolve({ code: 0 }) } catch { ended = Promise.resolve(null) }
        const closing = Promise.all([retiring.get(agent.id) ?? true, ended])
          .then(([before, result]) => before === true && result?.code === 0)
          .catch(() => false)
        state.closing = closing
        retiring.set(agent.id, closing)
        void closing.then(proof => {
          // Failed or unknown ends stay latched for this native session. A new
          // object or a repeated created event must not turn them into a join.
          if (proof && retiring.get(agent.id) === closing) retiring.delete(agent.id)
        })
        return closing
      }

      async function adopt(agent) {
        if (!active || disposed.has(agent) || states.has(agent) || !eligible(agent)) return
        // A user prompt can arrive before the libraries load or the previous
        // worker ends. Create the latch state first and record that prompt, or
        // the new lifecycle would start stopped and stay stopped.
        for (const [other, previous] of states) {
          if (other.id === agent.id) { states.delete(other); disposed.add(other); dispose(other, previous) }
        }
        const handlers = new Map()
        const bus = { on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) } }
        const state = {
          delivery: null,
          lifecycle: null,
          bootstrap: null,
          closing: null,
          latchEvents: [],
          fire(name, payload) {
            if (!state.lifecycle) return
            for (const fn of handlers.get(name) ?? []) fn(payload)
          },
        }
        states.set(agent, state)
        try {
          const loaded = await parts
          if (!loaded || !active || disposed.has(agent) || states.get(agent) !== state ||
              webCtx.agents.get(agent.id) !== agent || !eligible(agent)) {
            states.delete(agent)
            return
          }
          const ended = await (retiring.get(agent.id) ?? true)
          if (!active || disposed.has(agent) || states.get(agent) !== state ||
              webCtx.agents.get(agent.id) !== agent || !eligible(agent)) {
            states.delete(agent)
            return
          }
          if (!ended) {
            states.delete(agent)
            log("warn", "chat replacement refused after an unproved instance end; CI is unchanged")
            return
          }
          const delivery = loaded.createDelivery(webCtx, agent)
          state.delivery = delivery
          // Each join mints a fresh random boot id inside the lifecycle.
          state.lifecycle = loaded.createLifecycle(bus, delivery, config, {
            startProcess: loaded.startProcess,
            notice: text => log("info", String(text)),
          })
          state.fire("session_start", { nativeSessionId: agent.id })
          for (const event of state.latchEvents) {
            if (event.kind === "input") {
              // The native delivery has its own stop latch; replaying only the
              // lifecycle event would leave heartbeats and delivery stopped.
              if (delivery.onInserted(event.message)) state.fire("input", { source: "local" })
            } else {
              delivery.onTurnEnd({ kind: "aborted", reason: { kind: "user" } })
              state.fire("agent_settled", { aborted: true })
            }
          }
          state.latchEvents = []
        } catch (error) {
          states.delete(agent)
          isolate(agent, error)
        }
      }

      const disposers = [
        webCtx.on("agent/created", ({ agent }) => {
          // Old-worker I/O must neither fail nor delay native agent creation.
          void adopt(agent).catch(error => isolate(agent, error))
        }),
        webCtx.on("agent/disposed", ({ agent }) => {
          try {
            const state = states.get(agent)
            states.delete(agent)
            disposed.add(agent)
            if (state) void dispose(agent, state)
          } catch { /* nothing to recover */ }
        }),
        webCtx.on("agent/pre-step", async ({ agent }, next) => {
          const decision = await next()
          try {
            const state = states.get(agent)
            if (!state || decision?.kind !== "enter" || webCtx.agents.get(agent.id) !== agent) return decision
            const content = state.lifecycle?.context?.()
            const added = []
            if (content && state.bootstrap !== content) {
              added.push({
                id: randomUUID(),
                role: "user",
                source: { kind: CONTEXT_SOURCE_KIND },
                content: [{ type: "text", text: content }],
              })
              state.bootstrap = content
            }
            return added.length ? { ...decision, messages: [...decision.messages, ...added] } : decision
          } catch (error) { isolate(agent, error); return decision }
        }),
        webCtx.on("agent/inbox/inserted", ({ agent, message }) => {
          const state = states.get(agent)
          if (!state) return
          if (!state.delivery) {
            const source = message?.source
            if (source?.kind === "user" && typeof source.rpcId === "string" && source.rpcId) {
              state.latchEvents.push({ kind: "input", message })
            }
            return
          }
          route(agent, state => { if (state.delivery.onInserted(message)) state.fire("input", { source: "local" }) })
        }),
        webCtx.on("agent/inbox/claimed", ({ agent, message }) => {
          route(agent, state => state.delivery.onClaimed(message))
        }),
        webCtx.on("agent/inbox/discarded", ({ agent, message }) => {
          route(agent, state => state.delivery.onDiscarded(message))
        }),
        webCtx.on("agent/status", ({ agent, status }) => {
          route(agent, state => state.fire(status === "running" ? "agent_start" : "agent_settled", {}))
        }),
        webCtx.on("session/event", (session, event) => {
          try {
            const agent = webCtx.agents.get(session?.id)
            if (!agent || agent.session !== session) return
            const state = states.get(agent)
            if (state && !state.delivery) {
              const reason = event?.data?.reason
              if (event?.type === "turn/end" && reason?.kind === "aborted" && reason.reason?.kind === "user") {
                state.latchEvents.push({ kind: "abort" })
              }
              return
            }
            if (event?.type === "session/title") {
              route(agent, state => state.fire("session_info_changed", {}))
              return
            }
            if (event?.type !== "turn/end") return
            const reason = event.data?.reason
            route(agent, state => {
              state.delivery.onTurnEnd(reason)
              state.fire("agent_settled", { aborted: reason?.kind === "aborted" && reason.reason?.kind === "user" })
            })
          } catch { /* a listener must not throw into cordis */ }
        }),
      ]
      log("info", "registered (Web profile, opt-in)")
      return () => {
        active = false
        for (const off of disposers) { try { off?.() } catch { /* already gone */ } }
        for (const [agent, state] of [...states]) void dispose(agent, state)
        states.clear()
      }
    }

    try {
      ctx.inject(["agents", "webServer"], webCtx => {
        try { return register(webCtx) } catch (error) {
          log("warn", `could not register (${error?.code ?? error?.name ?? "fault"}); CI is unchanged`)
        }
      })
    } catch (error) {
      log("warn", `could not register (${error?.code ?? error?.name ?? "fault"}); CI is unchanged`)
    }
  }
  return agentChat
}

export default createAgentChat()
