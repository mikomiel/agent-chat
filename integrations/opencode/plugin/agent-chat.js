/**
 * agent-chat: opt-in Agent Chat for the root sessions of an OpenCode server. Default off.
 *
 * Off, it registers nothing: no event subscription, no timer, no process. One private config file named by
 * AGENT_CHAT_OPENCODE_CONFIG opts the server in, and a delegated child never joins even when it inherits the
 * variable. Every failure on the way turns chat off and leaves OpenCode untouched.
 *
 * The plugin is plain JavaScript and imports no OpenCode package. OpenCode's loader checks the shape of the default
 * export, `{ id, setup }`, which is what `Plugin.define` returns; the shape was read from the published 2.3.2
 * packages and has never been loaded by a live server (see the README, "Known limits").
 *
 * ONE OWNER PER SERVER. Every loaded instance joins one process-wide registry; one instance owns the joins. See
 * lib/owner.js. ONE FAULT BOUNDARY PER SESSION. See lib/manager.js.
 *
 * The libraries load lazily: when chat is off, or a library file is broken, nothing here may keep OpenCode from
 * starting.
 */
import { loadConfig } from "../lib/config.js"

async function defaultLoadParts() {
  const [{ createLifecycle }, { createDelivery }, { startWorker }, owner] = await Promise.all([
    import("../lib/lifecycle.js"),
    import("../lib/delivery.js"),
    import("../lib/worker.js"),
    import("../lib/owner.js"),
  ])
  return {
    createLifecycle,
    createDelivery,
    startProcess: startWorker, // the worker's default harness is "opencode"
    createMember: owner.createMember,
    registry: owner.globalRegistry,
  }
}

/**
 * The plugin, as a factory so node:test can inject the environment and the parts. OpenCode reads the default export.
 */
export function createPlugin({ env = process.env, loadParts = defaultLoadParts, registry } = {}) {
  return {
    id: "agent-chat",
    async setup(ctx) {
      try {
        // Off by default, and off for a delegated child. Nothing is registered.
        const config = loadConfig(env)
        if (config === null) return undefined
        const parts = await loadParts()
        if (!parts) return undefined
        const member = parts.createMember(ctx, config, parts)
        return (registry ?? parts.registry()).attach(member)
      } catch {
        // A fault here must not stop OpenCode or leak the config: chat is simply off.
        return undefined
      }
    },
  }
}

export default createPlugin()
