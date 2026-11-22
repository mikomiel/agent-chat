import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLIENT_ID_PREFIX, createThread, isChildThread, MIN_ADD_MS, monotonic, openAppServer, SETTLE_MS } from "../lib/appserver.js"
import { fakeAppServer, serverFrame } from "./fake-app-server.js"

const THREAD = "thread-1"
const dir = mkdtempSync(join(tmpdir(), "acs-"))
let counter = 0
const socketPath = () => join(dir, `s${counter++}.sock`)
test.after(() => rmSync(dir, { recursive: true, force: true }))

const thread = (extra = {}) => ({
  id: THREAD, parentThreadId: null, agentRole: null, ephemeral: false, source: "cli", modelProvider: "openai",
  status: { type: "idle" }, ...extra,
})
const ok = result => ({ result })

// A server that answers the reads like an idle, default-mode, main thread; `over` replaces one method each.
function main(over = {}) {
  const answers = {
    "thread/loaded/list": () => ok({ data: [THREAD], nextCursor: null }),
    "thread/read": () => ok({ thread: thread() }),
    "thread/turns/list": () => ok({ data: [{ id: "t1", status: "completed" }], nextCursor: null }),
    "thread/resume": () => ok({ thread: thread(), collaborationMode: { mode: "default", settings: {} } }),
    // Live, codex-cli 0.171.0: a delete of an id that was never queued (the bind's probe) answers { deleted: false }.
    "thread/queue/delete": () => ok({ deleted: false }),
    ...over,
  }
  return (message, connection) => {
    const answer = answers[message.method]
    return answer ? answer(message, connection) : { error: { code: -32601, message: "method not found" } }
  }
}

async function withServer(handler, task, options) {
  const path = socketPath()
  const server = await fakeAppServer(path, handler, options)
  try { return await task(path, server) } finally { await server.close() }
}

test("the client upgrades once, declares experimentalApi, acknowledges and closes", async () => {
  await withServer(main(), async (path, server) => {
    const link = await openAppServer(path)
    assert.match(server.heads[0], /^GET \/rpc HTTP\/1\.1\r\n/)
    assert.match(server.heads[0], /Upgrade: websocket/i)
    assert.match(server.heads[0], /Sec-WebSocket-Version: 13/)
    assert.doesNotMatch(server.heads[0], /Origin:/i)
    const [init] = server.log
    assert.equal(init.method, "initialize")
    assert.equal(init.params.capabilities.experimentalApi, true)
    assert.equal(init.params.clientInfo.name, "agent-chat-codex")
    assert.equal(typeof init.params.clientInfo.version, "string")
    await link.request("thread/loaded/list", {})
    assert.equal(server.state.initialized, 1, "the initialized notification went out before any other request")
    assert.equal(server.state.unmasked, 0, "every client frame is masked")
    link.close()
    for (let waited = 0; server.state.open && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(server.state.open, 0)
  })
})

test("the client announces the package version, which release-please moves with package.json", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.match(version, /^\d+\.\d+\.\d+/)
  await withServer(main(), async (path, server) => {
    const link = await openAppServer(path)
    assert.equal(server.log[0].method, "initialize")
    assert.equal(server.log[0].params.clientInfo.version, version)
    link.close()
  })
})

test("a handshake whose accept proof is wrong, and a socket nobody listens on, are refused", async () => {
  await withServer(main(), async path => {
    await assert.rejects(openAppServer(path), { code: "APP_SERVER_PROTOCOL" })
  }, { accept: false })
  await assert.rejects(openAppServer(join(dir, "absent.sock")), error => ["ENOENT", "APP_SERVER_CLOSED"].includes(error.code))
})

// The upgrade answer is checked whole before anything is sent: the whole status line (`HTTP/1.1 101`, then the end of the line or a
// space and a reason phrase of visible ASCII, spaces and tabs), every header line `name: value` with a token for a name and no
// control byte in the value (NUL, the rest of C0 except HTAB, and DEL), the whole head within 16 KiB, terminator included,
// `Upgrade: websocket` and a `Connection` header with the Upgrade token (any case, any repeat) as RFC 6455 section 4.1 wants, and
// the Accept proof. Only space and tab are trimmed from a value or a token, never what String.trim would take (a no-break space,
// say). The client offered no extension and no subprotocol, so an answer that names one is refused. A refusal writes no `initialize`.
// `sized` builds the header lines that make the whole head exactly `total` bytes, as the fake server writes it.
const sized = total => lines => {
  const base = ["HTTP/1.1 101 Switching Protocols", ...lines, "X-Pad: ", "", ""].join("\r\n").length
  return [...lines, `X-Pad: ${"a".repeat(total - base)}`]
}
const dropping = prefix => lines => lines.filter(line => !line.toLowerCase().startsWith(prefix))
const replacing = (prefix, ...added) => lines => [...dropping(prefix)(lines), ...added]
for (const [label, options, accepted] of [
  ["the headers the client expects", { headers: lines => lines }, true],
  ["the head that codex-cli 0.171.0 sends: lowercase names, and a header of its own", { headers: lines => [
    "connection: Upgrade", "upgrade: websocket",
    lines.find(line => line.startsWith("Sec-WebSocket-Accept:")).replace("Sec-WebSocket-Accept:", "sec-websocket-accept:"),
    "x-codex-websocket-max-unfragmented-message-bytes: 16777216",
  ] }, true],
  ["Upgrade and Connection in another case", { headers: lines => [...dropping("upgrade:")(dropping("connection:")(lines)), "UPGRADE: WebSocket", "connection: UPGRADE"] }, true],
  ["Connection with the Upgrade token among others", { headers: replacing("connection:", "Connection: keep-alive, Upgrade") }, true],
  ["Connection repeated, the Upgrade token in the second", { headers: replacing("connection:", "Connection: keep-alive", "Connection: Upgrade") }, true],
  ["no Upgrade header", { headers: dropping("upgrade:") }, false],
  ["Upgrade naming another protocol", { headers: replacing("upgrade:", "Upgrade: h2c") }, false],
  ["Upgrade naming websocket among others", { headers: replacing("upgrade:", "Upgrade: websocket, h2c") }, false],
  ["no Connection header", { headers: dropping("connection:") }, false],
  ["Connection without the Upgrade token", { headers: replacing("connection:", "Connection: keep-alive") }, false],
  ["Connection naming the token only as part of another", { headers: replacing("connection:", "Connection: upgrade-insecure") }, false],
  ["an extension in the answer", { headers: lines => [...lines, "Sec-WebSocket-Extensions: permessage-deflate"] }, false],
  ["an empty extensions header", { headers: lines => [...lines, "Sec-WebSocket-Extensions:"] }, false],
  ["a subprotocol in the answer", { headers: lines => [...lines, "Sec-WebSocket-Protocol: chat"] }, false],
  ["an empty subprotocol header", { headers: lines => [...lines, "Sec-WebSocket-Protocol:"] }, false],
  ["a header with token characters in its name and colons in its value", { headers: lines => [...lines, "X-A_b.c~1!#$%&'*+^`|: 12:30:45"] }, true],
  ["no space after the colon", { headers: replacing("upgrade:", "Upgrade:websocket") }, true],
  ["a status line that is only 101", { status: "HTTP/1.1 101" }, true],
  ["a status line whose reason phrase is empty", { status: "HTTP/1.1 101 " }, true],
  ["a reason phrase of visible ASCII with spaces and a tab", { status: "HTTP/1.1 101 Switching\tProtocols (ok), ~!" }, true],
  ["a tab inside a header value", { headers: lines => [...lines, "X-A: one\ttwo"] }, true],
  ["spaces and tabs around the Upgrade token", { headers: replacing("connection:", "Connection: \t keep-alive ,\t Upgrade \t") }, true],
  ["a byte from 0x80 up in a header value", { headers: lines => [...lines, "X-A: caf\u00e9"] }, true],
  ["a head of exactly 16 KiB, terminator included", { headers: sized(16 * 1024) }, true],
  ["a head one byte over 16 KiB, terminator in the same piece", { headers: sized(16 * 1024 + 1) }, false],
  ["a line with no colon", { headers: lines => [...lines, "X-Broken"] }, false],
  ["a malformed line before the upgrade headers", { headers: lines => ["X-Broken", ...lines] }, false],
  ["a name with a space in it", { headers: lines => [...lines, "X Bad: 1"] }, false],
  ["an empty name", { headers: lines => [...lines, ": value"] }, false],
  ["a continuation line", { headers: lines => [...lines, " continued"] }, false],
  ["a name with a character that is not a token character", { headers: lines => [...lines, "X(Bad): 1"] }, false],
  ["a line break that is only LF", { headers: lines => [...lines, "X-A: 1\nX-B: 2"] }, false],
  ["a bare CR in a line", { headers: lines => [...lines, "X-A: 1\rX-B: 2"] }, false],
  ["101 followed by a hyphen", { status: "HTTP/1.1 101-x" }, false],
  ["101 followed by a tab", { status: "HTTP/1.1 101\tx" }, false],
  ["a status code of 1010", { status: "HTTP/1.1 1010 x" }, false],
  ["a status of 100", { status: "HTTP/1.1 100 Continue" }, false],
  ["HTTP/1.0", { status: "HTTP/1.0 101 Switching Protocols" }, false],
  ["a lower case protocol name", { status: "http/1.1 101 Switching Protocols" }, false],
  ["two spaces before the code", { status: "HTTP/1.1  101 x" }, false],
  ["a space before the protocol name", { status: " HTTP/1.1 101 x" }, false],
  ["HTTP/1.10", { status: "HTTP/1.10 101 x" }, false],
  ["a reason phrase with a byte from 0x80 up", { status: "HTTP/1.1 101 caf\u00e9" }, false],
  ["a reason phrase with NUL", { status: "HTTP/1.1 101 a\u0000b" }, false],
  ["a reason phrase with a C0 control byte", { status: "HTTP/1.1 101 a\u0001b" }, false],
  ["a reason phrase with DEL", { status: "HTTP/1.1 101 a\u007fb" }, false],
  ["a reason phrase with a bare CR", { status: "HTTP/1.1 101 a\rb" }, false],
  ["a reason phrase with a bare LF", { status: "HTTP/1.1 101 a\nb" }, false],
  ["a header value with NUL", { headers: lines => [...lines, "X-A: a\u0000b"] }, false],
  ["a header value with a C0 control byte", { headers: lines => [...lines, "X-A: a\u0001b"] }, false],
  ["a header value with the last C0 control byte", { headers: lines => [...lines, "X-A: a\u001fb"] }, false],
  ["a header value with a vertical tab", { headers: lines => [...lines, "X-A: a\u000bb"] }, false],
  ["a header value with a form feed", { headers: lines => [...lines, "X-A: a\u000cb"] }, false],
  ["a header value with DEL", { headers: lines => [...lines, "X-A: a\u007fb"] }, false],
  ["a control byte at the end of the Upgrade value", { headers: replacing("upgrade:", "Upgrade: websocket\u0000") }, false],
  ["a control byte in the Connection value", { headers: replacing("connection:", "Connection: Upgrade\u007f") }, false],
  ["a no-break space after the Upgrade value", { headers: replacing("upgrade:", "Upgrade: websocket\u00a0") }, false],
  ["a no-break space before the Upgrade token", { headers: replacing("connection:", "Connection: keep-alive,\u00a0Upgrade") }, false],
  ["a no-break space after the Upgrade token", { headers: replacing("connection:", "Connection: Upgrade\u00a0,keep-alive") }, false],
  ["a vertical tab in a reason phrase", { status: "HTTP/1.1 101 a\u000bb" }, false],
  ["a form feed in a reason phrase", { status: "HTTP/1.1 101 a\u000cb" }, false],
  ["a no-break space before the Upgrade value", { headers: replacing("upgrade:", "Upgrade:\u00a0websocket") }, false],
  ["a vertical tab before the Upgrade value", { headers: replacing("upgrade:", "Upgrade:\u000bwebsocket") }, false],
  ["spaces and tabs around the Upgrade value", { headers: replacing("upgrade:", "Upgrade: \t websocket \t ") }, true],
  ["spaces and tabs between the Upgrade token and the comma", { headers: replacing("connection:", "Connection: Upgrade \t,keep-alive") }, true],
]) {
  test(`the upgrade answer is ${accepted ? "accepted" : "refused as APP_SERVER_PROTOCOL"} with ${label}`, async () => {
    await withServer(main(), async (path, server) => {
      if (accepted) {
        const link = await openAppServer(path)
        assert.equal(server.log[0].method, "initialize")
        link.close()
      } else {
        await assert.rejects(openAppServer(path), { code: "APP_SERVER_PROTOCOL" })
        assert.equal(server.log.length + server.state.initialized, 0, "no initialize and nothing else was sent after the refused answer")
      }
    }, options)
  })
}

// The 16 KiB limit holds before the terminator has come: a server that never ends its head is refused as soon as the head passes the
// limit, not left to the connect timeout.
test("a head that passes 16 KiB with no terminator in sight is refused as APP_SERVER_PROTOCOL, not left to the connect timeout", async () => {
  const path = socketPath()
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.once("data", () => socket.write(`HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${"a".repeat(16 * 1024)}`))
  })
  await new Promise(resolve => server.listen(path, resolve))
  try {
    await assert.rejects(openAppServer(path, { connectMs: 1500 }), { code: "APP_SERVER_PROTOCOL" })
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

test("ping is answered with pong, a server request is refused, and a notification is ignored", async () => {
  await withServer(message => (message.method === "thread/loaded/list" ? ok({ data: [THREAD], nextCursor: null }) : undefined), async (path, server) => {
    const link = await openAppServer(path)
    server.state.current.write(serverFrame(0x9, "hi"))
    server.state.current.write(serverFrame(0x1, JSON.stringify({ method: "thread/started", params: {} })))
    server.state.current.write(serverFrame(0x1, JSON.stringify({ id: 99, method: "item/approval", params: {} })))
    const answer = await link.request("thread/loaded/list", {})
    assert.deepEqual(answer.data, [THREAD])
    for (let waited = 0; server.state.replies.length < 1 && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(server.state.pongs, ["hi"])
    assert.equal(server.state.replies.length, 1, "the notification got no reply")
    assert.equal(server.state.replies[0].id, 99)
    assert.equal(server.state.replies[0].error.code, -32601)
    link.close()
  })
})

test("a masked, fragmented or binary server frame fails the connection", async () => {
  for (const bad of [
    Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0, 0]), // masked
    Buffer.from([0x01, 0x01, 0x61]), // text without FIN
    Buffer.from([0x82, 0x01, 0x61]), // binary
  ]) {
    await withServer(() => undefined, async (path, server) => {
      const link = await openAppServer(path)
      const pending = link.request("thread/loaded/list", {}, 2000)
      server.state.current.write(bad)
      await assert.rejects(pending, { code: "APP_SERVER_PROTOCOL" })
    })
  }
})

// No extension is negotiated, so a reserved bit (RSV1-3, the top bits of the first byte after FIN) is a protocol error:
// the frame is never read, whatever it carries. A reply that is well formed otherwise settles the call when the bit is 0.
test("a server frame with a reserved bit set fails the connection and is never dispatched", async () => {
  const reply = bit => (message, connection) => {
    const frame = serverFrame(0x1, JSON.stringify({ id: message.id, result: { data: [THREAD], nextCursor: null } }))
    frame[0] |= bit
    connection.socket.write(frame)
    return undefined
  }
  await withServer(reply(0), async path => {
    const link = await openAppServer(path)
    assert.deepEqual((await link.request("thread/loaded/list", {}, 2000)).data, [THREAD], "control: the same reply without the bit settles the call")
    link.close()
  })
  for (const bit of [0x40, 0x20, 0x10, 0x70]) {
    await withServer(reply(bit), async path => {
      const link = await openAppServer(path)
      await assert.rejects(link.request("thread/loaded/list", {}, 2000), { code: "APP_SERVER_PROTOCOL" }, `0x${bit.toString(16)} on a text frame`)
    })
    await withServer(() => undefined, async (path, server) => {
      const link = await openAppServer(path)
      const pending = link.request("thread/loaded/list", {}, 2000)
      const ping = serverFrame(0x9, "hi")
      ping[0] |= bit
      server.state.current.write(ping)
      await assert.rejects(pending, { code: "APP_SERVER_PROTOCOL" }, `0x${bit.toString(16)} on a ping`)
      assert.deepEqual(server.state.pongs, [], "the ping was not answered")
    })
  }
})

// RFC 6455 gives a length one form only, the shortest: 7 bits up to 125, 16 bits from 126, 64 bits from 65536. A frame that
// spells it the long way is a protocol error, not another way to write the same frame; so is a 64-bit length with its top bit set.
// `framed` builds a text frame with the length in the form asked for ("short", 16 or 64 bits), whether or not it is the shortest.
function framed(form, payload, bit = 0) {
  const body = Buffer.from(payload)
  const wide = Buffer.alloc(8)
  wide.writeBigUInt64BE(BigInt(body.length))
  const head = form === 16 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
    : form === 64 ? Buffer.concat([Buffer.from([0x81, 127]), wide])
      : Buffer.from([0x81, body.length])
  const frame = Buffer.concat([head, body])
  frame[0] |= bit
  return frame
}

