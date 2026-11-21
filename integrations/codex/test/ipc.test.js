import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import net from "node:net"
import { createInterface } from "node:readline"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertPrivateDirectory, connect, connectOrStart, MAX_LINE, paths, serve } from "../lib/ipc.js"
import { processStartTime } from "../lib/process.js"
import { trustedSocket } from "../lib/trust.js"

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
    assert.ok(first.socket.startsWith(`${dir}/codex-`) && first.socket.endsWith(".sock"))
    assert.ok(first.lock.startsWith(`${dir}/codex-`) && first.lock.endsWith(".lock"))
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

// A socket file with no listener behind it: what a killed receiver leaves.
async function staleSocket(socket) {
  const child = spawn(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))", socket],
  { stdio: ["ignore", "pipe", "ignore"] })
  await new Promise(resolve => child.stdout.once("data", resolve))
  const exited = new Promise(resolve => child.once("exit", resolve))
  child.kill("SIGKILL")
  await exited
  assert.ok(statSync(socket).isSocket(), "a killed process leaves its socket file")
}

test("two receivers recovering one stale socket at once leave exactly one live listener", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    await staleSocket(socket)
    const answers = ["first", "second"]
    const attempts = await Promise.allSettled(answers.map(name => serve(socket, async (_request, link) => { await link.send({ name }) })))
    const won = attempts.filter(attempt => attempt.status === "fulfilled")
    const lost = attempts.filter(attempt => attempt.status === "rejected")
    assert.equal(won.length, 1, "one receiver binds")
    assert.equal(lost.length, 1)
    assert.equal(lost[0].reason.code, "CHAT_RECEIVER_RUNNING", "the other stops as a running receiver")
    try {
      const link = await connect(socket)
      assert.ok(answers.includes((await link.call({}, 2000)).name), "the surviving listener is the one that answers")
      link.close()
    } finally { for (const attempt of won) attempt.value.close() }
    assert.throws(() => statSync(`${socket}.bind`), { code: "ENOENT" }, "the bind lock is released")
  } finally { cleanup(dir) }
})

test("only a refused connection proves the listener gone: any other probe result is a running receiver", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    await staleSocket(socket)
    for (const code of ["CHAT_RECEIVER_TIMEOUT", "EAGAIN", "EACCES", "ECONNRESET"]) {
      const inconclusive = async () => { throw Object.assign(new Error(code), { code }) }
      await assert.rejects(serve(socket, async () => {}, { connectImpl: inconclusive }), { code: "CHAT_RECEIVER_RUNNING" }, code)
      assert.ok(statSync(socket).isSocket(), `${code}: the path was not unlinked`)
      assert.throws(() => statSync(`${socket}.bind`), { code: "ENOENT" }, `${code}: the bind lock is released`)
    }
    const listener = await serve(socket, async () => {})
    listener.close()
  } finally { cleanup(dir) }
})

// ---- closing a listener ----------------------------------------------------------------------------------------
// A Node listener unlinks, when it closes, the name it was bound under. The receiver binds under a private name, so
// a receiver that closes after its successor took the path cannot remove the successor's socket.

test("a receiver that closes after its successor bound the path leaves the successor's socket", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    const old = await serve(socket, async (_request, link) => { await link.send({ owner: "old" }) })
    unlinkSync(socket) // the old path goes (a cleaner, an operator), and a successor takes it while the old receiver still runs
    const successor = await serve(socket, async (_request, link) => { await link.send({ owner: "successor" }) })
    try {
      old.close()
      const link = await connect(socket)
      assert.deepEqual(await link.call({}, 2000), { owner: "successor" }, "the successor's socket still exists and answers")
      link.close()
    } finally { successor.close() }
    assert.deepEqual(readdirSync(dir), [], "and its own close removes it")
  } finally { cleanup(dir) }
})

// Removing the path takes two system calls, a check and an unlink, and a successor publishes its socket under the bind
// lock. So the old receiver removes under that lock too, and when the lock is held it removes nothing.
test("a close that finds the bind lock held leaves the public path and the lock alone, and still closes the listener", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const gate = `${socket}.bind`
  try {
    const old = await serve(socket, async (_request, link) => { await link.send({ owner: "old" }) })
    const line = `${process.pid} ${processStartTime(process.pid) ?? "-"} successor` // a successor is publishing: it holds the lock
    writeFileSync(gate, line)
    old.close()
    assert.ok(statSync(socket).isSocket(), "the path is left for the lock holder: it may already be the successor's")
    assert.equal(readFileSync(gate, "utf8"), line, "and the lock is not the old receiver's to remove")
    await assert.rejects(connect(socket), { code: "ECONNREFUSED" }, "the listener itself is closed")
    unlinkSync(gate) // the lock holder is done; the dead socket file it leaves is the next serve's to recover
    const next = await attempt(socket)
    try { assert.ok(next.listener, next.code) } finally { next.listener?.close() }
  } finally { cleanup(dir) }
})

