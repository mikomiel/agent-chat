import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createThread, isChildThread, openAppServer } from "../lib/appserver.js"
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

// ---- bind --------------------------------------------------------------------------------------------------

test("bind finds the thread and fixes the provider, and asks nothing past the read", async () => {
  await withServer(main(), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "bound" })
    assert.equal(bound.provider, "openai")
    assert.deepEqual(server.methods(), ["initialize", "thread/loaded/list", "thread/read"])
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

// ---- the deadline of a bind and the call's own token -----------------------------------------------------------
// The caller's time is for the thread read. `signal` is the call's token: once aborted, nothing the call reads afterwards is
// recorded. `owns` is the same for a caller that stopped being the owner of the answer.

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
// agree with the read and the bound provider, or it says nothing about the thread. It ends the reading when it refuses.
const resumeWith = (body, mode = { mode: "default", settings: {} }) => ({ "thread/resume": () => ok({ ...body, collaborationMode: mode }) })
const without = key => { const record = thread(); delete record[key]; return record }
for (const [label, over, reason, status] of [
  ["shows the thread active", resumeWith({ thread: thread({ status: { type: "active", activeFlags: [] } }) }), "busy", "busy"],
  ["shows the thread in Plan Mode", resumeWith({ thread: thread() }, { mode: "plan", settings: {} }), "plan", "idle"],
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
  ["shows a status the read did not", resumeWith({ thread: thread({ status: { type: "systemError" } }) }), "unknown", "unknown"],
  ["shows another provider than the bound one", resumeWith({ thread: thread({ modelProvider: "other" }) }), "stale_binding", "idle"],
  ["shows a child", resumeWith({ thread: thread({ parentThreadId: "p" }) }), "child", "idle"],
]) {
  test(`a read whose resume answer ${label} refuses with ${reason}, and reads no turn`, async () => {
    const { result, methods } = await observeWith(over)
    assert.deepEqual(result, { reason, observed: { status, stopped: false, plan: reason === "plan" ? true : null } })
    assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/resume"], "the resume answer ends the reading")
  })
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

// A lookup of the newest turn that fails, or answers in a way that is not the documented one, leaves the thread unread.
test("a lookup of the newest turn that fails or is malformed leaves the thread unread: offline", async () => {
  for (const [label, answer] of [
    ["an error reply", () => ({ error: { code: -32000, message: "no" } })],
    ["data that is not a list", () => ok({ data: "none", nextCursor: null })],
    ["no data", () => ok({})],
    ["a connection that drops", (message, connection) => { connection.socket.destroy(); return undefined }],
  ]) {
    const { result } = await observeWith({ "thread/turns/list": answer })
    assert.equal(result.reason, "offline", label)
  }
})

// A status is looked up in a table, and a name that Object.prototype has (`constructor`, `toString`) is not a status: it is
// unknown, a string, like any other that the table lacks.
test("a thread status that is a property name of every object is unknown, not a value from the prototype", async () => {
  for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const viaRead = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type } }) }) })
    assert.deepEqual(viaRead.result, { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } }, `read: ${type}`)
    const viaResume = await observeWith({ "thread/resume": () => ok({ thread: thread({ status: { type } }), collaborationMode: { mode: "default", settings: {} } }) })
    assert.deepEqual(viaResume.result, { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } }, `resume: ${type}`)
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

test("a server that cannot be reached, or that sends a malformed answer, is offline", async () => {
  const gone = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.equal((await gone.observe()).reason, "offline")
  const { result } = await observeWith({ "thread/loaded/list": () => ok({ data: "x" }) })
  assert.equal(result.reason, "offline")
})

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