test("a length is read only in its shortest form: 16 bits from 126 and 64 bits from 65536, and a 64-bit length with its top bit is refused", async () => {
  const reply = (form, length) => (message, connection) => {
    const base = JSON.stringify({ id: message.id, result: { pad: "" } })
    connection.socket.write(framed(form, JSON.stringify({ id: message.id, result: { pad: "x".repeat(length - Buffer.byteLength(base)) } })))
    return undefined
  }
  for (const [form, length, accepted] of [
    ["short", 125, true], [16, 126, true], [16, 65535, true], [64, 65536, true], [64, 70_000, true],
    [16, 125, false], [16, 40, false], [64, 65535, false], [64, 126, false], [64, 40, false],
  ]) {
    await withServer(reply(form, length), async path => {
      const link = await openAppServer(path)
      const label = `${form} form, ${length} bytes`
      if (accepted) assert.equal((await link.request("thread/loaded/list", {}, 2000)).pad.length > 0, true, label)
      else await assert.rejects(link.request("thread/loaded/list", {}, 2000), { code: "APP_SERVER_PROTOCOL" }, label)
      link.close()
    })
  }
  await withServer((message, connection) => {
    connection.socket.write(Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0x01, 0x00])) // 2^63 + 256: only the header is sent
    return undefined
  }, async path => {
    const link = await openAppServer(path)
    await assert.rejects(link.request("thread/loaded/list", {}, 2000), { code: "APP_SERVER_PROTOCOL" }, "top bit set")
  })
})

// A server frame built one field at a time, so that each rule of RFC 6455 section 5 can be broken alone. `form` is how the length
// is spelled ("short" is 7 bits, or 16 or 64 bits); by default it is the shortest form that holds it.
function wire(opcode, payload = "", { fin = true, rsv = 0, form } = {}) {
  const body = Buffer.from(payload)
  const spelled = form ?? (body.length < 126 ? "short" : body.length < 65536 ? 16 : 64)
  const wide = Buffer.alloc(8)
  wide.writeBigUInt64BE(BigInt(body.length))
  const length = spelled === "short" ? Buffer.from([body.length])
    : spelled === 16 ? Buffer.from([126, body.length >> 8, body.length & 0xff])
      : Buffer.concat([Buffer.from([127]), wide])
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | rsv | opcode]), length, body])
}

// What a text frame may not carry: bytes that are not UTF-8, which `toString` would turn into U+FFFD and let through.
const NOT_UTF8 = [
  ["a lone continuation byte", [0x80]], ["a byte that never occurs", [0xff]], ["a truncated sequence", [0xe2, 0x82]],
  ["an overlong encoding", [0xc0, 0xaf]], ["a surrogate", [0xed, 0xa0, 0x80]], ["a code point past U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
]
// A JSON reply to `message` whose one string value ends with `tail`: well formed JSON, so only its encoding can refuse it.
const replyWith = (message, tail) => Buffer.concat([Buffer.from(`{"id":${message.id},"result":{"data":["${THREAD}"],"nextCursor":null,"note":"`), Buffer.from(tail), Buffer.from('"}}')])

// Every rule of RFC 6455 section 5 that the client relies on fails the connection before any frame is dispatched: no reply is
// read from a frame that breaks one, and a reply that follows it on the wire is not read either. `refused` rows must reject the
// pending request with APP_SERVER_PROTOCOL; the other rows are the controls, which show that a valid frame of each kind still works.
test("a server frame that breaks a rule of RFC 6455 section 5 fails the connection with APP_SERVER_PROTOCOL before any dispatch", async () => {
  const settling = message => serverFrame(0x1, JSON.stringify({ id: message.id, result: { data: [THREAD], nextCursor: null } }))
  const most = "x".repeat(125) // the longest payload a control frame may carry
  const over = "x".repeat(126)
  const rows = [
    // fragmentation is not supported
    ["a text frame with FIN=0", () => wire(0x1, "{}", { fin: false }), "refused"],
    ["a continuation frame (opcode 0) with FIN=1", () => wire(0x0, "{}"), "refused"],
    ["a continuation frame (opcode 0) with FIN=0", () => wire(0x0, "{}", { fin: false }), "refused"],
    ["a binary frame (opcode 2)", message => wire(0x2, JSON.stringify({ id: message.id, result: {} })), "refused"],
    ...[3, 4, 5, 6, 7, 11, 12, 13, 14, 15].map(opcode => [`a reserved opcode (${opcode})`, () => wire(opcode, "{}"), "refused"]),
    // control frames
    ["a ping with FIN=0", () => wire(0x9, "hi", { fin: false }), "refused"],
    ["a pong with FIN=0", () => wire(0xa, "hi", { fin: false }), "refused"],
    ["a close with FIN=0", () => wire(0x8, Buffer.from([0x03, 0xe8]), { fin: false }), "refused"],
    ["a ping of 126 bytes", () => wire(0x9, over), "refused"],
    ["a pong of 126 bytes", () => wire(0xa, over), "refused"],
    ["a close of 126 bytes", () => wire(0x8, over), "refused"],
    ["a pong of 70000 bytes in the 64-bit form", () => wire(0xa, "x".repeat(70_000)), "refused"],
    ["a ping that claims 126 bytes, header only: refused without waiting for the rest", () => wire(0x9, over).subarray(0, 4), "refused"],
    // text is UTF-8
    ...NOT_UTF8.map(([label, bytes]) => [`a text frame with ${label}`, message => wire(0x1, replyWith(message, bytes)), "refused"]),
    ["a text frame with a BOM, which is kept and which JSON does not allow", message => wire(0x1, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ id: message.id, result: {} }))])), "refused"],
    // the rules from before: no reserved bit, no mask, the shortest form of a length, and a length within the limit
    ...[0x40, 0x20, 0x10].map(rsv => [`a text frame with reserved bit 0x${rsv.toString(16)}`, () => wire(0x1, "{}", { rsv }), "refused"]),
    ["a ping with RSV1", () => wire(0x9, "hi", { rsv: 0x40 }), "refused"],
    // the mask bit alone, on frames that are otherwise well formed: nothing else about them could refuse them
    ["a text frame with the mask bit set", message => { const frame = wire(0x1, replyWith(message, "")); frame[1] |= 0x80; return frame }, "refused"],
    ["a ping with the mask bit set", () => { const frame = wire(0x9, "hi"); frame[1] |= 0x80; return frame }, "refused"],
    ["a masked text frame with its key", () => Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0, 0]), "refused"],
    ["a text frame with a 16-bit length that fits in 7 bits", () => wire(0x1, "{}", { form: 16 }), "refused"],
    ["a text frame with a 64-bit length that fits in 7 bits", () => wire(0x1, "{}", { form: 64 }), "refused"],
    ["a text frame with a 64-bit length that fits in 16 bits", () => wire(0x1, "x".repeat(300), { form: 64 }), "refused"],
    ["a text frame with a 64-bit length with its top bit set, header only", () => Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0x01, 0x00]), "refused"],
    ["a text frame one byte over the frame limit, header only", () => Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0x40, 0x00, 0x01]), "refused"],
    // what still works
    ["a text frame with FIN=1", () => Buffer.alloc(0), "settles"],
    ["a text frame with multi-byte UTF-8", message => wire(0x1, replyWith(message, "é€𝄞")), "settles"],
    ["a ping of 125 bytes, which is answered with its payload", () => wire(0x9, most), { pong: most }],
    ["a ping of no bytes, which is answered", () => wire(0x9), { pong: "" }],
    ["a pong of 125 bytes, which is dropped", () => wire(0xa, most), "settles"],
    ["a pong of no bytes, which is dropped", () => wire(0xa), "settles"],
    ["a close", () => wire(0x8, Buffer.from([0x03, 0xe8])), "closed"],
  ]
  for (const [label, frame, outcome] of rows) {
    const handler = (message, connection) => {
      connection.socket.write(frame(message))
      if (outcome !== "closed") connection.socket.write(settling(message))
      return undefined
    }
    await withServer(handler, async (path, server) => {
      const link = await openAppServer(path)
      const pending = link.request("thread/loaded/list", {}, 1500)
      if (outcome === "refused") {
        await assert.rejects(pending, { code: "APP_SERVER_PROTOCOL" }, label)
        assert.deepEqual(server.state.pongs, [], `${label}: nothing was answered`)
      } else if (outcome === "closed") await assert.rejects(pending, { code: "APP_SERVER_CLOSED" }, label)
      else {
        assert.deepEqual((await pending).data, [THREAD], label)
        if (typeof outcome === "object") {
          for (let waited = 0; server.state.pongs.length < 1 && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
          assert.deepEqual(server.state.pongs, [outcome.pong], `${label}: the pong carries the ping's payload`)
        }
        link.close()
      }
    })
  }
})

test("an error reply carries its code and never its message", async () => {
  await withServer(() => ({ error: { code: -32600, message: "secret detail" } }), async path => {
    const link = await openAppServer(path)
    await assert.rejects(link.request("thread/read", {}), error => error.code === "APP_SERVER_ERROR" && error.rpc === -32600 && !/secret/.test(error.message))
    link.close()
  })
})

test("a request that gets no answer times out as sent", async () => {
  await withServer(() => undefined, async path => {
    const link = await openAppServer(path)
    await assert.rejects(link.request("thread/read", {}, 50), error => error.code === "APP_SERVER_TIMEOUT" && error.sent === true)
    link.close()
  })
})

// ---- child refusal ---------------------------------------------------------------------------------------------

test("a thread is a child when it has a parent, a role, is ephemeral, or comes from exec or a sub-agent", () => {
  assert.equal(isChildThread(thread()), false)
  assert.equal(isChildThread(thread({ source: "vscode" })), false)
  assert.equal(isChildThread(thread({ source: { custom: "x" } })), false)
  for (const extra of [
    { parentThreadId: "p" }, { agentRole: "worker" }, { ephemeral: true }, { source: "exec" },
    { source: { subAgent: "review" } }, { source: { subagent: { thread_spawn: {} } } },
  ]) assert.equal(isChildThread(thread(extra)), true, JSON.stringify(extra))
})

// ---- bind and probe --------------------------------------------------------------------------------------------

test("bind finds the thread, fixes the provider, and probes the queue with an id nobody queued", async () => {
  await withServer(main(), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    assert.equal(bound.provider, "openai")
    assert.deepEqual(server.methods(), ["initialize", "thread/loaded/list", "thread/read", "thread/queue/delete"])
    const probe = server.log.at(-1).params
    assert.equal(probe.threadId, THREAD)
    assert.match(probe.queuedSubmissionId, /^[0-9a-f-]{36}$/)
  })
})

test("bind refuses a thread that is not loaded, and reads nothing else", async () => {
  await withServer(main({ "thread/loaded/list": () => ok({ data: ["other"], nextCursor: null }) }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unloaded" })
    assert.deepEqual(server.methods(), ["initialize", "thread/loaded/list"])
  })
})

test("bind follows the loaded-list cursor", async () => {
  await withServer(main({
    "thread/loaded/list": message => (message.params.cursor ? ok({ data: [THREAD], nextCursor: null }) : ok({ data: ["a"], nextCursor: "c1" })),
  }), async path => {
    assert.equal((await createThread({ path, threadId: THREAD }).bind()).status, "bound")
  })
})

test("bind refuses every child record and asks nothing past the read", async () => {
  for (const extra of [{ parentThreadId: "p" }, { agentRole: "worker" }, { ephemeral: true }, { source: "exec" }, { source: { subAgent: "review" } }]) {
    await withServer(main({ "thread/read": () => ok({ thread: thread(extra) }) }), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "child" }, JSON.stringify(extra))
      assert.deepEqual(server.methods(), ["initialize", "thread/loaded/list", "thread/read"])
    })
  }
})

test("bind refuses a changed provider as stale_binding", async () => {
  let provider = "openai"
  await withServer(main({ "thread/read": () => ok({ thread: thread({ modelProvider: provider }) }) }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.equal((await bound.bind()).status, "bound")
    provider = "other"
    assert.deepEqual(await bound.bind(), { status: "stale_binding" })
    assert.equal(bound.provider, "openai", "the first provider stays fixed")
  })
})

test("a bind with nobody listening is unavailable", async () => {
  const gone = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.deepEqual(await gone.bind(), { status: "unavailable" })
  assert.equal(gone.provider, null)
})

test("any probe answer but the documented one turns the route off", async () => {
  for (const answer of [
    () => ({ error: { code: -32601, message: "method not found" } }),
    () => ({ error: { code: -32600, message: "invalid" } }),
    () => ok({ deleted: true }), // never observed live
    () => ok({}),
    () => ok({ deleted: "no" }),
  ]) {
    await withServer(main({ "thread/queue/delete": answer }), async path => {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "bound" })
      assert.equal(bound.route, false)
    })
  }
})

test("a probe that cannot be completed leaves the route undecided: the read still found a main thread, as `unprobed`", async () => {
  await withServer(main({ "thread/queue/delete": (_message, { socket }) => { socket.destroy() } }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unprobed" })
    assert.equal(bound.route, null, "a transport failure is not an answer: the probe runs again at the next bind")
  })
  const gone = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.deepEqual(await gone.bind(), { status: "unavailable" })
  assert.equal(gone.route, null)
})

test("a probe that does not answer is `unprobed` within a second, so it cannot use up the bind's time", async () => {
  await withServer(main({ "thread/queue/delete": () => undefined }), async path => {
    const started = Date.now()
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unprobed" })
    assert.ok(Date.now() - started < 2000, "the whole bind stays well inside the receiver's 3 seconds")
    assert.equal(bound.route, null)
  })
})

test("the provider is recorded only for a loaded thread that is not a child", async () => {
  const cases = [
    ["not loaded", main({ "thread/loaded/list": () => ok({ data: ["other"], nextCursor: null }) })],
    ["a child", main({ "thread/read": () => ok({ thread: thread({ parentThreadId: "p" }) }) })],
    ["no provider", main({ "thread/read": () => ok({ thread: thread({ modelProvider: "" }) }) })],
    ["an unreadable thread", main({ "thread/read": () => ({ error: { code: -32600, message: "x" } }) })],
    ["an incomplete record", main({ "thread/read": () => ok({ thread: { id: THREAD, modelProvider: "openai" } }) })],
  ]
  for (const [label, handler] of cases) {
    await withServer(handler, async path => {
      const bound = createThread({ path, threadId: THREAD })
      await bound.bind()
      assert.equal(bound.provider, null, label)
    })
  }
})

test("a bind whose probe fails still fixes the provider: the read found a main thread", async () => {
  await withServer(main({ "thread/queue/delete": (_message, { socket }) => { socket.destroy() } }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unprobed" })
    assert.equal(bound.provider, "openai")
    assert.equal(bound.route, null)
  })
})

// A thread that the read does not show as a main one is never probed: the probe is the last step of a bind that found one.
test("a bind probes the queue only after it read a main thread: not for an unloaded, notLoaded, child or incomplete record", async () => {
  for (const [label, over] of [
    ["not loaded", { "thread/loaded/list": () => ok({ data: [], nextCursor: null }) }],
    ["notLoaded", { "thread/read": () => ok({ thread: thread({ status: { type: "notLoaded" } }) }) }],
    ["a child", { "thread/read": () => ok({ thread: thread({ parentThreadId: "p" }) }) }],
    ["no origin", { "thread/read": () => ok({ thread: without("source") }) }],
    ["no provider", { "thread/read": () => ok({ thread: without("modelProvider") }) }],
  ]) {
    await withServer(main(over), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      assert.notEqual((await bound.bind()).status, "bound", label)
      assert.equal(server.methods().includes("thread/queue/delete"), false, `${label}: no probe`)
      assert.equal(bound.route, null, label)
    })
  }
})

// The receiver joins on the answer of one bind alone: a main thread is only ever `bound` or `stale_binding`.
test("a record with no origin or no ephemeral flag is not a main thread, though it is no child either", async () => {
  const complete = thread()
  for (const record of [
    { id: THREAD, modelProvider: "openai" },
    { id: THREAD, modelProvider: "openai", source: "cli" },
    { id: THREAD, modelProvider: "openai", ephemeral: false },
    { ...complete, source: null },
    { ...complete, source: undefined },
    { ...complete, ephemeral: "false" },
  ]) {
    assert.equal(isChildThread(record), false, JSON.stringify(record))
    await withServer(main({ "thread/read": () => ok({ thread: record }) }), async path => {
      assert.deepEqual(await createThread({ path, threadId: THREAD }).bind(), { status: "unavailable" }, JSON.stringify(record))
    })
  }
  await withServer(main({ "thread/read": () => ok({ thread: { ...complete, source: { custom: "x" } } }) }), async path => {
    assert.equal((await createThread({ path, threadId: THREAD }).bind()).status, "bound", "an object origin is complete")
  })
})

