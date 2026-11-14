import { loadConfig } from "../lib/config.js"
import { createAgentChat } from "../lib/lifecycle.js"

// Pi calls the factory with its extension API only. `options` exists for the
// contract tests; a Pi process never supplies it.
export default function agentChatExtension(pi, options = {}) {
  const config = options.config ?? loadConfig(options.env ?? process.env)
  if (config === null || config === undefined) return
  createAgentChat(pi, config, options)
}