test("a close takes the bind lock only for its own check and releases it", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    const old = await serve(socket, async (_request, link) => { await link.send({ owner: "old" }) })
    old.close()
    assert.deepEqual(readdirSync(dir), [], "no socket and no lock are left")
    const next = await attempt(socket)
    try { assert.ok(next.listener, "a successor takes the path at once") } finally { next.listener?.close() }
  } finally { cleanup(dir) }
})

test("a listener leaves only its socket in the directory while it runs, and nothing once it is closed", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    const listener = await serve(socket, async (_request, link) => { await link.send({ ok: true }) })
    assert.deepEqual(readdirSync(dir), [socket.split("/").pop()], "no private bind name and no lock are left")
    assert.equal(statSync(socket).mode & 0o777, 0o600)
    const link = await connect(socket)
    assert.deepEqual(await link.call({}, 2000), { ok: true })
    link.close()
    listener.close()
    listener.close() // closing twice is harmless, and still removes nothing that is not its own
    assert.deepEqual(readdirSync(dir), [])
  } finally { cleanup(dir) }
})

// ---- the bind lock ---------------------------------------------------------------------------------------------
// The lock line is `<pid> <start time, or -> <token>`; a lock is taken over only when that exact process is gone.

const age = (path, ms = 60_000) => { const old = new Date(Date.now() - ms); utimesSync(path, old, old) }
const attempt = (socket, options) => serve(socket, async (_request, link) => { await link.send({ pid: process.pid }) }, options)
  .then(listener => ({ listener }), error => ({ code: error.code }))
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise(resolve => child.once("exit", resolve))
  return child.pid
}
const leftovers = dir => readdirSync(dir).filter(name => name.includes(".bind"))

test("a lock whose holder line cannot be read counts as held, whatever its age", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const gate = `${socket}.bind`
  try {
    for (const line of ["", "not a holder line", "1234", "0 - t", "abc - t", `${process.pid} - t extra`]) {
      writeFileSync(gate, line)
      for (const old of [false, true]) {
        if (old) age(gate)
        const result = await attempt(socket)
        try { assert.equal(result.code, "CHAT_RECEIVER_RUNNING", JSON.stringify(line)) } finally { result.listener?.close() }
        assert.equal(readFileSync(gate, "utf8"), line, "the other receiver's lock is not ours to remove")
      }
      unlinkSync(gate)
    }
  } finally { cleanup(dir) }
})

test("a lock held by a running process is never taken over, however old it is", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const gate = `${socket}.bind`
  try {
    const line = `${process.pid} ${processStartTime(process.pid) ?? "-"} token`
    writeFileSync(gate, line)
    age(gate, 3_600_000)
    const result = await attempt(socket)
    try { assert.equal(result.code, "CHAT_RECEIVER_RUNNING") } finally { result.listener?.close() }
    assert.equal(readFileSync(gate, "utf8"), line)
  } finally { cleanup(dir) }
})

test("a lock whose holder is gone is taken over at once, and leaves nothing behind", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const gate = `${socket}.bind`
  try {
    writeFileSync(gate, `${await deadPid()} - token`) // fresh: the holder's death is the proof, not the age
    const result = await attempt(socket)
    assert.ok(result.listener, result.code)
    try {
      const link = await connect(socket)
      assert.deepEqual(await link.call({}, 2000), { pid: process.pid })
      link.close()
    } finally { result.listener.close() }
    assert.deepEqual(leftovers(dir), [], "no lock and no retired name is left")
  } finally { cleanup(dir) }
})

// The documented limit: a receiver killed between linking the retired name and unlinking the lock leaves both behind.
// Age does not clear them, because an age rule is what let two receivers hold the lock.
test("a retired name left by a killed takeover makes later receivers stand back, and nothing is removed", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const gate = `${socket}.bind`
  try {
    const line = `${await deadPid()} - token`
    const retired = `${gate}.retired-${createHash("sha256").update(line).digest("hex").slice(0, 16)}`
    writeFileSync(gate, line)
    writeFileSync(retired, line)
    age(gate, 3_600_000)
    age(retired, 3_600_000)
    const result = await attempt(socket)
    try { assert.equal(result.code, "CHAT_RECEIVER_RUNNING") } finally { result.listener?.close() }
    assert.equal(readFileSync(gate, "utf8"), line)
    assert.equal(readFileSync(retired, "utf8"), line)
  } finally { cleanup(dir) }
})

