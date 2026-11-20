import test from "node:test"
import assert from "node:assert/strict"
import * as notice from "../lib/notice.js"
import { CHAT_PREFIX, MAX_CONTEXT_BYTES, NOTICE_BOUND } from "../lib/channel.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

// The vectors, the property, budget and pack tests, and the copy check are shared by every package.
runNoticeSuite("pi", notice, new URL("../lib/notice.js", import.meta.url))

test("the notice bound is what the 8 KiB limit leaves after the delivery line", () => {
  assert.equal(MAX_CONTEXT_BYTES, 8 * 1024)
  assert.equal(NOTICE_BOUND, MAX_CONTEXT_BYTES - Buffer.byteLength(CHAT_PREFIX, "utf8"))
})

test("the notice tells the model to run the CLI isolated, as the other packages do", () => {
  const joined = {
    session_id: "11111111-1111-4111-8111-111111111111",
    instance_id: "22222222-2222-4222-8222-222222222222",
    room_id: "33333333-3333-4333-8333-333333333333",
    host: "synthetic-host",
    harness: "pi",
    instance_file: "/tmp/agent-chat-state/boot-1.json",
  }
  const text = notice.renderNotice(joined, "/usr/bin/python3", [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", kind: "question", room_id: joined.room_id, history_after: "1",
  }], { bound: NOTICE_BOUND })
  assert.match(text, /the declared python with -I -m agent_chat\.cli/)
})
