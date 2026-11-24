// The offer and mark state of sender receipts: the one state machine every Agent Chat harness package that shows them uses.
//
// A receipt is a non-waking row the server keeps for the session that sent an addressed message. A package offers the rows
// to its model at a native boundary of a turn that is already running, then tells the server which ones it output. The
// rules are in integrations/README.md, "Sender receipts". This file holds only the decisions that do not depend on a
// harness: when a poll is due, which rows of an answer may be shown, which ids to mark, and what has been tracked.
//
// Every function is pure. A state is a plain value, a function returns the next state and never changes its argument, and
// the clock is a parameter, so a test needs no timer. Nothing here does I/O, throws on a bad answer, or reads a global.
//
// This file is dependency-free ESM and imports nothing. Packages have no install step, so each package's lib/receipts.js
// is a byte-identical copy of this file and a test in the package fails on a difference. Edit this file, then copy it over
// each lib/receipts.js. The notice text is shared/notice.js (renderReceiptNotice); package parts (the native output, the
// confirmation signal, the worker requests) stay in the package.

/** The shortest time between two polls of the receipts feed, in milliseconds. */
export const POLL_MS = 5_000
/** The most rows one offer carries: the oldest first. */
export const MAX_OFFER = 10
/** The most ids one mark carries: the worker takes 1 to 50, and refuses a longer or an empty list as fatal. */
export const MAX_MARK = 50
/** The most ids a state keeps: it forgets the oldest marked ones, and offers nothing while this many are unmarked. */
export const SEEN_LIMIT = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// An id is in flight (output, not yet confirmed), shown (confirmed, not yet marked) or marked, never back.
const RANK = { inflight: 0, shown: 1, marked: 2 }

/** The state of a session that has polled nothing and shown nothing. */
export const createReceipts = () => ({ polledAt: null, entries: [] })

/** Whether a poll is due at `now` (milliseconds on the caller's clock): never polled, POLL_MS since, or a clock that went back. */
export const due = (state, now) => state.polledAt === null || !(now >= state.polledAt) || now - state.polledAt >= POLL_MS

/** The state after a poll at `now`. A package records it before it asks, so a failed request keeps the cadence. */
export const polled = (state, now) => ({ ...state, polledAt: now })

// Keep every unmarked id, and drop the oldest marked ones above SEEN_LIMIT.
function trim(entries) {
  let extra = entries.length - SEEN_LIMIT
  if (extra <= 0) return entries
  return entries.filter(([, status]) => !(status === "marked" && extra-- > 0))
}

// Move each of `ids` up to `status`, adding an id that is not tracked yet. An id never moves down.
function advance(state, ids, status) {
  const wanted = new Set(ids)
  const entries = state.entries.map(([id, current]) => (wanted.delete(id) && RANK[current] < RANK[status] ? [id, status] : [id, current]))
  for (const id of wanted) entries.push([id, status])
  return { ...state, entries: trim(entries) }
}

/**
 * The rows of a worker `receipts` answer that may be shown now, oldest first, at most MAX_OFFER, none already tracked.
 * Nothing is offered unless the answer says `muted === false`: an absent or non-boolean flag counts as muted. Nothing is
 * offered while SEEN_LIMIT ids wait for output or a mark. A row without a lowercase UUID id is skipped; the notice
 * renderer checks every other field.
 */
export function offer(state, answer) {
  if (answer === null || typeof answer !== "object" || answer.muted !== false || !Array.isArray(answer.receipts)) return []
  if (state.entries.filter(([, status]) => status !== "marked").length >= SEEN_LIMIT) return []
  const known = new Set(state.entries.map(([id]) => id))
  const rows = []
  for (const row of answer.receipts) {
    const id = row?.id
    if (typeof id !== "string" || !UUID.test(id) || known.has(id)) continue
    known.add(id)
    rows.push(row)
    if (rows.length === MAX_OFFER) break
  }
  return rows
}

/** The state after the native output of these ids was issued but not yet confirmed: they are not offered again. */
export const issued = (state, ids) => advance(state, ids, "inflight")

/** The state after the native output of these ids was confirmed: they wait for a mark. */
export const confirmed = (state, ids) => advance(state, ids, "shown")

/** The state after output that was never confirmed: the in-flight ids may be offered again. Shown ids are not touched. */
export function released(state, ids) {
  const drop = new Set(ids)
  return { ...state, entries: state.entries.filter(([id, status]) => !(drop.has(id) && status === "inflight")) }
}

/** The ids to mark now, oldest first, 1 to MAX_MARK of them, or none: only ids whose output was confirmed. */
export const toMark = state => state.entries.filter(([, status]) => status === "shown").slice(0, MAX_MARK).map(([id]) => id)

/** The state after the server took a mark of these ids: they are kept, as marked, so a late feed does not show them twice. */
export function marked(state, ids) {
  const done = new Set(ids)
  return { ...state, entries: state.entries.map(([id, status]) => (done.has(id) && status === "shown" ? [id, "marked"] : [id, status])) }
}

/**
 * Whether a worker `receipts_delivered` answer is a success: a plain object with a `delivered` list and no refusal.
 * The ids asked for are then done, whichever of them the list names: an id the server ignores is not the session's and
 * cannot be marked by asking again. Anything else, a refusal included, keeps the ids for the next poll.
 */
export const accepted = answer =>
  answer !== null && typeof answer === "object" && Array.isArray(answer.delivered) && answer.refused === undefined