test("a pid that now belongs to another process is not the holder: the start time tells them apart", async t => {
  const start = processStartTime(process.pid)
  if (start === null) return t.skip("no /proc: the holder is checked by pid alone")
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  try {
    writeFileSync(`${socket}.bind`, `${process.pid} ${Number(start) + 1} token`)
    const result = await attempt(socket)
    try { assert.ok(result.listener, result.code) } finally { result.listener?.close() }
  } finally { cleanup(dir) }
})

// The contender decides from a reading of the lock, and a successor can take over before it acts. `alive` runs between
// the reading and the removal, so the swap happens exactly there.
test("a contender with an old reading of the lock cannot remove its successor's lock", async () => {
  const dir = privateDirectory()
  const { socket } = paths(dir, "session-1")
  const gate = `${socket}.bind`
  try {
    writeFileSync(gate, `${await deadPid()} - old`)
    const successor = `${process.pid} - successor`
    let swapped = false
    const alive = pid => {
      if (!swapped) { swapped = true; unlinkSync(gate); writeFileSync(gate, successor); return false }
      return pid === process.pid
    }
    const result = await attempt(socket, { alive })
    try { assert.equal(result.code, "CHAT_RECEIVER_RUNNING") } finally { result.listener?.close() }
    assert.ok(swapped)
    assert.equal(readFileSync(gate, "utf8"), successor, "the successor's lock is still there, whole")
    assert.deepEqual(leftovers(dir), [`${socket.split("/").pop()}.bind`], "and nothing else is")
  } finally { cleanup(dir) }
})

// Real processes: the reading and the removal are separate system calls, so only real contention shows the race.
// The contenders stay up between rounds and are told when to start, so a round costs milliseconds.
// One long-lived child that runs `script` and answers each command line on its standard output. `next` resolves its next
// reply, and rejects when the child has exited without one or says nothing for `waitMs`, so a contender that dies
// fails its round instead of leaving the test to wait for the runner's timeout.
function contender(script, waitMs = 10_000) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "ignore"] })
  const lines = []
  const waiting = []
  let gone = null
  createInterface({ input: child.stdout }).on("line", line => { const reader = waiting.shift(); if (reader) reader.resolve(line); else lines.push(line) })
  child.once("close", (code, signal) => { // after its output was read to the end
    gone = new Error(`contender ${child.pid} exited (${code ?? signal}) without replying`)
    for (const reader of waiting.splice(0)) reader.reject(gone)
  })
  const next = () => new Promise((resolve, reject) => {
    const line = lines.shift()
    if (line !== undefined) return resolve(line)
    if (gone) return reject(gone)
    const timer = setTimeout(() => reject(new Error(`contender ${child.pid} did not reply within ${waitMs} ms`)), waitMs)
    waiting.push({ resolve: reply => { clearTimeout(timer); resolve(reply) }, reject: error => { clearTimeout(timer); reject(error) } })
  })
  return { child, next }
}

test("a contender that exits without replying, or stays silent, fails its round instead of hanging", async () => {
  const dies = contender("process.stdin.once('data', () => process.exit(3))", 2000)
  const silent = contender("setInterval(() => {}, 1000)", 200)
  try {
    dies.child.stdin.write("go\n")
    await assert.rejects(dies.next(), /exited \(3\) without replying/)
    await assert.rejects(dies.next(), /exited \(3\) without replying/, "a later wait on the dead child fails at once too")
    await assert.rejects(silent.next(), /did not reply within 200 ms/)
  } finally {
    for (const { child } of [dies, silent]) child.kill("SIGKILL")
  }
})

