// The OpenCode constants that more than one module shares: the binding entry's key, the notice limits and the clock. The
// renderer is lib/notice.js, a byte-identical copy of integrations/shared/notice.js; it knows nothing about the prefix, the
// limit or the admission call.
//
// The notice reaches the model, when delivery is on, as one synthetic session input. It is data from the adapter, never
// a user prompt.
export const CHAT_PREFIX = "Agent Chat message(s) delivered by the native adapter.\n"
export const MAX_CONTEXT_BYTES = 8 * 1024
// The notice may use what is left of the limit: the admission counts the prefix and the notice together.
export const NOTICE_BOUND = MAX_CONTEXT_BYTES - Buffer.byteLength(CHAT_PREFIX, "utf8")
// The one keyed instruction entry that carries the binding. It is replaced on a rejoin and removed on an end.
// The key matches OpenCode's entry key pattern (lowercase letters, digits, dot, dash, underscore).
export const BINDING_KEY = "agent-chat-binding"
// Marks the synthetic input as this adapter's, so a reader of the session log can tell it from a peer or a user.
export const CHAT_SOURCE = "agent-chat"
// The one clock for rejoin arithmetic and for the delivery deadline, in milliseconds. It is monotonic, so a wall-clock
// correction can neither extend nor cut a backoff, the episode and hourly budgets, or a reservation. The lifecycle hands
// the delivery an absolute deadline on this clock, so both must use it.
export const monotonicNow = () => performance.now()