test("nothing from an earlier bind verifies a later one: a thread that is no longer loaded is `unloaded` again", async () => {
  let listed = [THREAD]
  await withServer(main({ "thread/loaded/list": () => ok({ data: listed, nextCursor: null }) }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.equal((await bound.bind()).status, "bound")
    listed = []
    assert.deepEqual(await bound.bind(), { status: "unloaded" })
  })
})

// ---- the two deadlines of a bind and the call's own token ------------------------------------------------------
// The caller's time is for the thread read: `onRead` says it is over, and the queue probe then has PROBE_MS of its own.
// `signal` is the call's token: once aborted, nothing the call reads afterwards is recorded. `owns` is the same for a caller
// that stopped being the owner of the answer.

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check, what) {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await pause(5)
  assert.ok(check(), `${what} never happened`)
}

test("a bind that the caller timed out while it was reading records nothing", async () => {
  await withServer(main({
    "thread/read": async () => { await pause(300); return ok({ thread: thread() }) },
  }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    const attempt = new AbortController()
    const first = bound.bind({ signal: attempt.signal })
    await eventually(() => server.methods().includes("thread/read"), "the read request")
    attempt.abort() // the caller's time ran out while the read was out
    assert.deepEqual(await first, { status: "unavailable" })
    assert.equal(bound.provider, null, "a late read does not fix the provider")
    assert.deepEqual(await bound.bind(), { status: "bound" }, "the next bind starts from nothing")
  })
})

// A thread can leave the loaded list between the list request and the read. observe() already reads that as offline.
test("a thread that is listed but reads as notLoaded is unloaded: nothing is recorded, and a child is still a child", async () => {
  await withServer(main({ "thread/read": () => ok({ thread: thread({ status: { type: "notLoaded" } }) }) }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unloaded" })
    assert.equal(bound.provider, null)
  })
  await withServer(main({ "thread/read": () => ok({ thread: thread({ parentThreadId: "p", status: { type: "notLoaded" } }) }) }), async path => {
    assert.deepEqual(await createThread({ path, threadId: THREAD }).bind(), { status: "child" })
  })
})

// `owns` is the caller's other way to stop owning an answer: the worker it binds for was retired. It is asked at the same check as
// the signal, and what the call read is committed in that same turn.
test("a bind whose owner is gone while its read is out records no provider: the next owner binds against nothing the first one left", async () => {
  let reads = 0
  await withServer(main({
    "thread/read": async () => { const modelProvider = ++reads === 1 ? "openai" : "other"; await pause(300); return ok({ thread: thread({ modelProvider }) }) },
  }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    let owner = true
    const first = bound.bind({ owns: () => owner })
    await eventually(() => server.methods().includes("thread/read"), "the read request")
    owner = false
    assert.deepEqual(await first, { status: "unavailable" })
    assert.equal(bound.provider, null)
    assert.deepEqual(await bound.bind({ owns: () => true }), { status: "bound" }, "not stale against a provider nobody committed")
    assert.equal(bound.provider, "other")
  })
})

test("the read is reported done before the probe starts, and the probe runs on its own limit, not on what the read left", async () => {
  const events = []
  await withServer(main({
    "thread/read": async () => { await pause(1200); events.push("read"); return ok({ thread: thread() }) },
    "thread/queue/delete": () => { events.push("probe") }, // silent
  }), async path => {
    const started = Date.now()
    const bound = createThread({ path, threadId: THREAD })
    let readAt = null
    const result = await bound.bind({ onRead: () => { readAt = Date.now() - started; events.push("onRead") } })
    const finished = Date.now() - started
    assert.deepEqual(result, { status: "unprobed" })
    assert.deepEqual(events, ["read", "onRead", "probe"])
    assert.ok(readAt >= 1100, "the read took 1.2 seconds")
    assert.ok(finished - readAt >= 900 && finished - readAt < 2000, `the probe had about its own second after the read: ${finished - readAt} ms`)
    assert.equal(bound.provider, "openai")
    assert.equal(bound.route, null)
  })
})

test("a bind that the caller timed out while it was probing cannot record a late negative answer: the next bind probes again", async () => {
  let probes = 0
  await withServer(main({
    "thread/queue/delete": async () => { probes += 1; await pause(300); return probes === 1 ? ok({ deleted: true }) : ok({ deleted: false }) }, // deleted:true: never observed live
  }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    const attempt = new AbortController()
    const first = bound.bind({ signal: attempt.signal })
    await eventually(() => probes === 1, "the first probe request")
    attempt.abort() // the caller stopped waiting; the answer is still on its way, and it is not the documented one
    assert.deepEqual(await first, { status: "unavailable" })
    assert.equal(bound.route, null, "a late negative answer is not recorded as the route")
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    assert.equal(probes, 2, "the later bind probed instead of trusting the expired one")
  })
})

// A thread can leave the loaded list between the list request and the read. observe() already reads that as offline.
// What a call reads is committed once, at the end, after the last look at its signal.
for (const [label, probe] of [
  ["answers the documented way", async () => { await pause(300); return ok({ deleted: false }) }],
  ["fails", async (_message, { socket }) => { await pause(300); socket.destroy() }],
]) {
  test(`a bind that the caller timed out while its probe ${label} records neither the provider nor the route`, async () => {
    let reads = 0
    let probes = 0
    await withServer(main({
      "thread/read": () => ok({ thread: thread({ modelProvider: ++reads === 1 ? "openai" : "other" }) }),
      "thread/queue/delete": (message, connection) => (++probes === 1 ? probe(message, connection) : ok({ deleted: false })),
    }), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      const attempt = new AbortController()
      let reported = 0
      const first = bound.bind({ signal: attempt.signal, onRead: () => { reported += 1 } })
      await eventually(() => server.methods().includes("thread/queue/delete"), "the probe request")
      attempt.abort()
      assert.deepEqual(await first, { status: "unavailable" })
      assert.equal(reported, 1, "the read was reported done before the probe, as always")
      assert.equal(bound.provider, null, "the aborted call fixed no provider")
      assert.equal(bound.route, null)
      assert.deepEqual(await bound.bind(), { status: "bound" }, "so the next bind is not stale against a provider nobody committed")
      assert.equal(bound.route, true)
      assert.equal(bound.provider, "other")
    })
  })
}

// `owns` is the caller's other way to stop owning an answer: the worker it binds for was retired. It is asked at the same
// checks as the signal, and the last one is the commit's own turn.
for (const [label, probe] of [
  ["answers the documented way", async () => { await pause(300); return ok({ deleted: false }) }],
  ["answers with something else", async () => { await pause(300); return ok({ deleted: true }) }], // never observed live
]) {
  test(`a bind whose owner is gone when its probe ${label} records neither the provider nor the route`, async () => {
    let reads = 0
    let probes = 0
    await withServer(main({
      "thread/read": () => ok({ thread: thread({ modelProvider: ++reads === 1 ? "openai" : "other" }) }),
      "thread/queue/delete": (message, connection) => (++probes === 1 ? probe(message, connection) : ok({ deleted: false })),
    }), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      let owner = true
      const first = bound.bind({ owns: () => owner })
      await eventually(() => server.methods().includes("thread/queue/delete"), "the probe request")
      owner = false
      assert.deepEqual(await first, { status: "unavailable" })
      assert.equal(bound.provider, null)
      assert.equal(bound.route, null)
      assert.deepEqual(await bound.bind({ owns: () => true }), { status: "bound" }, "the next owner binds against nothing the first one left")
      assert.equal(bound.route, true)
      assert.equal(bound.provider, "other")
    })
  })
}

test("a bind whose owner is gone when its read comes back records nothing and says unavailable", async () => {
  await withServer(main(), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind({ owns: () => false }), { status: "unavailable" })
    assert.equal(bound.provider, null)
    assert.deepEqual(await bound.bind({ owns: () => true }), { status: "bound" })
  })
})

// ---- observe ---------------------------------------------------------------------------------------------------

async function observeWith(over) {
  return withServer(main(over), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    await bound.bind()
    server.log.length = 0
    const result = await bound.observe()
    return { result, methods: server.methods(), server }
  })
}

test("an idle default-mode thread is clear, and the Plan Mode read closes its connection", async () => {
  const { result, methods, server } = await observeWith({})
  assert.deepEqual(result, { reason: null, observed: { status: "idle", stopped: false, plan: false } })
  assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/resume", "thread/turns/list"])
  assert.deepEqual(server.log.find(entry => entry.method === "thread/resume").params, { threadId: THREAD, excludeTurns: true })
  assert.deepEqual(server.log.find(entry => entry.method === "thread/turns/list").params, { threadId: THREAD, limit: 1, sortDirection: "desc" })
  for (let waited = 0; server.state.open && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(server.state.open, 0, "no connection outlives the read that subscribed it")
})

test("not loaded is offline, active is busy, and neither reads further", async () => {
  const gone = await observeWith({ "thread/loaded/list": () => ok({ data: [], nextCursor: null }) })
  assert.equal(gone.result.reason, "offline")
  assert.deepEqual(gone.methods, ["initialize", "thread/loaded/list"])
  const notLoaded = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type: "notLoaded" } }) }) })
  assert.equal(notLoaded.result.reason, "offline")
  const active = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type: "active", activeFlags: [] } }) }) })
  assert.deepEqual(active.result, { reason: "busy", observed: { status: "busy", stopped: false, plan: null } })
  assert.equal(active.methods.includes("thread/resume"), false)
  assert.equal(active.methods.includes("thread/turns/list"), false)
  const broken = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type: "systemError" } }) }) })
  assert.equal(broken.result.reason, "unknown")
})

test("a newest turn that was interrupted is stopped, and it is read last, after the resume answer", async () => {
  const { result, methods } = await observeWith({ "thread/turns/list": () => ok({ data: [{ id: "t1", status: "interrupted" }], nextCursor: null }) })
  assert.deepEqual(result, { reason: "stopped", observed: { status: "idle", stopped: true, plan: false } })
  assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/resume", "thread/turns/list"])
})

test("a collaboration mode other than default is plan, and an unreadable one is unknown", async () => {
  const plan = await observeWith({ "thread/resume": () => ok({ thread: thread(), collaborationMode: { mode: "plan", settings: {} } }) })
  assert.deepEqual(plan.result, { reason: "plan", observed: { status: "idle", stopped: false, plan: true } })
  for (const answer of [
    () => ok({ thread: thread(), collaborationMode: null }),
    () => ok({ thread: thread() }),
    () => ok({ thread: thread(), collaborationMode: { mode: "future-mode" } }),
    () => ({ error: { code: -32600, message: "no rollout found" } }),
  ]) {
    const unreadable = await observeWith({ "thread/resume": answer })
    assert.deepEqual(unreadable.result, { reason: "unknown", observed: { status: "idle", stopped: false, plan: null } })
  }
})

// The resume answer is a record of its own: it must be complete (id, status, origin, ephemeral flag and model provider) and
// agree with the read and the bound provider, or it says nothing about the thread, the mode included. It ends the reading
// when it refuses. A usable record whose status is not idle still gives its mode: the mode and the status are two answers.
const resumeWith = (body, mode = { mode: "default", settings: {} }) => ({ "thread/resume": () => ok({ ...body, collaborationMode: mode }) })
const without = key => { const record = thread(); delete record[key]; return record }
for (const [label, over, reason, status, plan = null] of [
  ["shows the thread active", resumeWith({ thread: thread({ status: { type: "active", activeFlags: [] } }) }), "busy", "busy", false],
  ["shows the thread active in Plan Mode", resumeWith({ thread: thread({ status: { type: "active", activeFlags: [] } }) }, { mode: "plan", settings: {} }), "busy", "busy", true],
  ["has no thread record", resumeWith({}), "unknown", "idle"],
  ["is another thread's record", resumeWith({ thread: thread({ id: "thread-2" }) }), "unknown", "idle"],
  ["has a record without a status", resumeWith({ thread: { id: THREAD } }), "unknown", "idle"],
  ["lacks the origin (source)", resumeWith({ thread: without("source") }), "unknown", "idle"],
  ["has an empty origin", resumeWith({ thread: thread({ source: "" }) }), "unknown", "idle"],
  ["has an origin that is an array", resumeWith({ thread: thread({ source: ["cli"] }) }), "unknown", "idle"],
  ["has an origin that is not a string or an object", resumeWith({ thread: thread({ source: 7 }) }), "unknown", "idle"],
  ["lacks the ephemeral flag", resumeWith({ thread: without("ephemeral") }), "unknown", "idle"],
  ["lacks the model provider", resumeWith({ thread: without("modelProvider") }), "unknown", "idle"],
  ["has an empty model provider", resumeWith({ thread: thread({ modelProvider: "" }) }), "unknown", "idle"],
  ["shows a status the read did not", resumeWith({ thread: thread({ status: { type: "systemError" } }) }), "unknown", "unknown", false],
  ["shows another provider than the bound one", resumeWith({ thread: thread({ modelProvider: "other" }) }), "stale_binding", "idle"],
  ["shows a child", resumeWith({ thread: thread({ parentThreadId: "p" }) }), "child", "idle"],
]) {
  test(`a read whose resume answer ${label} refuses with ${reason}, and reads no turn`, async () => {
    const { result, methods } = await observeWith(over)
    assert.deepEqual(result, { reason, observed: { status, stopped: false, plan } })
    assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/resume"], "the resume answer ends the reading")
  })
}

// The mode that the resume answer confirmed stays the answer for Plan Mode whatever the newest turn says, and the newest turn
// stays the answer for the running state whatever the mode: a turn that failed, or no turn, is an unknown state, not idle.
for (const [mode, plan] of [["default", false], ["plan", true]]) {
  for (const [label, data, reason, status, stopped = false] of [
    ["completed", [{ id: "t1", status: "completed" }], plan ? "plan" : null, "idle"],
    ["failed", [{ id: "t1", status: "failed" }], "unknown", "unknown"],
    ["absent", [], "unknown", "unknown"],
    ["interrupted", [{ id: "t1", status: "interrupted" }], "stopped", "idle", true],
    ["running", [{ id: "t1", status: "inProgress" }], "busy", "busy"],
  ]) {
    test(`a ${mode}-mode thread whose newest turn is ${label} reads as ${status} with plan ${plan}: the mode and the running state are two answers`, async () => {
      const { result, methods } = await observeWith({
        ...resumeWith({ thread: thread() }, { mode, settings: {} }),
        "thread/turns/list": () => ok({ data, nextCursor: null }),
      })
      assert.deepEqual(result, { reason, observed: { status, stopped, plan } })
      assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/resume", "thread/turns/list"])
    })
  }
}

// The interruption is the one change that the status cannot show: the thread is idle after it too. So the newest turn is read
// last, and an interruption that lands after the status read is seen.
test("an interruption that lands after the status read is seen: the newest turn is read last", async () => {
  let interrupted = false
  const { result, methods } = await observeWith({
    "thread/read": () => { interrupted = true; return ok({ thread: thread() }) },
    "thread/turns/list": () => ok({ data: [{ id: "t1", status: interrupted ? "interrupted" : "completed" }], nextCursor: null }),
  })
  assert.equal(result.reason, "stopped")
  assert.equal(methods.at(-1), "thread/turns/list")
})

// Only a newest turn that is known to be finished clears the thread, and the one finished status that the plugin knows is
// `completed`. A running turn is busy, an interrupted one is stopped, and anything else says nothing about the thread: no
// turn, a turn without a status, a status that is not a string or is not known (a failed turn included, which the
// plugin has not confirmed as a finished status). An unknown state is not idle.
const NEWEST = [
  ["a turn that is still running", [{ id: "t1", status: "inProgress" }], "busy", "busy"],
  ["a status that is not known", [{ id: "t1", status: "paused" }], "unknown", "unknown"],
  ["a failed turn, which is not on the list of finished statuses", [{ id: "t1", status: "failed" }], "unknown", "unknown"],
  ["a turn without a status", [{}], "unknown", "unknown"],
  ["a status that is not a string", [{ id: "t1", status: 7 }], "unknown", "unknown"],
  ["a turn that is null", [null], "unknown", "unknown"],
  ["no turn at all", [], "unknown", "unknown"],
]
for (const [label, data, reason, status] of NEWEST) {
  test(`a read of a thread whose newest turn is ${label} refuses with ${reason}`, async () => {
    const { result } = await observeWith({ "thread/turns/list": () => ok({ data, nextCursor: null }) })
    assert.deepEqual(result, { reason, observed: { status, stopped: false, plan: false } })
  })
}

