// A fake Codex app-server control socket for the tests: a real Unix socket that speaks the WebSocket handshake and
// JSON-RPC frames, answers `initialize` itself and hands every other request to the test's handler. It is a test
// double for the wire only; what a real app-server answers is the live run's question, not this file's.
import { createHash } from "node:crypto"
import { unlinkSync } from "node:fs"
import net from "node:net"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// An unmasked server frame.
export function serverFrame(opcode, payload) {
  const body = Buffer.from(payload)
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 0xff])
  return Buffer.concat([head, body])
}

// One masked client frame from the front of `buffer`: { opcode, payload, size } or null.
function clientFrame(buffer) {
  if (buffer.length < 2) return null
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4 }
  if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
  const masked = (buffer[1] & 0x80) !== 0
  const mask = masked ? buffer.subarray(offset, offset + 4) : null
  if (masked) offset += 4
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  return { opcode: buffer[0] & 0x0f, masked, payload, size: offset + length }
}

// handler(message, connection) returns { result } or { error } to reply, or nothing to stay silent. `status` replaces the status
// line of the upgrade answer, and `headers` rewrites its header lines (a list of "Name: value" strings) before they are sent;
// the answer is written as Latin-1.
export async function fakeAppServer(path, handler, { accept = true, initialize = true, status = "HTTP/1.1 101 Switching Protocols", headers = lines => lines } = {}) {
  const log = []
  const heads = []
  const state = { connections: 0, open: 0, closes: 0, unmasked: 0, initialized: 0, pongs: [], replies: [], current: null }
  const server = net.createServer(socket => {
    state.connections += 1
    state.open += 1
    state.current = socket
    let buffer = Buffer.alloc(0)
    let upgraded = false
    const send = value => socket.write(serverFrame(0x1, JSON.stringify(value)))
    socket.on("close", () => { state.open -= 1; state.closes += 1 })
    socket.on("error", () => {})
    socket.on("data", async chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n")
        if (end < 0) return
        const text = buffer.subarray(0, end).toString("latin1")
        buffer = buffer.subarray(end + 4)
        heads.push(text)
        const key = /sec-websocket-key:\s*(\S+)/i.exec(text)?.[1]
        const proof = createHash("sha1").update(`${key}${GUID}`).digest("base64")
        // Latin-1, so that one character is one byte on the wire and a test can put any single byte in a header.
        socket.write(Buffer.from([status, ...headers(["Upgrade: websocket", "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept ? proof : "wrong"}`]), "", ""].join("\r\n"), "latin1"))
        upgraded = true
      }
      for (let frame = clientFrame(buffer); frame; frame = clientFrame(buffer)) {
        buffer = buffer.subarray(frame.size)
        if (!frame.masked) state.unmasked += 1
        if (frame.opcode === 0x8) { socket.end(); return }
        if (frame.opcode === 0xa) state.pongs.push(frame.payload.toString("utf8"))
        if (frame.opcode !== 0x1) continue
        const message = JSON.parse(frame.payload.toString("utf8"))
        if (message.method === undefined) { state.replies.push(message); continue }
        if (message.method === "initialized") { state.initialized += 1; continue }
        log.push({ method: message.method, params: message.params })
        const answer = message.method === "initialize" && initialize
          ? { result: { userAgent: "fake", codexHome: "/tmp/fake" } }
          : await handler(message, { send, socket, state })
        if (answer) send({ id: message.id, ...answer })
      }
    })
  })
  try { unlinkSync(path) } catch { /* not there */ }
  await new Promise(resolve => server.listen(path, resolve))
  return {
    log, heads, state,
    methods: () => log.map(entry => entry.method),
    async close() { state.current?.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}
