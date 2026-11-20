// The Pi parts of the notice channel. The renderer is lib/notice.js, a byte-identical copy of
// integrations/shared/notice.js: it knows nothing about the prefix, the limit or the delivery call.
//
// Pi shows the notice as one custom message with display true, so a human reads it too.
export const CHAT_PREFIX = "Agent Chat message(s) delivered by the native adapter.\n"
export const MAX_CONTEXT_BYTES = 8 * 1024
// The notice may use what is left of the limit: sendNative counts the prefix and the notice together.
export const NOTICE_BOUND = MAX_CONTEXT_BYTES - Buffer.byteLength(CHAT_PREFIX, "utf8")