// The newest turn is asked for only once the resume confirmed the mode. A lookup that fails, or answers in a way that is not
// the documented one, keeps that mode: the running state is unknown, and the read is not offline.
test("a lookup of the newest turn that fails or is malformed keeps the confirmed mode, and the running state is unknown", async () => {
  for (const [label, answer] of [
    ["an error reply", () => ({ error: { code: -32000, message: "no" } })],
    ["data that is not a list", () => ok({ data: "none", nextCursor: null })],
    ["no data", () => ok({})],
    ["a connection that drops", (message, connection) => { connection.socket.destroy(); return undefined }],
  ]) {
    for (const plan of [false, true]) {
      const { result, methods } = await observeWith({
        ...resumeWith({ thread: thread() }, { mode: plan ? "plan" : "default", settings: {} }),
        "thread/turns/list": answer,
      })
      assert.deepEqual(result, { reason: "unknown", observed: { status: "unknown", stopped: false, plan } }, `${label}, plan ${plan}`)
      assert.equal(methods.at(-1), "thread/turns/list", label)
    }
  }
})

// A status is looked up in a table, and a name that Object.prototype has (`constructor`, `toString`) is not a status: it is
// unknown, a string, like any other that the table lacks.
test("a thread status that is a property name of every object is unknown, not a value from the prototype", async () => {
  for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const viaRead = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type } }) }) })
    assert.deepEqual(viaRead.result, { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } }, `read: ${type}`)
    const viaResume = await observeWith({ "thread/resume": () => ok({ thread: thread({ status: { type } }), collaborationMode: { mode: "default", settings: {} } }) })
    assert.deepEqual(viaResume.result, { reason: "unknown", observed: { status: "unknown", stopped: false, plan: false } }, `resume: ${type}`)
    const woken = await wakeWith({ "thread/read": () => ok({ thread: thread({ status: { type } }) }) })
    assert.deepEqual(woken.result, { outcome: "deferred", reason: "unknown" }, `wake: ${type}`)
    assert.equal(woken.methods.includes("thread/queue/add"), false)
  }
})

// A table is indexed with a string, and an array coerces to the string of its elements: a status type of `["idle"]` would index
// the table as `idle` and read as clear (`["active"]` would read as busy, `["notLoaded"]` as offline). A type that is not a string
// is no status. It is unknown, like a name that the table lacks.
for (const [label, type] of [
  ["an array of the idle status name", ["idle"]], ["an array of the active status name", ["active"]],
  ["an array of the notLoaded status name", ["notLoaded"]], ["a nested array of a status name", [["idle"]]],
  ["a number", 7], ["an object", {}], ["an object with a status name as a key", { idle: true }], ["null", null], ["a boolean", true],
]) {
  test(`a thread status type that is ${label} is unknown: a read refuses`, async () => {
    const seen = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type } }) }) })
    assert.deepEqual(seen.result, { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } })
    assert.equal(seen.methods.includes("thread/resume"), false, "nothing is read past the status")
    assert.equal(seen.methods.includes("thread/turns/list"), false, "nothing is read past the status")
  })
}

test("a resume answer whose status type is not a string is unknown too, whatever it would print as", async () => {
  for (const type of [["idle"], ["active"], 7, {}]) {
    const resume = { "thread/resume": () => ok({ thread: thread({ status: { type } }), collaborationMode: { mode: "default", settings: {} } }) }
    assert.equal((await observeWith(resume)).result.reason, "unknown", `read: ${JSON.stringify(type)}`)
  }
})

test("a child or a changed provider found by a later read is refused by name", async () => {
  let record = thread()
  await withServer(main({ "thread/read": () => ok({ thread: record }) }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    await bound.bind()
    record = thread({ modelProvider: "other" })
    assert.equal((await bound.observe()).reason, "stale_binding")
    record = thread({ parentThreadId: "p" })
    assert.equal((await bound.observe()).reason, "child")
  })
})

// Only a provider that a record names shows a change. After a bind that fixed the provider, a read record with no provider,
// an empty one or one that is not a string is no stale binding. It is an incomplete record, though: an idle read of it says
// nothing about the thread, so the read ends there as unknown and the resume is not asked. A complete read record with such
// a resume record is unknown too.
test("a read record whose provider is missing or invalid is no provider change", async () => {
  for (const modelProvider of [undefined, "", 7, null]) {
    const weak = thread()
    if (modelProvider === undefined) delete weak.modelProvider
    else weak.modelProvider = modelProvider
    let record = thread()
    let resumed = thread()
    await withServer(main({
      "thread/read": () => ok({ thread: record }),
      "thread/resume": () => ok({ thread: resumed, collaborationMode: { mode: "default", settings: {} } }),
    }), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "bound" })
      record = weak
      server.log.length = 0
      assert.deepEqual(await bound.observe(), { reason: "unknown", observed: { status: "idle", stopped: false, plan: null } }, String(modelProvider))
      assert.deepEqual(server.methods(), ["initialize", "thread/loaded/list", "thread/read"], `the read ends at the incomplete record: ${String(modelProvider)}`)
      record = thread()
      resumed = weak
      assert.equal((await bound.observe()).reason, "unknown", `an incomplete resume record too: ${String(modelProvider)}`)
    })
  }
})

test("a server that cannot be reached, or that sends a malformed answer, is offline", async () => {
  const gone = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.equal((await gone.observe()).reason, "offline")
  const { result } = await observeWith({ "thread/loaded/list": () => ok({ data: "x" }) })
  assert.equal(result.reason, "offline")
})

// A confirmation page that shows this attempt's userMessage, as codex-cli 0.171.0 lists it.
const confirmedItems = { "thread/items/list": () => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-9" } }], nextCursor: null }) }

// The newest turn is looked up after the mode. A lookup that fails, or answers in a way that is not the documented one, reads
// the running state as unknown, so the wake is refused as unknown and nothing is queued.
test("a lookup of the newest turn that fails or is malformed refuses the wake and adds nothing", async () => {
  for (const [label, answer] of [
    ["an error reply", () => ({ error: { code: -32000, message: "no" } })],
    ["data that is not a list", () => ok({ data: "none", nextCursor: null })],
    ["no data", () => ok({})],
    ["a connection that drops", (message, connection) => { connection.socket.destroy(); return undefined }],
  ]) {
    const { result: woken, methods } = await wakeWith({ "thread/turns/list": answer })
    assert.deepEqual(woken, { outcome: "deferred", reason: "unknown" }, `${label}: the wake is refused and adds nothing`)
    assert.equal(methods.includes("thread/queue/add"), false, label)
    assert.equal(methods.at(-1), "thread/turns/list", `${label}: the lookup was the last request`)
  }
})
// ---- wake ------------------------------------------------------------------------------------------------------

function clock(start = 1_000_000) {
  const time = { now: start }
  return { time, now: () => time.now, sleep: async ms => { time.now += ms } }
}
// What a wake reads before it adds: the thread as it is now, the interruption check last. It reads on a connection of its own, so the
// log shows two `initialize` frames: the connection that will carry the add, opened first, and the one for the reading.
const READS = ["thread/loaded/list", "thread/read", "thread/resume", "thread/turns/list"]
const OPENS = ["initialize", "initialize"]
// The queue as codex-cli 0.171.0 answered it live: the add reply echoes `clientUserMessageId` inside `queuedSubmission`, a
// delete of any id that is not queued (the bind's probe, and the fence once the turn has left the queue) answers
// { deleted: false }, and a dispatched item shows in thread/items/list as { turnId, item } with the client id as `item.clientId`.
const queueServer = (over = {}) => main({
  "thread/queue/add": message => ok({ queuedSubmission: { id: "q1", input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } }),
  "thread/queue/delete": () => ok({ deleted: false }),
  "thread/items/list": () => ok({ data: [], nextCursor: null }),
  ...over,
})
// The receiver wakes only a thread whose bind probed this socket, and a wake probes any socket the bind did not. So a wake
// test binds first, against a thread that is healthy, and only then arms `over`: the bind's probe is not what a test replaces.
function armed(over) {
  const healthy = queueServer()
  const changed = queueServer(over)
  let on = false
  return { handler: (message, connection) => (on ? changed : healthy)(message, connection), arm: () => { on = true } }
}
async function wakeWith(over, { reservation = 5000, text = "queued text", proceed } = {}) {
  const gate = armed(over)
  return withServer(gate.handler, async (path, server) => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
    await bound.bind()
    gate.arm()
    server.log.length = 0
    const result = await bound.wake({ text, attemptId: "attempt-9", until: ticks.now() + reservation, ...(proceed ? { proceed } : {}) })
    return { result, log: server.log, methods: server.methods(), ticks, server }
  })
}

test("a path check that stalls past the settlement cutoff sends no add: the time is read after the check", async () => {
  const gate = armed({})
  await withServer(gate.handler, async (path, server) => {
    const ticks = clock()
    let stalled = false
    const lstat = name => { // once the reading is over, the next look at the path takes the whole reservation
      if (!stalled && server.log.some(entry => entry.method === "thread/turns/list")) { stalled = true; ticks.time.now += 10_000 }
      return lstatSync(name)
    }
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep, open: (name, options) => openAppServer(name, { ...options, lstat }) })
    await bound.bind()
    gate.arm()
    server.log.length = 0
    const result = await bound.wake({ text: "queued text", attemptId: "attempt-9", until: ticks.now() + 5000 })
    assert.equal(stalled, true)
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
    assert.equal(server.methods().includes("thread/queue/add"), false)
  })
})

test("the add carries the client id and the text, then the fence deletes by the submission id", async () => {
  const seen = []
  const { log, methods } = await wakeWith({
    "thread/items/list": message => {
      seen.push(message.params)
      return ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i1", clientId: `${CLIENT_ID_PREFIX}attempt-9`, content: [] } }], nextCursor: null })
    },
  })
  assert.deepEqual(methods, [...OPENS, ...READS, "thread/queue/add", "thread/queue/delete", "thread/items/list"])
  const add = log.find(entry => entry.method === "thread/queue/add").params
  assert.deepEqual(add, { threadId: THREAD, clientUserMessageId: "agent-chat:attempt-9", input: [{ type: "text", text: "queued text", text_elements: [] }] })
  assert.deepEqual(log.find(entry => entry.method === "thread/queue/delete").params, { threadId: THREAD, queuedSubmissionId: "q1" })
  assert.deepEqual(seen[0], { threadId: THREAD, limit: 20, sortDirection: "desc" }, "the newest page: an old item order would miss the queued turn on a long thread")
})

// `thread/resume` subscribes the connection that asks, and the connection that carries the add, the fence and the
// confirmation must not be one that the thread's events are pushed to. So the reading is taken on a second connection that
// is closed before the add goes out, and the connection for the add is opened first, so no connect sits between the last answer and the add.
test("the reading before the add is taken on a connection of its own, closed before the add goes out on the first", async () => {
  const events = []
  let opened = 0
  const traced = async (target, options) => {
    const link = await openAppServer(target, options)
    const number = opened++
    events.push(`open ${number}`)
    return { identity: link.identity, same: link.same, request: (method, ...rest) => { events.push(`${number} ${method}`); return link.request(method, ...rest) }, close: () => { events.push(`close ${number}`); link.close() } }
  }
  const handler = queueServer({
    "thread/items/list": message => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i1", clientId: `${CLIENT_ID_PREFIX}attempt-9`, content: [] } }], nextCursor: null }),
  })
  await withServer(handler, async (path, server) => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, open: traced, now: ticks.now, sleep: ticks.sleep })
    const result = await bound.wake({ text: "queued text", attemptId: "attempt-9", until: ticks.now() + 5000 })
    assert.deepEqual(result, { outcome: "handed", reason: null })
    assert.deepEqual(events, [
      "open 0", "0 thread/queue/delete", "open 1", ...READS.map(method => `1 ${method}`), "close 1",
      "0 thread/queue/add", "0 thread/queue/delete", "0 thread/items/list", "close 0",
    ])
    await eventually(() => server.state.open === 0, "both connections to close")
    assert.equal(server.state.connections, 2, "the reading and the add each had one")
  })
})

// deleted:true was never observed live: the one run answered the fence { deleted: false } before the turn dispatched.
test("deleted:true means it never dispatched: deferred, and no confirmation is asked for", async () => {
  const { result, methods } = await wakeWith({ "thread/queue/delete": () => ok({ deleted: true }) })
  assert.deepEqual(result, { outcome: "deferred", reason: "busy" })
  assert.equal(methods.includes("thread/items/list"), false)
})

// A fence reply that is read as `deleted: true` is the one thing that settles a wake `deferred`, so a frame that must not be read
// can never be allowed to say it: with a reserved bit set, a length spelled in a longer form than it needs, FIN=0, an opcode
// that is not text, or text that is not UTF-8, the connection fails, and a failed fence is uncertain.
test("a fence reply in a frame that is not well formed is not read: the wake is uncertain, never deferred", async () => {
  const fenced = (bit, form = "short") => (message, connection) => {
    connection.socket.write(framed(form, JSON.stringify({ id: message.id, result: { deleted: true } }), bit))
    return undefined
  }
  const fencedWith = build => (message, connection) => {
    connection.socket.write(build(message))
    return undefined
  }
  const deleted = message => JSON.stringify({ id: message.id, result: { deleted: true } })
  const control = await wakeWith({ "thread/queue/delete": fenced(0) }) // deleted:true: never observed live
  assert.deepEqual(control.result, { outcome: "deferred", reason: "busy" }, "control: the same reply, well formed, proves the removal")
  for (const [label, handler] of [
    ["0x40", fenced(0x40)], ["0x20", fenced(0x20)], ["0x10", fenced(0x10)],
    ["a short payload with a 16-bit length", fenced(0, 16)],
    ["a short payload with a 64-bit length", fenced(0, 64)],
    ["FIN=0", fencedWith(message => wire(0x1, deleted(message), { fin: false }))],
    ["a binary frame", fencedWith(message => wire(0x2, deleted(message)))],
    ["text that is not UTF-8", fencedWith(message => wire(0x1, Buffer.concat([
      Buffer.from(`{"id":${message.id},"result":{"deleted":true,"note":"`), Buffer.from([0xff]), Buffer.from('"}}'),
    ])))],
  ]) {
    const { result, methods } = await wakeWith({ "thread/queue/delete": handler })
    assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" }, label)
    assert.equal(methods.filter(method => method === "thread/queue/add").length, 1, "nothing is retried")
  }
})

test("deleted:false with the userMessage in the items is handed", async () => {
  const { result } = await wakeWith({
    "thread/items/list": () => ok({ data: [
      { turnId: "t", item: { type: "agentMessage", id: "a" } },
      { turnId: "t", item: { type: "userMessage", id: "i1", clientId: "agent-chat:attempt-9", content: [] } },
    ], nextCursor: null }),
  })
  assert.deepEqual(result, { outcome: "handed", reason: null })
})

