// The Claude Code parts of the notice channel. The renderer is lib/notice.js, a byte-identical copy of
// integrations/shared/notice.js: it knows nothing about the prefix, the limit or the delivery call.
//
// Claude Code caps each hook context string at 10,000 characters and replaces a longer one with a file path and a
// short preview. A UTF-8 byte count is never smaller than the character count, so a byte bound keeps every output
// under that cap by construction; nothing here relies on the overflow file. The receiver subtracts the bytes of its
// own prefix (an announcement, then CHAT_PREFIX) from this limit to get the notice bound.
export const CHAT_PREFIX = "Agent Chat message(s) delivered by the native adapter.\n"
export const MAX_OUTPUT_BYTES = 10_000
