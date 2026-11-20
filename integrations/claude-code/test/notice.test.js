import test from "node:test"
import assert from "node:assert/strict"
import * as notice from "../lib/notice.js"
import { CHAT_PREFIX, MAX_OUTPUT_BYTES } from "../lib/channel.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

const { renderNotice } = notice

// The vectors, the property, budget and pack tests, and the copy check are shared by every package.
runNoticeSuite("claude-code", notice, new URL("../lib/notice.js", import.meta.url))

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
const bytes = text => Buffer.byteLength(text, "utf8")
const size = text => bytes(CHAT_PREFIX + text)
// What the receiver passes with no announcement in front: the cap minus the delivery line.
const BOUND = MAX_OUTPUT_BYTES - bytes(CHAT_PREFIX)
const bodies = (rows, options = {}) =>
  renderNotice(joined, "/usr/bin/python3", rows, { bodies: true, bound: BOUND, admittedAt: ADMITTED, ...options })

test("the cap is the documented 10,000 characters", () => {
  assert.equal(MAX_OUTPUT_BYTES, 10_000)
})

test("metadata mode carries ids and cursors, never bodies or senders", () => {
  const text = renderNotice(joined, "/usr/bin/python3", [row(0)], { bound: BOUND })
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
  assert.equal(renderNotice(joined, "/usr/bin/python3", [], { bound: BOUND }), null)
})

test("a maximum batch has no metadata fallback: every message keeps its frame inside the same whole-notice cap", () => {
  const rows = Array.from({ length: 16 }, (_, index) => bodyRow(index, "b".repeat(1200)))
  const text = bodies(rows)
  assert.ok(text)
  assert.ok(size(text) <= MAX_OUTPUT_BYTES)
  for (const item of rows) assert.ok(text.includes(`message ${item.id} kind question`))
  assert.doesNotMatch(text, /"history_after"/)
  assert.match(text, /^Body cut\. Read all of it with: history --room /m)
})

test("bodies share what is left of the bound: one halved cap for every body", () => {
  const rows = Array.from({ length: 16 }, (_, index) => bodyRow(index, "b".repeat(1200)))
  const text = bodies(rows)
  assert.ok(size(text) <= MAX_OUTPUT_BYTES)
  const runs = text.split("\n").filter(line => line.startsWith("> b")).map(line => line.length - 2)
  assert.equal(runs.length, 16)
  assert.equal(new Set(runs).size, 1, "every body is cut to the same length")
  assert.ok([1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1].includes(runs[0]), `${runs[0]} is a halving of 4096`)
})

test("a batch whose metadata alone does not fit renders nothing", () => {
  const rows = Array.from({ length: 16 }, (_, index) => ({
    ...row(index),
    history_after: `${index}-${"c".repeat(600)}`,
  }))
  assert.equal(renderNotice(joined, "/usr/bin/python3", rows, { bound: BOUND }), null)
})

test("the budget is bytes, so multi-byte bodies never push the notice over the cap", () => {
  // Each body is 1200 characters but 3600 bytes; a character count would let 16 of them through.
  const rows = Array.from({ length: 16 }, (_, index) => bodyRow(index, "€".repeat(1200)))
  const text = bodies(rows)
  assert.ok(text)
  assert.ok(size(text) <= MAX_OUTPUT_BYTES)
})

test("a smaller bound is honoured, and a bound the notice cannot meet renders nothing", () => {
  const rows = [bodyRow(0), bodyRow(1)]
  for (const bound of [700, 1200, 2500, 5000, 9000]) {
    const text = bodies(rows, { bound })
    if (text !== null) assert.ok(bytes(text) <= bound, `bound ${bound}`)
  }
  assert.equal(renderNotice(joined, "/usr/bin/python3", [row(0), row(1)], { bound: 100 }), null)
  assert.equal(bodies(rows, { bound: 100 }), null)
  assert.throws(() => bodies(rows, { bound: Number.NaN }), TypeError, "a bound that is not a whole number is a caller error")
})

test("a body over the per-body cap is cut and pointed at, never passed on as a full copy", () => {
  const text = bodies([bodyRow(0, "x".repeat(5000))])
  assert.match(text, /^> x{4096}$/m)
  assert.doesNotMatch(text, /x{4097}/)
  assert.match(text, /^Body cut\. Read all of it with: history --room 33333333-3333-4333-8333-333333333333 --after 100 --limit 1 \(verify id aaaaaaaa-aaaa-4aaa-8aaa-000000000000\)$/m)
})
