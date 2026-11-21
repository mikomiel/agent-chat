import test from "node:test"
import assert from "node:assert/strict"
import * as notice from "../lib/notice.js"
import { CHAT_PREFIX, MAX_CONTEXT_BYTES, NOTICE_BOUND } from "../lib/channel.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

// The vectors, the property, budget, pack and headroom tests, and the copy check are shared by every package.
runNoticeSuite("opencode", notice, new URL("../lib/notice.js", import.meta.url), { noticeBound: NOTICE_BOUND })

// What stays here is how this package uses the renderer: the limit and the bound it passes from lib/channel.js.
const joined = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "opencode",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const row = {
  id: "00000000-0000-4000-8000-000000000000",
  kind: "question",
  room_id: joined.room_id,
  history_after: "100",
  body: "synthetic body",
  body_truncated: false,
  sender_session_id: "44444444-4444-4444-8444-444444444444",
  sender_principal_id: "55555555-5555-4555-8555-555555555555",
  created_at: "2026-01-01T00:00:00.000000+00:00",
}

test("the notice bound is what the 8 KiB limit leaves after the delivery line", () => {
  assert.equal(MAX_CONTEXT_BYTES, 8 * 1024)
  assert.equal(NOTICE_BOUND, MAX_CONTEXT_BYTES - Buffer.byteLength(CHAT_PREFIX, "utf8"))
  const text = notice.renderNotice(joined, "/usr/bin/python3", [row], {
    bodies: true, bound: NOTICE_BOUND, admittedAt: "2026-01-01T00:01:00.000000+00:00",
  })
  assert.ok(text, "the notice renders at the package bound")
  assert.ok(Buffer.byteLength(CHAT_PREFIX + text, "utf8") <= MAX_CONTEXT_BYTES)
})
