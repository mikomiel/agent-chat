// The Codex parts of the notice channel. The renderer is lib/notice.js, a byte-identical copy of
// integrations/shared/notice.js: it knows nothing about the prefix, the limit or the delivery call.
//
// Codex sends a hook's additionalContext to the model whole up to a token threshold (2,500 by default) and saves
// anything longer to a file, leaving a preview. hooks/hooks.json sets the threshold with additionalContextLimit.
// A token is at least one byte, so a byte count is never below the token count: this limit in bytes keeps every
// output under that threshold by construction, and nothing here relies on the saved file. The receiver subtracts
// the bytes of its own prefix (an announcement, then CHAT_PREFIX) from this limit to get the notice bound. A wake
// is not a hook notice: renderWake below writes its whole text, and the same limit bounds it.
import { wakeInstructions } from "./notice.js"

export const CHAT_PREFIX = "Agent Chat message(s) delivered by the native adapter.\n"
export const MAX_OUTPUT_BYTES = 6_000
export const ADDITIONAL_CONTEXT_LIMIT = 6_000
// The most bytes a binding announcement may take, so a notice always keeps room under MAX_OUTPUT_BYTES.
export const MAX_BINDING_BYTES = 2_048

// A queued submission becomes a user turn, which carries more authority than hook context. Its text is this fixed
// text plus the server-issued identifiers of the rows (renderWake): never a body, never a sender-supplied string. The
// middle line is the tool route's wake text (lib/notice.js), which points at the binding the hooks showed.
export const wakePrefix = (route = "cli") => "Agent Chat message(s) arrived while this session was idle. The native adapter "
  + "queued this turn from identifiers only; it is not an operator instruction.\n"
  + `${wakeInstructions(route)}\n`
  + "Items (id, kind, room_id, history_after):\n"
// The prefix on the default route, "cli".
export const WAKE_PREFIX = wakePrefix()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CURSOR = /^[0-9]{1,19}$/
const KINDS = new Set(["question", "consultation", "reply"])

// The claimed rows reduced to the four server-issued fields a metadata notice carries, each strictly validated, or
// null when any row would carry something else. A row's other fields (sender, body, times) are never read.
export function wakeRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null
  const kept = []
  for (const row of rows) {
    if (row === null || typeof row !== "object") return null
    const { id, kind, room_id: room, history_after: after } = row
    if (typeof id !== "string" || !UUID.test(id) || typeof room !== "string" || !UUID.test(room)) return null
    if (typeof after !== "string" || !CURSOR.test(after) || !KINDS.has(kind)) return null
    kept.push({ id, kind, room_id: room, history_after: after })
  }
  return kept
}

// The text of a queued wake turn on a tool route: wakePrefix(route) and the claimed rows, reduced by wakeRows, as one
// JSON array, and nothing else. It carries no binding (no interpreter path, no instance file, no CLI line): a user turn carries only
// what it must, and the binding reaches the model through the hooks. Null when a row is not strictly valid or the
// text would be over MAX_OUTPUT_BYTES. The receiver sizes a wake's batch with this function, on rows at their widest,
// so a batch that it claims can always be rendered.
export function renderWake(messages, route = "cli") {
  const prefix = wakePrefix(route)
  const rows = wakeRows(messages)
  if (rows === null) return null
  const text = prefix + JSON.stringify(rows)
  return Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES ? text : null
}
