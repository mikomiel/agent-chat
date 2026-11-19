import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertPrivateDirectory, connect, connectOrStart, MAX_LINE, paths, serve } from "../lib/ipc.js"

function privateDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "acc-"))
  chmodSync(dir, 0o700)
  return dir
}
const cleanup = dir => rmSync(dir, { recursive: true, force: true })

test("socket and lock paths are stable per session and stay inside the directory", () => {
  const dir = privateDirectory()
  try {
    const first = paths(dir, "session-1")
    assert.deepEqual(paths(dir, "session-1"), first)
    assert.notEqual(paths(dir, "session-2").socket, first.socket)
    assert.ok(first.socket.startsWith(`${dir}/claude-`) && first.socket.endsWith(".sock"))
    assert.ok(first.lock.startsWith(`${dir}/claude-`) && first.lock.endsWith(".lock"))
    assert.doesNotMatch(first.socket, /session-1/)
  } finally { cleanup(dir) }
})

test("a directory that leaves no room for a socket name is refused", () => {
  assert.throws(() => paths(`/tmp/${"d".repeat(120)}`, "session-1"), { code: "CHAT_SOCKET_PATH" })
})

test("only a private directory owned by this user may hold the socket", () => {
  const dir = privateDirectory()
  try {
    assertPrivateDirectory(dir)
    chmodSync(dir, 0o755)
    assert.throws(() => assertPrivateDirectory(dir), { code: "CHAT_SOCKET_DIRECTORY" })
    chmodSync(dir, 0o770)
    assert.throws(() => assertPrivateDirectory(dir), { code: "CHAT_SOCKET_DIRECTORY" })
    chmodSync(dir, 0o700)
    const link = join(dir, "link")
    symlinkSync(dir, link)
    assert.throws(() => assertPrivateDirectory(link), { code: "CHAT_SOCKET_DIRECTORY" })
    assert.throws(() => assertPrivateDirectory(join(dir, "missing")), { code: "ENOENT" })
  } finally { cleanup(dir) }
})

test("a socket serves one request per connection and is owner-only", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const listener = await serve(socket, async (first, link) => { await link.send({ echo: first.value }) })
  try {
    assert.equal(statSync(socket).mode & 0o777, 0o600)
    const link = await connect(socket)
    assert.deepEqual(await link.call({ value: 7 }, 2000), { echo: 7 })
    link.close()
  } finally { listener.close(); cleanup(dir) }
})

test("a handler can read follow-up frames from the same connection", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  let seen
  const listener = await serve(socket, async (first, link) => {
    await link.send({ ready: first.op })
    seen = await link.next(2000)
    await link.send({ ok: true })
  })
  try {
    const link = await connect(socket)
    assert.deepEqual(await link.call({ op: "turn" }, 2000), { ready: "turn" })
    assert.deepEqual(await link.call({ op: "done" }, 2000), { ok: true })
    assert.deepEqual(seen, { op: "done" })
    link.close()
  } finally { listener.close(); cleanup(dir) }
})

test("a malformed, non-object or oversized frame ends the connection", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  let handled = 0
  const listener = await serve(socket, async () => { handled += 1 })
  const closes = payload => new Promise(resolve => {
    const raw = net.createConnection(socket)
    raw.on("error", () => {})
    raw.on("close", () => resolve(true))
    raw.on("connect", () => raw.write(payload))
  })
  try {
    assert.equal(await closes("{not json\n"), true)
    assert.equal(await closes("[1,2]\n"), true)
    assert.equal(await closes("null\n"), true)
    assert.equal(await closes(`{"pad":"${"x".repeat(MAX_LINE + 10)}"}\n`), true)
    assert.equal(handled, 0)
  } finally { listener.close(); cleanup(dir) }
})

test("a live receiver is never taken over", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const listener = await serve(socket, async () => {})
  try {
    await assert.rejects(serve(socket, async () => {}), { code: "CHAT_RECEIVER_RUNNING" })
    const link = await connect(socket)
    link.close()
  } finally { listener.close(); cleanup(dir) }
})

test("a path that is not a socket is never replaced", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    writeFileSync(socket, "not a socket")
    await assert.rejects(serve(socket, async () => {}), { code: "CHAT_SOCKET_UNSAFE" })
  } finally { cleanup(dir) }
})

