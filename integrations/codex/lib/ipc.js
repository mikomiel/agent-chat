// The local transport between a hook command and its session's receiver:
// newline-delimited JSON over a Unix socket inside the private state directory.
//
// The state directory is the one the product's worker already requires to be
// owned by the user with mode 0700, so the socket needs no other access control.
// That holds only while nobody else can swap the directory or the socket, so the
// directory and every one above it must be unchangeable by others, and a client
// connects only to a socket of the current user that passed the same check as the
// app-server socket (lib/trust.js). This module owns paths, framing and the
// connect-or-start handshake. It owns no chat policy.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, closeSync, linkSync, lstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import net from "node:net"
import { dirname, join } from "node:path"
import { HARNESS } from "./config.js"
import { ownerAlive, processStartTime } from "./process.js"
import { trustedDirectory, trustedSocket } from "./trust.js"

export const MAX_LINE = 64 * 1024
// sun_path holds 104 bytes on macOS and 108 on Linux, including the terminator.
const MAX_PATH_BYTES = 100
const LOCK_STALE_MS = 30_000
const ABSENT = new Set(["ENOENT", "ECONNREFUSED"])

const refusal = code => Object.assign(new Error(code), { code })

export function paths(directory, sessionId) {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  const socket = join(directory, `${HARNESS}-${digest}.sock`)
  if (Buffer.byteLength(socket) > MAX_PATH_BYTES) throw refusal("CHAT_SOCKET_PATH")
  return { socket, lock: join(directory, `${HARNESS}-${digest}.lock`) }
}

export function assertPrivateDirectory(directory) {
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o700) {
    throw refusal("CHAT_SOCKET_DIRECTORY")
  }
  trustedDirectory(directory, { refuse: "CHAT_SOCKET_DIRECTORY" }) // and nobody else can change a directory above it
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

// A client connection: `call` sends one object and waits for one reply. The path is trusted first, and the connection goes to
// the checked real path: a socket that another user owns, or that sits below a directory others can change, is refused as
// CHAT_SOCKET_UNTRUSTED before anything is connected to. `trust` replaces the check, for tests.
const trustSocket = path => trustedSocket(path, { refuse: "CHAT_SOCKET_UNTRUSTED" })
export function connect(path, { timeoutMs = 1500, trust = trustSocket } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try { target = trust(path).path } catch (error) { return reject(error) }
    const socket = net.createConnection(target)
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

// The bind lock names its holder, `<pid> <start time, or "-"> <token>`, and is created whole: written to a private
// temporary file and linked into place, so no reader sees a half-written one. It is taken over only when that exact
// process is gone (the receiver's owner check: the pid is not running, or the pid now has another start time). A lock
// whose holder line cannot be read counts as held.
const holderLine = () => `${process.pid} ${processStartTime(process.pid) ?? "-"} ${randomUUID()}`

function holderGone(line, { alive, startTime }) {
  const [pid, start, token, ...rest] = line.split(" ")
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 1 || !start || !token || rest.length) return false
  if (!alive(id)) return true
  const current = start === "-" ? null : startTime(id)
  return current !== null && current !== start
}

// Remove the lock that was just read, if its holder is gone. True when the caller should try to take the lock again.
// The removal cannot hit a successor's lock: the lock is first given a second name that only the first contender to
// retire this holder line can create, and the lock itself is unlinked only if what that name holds is the line that
// was read. A contender with an old reading that finds a successor's lock under the lock name only adds and drops
// its own extra name; the successor's lock never moves.
function retire(path, deps) {
  let seen
  try { seen = readFileSync(path, "utf8") } catch (error) { return error.code === "ENOENT" }
  if (!holderGone(seen, deps)) return false
  const retired = `${path}.retired-${createHash("sha256").update(seen).digest("hex").slice(0, 16)}`
  try { linkSync(path, retired) } catch (error) { return error.code === "ENOENT" } // taken by another contender: stand back
  try {
    if (readFileSync(retired, "utf8") === seen) unlinkSync(path)
  } catch { /* the lock went with its holder */ } finally {
    try { unlinkSync(retired) } catch { /* already gone */ }
  }
  return true
}

