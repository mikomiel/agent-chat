import test from "node:test"
import assert from "node:assert/strict"
import * as notice from "../lib/notice.js"
import { CHAT_PREFIX, MAX_CONTEXT_BYTES, NOTICE_BOUND } from "../lib/channel.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

// The binding takes the tool route's lines from lib/notice.js, the shared renderer every package copies
// (integrations/shared/notice.js), and the idle hook renders its notice (identifiers and cursors, no body) with the same
// copy, within NOTICE_BOUND. The suite pins the copy and the route text, and with `noticeBound` that the bound holds the
// widest notice the renderer writes.
runNoticeSuite("opencode", notice, new URL("../lib/notice.js", import.meta.url), { noticeBound: NOTICE_BOUND })

test("the notice bound is what the 8 KiB limit leaves after the delivery line", () => {
  assert.equal(MAX_CONTEXT_BYTES, 8 * 1024)
  assert.equal(NOTICE_BOUND, MAX_CONTEXT_BYTES - Buffer.byteLength(CHAT_PREFIX, "utf8"))
})
