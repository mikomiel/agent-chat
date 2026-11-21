// The OpenCode constants that more than one module shares. The plugin delivers nothing to a session, so this file holds
// the binding entry's key and the clock, and no notice or delivery limit.
//
// The one keyed instruction entry that carries the binding. It is replaced on a rejoin and removed on an end.
// The key matches OpenCode's entry key pattern (lowercase letters, digits, dot, dash, underscore).
export const BINDING_KEY = "agent-chat-binding"
// The one clock for rejoin arithmetic, in milliseconds. It is monotonic, so a wall-clock correction can neither extend
// nor cut a backoff or the episode and hourly budgets.
export const monotonicNow = () => performance.now()