function takeBindLock(path, deps) {
  const temporary = `${path}.${randomUUID()}`
  writeFileSync(temporary, holderLine(), { flag: "wx", mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { linkSync(temporary, path); return true } catch (error) { if (error.code !== "EEXIST") throw error }
      if (!retire(path, deps)) return false
    }
    return false
  } finally { try { unlinkSync(temporary) } catch { /* already gone */ } }
}

// Serve one handler per connection. The first frame selects the request; the
// handler may reply, then read follow-up frames from the same session. A socket
// left by a dead receiver is removed; a live one is never taken over.
//
// Two receivers can start for one session (the hook's start lock is released after
// its own wait, whether or not the child has bound). So the probe, the unlink and the
// bind run under the bind lock, a file next to the socket, held until the listener is up: a
// second receiver then finds the first one bound and stops, and cannot unlink a live
// listener's path. The lock is not the one the hooks hold to start a receiver. A
// receiver that cannot take it exits as a running one.
//
// The listener is bound under a private name and linked to the public path, then the private name is dropped. Closing
// a Node listener unlinks the name it was bound under, whatever is there by then, so with the public path as that
// name a receiver that closed late would remove its successor's socket. With the private name, closing touches
// nothing public: `close` removes the public path itself, only while that path is still this listener's file, and
// only under the bind lock, so no successor can publish its socket between the check and the removal.
export async function serve(path, handler, { connectImpl = connect, alive = ownerAlive, startTime = processStartTime } = {}) {
  const gate = `${path}.bind`
  if (!takeBindLock(gate, { alive, startTime })) throw refusal("CHAT_RECEIVER_RUNNING")
  let server
  let own // dev and ino of the public path as this listener linked it
  try {
    let existing = null
    try { existing = lstatSync(path) } catch (error) { if (error.code !== "ENOENT") throw error }
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.geteuid()) throw refusal("CHAT_SOCKET_UNSAFE")
      // Only a refused connection (or a path that vanished) proves the listener is gone. A timeout or any other
      // error can come from a live receiver, so it is treated as one.
      const evidence = await connectImpl(path, { timeoutMs: 500 }).then(link => { link.close(); return "live" }, error => error?.code)
      if (!ABSENT.has(evidence)) throw refusal("CHAT_RECEIVER_RUNNING")
      try { unlinkSync(path) } catch (error) { if (error.code !== "ENOENT") throw error }
    }
    server = net.createServer(async socket => {
      const session = channel(socket)
      try {
        const first = await session.next(5000)
        if (first) await handler(first, session)
      } catch { /* a handler failure ends only this connection */ }
      session.close()
    })
    const bound = join(dirname(path), randomBytes(6).toString("hex"))
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(bound, () => { server.off("error", reject); resolve() })
    })
    try {
      chmodSync(bound, 0o600)
      linkSync(bound, path) // EEXIST: something took the path under the lock, so a receiver is running
      own = lstatSync(path, { bigint: true })
    } catch (error) {
      server.close()
      throw error.code === "EEXIST" ? refusal("CHAT_RECEIVER_RUNNING") : error
    } finally {
      try { unlinkSync(bound) } catch { /* already gone */ }
    }
  } finally {
    try { unlinkSync(gate) } catch { /* already gone */ }
  }
  return {
    // The check of the path and its removal are two system calls, so they run under the bind lock, which every receiver
    // holds while it publishes a socket: no successor can link its socket between them. A close that cannot take the
    // lock leaves the public path alone, because a successor may be publishing; a dead socket file is what the next
    // `serve` already recovers. The listener closes either way.
    close() {
      let held = false
      try { held = takeBindLock(gate, { alive, startTime }) } catch { /* no lock, no unlink */ }
      if (held) {
        try {
          const now = lstatSync(path, { bigint: true })
          if (now.dev === own.dev && now.ino === own.ino) unlinkSync(path)
        } catch { /* already gone */ } finally {
          try { unlinkSync(gate) } catch { /* already gone */ }
        }
      }
      server.close()
    },
  }
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