test("deleted:false is confirmed by polling until the item shows up", async () => {
  let polls = 0
  const { result } = await wakeWith({
    "thread/items/list": () => ok({ data: ++polls < 3 ? [] : [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-9" } }], nextCursor: null }),
  })
  assert.equal(polls, 3)
  assert.equal(result.outcome, "handed")
})

test("a userMessage with another client id, or none, is never a confirmation: uncertain once the reservation runs out", async () => {
  let polls = 0
  const { result, methods, ticks } = await wakeWith({
    "thread/items/list": () => { polls += 1; return ok({ data: [
      { turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-8" } },
      { turnId: "t", item: { type: "userMessage", id: "j", clientId: null } },
      { turnId: "t", item: { type: "agentMessage", id: "k", clientId: "agent-chat:attempt-9" } },
    ], nextCursor: null }) },
  })
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.ok(polls > 1)
  assert.equal(methods.filter(method => method === "thread/queue/add").length, 1, "nothing is retried")
  assert.ok(ticks.time.now <= 1_000_000 + 5000, "the loop stops inside the reservation")
})

test("an error after the add frame was written is uncertain, at every step", async () => {
  const uncertain = { outcome: "uncertain", reason: "transport_ambiguous" }
  for (const over of [
    { "thread/queue/add": () => ({ error: { code: -32600, message: "queue full" } }) },
    { "thread/queue/add": () => ok({ queuedSubmission: {} }) },
    { "thread/queue/add": () => ok({}) },
    { "thread/queue/delete": () => ({ error: { code: -32600, message: "x" } }) },
    { "thread/queue/delete": () => ok({}) },
    { "thread/items/list": () => ({ error: { code: -32601, message: "not supported yet" } }) },
  ]) {
    const { result, methods } = await wakeWith(over)
    assert.deepEqual(result, uncertain, JSON.stringify(Object.keys(over)))
    assert.equal(methods.filter(method => method === "thread/queue/add").length, 1)
  }
})

test("an add that gets no answer is uncertain, and is never sent twice", async () => {
  const { result, methods } = await wakeWith({ "thread/queue/add": () => undefined }, { reservation: SETTLE_MS + 700 })
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(methods.filter(method => method === "thread/queue/add").length, 1)
  assert.equal(methods.includes("thread/queue/delete"), false)
})

test("a failure before the add frame is written is failed, and under half a second left after the margin sends nothing", async () => {
  const absent = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.deepEqual(await absent.wake({ text: "t", attemptId: "a", until: monotonic() + 5000 }), { outcome: "failed", reason: "native_unavailable" })
  assert.equal(MIN_ADD_MS, 500)
  const { result, methods } = await wakeWith({}, { reservation: SETTLE_MS + MIN_ADD_MS - 1 })
  assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(methods, ["initialize"], "no add frame")
  const exactly = await wakeWith({}, { reservation: SETTLE_MS + MIN_ADD_MS })
  assert.ok(exactly.methods.includes("thread/queue/add"), "half a second left after the margin is enough")
})

test("the settlement margin comes off the reservation first: with less than the margin and half a second left, nothing is sent", async () => {
  assert.equal(SETTLE_MS, 1000)
  for (const reservation of [MIN_ADD_MS + 200, SETTLE_MS, 0, -1]) {
    const { result, methods } = await wakeWith({}, { reservation })
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" }, `${reservation} ms`)
    assert.equal(methods.includes("thread/queue/add"), false, `${reservation} ms: no add frame`) // a connection that ran out of time never reached initialize
  }
})

test("the add is not sent when the receiver says the state changed: deferred with its reason, no add frame", async () => {
  const asked = []
  const stale = await wakeWith({}, { proceed: fresh => { asked.push(fresh); return "stopped" } })
  assert.deepEqual(stale.result, { outcome: "deferred", reason: "stopped" })
  assert.deepEqual(stale.methods, [...OPENS, ...READS], "the reads, and no add frame")
  assert.deepEqual(asked, [{ reason: null, observed: { status: "idle", stopped: false, plan: false } }], "asked once, with the reading taken on this connection")
  const clear = await wakeWith({}, { proceed: () => null })
  assert.deepEqual(clear.methods.slice(0, 7), [...OPENS, ...READS, "thread/queue/add"])
})

// A reply that comes later than the reservation allows: real time, because the point is where the wake gives up. One
// test per step, so each shows up by name.
const slowReplies = {
  "thread/queue/add": message => ok({ queuedSubmission: { id: "q1", input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } }),
  "thread/queue/delete": () => ok({ deleted: false }),
  "thread/items/list": () => ok({ data: [], nextCursor: null }),
}
for (const slow of Object.keys(slowReplies)) {
  test(`a slow ${slow} reply ends the wake SETTLE_MS before the reservation, so the result can still be recorded`, async () => {
    const gate = armed({ [slow]: async (...args) => { await new Promise(resolve => setTimeout(resolve, 1500)); return slowReplies[slow](...args) } })
    await withServer(gate.handler, async path => {
      const bound = createThread({ path, threadId: THREAD })
      await bound.bind()
      gate.arm()
      const until = monotonic() + SETTLE_MS + 600
      const result = await bound.wake({ text: "t", attemptId: "attempt-9", until })
      const left = until - monotonic()
      assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
      assert.ok(left >= SETTLE_MS / 2, `${left} ms of the reservation were left to settle`)
    })
  })
}

// The reading before the add runs on the same cutoff: each of its requests gets only what is left before it, so a slow read
// ends the wake in time to settle, with nothing sent. One test per read.
for (const slow of READS) {
  test(`a slow ${slow} reply in the reading before the add ends the wake SETTLE_MS before the reservation, with nothing sent`, async () => {
    const answer = queueServer()
    const gate = armed({ [slow]: async (...args) => { await pause(1500); return answer(...args) } })
    await withServer(gate.handler, async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      await bound.bind()
      gate.arm()
      server.log.length = 0
      const until = monotonic() + SETTLE_MS + 600
      const result = await bound.wake({ text: "t", attemptId: "attempt-9", until })
      const left = until - monotonic()
      assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
      assert.ok(server.methods().includes(slow), `the reading got as far as ${slow}`)
      assert.equal(server.methods().includes("thread/queue/add"), false, "no add frame")
      assert.ok(left >= SETTLE_MS / 2, `${left} ms of the reservation were left to settle`)
    })
  })
}

test("the reading's own connection is bounded by the settlement cutoff, as the add connection is", async () => {
  const given = []
  const gate = armed({})
  await withServer(gate.handler, async path => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep, open: (target, options) => { given.push(options); return openAppServer(target, options) } })
    await bound.bind()
    gate.arm()
    given.length = 0
    await bound.wake({ text: "t", attemptId: "attempt-9", until: ticks.now() + SETTLE_MS + 600 })
    assert.equal(given.length, 2, "the add connection and the reading's")
    assert.deepEqual(given.map(options => options.connectMs), [600, 600], "each connect ends by the cutoff")
  })
})

// `sent: false` comes only from a frame that never left: here the add connection is closed in the turn before the add.
test("an add whose frame never left, because its connection closed first, is failed: nothing was sent", async () => {
  let first = null
  const open = async (target, options) => { const link = await openAppServer(target, options); first ??= link; return link }
  await withServer(queueServer(confirmedItems), async (path, server) => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, open, now: ticks.now, sleep: ticks.sleep })
    await bound.bind()
    first = null // the next connection opened is the wake's add connection
    server.log.length = 0
    const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: ticks.now() + 5000, proceed: () => { first.close(); return null } })
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
    assert.deepEqual(server.methods(), [...OPENS, ...READS], "the reads, and no add frame")
  })
})

// Only `deleted: false` lets the confirmation run. Any other fence reply proves neither removal nor dispatch, so the wake is
// uncertain even when the matching userMessage would already show, and no confirmation is asked for.
test("a fence reply that is neither deleted:true nor deleted:false is uncertain, though the userMessage already shows", async () => {
  for (const reply of [{ deleted: null }, {}, { deleted: "false" }, { deleted: 0 }]) {
    const { result, methods } = await wakeWith({ ...confirmedItems, "thread/queue/delete": () => ok(reply) })
    assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" }, JSON.stringify(reply))
    assert.equal(methods.includes("thread/items/list"), false, `${JSON.stringify(reply)}: no confirmation is asked for`)
  }
})

// CONFIRM_MARGIN_MS (300 ms): a confirmation poll starts only with more than that left before the settlement cutoff, so its
// request has time to be answered. The fake clock moves only by the confirm waits (CONFIRM_MS, 250 ms).
test("the confirmation polls until CONFIRM_MARGIN_MS before the settlement cutoff, and starts no poll after that", async () => {
  const ticks = clock()
  const at = []
  const gate = armed({ "thread/items/list": () => { at.push(ticks.now()); return ok({ data: [], nextCursor: null }) } })
  await withServer(gate.handler, async path => {
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
    await bound.bind()
    gate.arm()
    const until = ticks.now() + 5000
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until }), { outcome: "uncertain", reason: "transport_ambiguous" })
    const left = until - SETTLE_MS - at.at(-1)
    assert.ok(at.length > 1)
    assert.ok(left > 300, `the last poll started ${left} ms before the cutoff`)
    assert.ok(left <= 300 + 250, `and no poll that fitted was skipped (${left} ms left)`)
  })
})

// An empty answer that comes in just before `end` leaves no room for another poll: the wake settles at once, not after one
// more CONFIRM_MS wait past its end.
test("an empty confirmation that answers 20 ms before the end returns uncertain by the end, with no wait after it", async () => {
  const ticks = clock()
  let end = null
  const gate = armed({ "thread/items/list": () => { ticks.time.now = end - 20; return ok({ data: [], nextCursor: null }) } })
  await withServer(gate.handler, async (path, server) => {
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
    await bound.bind()
    gate.arm()
    server.log.length = 0
    const until = ticks.now() + 5000
    end = until - SETTLE_MS
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until }), { outcome: "uncertain", reason: "transport_ambiguous" })
    assert.equal(server.methods().filter(method => method === "thread/items/list").length, 1)
    assert.ok(ticks.now() <= end, `returned ${ticks.now() - end} ms after the end`)
  })
})

test("a connection that never finishes ends the wake SETTLE_MS before the reservation too, with nothing sent", async () => {
  await withServer(() => undefined, async (path, server) => {
    const until = monotonic() + SETTLE_MS + 600
    const result = await createThread({ path, threadId: THREAD }).wake({ text: "t", attemptId: "attempt-9", until })
    const left = until - monotonic()
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
    assert.deepEqual(server.methods(), ["initialize"], "nothing past initialize was sent")
    assert.ok(left >= SETTLE_MS / 2, `${left} ms of the reservation were left to settle`)
  }, { initialize: false })
})

test("the wake connection is closed when it is done", async () => {
  const gate = armed({ "thread/queue/delete": () => ok({ deleted: true }) }) // never observed live
  await withServer(gate.handler, async (path, server) => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
    await bound.bind()
    gate.arm()
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "a", until: ticks.now() + 5000 }), { outcome: "deferred", reason: "busy" }, "the wake went as far as the fence")
    for (let waited = 0; server.state.open && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(server.state.open, 0)
  })
})

// The default clock is the monotonic one, because a reservation is a duration: a wall clock that is stepped back (an NTP
// correction, an operator) must not give a wake more time than it has. Here every read of the wall clock steps it back an hour.
test("by default the wake runs on the monotonic clock: a wall clock that steps back is never read, and cannot revive an expired reservation", async t => {
  let wallTime = 1_800_000_000_000
  const wall = t.mock.method(Date, "now", () => (wallTime -= 3_600_000))
  const gate = armed({ "thread/queue/delete": () => ok({ deleted: true }) }) // never observed live
  await withServer(gate.handler, async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    await bound.bind()
    gate.arm()
    server.log.length = 0
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "a", until: monotonic() + 5000 }), { outcome: "deferred", reason: "busy" }, "a live reservation goes as far as the fence")
    server.log.length = 0
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "b", until: monotonic() - 1 }), { outcome: "failed", reason: "native_unavailable" }, "an expired one sends nothing")
    assert.equal(server.methods().includes("thread/queue/add"), false)
  })
  assert.equal(wall.mock.callCount(), 0, "no deadline of the thread was measured on the wall clock")
})

// On Linux performance.now() does not count time spent suspended, while the server's reservation runs on. The wake takes the
// wall-clock end of the reservation too (`wallUntil`) and, right before the add, counts the larger of the two elapsed times.
// Here the clocks move while the reading is out: the last read before the add. Of a 5-second reservation, SETTLE_MS and
// MIN_ADD_MS must be left on both clocks.
for (const [label, monotonicStep, wallStep, sent] of [
  ["a suspend (the wall clock 45 s on, the monotonic clock 1 s) sends no add and settles failed", 1_000, 45_000, false],
  ["a wall clock stepped back an hour does not stop a wake that the monotonic clock allows", 1_000, -3_600_000, true],
  ["a wall clock stepped back an hour does not revive a reservation that the monotonic clock used up", 4_000, -3_600_000, false],
  ["the wall clock keeps the settlement margin: 400 ms left after it sends no add", 1_000, 3_600, false],
  ["a wall clock that moves with the monotonic one leaves the wake as it was", 1_000, 1_000, true],
]) {
  test(`before the add, ${label}`, async () => {
    const gate = armed({
      "thread/items/list": () => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: `${CLIENT_ID_PREFIX}attempt-9` } }], nextCursor: null }),
    })
    const ticks = clock()
    let wallTime = 1_800_000_000_000
    let stepped = false
    let reading = false // the bind's reads are not the wake's
    const handler = (message, connection) => {
      if (reading && !stepped && message.method === "thread/turns/list") { stepped = true; ticks.time.now += monotonicStep; wallTime += wallStep }
      return gate.handler(message, connection)
    }
    await withServer(handler, async (path, server) => {
      const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep, wall: () => wallTime })
      await bound.bind()
      gate.arm()
      reading = true
      server.log.length = 0
      const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: ticks.now() + 5_000, wallUntil: wallTime + 5_000 })
      assert.equal(stepped, true, "the clocks moved during the reading")
      assert.equal(server.methods().includes("thread/queue/add"), sent)
      assert.deepEqual(result, sent ? { outcome: "handed", reason: null } : { outcome: "failed", reason: "native_unavailable" })
    })
  })
}

// After the add check, the requests that follow (the add reply, the fence, the confirmation) end by the tighter of the two
// budgets, derived once at that check. A host that slept 25 s of a 30 s reservation passes the check with about 4 s of
// wall time left after the settlement margin, so the confirmation that never sees its item gives up within that, not
// within the 28 s the monotonic clock would allow. The budget is not read again: a wall clock stepped back an hour during the
// confirmation extends nothing. The control leg, with no suspend, keeps the monotonic budget.
for (const [label, wallStep, budget, stepBack] of [
  ["after a suspend, the confirmation ends by the wall-clock budget derived at the add check", 25_000, 4_000, false],
  ["after a suspend, a wall clock stepped back during the confirmation does not extend its budget", 25_000, 4_000, true],
  ["with no suspend, the confirmation keeps the monotonic budget", 1_000, 28_000, false],
]) {
  test(label, async () => {
    const gate = armed({}) // the fence answers deleted:false and thread/items/list never shows the item
    const ticks = clock()
    let wallTime = 1_800_000_000_000
    let reading = false
    let checkedAt = null
    const handler = (message, connection) => {
      if (reading && checkedAt === null && message.method === "thread/turns/list") { ticks.time.now += 1_000; wallTime += wallStep; checkedAt = ticks.now() }
      if (stepBack && message.method === "thread/items/list") wallTime -= 3_600_000
      return gate.handler(message, connection)
    }
    await withServer(handler, async (path, server) => {
      const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep, wall: () => wallTime })
      await bound.bind()
      gate.arm()
      reading = true
      server.log.length = 0
      const until = ticks.now() + 30_000
      const result = await bound.wake({ text: "t", attemptId: "attempt-9", until, wallUntil: wallTime + 30_000 })
      assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
      assert.ok(server.methods().includes("thread/queue/add"), "the add passed its check")
      const elapsed = ticks.now() - checkedAt
      // The last poll starts within CONFIRM_MARGIN_MS + CONFIRM_MS (550 ms) of the end, and no wait follows it.
      assert.ok(elapsed <= budget && elapsed >= budget - 550, `the confirmation polled for ${elapsed} ms of a ${budget} ms budget`)
    })
  })
}

// The fence deletes only the submission that this attempt queued. codex-cli 0.171.0 echoes `clientUserMessageId` exactly inside
// `queuedSubmission`; a reply that does not tie its submission to this attempt may name another turn, and a delete of it could
// remove that turn. So without the echo the wake is uncertain at once: no delete, no confirmation, and the add is not resent.
for (const [label, echo] of [
  ["echoes another attempt's client id", { clientUserMessageId: `${CLIENT_ID_PREFIX}attempt-8` }],
  ["has no client id", {}],
  ["has a client id that is not a string", { clientUserMessageId: 9 }],
  ["echoes a different id for the same attempt number", { clientUserMessageId: "attempt-9" }],
]) {
  test(`an add reply whose submission ${label} is uncertain, and nothing is deleted or confirmed`, async () => {
    const { result, methods } = await wakeWith({
      "thread/queue/add": message => ok({ queuedSubmission: { id: "q1", input: message.params.input, ...echo } }),
    })
    assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
    assert.deepEqual(methods, [...OPENS, ...READS, "thread/queue/add"], "the add was the last request: no thread/queue/delete, no thread/items/list")
    assert.equal(methods.filter(method => method === "thread/queue/add").length, 1, "one add only")
  })
}

// Live, codex-cli 0.171.0 pushed `thread/status/changed` (active) to the connection that queued the turn 3 ms after it answered
// the fence. A notification is not an answer: the client sends nothing for it, and the wake goes on to the confirmation.
const ACTIVE_NOTICE = { method: "thread/status/changed", params: { threadId: THREAD, status: { type: "active", activeFlags: [] } } }
for (const [label, when] of [
  ["right after the fence reply, as seen live", "after"],
  ["before the fence reply (not observed live)", "before"],
]) {
  test(`a thread/status/changed notification ${label} is ignored: no request for it, and the wake is still handed`, async () => {
    const { result, methods, server } = await wakeWith({
      ...confirmedItems,
      "thread/queue/delete": (_message, { send }) => {
        if (when === "before") send(ACTIVE_NOTICE)
        else setImmediate(() => send(ACTIVE_NOTICE))
        return ok({ deleted: false })
      },
    })
    assert.deepEqual(result, { outcome: "handed", reason: null })
    assert.deepEqual(methods, [...OPENS, ...READS, "thread/queue/add", "thread/queue/delete", "thread/items/list"], "no request was added for the notification")
    assert.deepEqual(server.state.replies, [], "and nothing answered it")
  })
}

