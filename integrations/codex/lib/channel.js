// The Codex parts of the notice channel. The renderer is lib/notice.js, a byte-identical copy of
// integrations/shared/notice.js: it knows nothing about the prefix, the limit or the delivery call.
//
// Codex sends a hook's additionalContext to the model whole up to a token threshold (2,500 by default) and saves
// anything longer to a file, leaving a preview. hooks/hooks.json sets the threshold with additionalContextLimit.
// A token is at least one byte, so a byte count is never below the token count: this limit in bytes keeps every
// output under that threshold by construction, and nothing here relies on the saved file. The receiver subtracts
// the bytes of its own prefix (an announcement, then CHAT_PREFIX) from this limit to get the notice bound.
export const CHAT_PREFIX = "Agent Chat message(s) delivered by the native adapter.\n"
export const MAX_OUTPUT_BYTES = 6_000
export const ADDITIONAL_CONTEXT_LIMIT = 6_000
// The most bytes a binding announcement may take, so a notice always keeps room under MAX_OUTPUT_BYTES.
export const MAX_BINDING_BYTES = 2_048
