import test from "node:test"
import assert from "node:assert/strict"
import * as notice from "../lib/notice.js"
import { CHAT_PREFIX, MAX_CONTEXT_BYTES, NOTICE_BOUND } from "../lib/channel.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

const { renderNotice } = notice

// The vectors, the property, budget and pack tests, and the copy check are shared by every package.
runNoticeSuite("deepseek", notice, new URL("../lib/notice.js", import.meta.url))

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
// A message as `claim` returns it in bodies mode: the core's field set, a canonical id and a numeric cursor.
const bodyRow = (index, body = "synthetic body") => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
  kind: "question",
  room_id: joined.room_id,
  history_after: String(100 + index),
  body,
  body_truncated: false,
  sender_session_id: "66666666-6666-4666-8666-666666666666",
  sender_principal_id: "77777777-7777-4777-8777-777777777777",
  created_at: "2026-01-01T00:00:00+00:00",
  thread_id: "88888888-8888-4888-8888-888888888888",
})
const ADMITTED = "2026-01-01T00:00:42+00:00"
const bodies = (rows, options = {}) =>
  renderNotice(joined, "/usr/bin/python3", rows, { bodies: true, bound: NOTICE_BOUND, admittedAt: ADMITTED, ...options })

test("the notice bound is what the 8 KiB limit leaves after the delivery line", () => {
  assert.equal(MAX_CONTEXT_BYTES, 8 * 1024)
  assert.equal(NOTICE_BOUND, MAX_CONTEXT_BYTES - Buffer.byteLength(CHAT_PREFIX, "utf8"))
})

test("metadata mode carries ids and cursors, never bodies or senders", () => {
  const text = renderNotice(joined, "/usr/bin/python3", [row(0)], { bound: NOTICE_BOUND })
  assert.ok(text)
  assert.match(text, /Process every item/)
  assert.match(text, /"history_after":"history-cursor-0"/)
  assert.match(text, /"room_id":"33333333-3333-4333-8333-333333333333"/)
  assert.doesNotMatch(text, /synthetic body/)
  assert.doesNotMatch(text, /sender_session_id/)
})

test("bodies mode frames the body and names the sender in the message header", () => {
  const text = bodies([bodyRow(1)], { nonce: "0123456789abcdef" })
  assert.match(text, /^message aaaaaaaa-aaaa-4aaa-8aaa-000000000001 kind question from session 66666666-6666-4666-8666-666666666666 /m)
  assert.match(text, /^<<<AGENT-CHAT-BODY 0123456789abcdef\n> synthetic body\nAGENT-CHAT-BODY 0123456789abcdef>>>$/m)
  assert.doesNotMatch(text, /sender_session_id/)
})

test("an empty batch renders nothing", () => {
  assert.equal(renderNotice(joined, "/usr/bin/python3", [], { bound: NOTICE_BOUND }), null)
})

test("a maximum batch has no metadata fallback: every message keeps its frame inside the same whole-notice limit", () => {
  const rows = Array.from({ length: 16 }, (_, index) => bodyRow(index, "b".repeat(1200)))
  const text = bodies(rows)
  assert.ok(text)
  assert.ok(Buffer.byteLength(CHAT_PREFIX + text, "utf8") <= MAX_CONTEXT_BYTES)
  for (const item of rows) assert.ok(text.includes(`message ${item.id} kind question`))
  assert.doesNotMatch(text, /"history_after"/)
  assert.match(text, /^Body cut\. Read all of it with: history --room /m)
})

test("a batch whose metadata alone does not fit renders nothing", () => {
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ...row(index),
    history_after: `${index}-${"c".repeat(600)}`,
  }))
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows, { bound: NOTICE_BOUND }), null)
})