// Live, the userMessage item showed on the third poll (+583 ms). Each poll that does not show it waits CONFIRM_MS (250 ms).
test("an item that shows on the third poll is handed after two confirm waits, with three thread/items/list requests", async () => {
  let polls = 0
  const { result, methods, ticks } = await wakeWith({
    "thread/items/list": () => ok({ data: ++polls < 3 ? [] : confirmedItems["thread/items/list"]().result.data, nextCursor: null }),
  })
  assert.deepEqual(result, { outcome: "handed", reason: null })
  assert.equal(methods.filter(method => method === "thread/items/list").length, 3)
  assert.equal(ticks.time.now - 1_000_000, 2 * 250, "two waits of CONFIRM_MS on the virtual clock, and nothing else moved it")
})

// Live, codex-cli 0.171.0 answers thread/items/list with -32601 (not supported yet) on a thread before its first user message.
// A build that answers so on a dispatched wake gives no proof of dispatch: uncertain, never handed, and nothing is sent again.
test("a confirmation that thread/items/list refuses as -32601 is uncertain, never handed, and nothing is resent", async () => {
  const { result, methods } = await wakeWith({ "thread/items/list": () => ({ error: { code: -32601, message: "not supported yet" } }) })
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.deepEqual(methods, [...OPENS, ...READS, "thread/queue/add", "thread/queue/delete", "thread/items/list"])
})

// Before the first user message codex-cli 0.171.0 answers thread/resume and thread/turns/list with -32600 and
// thread/items/list with -32601. Whether loaded/list and read answer on such a thread is not in the probe facts; here they do.
// So that session reads unknown, and a wake is never its first message.
test("a thread before its first user message, as codex-cli answers it, is never woken: deferred unknown, no add", async () => {
  const { result, methods } = await wakeWith({
    "thread/resume": () => ({ error: { code: -32600, message: "no rollout found" } }),
    "thread/turns/list": () => ({ error: { code: -32600, message: "not materialized yet" } }),
    "thread/items/list": () => ({ error: { code: -32601, message: "not supported yet" } }),
  })
  assert.deepEqual(result, { outcome: "deferred", reason: "unknown" })
  assert.deepEqual(methods, [...OPENS, ...READS.slice(0, 3)], "the refused resume ends the reading, and no add frame")
})

// ---- a wake acts on the newest reading of the thread ------------------------------------------------------------

const active = { "thread/read": () => ok({ thread: thread({ status: { type: "active", activeFlags: [] } }) }) }

// The resume answer is a record of its own: it must be complete (id, status, origin, ephemeral flag and model provider),
// show the thread idle in default mode, and agree with the read and the bound provider. It ends the reading when it refuses.
// The newest turn is read after every resume answer that is a usable record and not busy, so a leg whose refusal comes from the
// mode (Plan Mode, no mode, a mode that is not known) reads all four.
for (const [label, over, reason, reads = 3] of [
  ["the resume answer shows the thread active", resumeWith({ thread: thread({ status: { type: "active", activeFlags: [] } }) }), "busy"],
  ["the resume answer shows the thread in Plan Mode", resumeWith({ thread: thread() }, { mode: "plan", settings: {} }), "plan", 4],
  ["the resume answer has no collaboration mode", { "thread/resume": () => ok({ thread: thread() }) }, "unknown", 4],
  ["the resume answer has a mode that is not known", resumeWith({ thread: thread() }, { mode: "future-mode" }), "unknown", 4],
  ["the resume answer has no thread record", resumeWith({}), "unknown"],
  ["the resume answer is another thread's record", resumeWith({ thread: thread({ id: "thread-2" }) }), "unknown"],
  ["the resume answer has a record without a status", resumeWith({ thread: { id: THREAD } }), "unknown"],
  ["the resume answer lacks the origin (source)", resumeWith({ thread: without("source") }), "unknown"],
  ["the resume answer lacks the ephemeral flag", resumeWith({ thread: without("ephemeral") }), "unknown"],
  ["the resume answer lacks the model provider", resumeWith({ thread: without("modelProvider") }), "unknown"],
  ["the resume answer has an empty model provider", resumeWith({ thread: thread({ modelProvider: "" }) }), "unknown"],
  ["the resume answer has an origin that is not a string or an object", resumeWith({ thread: thread({ source: 7 }) }), "unknown"],
  ["the resume answer shows a status the read did not", resumeWith({ thread: thread({ status: { type: "systemError" } }) }), "unknown"],
  ["the resume request is refused", { "thread/resume": () => ({ error: { code: -32600, message: "no rollout found" } }) }, "unknown"],
  ["the resume answer shows a child", resumeWith({ thread: thread({ parentThreadId: "p" }) }), "offline"],
]) {
  test(`a wake whose reads are idle but where ${label} sends no add, and defers as ${reason}`, async () => {
    const { result, methods } = await wakeWith(over)
    assert.deepEqual(result, { outcome: "deferred", reason })
    assert.deepEqual(methods, [...OPENS, ...READS.slice(0, reads)], "the reads up to the answer that ends the reading, and no add frame")
  })
}

test("a wake whose resume answer shows another provider than the bound one is refused as stale_binding", async () => {
  await withServer(queueServer(resumeWith({ thread: thread({ modelProvider: "other" }) })), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    await bound.bind()
    server.log.length = 0
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000 }), { outcome: "deferred", reason: "stale_binding" })
    assert.equal(server.methods().includes("thread/queue/add"), false)
  })
})

// The reading before the add is taken on the wake's own connection, now: nothing the receiver cached or an earlier call
// read counts.
for (const [label, over, reason] of [
  ["the thread has become active", active, "busy"],
  ["its newest turn was interrupted", { "thread/turns/list": () => ok({ data: [{ id: "t1", status: "interrupted" }], nextCursor: null }) }, "stopped"],
  ["it is no longer in the loaded list", { "thread/loaded/list": () => ok({ data: [], nextCursor: null }) }, "offline"],
  ["it reads as notLoaded", { "thread/read": () => ok({ thread: thread({ status: { type: "notLoaded" } }) }) }, "offline"],
  ["it has become a child", { "thread/read": () => ok({ thread: thread({ parentThreadId: "p" }) }) }, "offline"],
  ["its status is one the plugin does not know", { "thread/read": () => ok({ thread: thread({ status: { type: "systemError" } }) }) }, "unknown"],
]) {
  test(`a wake whose fresh read finds that ${label} sends no add, and defers as ${reason}`, async () => {
    const { result, methods } = await wakeWith(over)
    assert.deepEqual(result, { outcome: "deferred", reason })
    assert.equal(methods.includes("thread/queue/add"), false, "no add frame")
  })
}

test("the reading before an add is taken afresh by every wake: the thread that was idle for the last one is busy for this one", async () => {
  let busy = false
  await withServer(queueServer({
    "thread/read": () => ok({ thread: thread({ status: { type: busy ? "active" : "idle", ...(busy ? { activeFlags: [] } : {}) } }) }),
    "thread/items/list": () => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-9" } }], nextCursor: null }),
  }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    await bound.bind()
    assert.equal((await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000 })).outcome, "handed")
    busy = true
    server.log.length = 0
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000 }), { outcome: "deferred", reason: "busy" })
    assert.equal(server.methods().includes("thread/queue/add"), false)
  })
})

// The interruption is the one change that the status and the mode cannot show: the thread is idle after it too. So the
// newest turn is read last, after the resume answer, and an interruption that lands between them is seen.
test("an interruption that lands after the resume answer is seen: the newest turn is read last", async () => {
  let interrupted = false
  const { result, methods } = await wakeWith({
    "thread/resume": () => { interrupted = true; return ok({ thread: thread(), collaborationMode: { mode: "default", settings: {} } }) },
    "thread/turns/list": () => ok({ data: [{ id: "t1", status: interrupted ? "interrupted" : "completed" }], nextCursor: null }),
  })
  assert.deepEqual(result, { outcome: "deferred", reason: "stopped" })
  assert.deepEqual(methods, [...OPENS, ...READS], "all four reads, the turn list last, and no add frame")
})

// Only a newest turn that is known to be finished clears the thread, and the one finished status that the plugin knows is
// `completed`. A running turn is busy, an interrupted one is stopped, and anything else says nothing about the thread: no
// turn, a turn without a status, a status that is not a string or is not known (a failed turn included, which the

for (const [label, data, reason] of NEWEST) {
  test(`a wake whose newest turn is ${label} sends no add, and defers as ${reason}`, async () => {
    const { result, methods } = await wakeWith({ "thread/turns/list": () => ok({ data, nextCursor: null }) })
    assert.deepEqual(result, { outcome: "deferred", reason })
    assert.deepEqual(methods, [...OPENS, ...READS], "all four reads, and no add frame")
  })
}

// A status type that is not a string is no status, in the read record or the resume record: a wake never goes through on it.
test("a status type that is not a string never lets a wake through, in the read record or in the resume record", async () => {
  for (const type of [["idle"], ["active"], ["notLoaded"], [["idle"]], 7, {}, { idle: true }, null, true]) {
    for (const over of [
      { "thread/read": () => ok({ thread: thread({ status: { type } }) }) },
      { "thread/resume": () => ok({ thread: thread({ status: { type } }), collaborationMode: { mode: "default", settings: {} } }) },
    ]) {
      const woken = await wakeWith(over)
      assert.deepEqual(woken.result, { outcome: "deferred", reason: "unknown" }, `${Object.keys(over)[0]}: ${JSON.stringify(type)}`)
      assert.equal(woken.methods.includes("thread/queue/add"), false, "no add frame")
    }
  }
})

// ---- an idle read record must be complete before the reading goes on ---------------------------------------------------
// A bind requires the origin, the `ephemeral` flag and a named provider of the read record; a later idle read requires the
// same before it goes on to the resume. Each leg has a complete resume record and a completed newest turn, so only the read
// record can be the cause. `observeArmed` binds against a healthy thread first, so the provider is fixed.
async function observeArmed(over) {
  const gate = armed(over)
  return withServer(gate.handler, async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "bound" })
    gate.arm()
    server.log.length = 0
    return { result: await bound.observe(), methods: server.methods() }
  })
}
const readRecord = record => ({ "thread/read": () => ok({ thread: record }) })
for (const [label, record] of [
  ["no origin (source)", without("source")],
  ["an origin that is a number", thread({ source: 7 })],
  ["an origin that is an empty array", thread({ source: [] })],
  ["an empty origin", thread({ source: "" })],
  ["no ephemeral flag", without("ephemeral")],
  ["no model provider", without("modelProvider")],
  ["an empty model provider", thread({ modelProvider: "" })],
]) {
  test(`an idle read record with ${label} is unknown: the resume is not asked, and a wake sends no add`, async () => {
    const { result, methods } = await observeArmed(readRecord(record))
    assert.deepEqual(result, { reason: "unknown", observed: { status: "idle", stopped: false, plan: null } })
    assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read"], "the resume request is never sent")
    const woken = await wakeWith(readRecord(record))
    assert.deepEqual(woken.result, { outcome: "deferred", reason: "unknown" })
    assert.deepEqual(woken.methods, [...OPENS, "thread/loaded/list", "thread/read"], "the resume request is never sent, and no add frame")
  })
}

// The completeness check comes last of the read record's checks: a child, a changed named provider and a thread that is not
// idle are answered as they were, whatever else the record lacks.
test("an incomplete read record still answers child, stale_binding, offline and busy first: only an idle one is unknown", async () => {
  const bare = { id: THREAD, status: { type: "idle" } }
  for (const [label, record, reason, wakeReason] of [
    ["a parent", thread({ parentThreadId: "p" }), "child", "offline"],
    ["a parent and nothing else", { ...bare, parentThreadId: "p" }, "child", "offline"],
    ["notLoaded and nothing else", { id: THREAD, status: { type: "notLoaded" } }, "offline", "offline"],
    ["no provider", without("modelProvider"), "unknown", "unknown"],
    ["another named provider and no origin", { ...without("source"), modelProvider: "other" }, "stale_binding", "stale_binding"],
    ["an active status and no origin", { ...without("source"), status: { type: "active", activeFlags: [] } }, "busy", "busy"],
  ]) {
    const { result } = await observeArmed(readRecord(record))
    assert.equal(result.reason, reason, label)
    const woken = await wakeWith(readRecord(record))
    assert.deepEqual(woken.result, { outcome: "deferred", reason: wakeReason }, `wake: ${label}`)
    assert.equal(woken.methods.includes("thread/resume"), false, `${label}: the read record ended the reading`)
    assert.equal(woken.methods.includes("thread/queue/add"), false, `${label}: no add frame`)
  }
})

// Both connections of a wake must reach the one socket that was checked: the same device and inode.
// A wake on a thread that no bind has probed asks the probe first, on the add connection, before it opens the reading's.
const PROBE = "thread/queue/delete"
const swapping = (socket, inodes, field = "ino") => path => {
  const info = lstatSync(path)
  return path === socket ? Object.create(info, { [field]: { value: inodes() } }) : info
}
async function wakeOverSwapping(inodes, proceed, field) {
  const confirmed = { "thread/items/list": () => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-9" } }], nextCursor: null }) }
  return withServer(queueServer(confirmed), async (path, server) => {
    let calls = 0
    const lstat = swapping(realpathSync(path), () => inodes(++calls), field)
    const bound = createThread({ path, threadId: THREAD, open: (target, options) => openAppServer(target, { ...options, lstat }) })
    const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000, proceed })
    return { result, methods: server.methods(), connections: server.state.connections }
  })
}

test("a socket replaced between the two connects is refused: the reading is not taken, and no add is sent", async () => {
  const { result, methods, connections } = await wakeOverSwapping(call => (call === 1 ? 100 : 200))
  assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(methods, ["initialize", PROBE], "only the add connection was made, and it asked only the probe")
  assert.equal(connections, 1, "the second connection was refused before it was made")
})

test("a socket replaced after the reading, before the add frame, sends no add and does not ask the receiver", async () => {
  let asked = 0
  const { result, methods } = await wakeOverSwapping(call => (call <= 2 ? 100 : 200), () => { asked += 1; return null })
  assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(methods, ["initialize", PROBE, "initialize", ...READS], "the probe and the reads were made, and no add frame")
  assert.equal(asked, 0, "the receiver is not asked to adopt a reading from a socket that is gone")
})

test("a socket that is the same for the add connection, the reading and the add frame is used", async () => {
  const { result, methods } = await wakeOverSwapping(() => 100)
  assert.deepEqual(methods.slice(0, 8), ["initialize", PROBE, "initialize", ...READS, "thread/queue/add"])
  assert.deepEqual(result, { outcome: "handed", reason: null })
})
// A socket is its device and its inode together: the same inode on another device is another socket.
test("a socket on another device with the same inode is another socket: refused between the connects, and before the add", async () => {
  const between = await wakeOverSwapping(call => (call === 1 ? 100 : 200), undefined, "dev")
  assert.deepEqual(between.result, { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(between.methods, ["initialize", PROBE], "the second connection was refused before it was made")
  const after = await wakeOverSwapping(call => (call <= 2 ? 100 : 200), () => null, "dev")
  assert.deepEqual(after.result, { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(after.methods, ["initialize", PROBE, "initialize", ...READS], "the reads, and no add frame")
  const same = await wakeOverSwapping(() => 100, undefined, "dev")
  assert.deepEqual(same.result, { outcome: "handed", reason: null }, "control: one device throughout is the same socket")
})

test("a probe taken on one device does not count for the same inode on another: replaced() says so, and the wake probes again", async () => {
  await withServer(queueServer(handedItems), async (path, server) => {
    const socket = realpathSync(path)
    let moved = false
    const lstat = name => {
      const info = lstatSync(name)
      return moved && name === socket ? Object.create(info, { dev: { value: info.dev + 1 } }) : info
    }
    const bound = createThread({ path, threadId: THREAD, lstat, open: (target, options) => openAppServer(target, { ...options, lstat }) })
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.replaced(), false, "control: the probed socket")
    moved = true
    assert.equal(bound.replaced(), true)
    server.log.length = 0
    assert.deepEqual(await wakeNow(bound), { outcome: "handed", reason: null })
    assert.deepEqual(server.methods().slice(0, 3), ["initialize", PROBE, "initialize"], "the wake probed it before the reading")
  })
})

// The wake's own probe has PROBE_MS, like a bind's, however much of the reservation is left.
test("a wake's own probe that gets no answer gives up within PROBE_MS, and nothing is sent", async () => {
  await withServer(queueServer({ [PROBE]: () => undefined }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    const started = monotonic()
    const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: started + 6000 })
    const took = monotonic() - started
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
    assert.deepEqual(server.methods(), ["initialize", PROBE])
    assert.ok(took < 2500, `the probe gave up after ${took} ms`)
    assert.equal(bound.route, null, "no answer is recorded")
  })
})
// ---- the configured path is checked again before the add ---------------------------------------------------------------

// The check before the add resolves the configured path again, from its first name, through the whole trust rule. It is not
// enough that the canonical path of the add connection still holds the same socket: a link in the configured path may have
// moved, and the path then selects another listener while the old socket is still there.
// `<base>/current/app/control.sock` goes through the link `current`, which names `a`; `b` holds another app-server. Both answer a
// wake the same way, and confirm its add.
async function throughLink() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acr-")))
  const handler = queueServer({ "thread/items/list": () => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-9" } }], nextCursor: null }) })
  const listen = async name => {
    for (const path of [join(base, name), join(base, name, "app")]) {
      mkdirSync(path, { mode: 0o700 })
      chmodSync(path, 0o700)
    }
    return fakeAppServer(join(base, name, "app", "control.sock"), handler)
  }
  const old = await listen("a")
  const next = await listen("b")
  symlinkSync(join(base, "a"), join(base, "current"))
  return {
    base, old, next, path: join(base, "current", "app", "control.sock"),
    // A new link renamed over the old one, as an operator switches `current`.
    retarget() {
      symlinkSync(join(base, "b"), join(base, "current.new"))
      renameSync(join(base, "current.new"), join(base, "current"))
    },
    async close() { await old.close(); await next.close(); rmSync(base, { recursive: true, force: true }) },
  }
}

// An `open` for `createThread` that calls `after` once the connection with this number (counted from 0) has closed. A wake opens
// the connection for the add first and the reading's second, and closes the reading's before it checks the path and adds.
function afterClose(number, after) {
  let opened = 0
  return async (target, options) => {
    const link = await openAppServer(target, options)
    const mine = opened++
    return { identity: link.identity, same: link.same, request: link.request, close() { link.close(); if (mine === number) after() } }
  }
}
const addsTo = server => server.methods().filter(method => method === "thread/queue/add").length

test("a link in the configured path that moves after the reading sends no add, though the socket that was reached is still there", async () => {
  const w = await throughLink()
  try {
    const wake = async moved => {
      let asked = 0
      const bound = createThread({ path: w.path, threadId: THREAD, open: afterClose(1, moved) })
      const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000, proceed: () => { asked += 1; return null } })
      return { result, asked }
    }
    assert.deepEqual(await wake(() => {}), { result: { outcome: "handed", reason: null }, asked: 1 }, "control: with the link where it was, the same wake is handed")
    assert.equal(addsTo(w.old), 1)
    w.old.log.length = 0
    assert.deepEqual(await wake(() => w.retarget()), { result: { outcome: "failed", reason: "native_unavailable" }, asked: 0 }, "the reading's connection closed, then the link moved")
    assert.equal(addsTo(w.old), 0, "the old socket, which is still there, was sent nothing")
    assert.equal(w.next.state.connections, 0, "and the new one was never connected to")
  } finally { await w.close() }
})