test("receivers in separate processes that all find the same dead lock and dead socket leave exactly one live listener", async () => {
  const script = `
    import { createInterface } from "node:readline"
    import { serve } from ${JSON.stringify(new URL("../lib/ipc.js", import.meta.url).href)}
    let listener = null
    for await (const line of createInterface({ input: process.stdin })) {
      const [command, socket, goAt] = line.split(" ")
      if (command === "release") { listener?.close(); listener = null; console.log("released"); continue }
      while (Date.now() < Number(goAt)) { /* every contender leaves the gate together */ }
      try { listener = await serve(socket, async (_request, link) => { await link.send({ pid: process.pid }) }); console.log("bound") }
      catch (error) { console.log(error.code ?? "error") }
    }
  `
  const ROUNDS = 30
  const dir = privateDirectory()
  const contenders = []
  try {
    // One killed process leaves a dead socket file for every round.
    const sockets = Array.from({ length: ROUNDS }, (_unused, round) => join(dir, `round-${round}.sock`))
    const killed = spawn(process.execPath, ["-e",
      "const net = require('node:net'); const paths = process.argv.slice(1); let up = 0; for (const path of paths) net.createServer().listen(path, () => { if (++up === paths.length) console.log('up') })",
      ...sockets], { stdio: ["ignore", "pipe", "ignore"] })
    await new Promise(resolve => killed.stdout.once("data", resolve))
    const exited = new Promise(resolve => killed.once("exit", resolve))
    killed.kill("SIGKILL")
    await exited
    const dead = await deadPid()
    for (let index = 0; index < 8; index += 1) contenders.push(contender(script))
    for (const [round, socket] of sockets.entries()) {
      writeFileSync(`${socket}.bind`, `${dead} - token`)
      age(`${socket}.bind`)
      const goAt = Date.now() + 25
      for (const { child } of contenders) child.stdin.write(`go ${socket} ${goAt}\n`)
      const said = await Promise.all(contenders.map(({ next }) => next()))
      const winners = contenders.filter((_contender, index) => said[index] === "bound")
      assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(said)}`)
      assert.ok(said.every(word => word === "bound" || word === "CHAT_RECEIVER_RUNNING"), JSON.stringify(said))
      const link = await connect(socket)
      assert.deepEqual(await link.call({}, 2000), { pid: winners[0].child.pid }, `round ${round}: the listener on the path is the winner's`)
      link.close()
      for (const { child } of contenders) child.stdin.write("release\n")
      await Promise.all(contenders.map(({ next }) => next()))
    }
  } finally {
    for (const { child } of contenders) { child.stdin.end(); child.kill("SIGKILL") }
    await Promise.all(contenders.map(({ child }) => new Promise(resolve => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve()))))
    cleanup(dir)
  }
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

// ---- a client trusts the path to the receiver before it connects ------------------------------------------------------

// A private state directory that sits below `parentMode`, the way an operator might have put it.
function nested(parentMode) {
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  const parent = join(root, "p")
  mkdirSync(parent)
  chmodSync(parent, parentMode)
  const state = join(parent, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  return { root, state }
}

test("the state directory must also sit below directories that nobody else can change", () => {
  for (const mode of [0o777, 0o775, 0o757]) {
    const { root, state } = nested(mode)
    try {
      assert.throws(() => assertPrivateDirectory(state), { code: "CHAT_SOCKET_DIRECTORY" }, mode.toString(8))
    } finally { cleanup(root) }
  }
  for (const mode of [0o700, 0o755, 0o1777]) {
    const { root, state } = nested(mode)
    try { assertPrivateDirectory(state) } finally { cleanup(root) }
  }
})

test("a client never connects to a socket below a directory that others can change, or to one that another user owns", async () => {
  const { root, state } = nested(0o777)
  const dir = privateDirectory()
  const served = []
  let handled = 0
  try {
    for (const where of [paths(state, "session-1").socket, paths(dir, "session-1").socket]) {
      served.push(await serve(where, async (_first, link) => { handled += 1; await link.send({ ok: true }) }))
    }
    await assert.rejects(connect(paths(state, "session-1").socket), { code: "CHAT_SOCKET_UNTRUSTED" }, "a directory that others can write")
    const other = path => trustedSocket(path, {
      refuse: "CHAT_SOCKET_UNTRUSTED",
      lstat: target => { const info = lstatSync(target); return target.endsWith(".sock") ? Object.create(info, { uid: { value: process.geteuid() + 1 } }) : info },
    })
    await assert.rejects(connect(paths(dir, "session-1").socket, { trust: other }), { code: "CHAT_SOCKET_UNTRUSTED" }, "a socket of another user")
    assert.equal(handled, 0, "neither receiver was ever connected to")
    const link = await connect(paths(dir, "session-1").socket) // control: the same socket, trusted, is reachable
    assert.deepEqual(await link.call({ hello: 1 }, 2000), { ok: true })
    assert.equal(handled, 1, "and it was asked")
    link.close()
  } finally { for (const listener of served) listener.close(); cleanup(root); cleanup(dir) }
})

test("an untrusted socket is not an absent one: no receiver is started on top of it", async () => {
  const { root, state } = nested(0o777)
  let started = 0
  const listener = await serve(paths(state, "session-1").socket, async (_first, link) => { await link.send({ ok: true }) })
  try {
    await assert.rejects(connectOrStart(paths(state, "session-1"), { start: () => { started += 1 }, ...fastClock() }), { code: "CHAT_SOCKET_UNTRUSTED" })
    assert.equal(started, 0)
  } finally { listener.close(); cleanup(root) }
})

