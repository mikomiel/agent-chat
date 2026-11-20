import test from "node:test"
import assert from "node:assert/strict"
import { CHAT_PREFIX, MAX_OUTPUT_BYTES, renderNotice } from "../lib/notice.js"

const joined = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "claude",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const row = index => ({
  id: `message-${index}`,
  kind: "question",
  room_id: joined.room_id,
  history_after: `history-cursor-${index}`,
  body: "synthetic body",
  sender_session_id: "peer-1",
  created_at: "2026-01-01T00:00:00Z",
})
const size = notice => Buffer.byteLength(CHAT_PREFIX + notice, "utf8")

test("the cap is the documented 10,000 characters", () => {
  assert.equal(MAX_OUTPUT_BYTES, 10_000)
})

test("metadata mode carries ids and cursors, never bodies or senders", () => {
  const notice = renderNotice(joined, "/usr/bin/python3", [row(0)])
  assert.ok(notice)
  assert.match(notice, /Process every item/)
  assert.match(notice, /"history_after":"history-cursor-0"/)
  assert.match(notice, /"room_id":"33333333-3333-4333-8333-333333333333"/)
  assert.doesNotMatch(notice, /synthetic body/)
  assert.doesNotMatch(notice, /sender_session_id/)
})

test("bodies mode carries the body and the sender field", () => {
  const notice = renderNotice(joined, "/usr/bin/python3", [row(0)], { bodies: true })
  assert.match(notice, /synthetic body/)
  assert.match(notice, /"sender_session_id":"peer-1"/)
})

test("an empty batch renders nothing", () => {
  assert.equal(renderNotice(joined, "/usr/bin/python3", []), null)
})

const wide = (index, cursor) => ({
  ...row(index),
  history_after: `cursor-${String(index).padStart(2, "0")}-${"c".repeat(cursor)}`,
  body: "b".repeat(1200),
})

test("a maximum batch falls back to metadata inside the same whole-notice budget", () => {
  // Cursors this long leave the bodies no room to share the 10,000-byte budget,
  // so the notice must fall back to metadata instead of deferring the batch.
  const rows = Array.from({ length: 16 }, (_, index) => wide(index, 300))
  const notice = renderNotice(joined, "/usr/bin/python3", rows, { bodies: true })
  assert.ok(notice)
  assert.ok(size(notice) <= MAX_OUTPUT_BYTES)
  assert.match(notice, /"history_after":"cursor-15-/)
  assert.doesNotMatch(notice, /bbbb/)
})

test("bodies share what is left of the budget before the metadata fallback", () => {
  const rows = Array.from({ length: 16 }, (_, index) => wide(index, 220))
  const notice = renderNotice(joined, "/usr/bin/python3", rows, { bodies: true })
  assert.ok(size(notice) <= MAX_OUTPUT_BYTES)
  assert.match(notice, /--- message-15 from peer-1 ---\nb+…/)
  assert.doesNotMatch(notice, /b{200}/)
})

test("a batch whose metadata alone does not fit renders nothing", () => {
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ...row(index),
    history_after: `${index}-${"c".repeat(600)}`,
  }))
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows), null)
})

test("the budget is bytes, so multi-byte bodies never push the notice over the cap", () => {
  // Each body is 1200 characters but 3600 bytes; a character count would let 16 of them through.
  const rows = Array.from({ length: 16 }, (_, index) => ({ ...row(index), body: "€".repeat(1200) }))
  const notice = renderNotice(joined, "/usr/bin/python3", rows, { bodies: true })
  assert.ok(notice)
  assert.ok(size(notice) <= MAX_OUTPUT_BYTES)
})

test("a smaller budget is honoured, and a budget the metadata cannot meet renders nothing", () => {
  const rows = [row(0), row(1)]
  for (const budget of [700, 1200, 2500, 5000, 9000]) {
    const notice = renderNotice(joined, "/usr/bin/python3", rows, { bodies: true, budget })
    if (notice !== null) assert.ok(size(notice) <= budget, `budget ${budget}`)
  }
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows, { budget: 100 }), null)
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows, { budget: Number.NaN }), null)
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows, { budget: 10 ** 9 }) === null, false)
  const huge = renderNotice(joined, "/usr/bin/python3", rows, { bodies: true, budget: 10 ** 9 })
  assert.ok(size(huge) <= MAX_OUTPUT_BYTES, "a caller cannot raise the cap")
})

test("a body is clipped, not truncated into a false full copy", () => {
  const notice = renderNotice(joined, "/usr/bin/python3", [{ ...row(0), body: "x".repeat(5000) }], { bodies: true })
  assert.match(notice, /x…/)
  assert.doesNotMatch(notice, /x{1300}/)
})
