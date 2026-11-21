import test from "node:test"
import assert from "node:assert/strict"
import {
  ADDITIONAL_CONTEXT_LIMIT, CHAT_PREFIX, MAX_BINDING_BYTES, MAX_OUTPUT_BYTES,
} from "../lib/channel.js"
import { packCandidates, renderNotice } from "../lib/notice.js"

// What the package owns around the shared notice renderer: the byte limits and the delivery prefix. The renderer's own
// contract suite runs from test/notice.test.js and is not repeated here.
const joined = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "codex",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
const row = number => ({
  id: id(number), kind: "question", room_id: joined.room_id, history_after: String(1000 + number),
  body: "synthetic body", sender_session_id: id(900), created_at: "2026-01-01T00:00:00+00:00",
})
const bytes = text => Buffer.byteLength(text, "utf8")

test("the output cap, the Codex context threshold and the binding cap leave room for a notice", () => {
  assert.equal(MAX_OUTPUT_BYTES, ADDITIONAL_CONTEXT_LIMIT)
  assert.ok(MAX_BINDING_BYTES < MAX_OUTPUT_BYTES / 2)
  assert.ok(bytes(CHAT_PREFIX) < 200)
})

test("a metadata notice behind the delivery prefix is inside the cap", () => {
  const bound = MAX_OUTPUT_BYTES - bytes(CHAT_PREFIX)
  const notice = renderNotice(joined, "/usr/bin/python3", [row(1), row(2)], { bound })
  assert.ok(notice)
  assert.ok(bytes(CHAT_PREFIX + notice) <= MAX_OUTPUT_BYTES)
  assert.doesNotMatch(notice, /synthetic body/)
})

test("a bodies notice is framed, bounded and never exceeds the cap with the binding and the prefix", () => {
  const prefix = `${"b".repeat(MAX_BINDING_BYTES)}\n\n${CHAT_PREFIX}`
  const bound = MAX_OUTPUT_BYTES - bytes(prefix)
  const big = { ...row(1), body: "x".repeat(9_000) }
  const notice = renderNotice(joined, "/usr/bin/python3", [big], { bodies: true, bound, admittedAt: "2026-01-01T00:00:01+00:00" })
  assert.ok(notice)
  assert.ok(bytes(prefix + notice) <= MAX_OUTPUT_BYTES)
  assert.match(notice, /<<<AGENT-CHAT-BODY [0-9a-f]{16}\n/)
  assert.match(notice, /Body cut\./)
})

test("a batch that cannot fit is claimed in part, and a notice that cannot fit is null", () => {
  const pending = { messages: Array.from({ length: 40 }, (_, number) => id(number + 1)), sizes: Object.fromEntries(Array.from({ length: 40 }, (_, number) => [id(number + 1), 4_000])) }
  const bound = MAX_OUTPUT_BYTES - bytes(CHAT_PREFIX)
  const claim = packCandidates(pending, { joined, python: "/usr/bin/python3", bound })
  assert.ok(claim.length >= 1 && claim.length < 40)
  assert.equal(renderNotice(joined, "/usr/bin/python3", [row(1)], { bound: 10 }), null)
})
