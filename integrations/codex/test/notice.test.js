import test from "node:test"
import assert from "node:assert/strict"
import * as notice from "../lib/notice.js"
import { CHAT_PREFIX, MAX_BINDING_BYTES, MAX_OUTPUT_BYTES } from "../lib/channel.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

const { packCandidates, renderNotice, WORST_FRAME_BYTES } = notice

// The vectors, the property, budget and pack tests, and the copy check are shared by every package. Codex has no
// fixed notice bound: the receiver subtracts a binding announcement of up to MAX_BINDING_BYTES, which varies, so it
// passes no `noticeBound`, as Claude Code does. The tests below hold the package to the smallest bound it can pass.
runNoticeSuite("codex", notice, new URL("../lib/notice.js", import.meta.url))

const joined = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "codex",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const PYTHON = "/usr/bin/python3"
const WIDEST_ADMITTED = "9999-12-31T23:59:59.999999+00:00"
const bytes = text => Buffer.byteLength(text, "utf8")
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
// A message with every header field at its widest and a body over the 4096-byte cap, so it carries a pointer.
const widest = number => ({
  id: id(number),
  room_id: joined.room_id,
  history_after: "9".repeat(19),
  kind: "consultation",
  body: "x".repeat(16384),
  body_truncated: true,
  sender_session_id: null,
  sender_principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  created_at: "0001-01-01T00:00:00.000000+00:00",
})
// What the receiver passes with the longest binding announcement in front: the cap minus the announcement, the blank
// line after it and the delivery line.
const SMALLEST_BOUND = MAX_OUTPUT_BYTES - bytes(`${"b".repeat(MAX_BINDING_BYTES)}\n\n${CHAT_PREFIX}`)
const headers = text => text.split("\n").filter(line => line.startsWith("message ")).map(line => line.split(" ")[1])

test("the smallest notice bound still holds one message at its widest", () => {
  assert.ok(SMALLEST_BOUND > 0)
  assert.ok(WORST_FRAME_BYTES < SMALLEST_BOUND)
  const text = renderNotice(joined, PYTHON, [widest(1)], { bodies: true, bound: SMALLEST_BOUND, admittedAt: WIDEST_ADMITTED })
  assert.ok(text, "the packer always claims one candidate, so one widest message must render at the smallest bound (with this fixture's short paths)")
  assert.ok(bytes(text) <= SMALLEST_BOUND)
  assert.ok(bytes(`${"b".repeat(MAX_BINDING_BYTES)}\n\n${CHAT_PREFIX}${text}`) <= MAX_OUTPUT_BYTES)
  assert.deepEqual(headers(text), [id(1)])
})

test("a pack at the smallest bound renders every claimed message inside it", () => {
  const ids = Array.from({ length: 16 }, (_, index) => id(index + 1))
  const sizes = Object.fromEntries(ids.map(candidate => [candidate, 16384]))
  const claimed = packCandidates({ messages: ids, sizes, retry: false }, { joined, python: PYTHON, bound: SMALLEST_BOUND })
  assert.ok(claimed.length >= 1 && claimed.length < ids.length, "a prefix is claimed, never the whole batch")
  assert.deepEqual(claimed, ids.slice(0, claimed.length))
  const text = renderNotice(joined, PYTHON, claimed.map((_, index) => widest(index + 1)), { bodies: true, bound: SMALLEST_BOUND, admittedAt: WIDEST_ADMITTED })
  assert.ok(text, "the claimed prefix renders at the bound it was packed for")
  assert.ok(bytes(text) <= SMALLEST_BOUND)
  assert.deepEqual(headers(text), claimed)
})