test("the configured path must still pass the whole trust rule before the add: a directory that others can write by then sends no add", async () => {
  const w = await throughLink()
  try {
    const bound = createThread({ path: w.path, threadId: THREAD, open: afterClose(1, () => chmodSync(join(w.base, "a", "app"), 0o777)) })
    const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000 })
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
    assert.equal(addsTo(w.old), 0, "the socket is the same one, but its directory is no longer one that nobody else can change")
  } finally { await w.close() }
})
// ---- the probe belongs to the socket it was taken on -----------------------------------------------------------------

const handedItems = { "thread/items/list": () => ok({ data: [{ turnId: "t", item: { type: "userMessage", id: "i", clientId: "agent-chat:attempt-9" } }], nextCursor: null }) }
// Another listener takes over `path` without that path ever being bound twice: it listens under a second name and is renamed
// over the first, so the two sockets have different inodes and the first one is still alive.
async function replaceSocket(path, handler) {
  const spare = `${path}.next`
  const next = await fakeAppServer(spare, handler)
  renameSync(spare, path)
  return next
}
const wakeNow = bound => bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000 })

test("a probe taken on one socket does not count on another: the wake probes the replacement on its add connection before any add", async () => {
  const path = socketPath()
  const first = await fakeAppServer(path, queueServer(handedItems))
  const bound = createThread({ path, threadId: THREAD })
  let second
  try {
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    assert.equal((await wakeNow(bound)).outcome, "handed")
    assert.deepEqual(first.methods().slice(4), [...OPENS, ...READS, "thread/queue/add", "thread/queue/delete", "thread/items/list"], "control: on the socket that was probed, the wake does not probe again")
    second = await replaceSocket(path, queueServer(handedItems))
    assert.equal(bound.route, true, "the cached answer is still the one for the first socket")
    assert.deepEqual(await wakeNow(bound), { outcome: "handed", reason: null })
    assert.deepEqual(second.methods(), ["initialize", "thread/queue/delete", "initialize", ...READS, "thread/queue/add", "thread/queue/delete", "thread/items/list"], "the probe is the first request after the add connection opens, before the reading and the add")
    assert.match(second.log[1].params.queuedSubmissionId, /^[0-9a-f-]{36}$/, "it is the probe: an id nobody queued")
    assert.equal(first.methods().filter(method => method === "thread/queue/add").length, 1, "the first socket was not asked again")
    second.log.length = 0
    await wakeNow(bound)
    assert.deepEqual(second.methods().slice(0, 3), [...OPENS, "thread/loaded/list"], "the replacement is probed once: the next wake on it does not probe")
  } finally { await first.close(); await second?.close() }
})

test("a replacement that does not answer the probe as documented gets no add: the wake fails and the route is off", async () => {
  for (const answer of [() => ok({ deleted: true }) /* never observed live */, () => ({ error: { code: -32601, message: "method not found" } }), () => ok({})]) {
    const path = socketPath()
    const first = await fakeAppServer(path, queueServer(handedItems))
    const bound = createThread({ path, threadId: THREAD })
    let second
    try {
      assert.equal((await bound.bind()).status, "bound")
      second = await replaceSocket(path, queueServer({ ...handedItems, "thread/queue/delete": answer }))
      assert.deepEqual(await wakeNow(bound), { outcome: "failed", reason: "native_unavailable" })
      assert.deepEqual(second.methods(), ["initialize", "thread/queue/delete"], "only the probe was sent: no reading, no add")
      assert.equal(first.methods().includes("thread/queue/add"), false)
      assert.equal(bound.route, false, "the answer for the socket that is there now")
    } finally { await first.close(); await second?.close() }
  }
})

test("a replacement that cannot complete the probe gets no add either, and nothing is recorded for it", async () => {
  const path = socketPath()
  const first = await fakeAppServer(path, queueServer(handedItems))
  const bound = createThread({ path, threadId: THREAD })
  let second
  try {
    await bound.bind()
    second = await replaceSocket(path, queueServer({ ...handedItems, "thread/queue/delete": (_message, { socket }) => { socket.destroy() } }))
    assert.deepEqual(await wakeNow(bound), { outcome: "failed", reason: "native_unavailable" })
    assert.equal(second.methods().includes("thread/queue/add"), false)
    assert.equal(bound.route, true, "a transport failure is not an answer: the cached route is untouched")
  } finally { await first.close(); await second?.close() }
})

test("a bind on a replaced socket probes it again, and a bind on the same socket does not", async () => {
  const path = socketPath()
  const first = await fakeAppServer(path, queueServer(handedItems))
  const bound = createThread({ path, threadId: THREAD })
  let second
  try {
    await bound.bind()
    first.log.length = 0
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    assert.equal(first.methods().includes("thread/queue/delete"), false, "the same socket is not probed twice")
    second = await replaceSocket(path, queueServer({ ...handedItems, "thread/queue/delete": () => ok({ deleted: true }) })) // never observed live
    assert.deepEqual(await bound.bind(), { status: "bound" }, "the replacement was probed, and answered differently")
    assert.equal(bound.route, false)
    assert.equal(second.methods().includes("thread/queue/delete"), true)
  } finally { await first.close(); await second?.close() }
})

// The receiver asks this at each heartbeat while the route is off: the configured path through the trust check, no connection.
test("the thread tells whether its path still names the socket of its newest probe, and nothing is connected to", async () => {
  const path = socketPath()
  const first = await fakeAppServer(path, queueServer(handedItems))
  const bound = createThread({ path, threadId: THREAD })
  let second
  try {
    assert.equal(bound.replaced(), false, "nothing was probed, so there is no socket to compare with")
    await bound.bind()
    assert.equal(bound.replaced(), false, "the probed socket is still there")
    const connections = first.state.connections
    second = await replaceSocket(path, queueServer(handedItems))
    assert.equal(bound.replaced(), true, "the path names another socket now")
    assert.equal(first.state.connections + second.state.connections, connections, "asking connected to nothing")
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    assert.equal(bound.replaced(), false, "the replacement was probed: it is the socket that counts now")
    renameSync(path, `${path}.gone`)
    assert.equal(bound.replaced(), false, "a path that names nothing has no other socket to probe")
  } finally { await first.close(); await second?.close() }
})

// Only another socket that passes the trust check is a replacement. Whatever else the path names or fails to name (a regular file,
// a directory that became a file, an unreadable path, another user's socket), there is nothing to probe: the receiver does not
// bind again, and the heartbeat's ordinary read goes on and reports the thread offline.
// A thread that has probed a live socket in a directory of its own, for the task to change what the path names.
async function probedAt(task, options = {}) {
  const base = mkdtempSync(join(dir, "r-"))
  const parent = join(base, "d")
  mkdirSync(parent, { mode: 0o700 })
  chmodSync(parent, 0o700)
  const path = join(parent, "s.sock")
  const server = await fakeAppServer(path, queueServer(handedItems))
  try {
    const bound = createThread({ path, threadId: THREAD, ...options })
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    return await task({ bound, path, parent })
  } finally { await server.close() }
}

test("replaced() is false when a regular file took the path: it is not a socket, so there is nothing to probe", async () => {
  await probedAt(async ({ bound, path }) => {
    assert.equal(bound.replaced(), false, "control: the probed socket is still there")
    renameSync(path, `${path}.moved`)
    writeFileSync(path, "")
    assert.equal(bound.replaced(), false)
  })
})

test("replaced() is false when a directory above the socket became a file (ENOTDIR)", async () => {
  await probedAt(async ({ bound, path, parent }) => {
    renameSync(parent, `${parent}.moved`)
    writeFileSync(parent, "")
    assert.throws(() => lstatSync(path), { code: "ENOTDIR" }, "control: this is what the path gives")
    assert.equal(bound.replaced(), false)
  })
})

test("replaced() is false whatever else the lstat fails with, not only ENOENT: a loop of links (ELOOP), EACCES, an error with no code", async () => {
  await probedAt(async ({ bound, path, parent }) => {
    renameSync(parent, `${parent}.moved`)
    symlinkSync(parent, parent) // the name of the directory is a link to itself
    assert.throws(() => lstatSync(path), { code: "ELOOP" }, "control: this is what the path gives")
    assert.equal(bound.replaced(), false)
  })
  for (const code of ["EACCES", "ENAMETOOLONG", undefined]) {
    const failing = () => { throw Object.assign(new Error("lstat failed"), code === undefined ? {} : { code }) }
    await probedAt(async ({ bound }) => assert.equal(bound.replaced(), false, String(code)), { lstat: failing })
  }
})

test("replaced() is true only for another socket of the current user: another user's socket is refused at a bind, not probed", async () => {
  const path = socketPath()
  const first = await fakeAppServer(path, queueServer(handedItems))
  let second
  try {
    let owner = process.geteuid() + 1
    const bound = createThread({ path, threadId: THREAD, lstat: target => Object.create(lstatSync(target), { uid: { value: owner } }) })
    await bound.bind()
    second = await replaceSocket(path, queueServer(handedItems))
    assert.equal(bound.replaced(), false, "another socket took the path, but another user owns it")
    owner = process.geteuid()
    assert.equal(bound.replaced(), true, "control: seen as the current user's, the same socket is a replacement")
  } finally { await first.close(); await second?.close() }
})

test("replaced() looks at nothing before a probe has finished, and afterwards only through the trust check, connecting to nothing", async () => {
  const path = socketPath()
  const first = await fakeAppServer(path, queueServer(handedItems))
  let calls = 0
  const bound = createThread({ path, threadId: THREAD, lstat: target => { calls += 1; return lstatSync(target) } })
  let second
  try {
    assert.equal(bound.replaced(), false)
    assert.equal(calls, 0, "no probe has finished: the path is not looked at")
    await bound.bind()
    const connections = first.state.connections
    assert.equal(bound.replaced(), false, "the socket that was probed, unchanged")
    assert.ok(calls > 0, "the path was walked")
    second = await replaceSocket(path, queueServer(handedItems))
    assert.equal(bound.replaced(), true, "another socket")
    renameSync(path, `${path}.gone`)
    assert.equal(bound.replaced(), false, "no socket")
    assert.equal(first.state.connections + second.state.connections, connections, "asking connected to nothing")
  } finally { await first.close(); await second?.close() }
})

// No bind has probed the socket, so no cached answer can count: the receiver does not wake such a thread (its route is not

// ---- the live layout: the configured path is a link whose final name links to the socket ---------------------------------
// `codex app-server --listen unix://PATH` (codex-cli 0.171.0) leaves PATH as a symlink to a socket in a private directory of
// its own. The probe, `replaced()` and `same()` all judge the socket at the end of the link. A raw lstat of PATH sees a link,
// not a socket, and could never tell that the link now names another one. Real files, since the injected lstat fakes lstat only.
async function finalLink() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acl-")))
  const listen = async name => {
    mkdirSync(join(base, name), { mode: 0o700 })
    chmodSync(join(base, name), 0o700)
    return fakeAppServer(join(base, name, "h.sock"), queueServer(handedItems))
  }
  const one = await listen("one")
  const two = await listen("two")
  const path = join(base, "control.sock")
  symlinkSync(join(base, "one", "h.sock"), path)
  return {
    one, two, path,
    // A new link renamed over the old one, as a restarted app-server leaves it.
    retarget() {
      symlinkSync(join(base, "two", "h.sock"), `${path}.new`)
      renameSync(`${path}.new`, path)
    },
    async close() { await one.close(); await two.close(); rmSync(base, { recursive: true, force: true }) },
  }
}

test("through a final link, the bind probes the socket, replaced() is false, and it is true once the link names another socket", async () => {
  const w = await finalLink()
  try {
    const bound = createThread({ path: w.path, threadId: THREAD })
    assert.equal(lstatSync(w.path).isSymbolicLink(), true, "control: the configured path is a link")
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.route, true)
    assert.ok(w.one.methods().includes("thread/queue/delete"), "the probe went to the socket at the end of the link")
    assert.equal(bound.replaced(), false, "the link still names the probed socket")
    const connections = w.one.state.connections
    w.retarget()
    assert.equal(bound.replaced(), true, "the link now names another socket")
    assert.equal(w.two.state.connections, 0, "asking connected to nothing")
    assert.equal(w.one.state.connections, connections)
  } finally { await w.close() }
})

test("through a final link a wake is handed, and a link retargeted between the reading and the add sends no add", async () => {
  const w = await finalLink()
  try {
    const wake = async moved => {
      let asked = 0
      const bound = createThread({ path: w.path, threadId: THREAD, open: afterClose(1, moved) })
      const result = await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000, proceed: () => { asked += 1; return null } })
      return { result, asked }
    }
    assert.deepEqual(await wake(() => {}), { result: { outcome: "handed", reason: null }, asked: 1 }, "control: through the link, the wake is handed")
    assert.equal(addsTo(w.one), 1)
    assert.deepEqual(await wake(() => w.retarget()), { result: { outcome: "failed", reason: "native_unavailable" }, asked: 0 }, "same() saw the link move")
    assert.equal(addsTo(w.one), 1, "the socket that was reached was sent no second add")
    assert.equal(w.two.state.connections, 0, "and the new one was never connected to")
  } finally { await w.close() }
})

// No bind has probed the socket, so no cached answer can count: the receiver does not wake such a thread (its route is not
// true), and `wake` itself still adds only after a positive probe on the very socket it will use.
test("a wake on a thread that no bind has probed asks the probe first, and a probe that is not positive sends no add", async () => {
  for (const answer of [() => ok({ deleted: true }) /* never observed live */, () => ok({}), () => ({ error: { code: -32600, message: "unknown queue entry" } })]) {
    await withServer(queueServer({ "thread/queue/delete": answer }), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await wakeNow(bound), { outcome: "failed", reason: "native_unavailable" })
      assert.deepEqual(server.methods(), ["initialize", PROBE], "the probe, and nothing after it")
      assert.equal(bound.route, false, "what the wake learned is kept for this socket")
    })
  }
  await withServer(queueServer(handedItems), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    assert.equal(bound.route, null)
    assert.equal((await wakeNow(bound)).outcome, "handed")
    assert.equal(server.methods().filter(method => method === PROBE).length, 2, "the probe, and the fence")
    server.log.length = 0
    assert.equal((await wakeNow(bound)).outcome, "handed")
    assert.equal(server.methods().filter(method => method === PROBE).length, 1, "the answer is cached for this socket: the fence only")
  })
})