test("the socket left by a killed receiver is replaced", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const child = spawn(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))", socket],
  { stdio: ["ignore", "pipe", "ignore"] })
  try {
    await new Promise(resolve => child.stdout.once("data", resolve))
    const exited = new Promise(resolve => child.once("exit", resolve))
    child.kill("SIGKILL")
    await exited
    assert.ok(statSync(socket).isSocket(), "a killed process leaves its socket file")
    const listener = await serve(socket, async (first, link) => { await link.send({ fresh: true }) })
    try {
      const link = await connect(socket)
      assert.deepEqual(await link.call({}, 2000), { fresh: true })
      link.close()
    } finally { listener.close() }
  } finally { cleanup(dir) }
})

test("closing the listener removes the socket so a resumed session can bind another", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    const first = await serve(socket, async () => {})
    first.close()
    assert.throws(() => statSync(socket), { code: "ENOENT" })
    const second = await serve(socket, async () => {})
    second.close()
  } finally { cleanup(dir) }
})

test("a connect to nothing fails with a code the caller can read", async () => {
  const dir = privateDirectory()
  try { await assert.rejects(connect(paths(dir, "session-1").socket), { code: "ENOENT" }) }
  finally { cleanup(dir) }
})

// A connect double: it refuses until `start` ran, then answers.
function startable() {
  const state = { started: 0, up: false, connects: 0 }
  return {
    state,
    start: () => { state.started += 1; setImmediate(() => { state.up = true }) },
    connectImpl: async () => {
      state.connects += 1
      if (!state.up) throw Object.assign(new Error("absent"), { code: "ENOENT" })
      return { call() {}, close() {}, link: true }
    },
  }
}
const fastClock = () => {
  let clock = 0
  return { now: () => clock, sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)) } }
}

test("an existing receiver is used without starting another", async () => {
  const dir = privateDirectory()
  const { state, start, connectImpl } = startable()
  state.up = true
  try {
    const link = await connectOrStart(paths(dir, "s"), { start, connectImpl, ...fastClock() })
    assert.equal(link.link, true)
    assert.equal(state.started, 0)
  } finally { cleanup(dir) }
})

test("a missing receiver is started once and the hook connects to it", async () => {
  const dir = privateDirectory()
  const { state, start, connectImpl } = startable()
  try {
    const link = await connectOrStart(paths(dir, "s"), { start, connectImpl, ...fastClock() })
    assert.equal(link.link, true)
    assert.equal(state.started, 1)
  } finally { cleanup(dir) }
})

test("concurrent hooks start one receiver between them", async () => {
  const dir = privateDirectory()
  const { state, start, connectImpl } = startable()
  const clock = fastClock()
  try {
    const where = paths(dir, "s")
    const links = await Promise.all([1, 2, 3].map(() => connectOrStart(where, { start, connectImpl, ...clock })))
    assert.equal(links.length, 3)
    assert.equal(state.started, 1)
  } finally { cleanup(dir) }
})

test("a stale start lock is taken over, a fresh one is respected", async () => {
  const dir = privateDirectory()
  const where = paths(dir, "s")
  try {
    writeFileSync(where.lock, "")
    const old = new Date(Date.now() - 120_000)
    utimesSync(where.lock, old, old)
    const stale = startable()
    await connectOrStart(where, { ...stale, ...fastClock(), now: Date.now })
    assert.equal(stale.state.started, 1)

    writeFileSync(where.lock, "")
    const fresh = startable()
    await assert.rejects(
      connectOrStart(where, { ...fresh, ...fastClock(), now: (() => { let t = Date.now(); return () => (t += 1000) })(), startMs: 3000 }),
      { code: "CHAT_RECEIVER_UNAVAILABLE" },
    )
    assert.equal(fresh.state.started, 0, "a fresh lock means another hook is already starting it")
  } finally { cleanup(dir) }
})

test("a receiver that never appears ends the wait with a fixed code", async () => {
  const dir = privateDirectory()
  try {
    await assert.rejects(
      connectOrStart(paths(dir, "s"), {
        start: () => {}, connectImpl: async () => { throw Object.assign(new Error("absent"), { code: "ECONNREFUSED" }) },
        ...fastClock(), startMs: 1000,
      }),
      { code: "CHAT_RECEIVER_UNAVAILABLE" },
    )
  } finally { cleanup(dir) }
})

test("an unexpected connect error is not retried as absence", async () => {
  const dir = privateDirectory()
  let started = 0
  try {
    await assert.rejects(
      connectOrStart(paths(dir, "s"), {
        start: () => { started += 1 },
        connectImpl: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
        ...fastClock(),
      }),
      { code: "EACCES" },
    )
    assert.equal(started, 0)
  } finally { cleanup(dir) }
})
