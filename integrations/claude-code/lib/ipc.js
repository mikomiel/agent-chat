// The local transport between a hook command and its session's receiver:
// newline-delimited JSON over a Unix socket inside the private state directory.
//
// The state directory is the one the product's worker already requires to be
// owned by the user with mode 0700, so the socket needs no other access control.
// This module owns paths, framing and the connect-or-start handshake. It owns no
// chat policy.
import { createHash } from "node:crypto"
import { chmodSync, closeSync, lstatSync, openSync, statSync, unlinkSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"

export const MAX_LINE = 64 * 1024
// sun_path holds 104 bytes on macOS and 108 on Linux, including the terminator.
const MAX_PATH_BYTES = 100
const LOCK_STALE_MS = 30_000
const ABSENT = new Set(["ENOENT", "ECONNREFUSED"])

const refusal = code => Object.assign(new Error(code), { code })

export function paths(directory, sessionId) {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  const socket = join(directory, `claude-${digest}.sock`)
  if (Buffer.byteLength(socket) > MAX_PATH_BYTES) throw refusal("CHAT_SOCKET_PATH")
  return { socket, lock: join(directory, `claude-${digest}.lock`) }
}

export function assertPrivateDirectory(directory) {
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o700) {
    throw refusal("CHAT_SOCKET_DIRECTORY")
  }
}

// One socket as an ordered stream of JSON objects. `next` resolves null on close
// or timeout; a malformed or oversized line destroys the socket.
function channel(socket) {
  const queue = []
  const listeners = []
  let waiting = null
  let closed = false
  let buffer = ""
  const give = value => { const resolve = waiting; waiting = null; resolve?.(value) }
  socket.setEncoding("utf8")
  socket.on("data", chunk => {
    buffer += chunk
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let value
      try { value = JSON.parse(line) } catch { socket.destroy(); return }
      if (line.length > MAX_LINE || value === null || typeof value !== "object" || Array.isArray(value)) {
        socket.destroy()
        return
      }
      queue.push(value)
      if (waiting) give(queue.shift())
    }
    if (buffer.length > MAX_LINE) socket.destroy()
  })
  socket.on("error", () => socket.destroy())
  socket.on("close", () => {
    closed = true
    give(null)
    for (const listener of listeners) listener()
  })
  return {
    get closed() { return closed },
    onClose(listener) { listeners.push(listener) },
    send(value) {
      return new Promise(resolve => {
        if (closed) return resolve(false)
        try { socket.write(`${JSON.stringify(value)}\n`, error => resolve(!error)) } catch { resolve(false) }
      })
    },
    next(ms) {
      return new Promise(resolve => {
        if (queue.length) return resolve(queue.shift())
        if (closed) return resolve(null)
        const on = value => { clearTimeout(timer); resolve(value) }
        const timer = setTimeout(() => { if (waiting === on) waiting = null; resolve(null) }, ms)
        waiting = on
      })
    },
    close() { try { socket.end() } catch { /* already closed */ } },
  }
}

// A client connection: `call` sends one object and waits for one reply.
export function connect(path, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    const link = channel(socket)
    const timer = setTimeout(() => { socket.destroy(); reject(refusal("CHAT_RECEIVER_TIMEOUT")) }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve({
        send: link.send,
        next: link.next,
        close: link.close,
        async call(value, ms) {
          if (!(await link.send(value))) throw refusal("CHAT_RECEIVER_CLOSED")
          const reply = await link.next(ms)
          if (reply === null) throw refusal("CHAT_RECEIVER_NO_REPLY")
          return reply
        },
      })
    })
    socket.once("error", error => { clearTimeout(timer); reject(error) })
  })
}

// Serve one handler per connection. The first frame selects the request; the
// handler may reply, then read follow-up frames from the same session. A socket
// left by a dead receiver is removed; a live one is never taken over.
export async function serve(path, handler) {
  let existing = null
  try { existing = lstatSync(path) } catch (error) { if (error.code !== "ENOENT") throw error }
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.geteuid()) throw refusal("CHAT_SOCKET_UNSAFE")
    const live = await connect(path, { timeoutMs: 500 }).then(link => { link.close(); return true }, () => false)
    if (live) throw refusal("CHAT_RECEIVER_RUNNING")
    unlinkSync(path)
  }
  const server = net.createServer(async socket => {
    const session = channel(socket)
    try {
      const first = await session.next(5000)
      if (first) await handler(first, session)
    } catch { /* a handler failure ends only this connection */ }
    session.close()
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => { server.off("error", reject); resolve() })
  })
  chmodSync(path, 0o600)
  return {
    close() {
      server.close()
      try { unlinkSync(path) } catch { /* already gone */ }
    },
  }
}

function takeLock(path, now) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { closeSync(openSync(path, "wx", 0o600)); return true }
    catch (error) {
      if (error.code !== "EEXIST") throw error
      try {
        if (now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return false
        unlinkSync(path)
      } catch { return false }
    }
  }
  return false
}

// Connect to the session's receiver, starting it when none answers. The lock
// serializes concurrent starters so one session never gets two receivers.
export async function connectOrStart(where, {
  start, connectImpl = connect, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, startMs = 4000,
}) {
  const attempt = async () => {
    try { return await connectImpl(where.socket) }
    catch (error) { if (ABSENT.has(error?.code)) return null; throw error }
  }
  const first = await attempt()
  if (first) return first
  const deadline = now() + startMs
  while (now() < deadline) {
    if (takeLock(where.lock, now)) {
      try {
        const raced = await attempt()
        if (raced) return raced
        start()
        while (now() < deadline) {
          await sleep(50)
          const started = await attempt()
          if (started) return started
        }
      } finally {
        try { unlinkSync(where.lock) } catch { /* already gone */ }
      }
      break
    }
    await sleep(50)
    const other = await attempt()
    if (other) return other
  }
  throw refusal("CHAT_RECEIVER_UNAVAILABLE")
}