// A reply that is not a JSON object is a protocol error that arrives after the frame was written: it settles `uncertain`,
// and never reaches the code that reads the reply as a record.
test("a reply that is not an object, to the add or to the fence, is uncertain and is not an exception", async () => {
  for (const method of ["thread/queue/add", "thread/queue/delete"]) {
    for (const reply of [null, [], "text", 7]) {
      const { result, methods } = await wakeWith({ [method]: () => ok(reply) })
      assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" }, `${method} answered ${JSON.stringify(reply)}`)
      assert.equal(methods.filter(name => name === "thread/queue/add").length, 1, "the add is not repeated")
    }
  }
})

test("the add is the next request after the last read of the wake, and a failed read sends none", async () => {
  const { methods } = await wakeWith({})
  assert.deepEqual(methods.slice(0, 7), [...OPENS, ...READS, "thread/queue/add"], "nothing is asked between the last answer and the add")
  const { result, methods: failed } = await wakeWith({ "thread/turns/list": () => ({ error: { code: -32600, message: "x" } }) })
  assert.deepEqual(result, { outcome: "deferred", reason: "unknown" }, "a refused newest-turn lookup reads the state as unknown")
  assert.equal(failed.includes("thread/queue/add"), false)
})
// `ready` is the caller's own check after the reading (the receiver asks the ledger for the mute again). It sends nothing to
// the app-server, so the add is still the next request after the last read; a reason from it, or a throw, sends no add.
test("a wake awaits ready after its reading and before the add: null goes on, a reason defers, a throw fails, and none sends to the app-server", async () => {
  for (const [label, ready, expected] of [
    ["null", async () => null, null],
    ["muted", async () => "muted", { outcome: "deferred", reason: "muted" }],
    ["a throw", async () => { throw new Error("x") }, { outcome: "failed", reason: "native_unavailable" }],
  ]) {
    const gate = armed({})
    await withServer(gate.handler, async (path, server) => {
      const ticks = clock()
      const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
      await bound.bind()
      gate.arm()
      server.log.length = 0
      let seenAtReady = null
      const result = await bound.wake({
        text: "t", attemptId: "attempt-9", until: ticks.now() + 5000,
        ready: () => { seenAtReady = server.methods(); return ready() },
      })
      assert.deepEqual(seenAtReady, [...OPENS, ...READS], `${label}: ready is asked once the reading is done`)
      if (expected === null) {
        assert.deepEqual(server.methods().slice(0, 7), [...OPENS, ...READS, "thread/queue/add"], `${label}: the add is still the next request`)
      } else {
        assert.deepEqual(result, expected, label)
        assert.deepEqual(server.methods(), [...OPENS, ...READS], `${label}: nothing more went to the app-server`)
      }
    })
  }
})

// `ready` is not started without the time for an add after it: a suspend during the reading (wall +45 s, monotonic +1 s)
// fails the wake before the status is asked again. With the clocks in step, `ready` is called exactly once.
for (const [label, wallStep, calls] of [
  ["a suspend during the reading fails the wake before ready is asked, and nothing follows the reads", 45_000, 0],
  ["with the clocks in step, ready is asked exactly once", 1_000, 1],
]) {
  test(label, async () => {
    const gate = armed({})
    const ticks = clock()
    let wallTime = 1_800_000_000_000
    let reading = false
    const handler = (message, connection) => {
      if (reading && message.method === "thread/turns/list") { reading = false; ticks.time.now += 1_000; wallTime += wallStep }
      return gate.handler(message, connection)
    }
    await withServer(handler, async (path, server) => {
      const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep, wall: () => wallTime })
      await bound.bind()
      gate.arm()
      reading = true
      server.log.length = 0
      let asked = 0
      const result = await bound.wake({
        text: "t", attemptId: "attempt-9", until: ticks.now() + 5_000, wallUntil: wallTime + 5_000,
        ready: async () => { asked += 1; return null },
      })
      assert.equal(asked, calls, label)
      if (calls === 0) {
        assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
        assert.deepEqual(server.methods(), [...OPENS, ...READS], "nothing follows the reads")
      } else {
        assert.equal(server.methods().filter(method => method === "thread/queue/add").length, 1)
      }
    })
  })
}

// ---- the app-server socket is trusted before each connect (the rule itself is tested in trust.test.js) ---------------

const untrusted = { code: "CHAT_APPSERVER_UNTRUSTED" }

test("with the real file system: a private directory is trusted, and a group-writable, other-writable or symlinked one is not", async () => {
  const base = mkdtempSync(join(tmpdir(), "acu-"))
  try {
    const open = mode => {
      const where = mkdtempSync(join(base, "d-"))
      chmodSync(where, mode)
      return where
    }
    const served = []
    const listen = async directory => {
      const path = join(directory, "s.sock")
      const server = await fakeAppServer(path, main())
      served.push(server)
      return { path, server }
    }
    const private_ = await listen(open(0o700))
    const link = await openAppServer(private_.path)
    link.close()
    assert.ok(private_.server.state.connections > 0, "a private directory is connected to")
    for (const mode of [0o770, 0o707, 0o777]) {
      const { path, server } = await listen(open(mode))
      await assert.rejects(openAppServer(path), untrusted, `mode ${mode.toString(8)}`)
      assert.equal(server.state.connections, 0, `mode ${mode.toString(8)}: nothing was connected to`)
    }
    const real = open(0o700)
    const target = await listen(real)
    symlinkSync(real, join(base, "link"))
    await assert.rejects(openAppServer(join(base, "link", "s.sock")), untrusted, "a symlinked directory")
    assert.equal(target.server.state.connections, 0)
    writeFileSync(join(real, "plain.sock"), "")
    await assert.rejects(openAppServer(join(real, "plain.sock")), untrusted, "a regular file")
    mkdirSync(join(real, "inner"), { mode: 0o700 })
    await assert.rejects(openAppServer(join(real, "inner", "none.sock")), { code: "APP_SERVER_CLOSED" }, "an absent socket")
    for (const server of served) await server.close()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("a socket that another user owns is refused by openAppServer as CHAT_APPSERVER_UNTRUSTED, before anything is connected to", async () => {
  await withServer(main(), async (path, server) => {
    const other = target => {
      const info = lstatSync(target)
      return target.endsWith(path.slice(path.lastIndexOf("/"))) ? Object.create(info, { uid: { value: process.geteuid() + 1 } }) : info
    }
    await assert.rejects(openAppServer(path, { lstat: other }), untrusted)
    assert.equal(server.state.connections, 0, "not one connection was made")
    const link = await openAppServer(path) // control: the same socket, with its real owner, is connected to
    link.close()
    assert.equal(server.state.connections, 1)
  })
})

// A socket path is held to 103 bytes, measured on the real path (see lib/trust.js), and a longer one never reaches Node.
test("a control socket whose real path is over 103 bytes is refused as untrusted before anything is connected to, and one of 103 bytes is connected to", async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acl-")))
  try {
    const room = 103 - Buffer.byteLength(base) - "s.sock".length - 2 // a directory for which `<directory>/s.sock` is 103 bytes
    if (room < 1 || room > 254) return t.skip("the temporary directory leaves no room for a path of this length")
    const fits = join(base, "d".repeat(room))
    mkdirSync(fits, { mode: 0o700 })
    chmodSync(fits, 0o700)
    let connected = 0
    const createConnection = (...args) => { connected += 1; return net.createConnection(...args) }
    const server = await fakeAppServer(join(fits, "s.sock"), main())
    try {
      const link = await openAppServer(join(fits, "s.sock"), { createConnection })
      link.close()
      assert.equal(connected, 1, "103 bytes are connected to")
    } finally { await server.close() }
    connected = 0
    const over = join(base, "e".repeat(room + 1)) // one byte more: `<over>/s.sock` is 104 bytes
    mkdirSync(over, { mode: 0o700 })
    chmodSync(over, 0o700)
    assert.equal(Buffer.byteLength(join(over, "s.sock")), 104)
    await assert.rejects(openAppServer(join(over, "s.sock"), { createConnection }), untrusted, "104 bytes, a socket that is not even there")
    // a short spelling whose real path is long: a link above the directory, resolved first
    mkdirSync(join(over, "inner"), { mode: 0o700 })
    symlinkSync(over, join(base, "ln"))
    const shortened = join(base, "ln", "inner", "s.sock")
    assert.ok(Buffer.byteLength(shortened) < 103 && Buffer.byteLength(join(over, "inner", "s.sock")) > 103)
    await assert.rejects(openAppServer(shortened, { createConnection }), untrusted, "a short spelling that resolves to a long path")
    assert.equal(connected, 0, "nothing was connected to")
    const bound = createThread({ path: join(over, "s.sock"), threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "untrusted" })
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("an untrusted socket is refused before any connection: the bind says untrusted and the read is offline", async () => {
  const base = mkdtempSync(join(tmpdir(), "acu-"))
  try {
    const open = mode => { const where = mkdtempSync(join(base, "d-")); chmodSync(where, mode); return where }
    const path = join(open(0o777), "s.sock")
    const server = await fakeAppServer(path, main())
    try {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "untrusted" })
      assert.equal(bound.provider, null)
      assert.equal((await bound.observe()).reason, "offline")
      assert.equal(server.state.connections, 0, "not one connection was made")
    } finally { await server.close() }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("an untrusted socket gets no wake: the wake fails before any connection, and chat is not touched", async () => {
  const base = mkdtempSync(join(tmpdir(), "acu-"))
  try {
    const where = mkdtempSync(join(base, "d-"))
    chmodSync(where, 0o777)
    const path = join(where, "s.sock")
    const server = await fakeAppServer(path, queueServer())
    try {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until: monotonic() + 5000 }), { outcome: "failed", reason: "native_unavailable" })
      assert.equal(bound.route, null)
      assert.equal(server.state.connections, 0, "not one connection was made")
    } finally { await server.close() }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---- a control socket that is a symlink: where `codex app-server --listen unix://PATH` leaves PATH ---------------------------
// The app-server binds its socket in a private directory of its own and leaves PATH as a symlink to it. The check follows the link:
// the link and the target are each judged by the rule, and the connection goes to the target. The layout: a root that holds the
// link (`control.sock`) and one directory per daemon, each with a socket that the fake server answers on.
async function daemons(...modes) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acd-")))
  const served = []
  for (const [index, mode] of modes.entries()) {
    const directory = join(root, `daemon${index}`)
    mkdirSync(directory, { mode })
    chmodSync(directory, mode)
    const socket = join(directory, "h.sock")
    served.push({ socket, server: await fakeAppServer(socket, main()) })
  }
  return {
    root, served, link: join(root, "control.sock"),
    async close() {
      for (const { server } of served) await server.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a control socket path that is a symlink to a socket in a private directory is followed: the connection and the bind go to the socket", async () => {
  for (const relative of [false, true]) {
    const w = await daemons(0o700)
    try {
      symlinkSync(relative ? join("daemon0", "h.sock") : w.served[0].socket, w.link)
      const link = await openAppServer(w.link)
      link.close()
      assert.equal(w.served[0].server.state.connections, 1, relative ? "a relative link" : "an absolute link")
      assert.deepEqual(await createThread({ path: w.link, threadId: THREAD }).bind(), { status: "bound" })
    } finally { await w.close() }
  }
})

test("a link into a directory that group or others can write is refused, and nothing is connected to", async () => {
  for (const mode of [0o770, 0o707, 0o777]) {
    const w = await daemons(mode)
    try {
      symlinkSync(w.served[0].socket, w.link)
      await assert.rejects(openAppServer(w.link), untrusted, `mode ${mode.toString(8)}`)
      assert.deepEqual(await createThread({ path: w.link, threadId: THREAD }).bind(), { status: "untrusted" })
      assert.equal(w.served[0].server.state.connections, 0, `mode ${mode.toString(8)}: not one connection was made`)
    } finally { await w.close() }
  }
})

test("a link that another user owns is refused, and the same link owned by the current user is not", async () => {
  const w = await daemons(0o700)
  try {
    symlinkSync(w.served[0].socket, w.link)
    const owned = by => path => {
      const info = lstatSync(path)
      if (path !== w.link) return info
      return { isSocket: () => info.isSocket(), isSymbolicLink: () => info.isSymbolicLink(), isDirectory: () => info.isDirectory(), uid: by, mode: info.mode, dev: info.dev, ino: info.ino }
    }
    await assert.rejects(openAppServer(w.link, { lstat: owned(lstatSync(w.link).uid + 1) }), untrusted)
    assert.equal(w.served[0].server.state.connections, 0, "nothing was connected to")
    const link = await openAppServer(w.link, { lstat: owned(lstatSync(w.link).uid) })
    link.close()
  } finally { await w.close() }
})

test("a loop of links, and a link to itself, are refused", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acd-")))
  try {
    symlinkSync("b.sock", join(root, "a.sock"))
    symlinkSync("a.sock", join(root, "b.sock"))
    symlinkSync("self.sock", join(root, "self.sock"))
    for (const name of ["a.sock", "b.sock", "self.sock"]) {
      await assert.rejects(openAppServer(join(root, name)), untrusted, name)
      assert.deepEqual(await createThread({ path: join(root, name), threadId: THREAD }).bind(), { status: "untrusted" }, name)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a link that the app-server left behind when it went away is a closed app-server, not an untrusted one", async () => {
  const w = await daemons(0o700)
  try {
    for (const target of [join(w.root, "gone", "h.sock"), join(w.root, "daemon0", "absent.sock")]) {
      symlinkSync(target, w.link)
      await assert.rejects(openAppServer(w.link), { code: "APP_SERVER_CLOSED" }, target)
      assert.deepEqual(await createThread({ path: w.link, threadId: THREAD }).bind(), { status: "unavailable" }, target)
      rmSync(w.link)
    }
  } finally { await w.close() }
})

// Nothing remembers the socket that an earlier connection reached: each connection is checked from the configured name again, so a
// link that moved is judged as the path it names now, and the connection goes to that socket.
test("a link that moves to another target is judged anew, and the connection goes to the socket it names then", async () => {
  const w = await daemons(0o700, 0o770, 0o700)
  try {
    const [first, loose, second] = w.served
    symlinkSync(first.socket, w.link)
    const one = await openAppServer(w.link)
    one.close()
    rmSync(w.link)
    symlinkSync(loose.socket, w.link)
    await assert.rejects(openAppServer(w.link), untrusted, "moved into a directory that its group can write")
    assert.equal(loose.server.state.connections, 0)
    rmSync(w.link)
    symlinkSync(second.socket, w.link)
    const two = await openAppServer(w.link)
    two.close()
    assert.deepEqual([first.server.state.connections, second.server.state.connections], [1, 1], "the new target was connected to, the old one not again")
  } finally { await w.close() }
})

// The record that codex-cli 0.171.0 returns for a TUI attached with `--remote`: `source` is "vscode", and there are many fields
// besides the ones this package reads.
const LIVE_RECORD = {
  id: THREAD, sessionId: THREAD, parentThreadId: null, forkedFromId: null, attachedToThreadId: null, ephemeral: false, modelProvider: "openai",
  status: { type: "idle" }, source: "vscode", threadSource: "user", originator: "codex-tui", agentRole: null, agentNickname: null, turns: [],
}

// After a turn, codex-cli 0.171.0 answers `thread/resume` with `excludeTurns: true` with the record next to the collaboration
// mode and its settings, among other fields. The settings and the other fields here are synthetic: this package reads only the mode.
const LIVE_RESUME = { thread: LIVE_RECORD, collaborationMode: { mode: "default", settings: { model: "synthetic-model", reasoningEffort: null } }, cwd: "/tmp/synthetic" }

test("the record that codex-cli returns for a TUI attached with --remote is a main thread: the bind joins and the read finds it idle", async () => {
  await withServer(main({ "thread/read": () => ok({ thread: LIVE_RECORD }), "thread/resume": () => ok(LIVE_RESUME) }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.deepEqual(await bound.observe(), { reason: null, observed: { status: "idle", stopped: false, plan: false } })
  })
})

// Before the first user message codex-cli 0.171.0 refuses both the resume (-32600 "no rollout found") and the turns list
// (-32600 "not materialized yet"). The resume comes first and its refusal ends the reading: the mode is unknown, and so is
// the thread. Nothing here is a child or an offline thread.
test("a thread before its first user message, as codex-cli answers it, reads as unknown, and the turns list is never asked", async () => {
  const { result, methods } = await observeWith({
    "thread/read": () => ok({ thread: LIVE_RECORD }),
    "thread/resume": () => ({ error: { code: -32600, message: "no rollout found" } }),
    "thread/turns/list": () => ({ error: { code: -32600, message: "not materialized yet" } }),
  })
  assert.deepEqual(result, { reason: "unknown", observed: { status: "idle", stopped: false, plan: null } })
  assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/resume"])
})
