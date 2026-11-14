import test from "node:test"
import assert from "node:assert/strict"
import { CHAT_PREFIX, MAX_CONTEXT_BYTES, renderNotice } from "../lib/notice.js"

const joined = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "deepseek",
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

test("a maximum batch falls back to metadata inside the same whole-notice budget", () => {
  // Long cursors make the metadata alone eat the budget, so the bodies cannot
  // share it. The fallback must still hand the batch over once.
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ...row(index),
    history_after: `cursor-${String(index).padStart(2, "0")}-${"c".repeat(220)}`,
    body: "b".repeat(1200),
  }))
  const notice = renderNotice(joined, "/usr/bin/python3", rows, { bodies: true })
  assert.ok(notice)
  assert.ok(Buffer.byteLength(CHAT_PREFIX + notice, "utf8") <= MAX_CONTEXT_BYTES)
  assert.match(notice, /"history_after":"cursor-15-/)
  assert.doesNotMatch(notice, /bbbb/)
})

test("a batch whose metadata alone does not fit renders nothing", () => {
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ...row(index),
    history_after: `${index}-${"c".repeat(600)}`,
  }))
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows), null)
})
