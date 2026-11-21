import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLIENT_ID_PREFIX, createThread, isChildThread, MIN_ADD_MS, openAppServer, SETTLE_MS, trustedSocket } from "../lib/appserver.js"
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
    assert.deepEqual(await bound.bind(), { status: "bound", route: true })
    assert.equal(bound.provider, "openai")
    assert.equal(bound.route, true)
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
    assert.equal(bound.route, null)
  })
})

test("bind follows the loaded-list cursor", async () => {
  await withServer(main({
    "thread/loaded/list": message => (message.params.cursor ? ok({ data: [THREAD], nextCursor: null }) : ok({ data: ["a"], nextCursor: "c1" })),
  }), async path => {
    assert.equal((await createThread({ path, threadId: THREAD }).bind()).status, "bound")
  })
})

test("bind refuses every child record before the queue is probed", async () => {
  for (const extra of [{ parentThreadId: "p" }, { agentRole: "worker" }, { ephemeral: true }, { source: "exec" }, { source: { subAgent: "review" } }]) {
    await withServer(main({ "thread/read": () => ok({ thread: thread(extra) }) }), async (path, server) => {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "child" }, JSON.stringify(extra))
      assert.equal(server.methods().includes("thread/queue/delete"), false)
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

test("any probe answer but the documented one turns the route off", async () => {
  for (const answer of [
    () => ({ error: { code: -32601, message: "method not found" } }),
    () => ({ error: { code: -32600, message: "invalid" } }),
    () => ok({ deleted: true }),
    () => ok({}),
    () => ok({ deleted: "no" }),
  ]) {
    await withServer(main({ "thread/queue/delete": answer }), async path => {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "bound", route: false })
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

test("the provider is recorded only for a loaded thread that is not a child, and a probe that fails still leaves it recorded", async () => {
  // The receiver reads it as "a main thread was found": a probe that fails still leaves it recorded.
  await withServer(main({ "thread/queue/delete": (_message, { socket }) => { socket.destroy() } }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unprobed" })
    assert.equal(bound.provider, "openai")
  })
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

// The receiver joins on the answer of one bind alone: a main thread is only ever `bound`, `unprobed` or `stale_binding`.
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
    await withServer(main({ "thread/read": () => ok({ thread: record }) }), async (path, server) => {
      assert.deepEqual(await createThread({ path, threadId: THREAD }).bind(), { status: "unavailable" }, JSON.stringify(record))
      assert.equal(server.methods().includes("thread/queue/delete"), false, "no probe for a record that proves nothing")
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
// `signal` is the call's token: once aborted, nothing the call reads afterwards is recorded.

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check, what) {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await pause(5)
  assert.ok(check(), `${what} never happened`)
}

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

test("a bind that the caller timed out while it was reading records nothing and probes nothing", async () => {
  await withServer(main({
    "thread/read": async () => { await pause(300); return ok({ thread: thread() }) },
  }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    const attempt = new AbortController()
    let reads = 0
    const first = bound.bind({ signal: attempt.signal, onRead: () => { reads += 1 } })
    await eventually(() => server.methods().includes("thread/read"), "the read request")
    attempt.abort() // the caller's time ran out while the read was out
    assert.deepEqual(await first, { status: "unavailable" })
    assert.equal(reads, 0, "the read it finished late is not reported as done")
    assert.equal(bound.provider, null, "a late read does not fix the provider")
    assert.equal(server.methods().includes("thread/queue/delete"), false, "and nothing is probed on its account")
    assert.deepEqual(await bound.bind(), { status: "bound", route: true }, "the next bind starts from nothing")
  })
})

test("a bind that the caller timed out while it was probing cannot record a late negative answer: the next bind probes again", async () => {
  let probes = 0
  await withServer(main({
    "thread/queue/delete": async () => { probes += 1; await pause(300); return probes === 1 ? ok({ deleted: true }) : ok({ deleted: false }) },
  }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    const attempt = new AbortController()
    const first = bound.bind({ signal: attempt.signal })
    await eventually(() => probes === 1, "the first probe request")
    attempt.abort() // the caller stopped waiting; the answer is still on its way, and it is not the documented one
    assert.deepEqual(await first, { status: "unavailable" })
    assert.equal(bound.route, null, "a late negative answer is not recorded as the route")
    assert.deepEqual(await bound.bind(), { status: "bound", route: true })
    assert.equal(probes, 2, "the later bind probed instead of trusting the expired one")
  })
})

// A thread can leave the loaded list between the list request and the read. observe() already reads that as offline.
test("a thread that is listed but reads as notLoaded is unloaded: nothing is probed or recorded, and a child is still a child", async () => {
  await withServer(main({ "thread/read": () => ok({ thread: thread({ status: { type: "notLoaded" } }) }) }), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unloaded" })
    assert.equal(server.methods().includes("thread/queue/delete"), false)
    assert.equal(bound.provider, null)
    assert.equal(bound.route, null)
  })
  await withServer(main({ "thread/read": () => ok({ thread: thread({ parentThreadId: "p", status: { type: "notLoaded" } }) }) }), async path => {
    assert.deepEqual(await createThread({ path, threadId: THREAD }).bind(), { status: "child" })
  })
})

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
      assert.deepEqual(await bound.bind(), { status: "bound", route: true }, "so the next bind is not stale against a provider nobody committed")
      assert.equal(bound.provider, "other")
    })
  })
}

// `owns` is the caller's other way to stop owning an answer: the worker it binds for was retired. It is asked at the same
// checks as the signal, and the last one is the commit's own turn.
for (const [label, probe] of [
  ["answers the documented way", async () => { await pause(300); return ok({ deleted: false }) }],
  ["answers with something else", async () => { await pause(300); return ok({ deleted: true }) }],
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
      assert.deepEqual(await bound.bind({ owns: () => true }), { status: "bound", route: true }, "the next owner binds against nothing the first one left")
      assert.equal(bound.provider, "other")
    })
  })
}

test("a bind whose owner is gone when its read comes back records nothing and says unavailable", async () => {
  await withServer(main(), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind({ owns: () => false }), { status: "unavailable" })
    assert.equal(bound.provider, null)
    assert.equal(bound.route, null)
    assert.deepEqual(await bound.bind({ owns: () => true }), { status: "bound", route: true })
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
  assert.deepEqual(methods, ["initialize", "thread/loaded/list", "thread/read", "thread/turns/list", "thread/resume"])
  assert.deepEqual(server.log.at(-1).params, { threadId: THREAD, excludeTurns: true })
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
  const broken = await observeWith({ "thread/read": () => ok({ thread: thread({ status: { type: "systemError" } }) }) })
  assert.equal(broken.result.reason, "unknown")
})

test("a newest turn that was interrupted is stopped, and the Plan Mode read is not made", async () => {
  const { result, methods } = await observeWith({ "thread/turns/list": () => ok({ data: [{ id: "t1", status: "interrupted" }], nextCursor: null }) })
  assert.deepEqual(result, { reason: "stopped", observed: { status: "idle", stopped: true, plan: null } })
  assert.equal(methods.includes("thread/resume"), false)
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

// ---- wake ------------------------------------------------------------------------------------------------------

function clock(start = 1_000_000) {
  const time = { now: start }
  return { time, now: () => time.now, sleep: async ms => { time.now += ms } }
}
// What a wake reads before it adds: the thread as it is now, the resume answer last. It reads on a connection of its own, so the
// log shows two `initialize` frames: the connection that will carry the add, opened first, and the one for the reading.
const READS = ["thread/loaded/list", "thread/read", "thread/turns/list", "thread/resume"]
const OPENS = ["initialize", "initialize"]
const queueServer = (over = {}) => main({
  "thread/queue/add": message => ok({ queuedSubmission: { id: "q1", input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } }),
  "thread/queue/delete": () => ok({ deleted: false }),
  "thread/items/list": () => ok({ data: [], nextCursor: null }),
  ...over,
})
async function wakeWith(over, { reservation = 5000, text = "queued text", proceed } = {}) {
  return withServer(queueServer(over), async (path, server) => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
    const result = await bound.wake({ text, attemptId: "attempt-9", until: ticks.now() + reservation, ...(proceed ? { proceed } : {}) })
    return { result, log: server.log, methods: server.methods(), ticks }
  })
}

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
  assert.equal(seen[0].threadId, THREAD)
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
    return { request: (method, ...rest) => { events.push(`${number} ${method}`); return link.request(method, ...rest) }, close: () => { events.push(`close ${number}`); link.close() } }
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
      "open 0", "open 1", ...READS.map(method => `1 ${method}`), "close 1",
      "0 thread/queue/add", "0 thread/queue/delete", "0 thread/items/list", "close 0",
    ])
    await eventually(() => server.state.open === 0, "both connections to close")
    assert.equal(server.state.connections, 2, "the reading and the add each had one")
  })
})

test("deleted:true means it never dispatched: deferred, and no confirmation is asked for", async () => {
  const { result, methods } = await wakeWith({ "thread/queue/delete": () => ok({ deleted: true }) })
  assert.deepEqual(result, { outcome: "deferred", reason: "busy" })
  assert.equal(methods.includes("thread/items/list"), false)
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
  assert.deepEqual(await absent.wake({ text: "t", attemptId: "a", until: Date.now() + 5000 }), { outcome: "failed", reason: "native_unavailable" })
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
    const handler = queueServer({ [slow]: async (...args) => { await new Promise(resolve => setTimeout(resolve, 1500)); return slowReplies[slow](...args) } })
    await withServer(handler, async path => {
      const until = Date.now() + SETTLE_MS + 600
      const result = await createThread({ path, threadId: THREAD }).wake({ text: "t", attemptId: "attempt-9", until })
      const left = until - Date.now()
      assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
      assert.ok(left >= SETTLE_MS / 2, `${left} ms of the reservation were left to settle`)
    })
  })
}

test("a connection that never finishes ends the wake SETTLE_MS before the reservation too, with nothing sent", async () => {
  await withServer(() => undefined, async (path, server) => {
    const until = Date.now() + SETTLE_MS + 600
    const result = await createThread({ path, threadId: THREAD }).wake({ text: "t", attemptId: "attempt-9", until })
    const left = until - Date.now()
    assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
    assert.deepEqual(server.methods(), ["initialize"], "nothing past initialize was sent")
    assert.ok(left >= SETTLE_MS / 2, `${left} ms of the reservation were left to settle`)
  }, { initialize: false })
})

test("the wake connection is closed when it is done", async () => {
  await withServer(queueServer({ "thread/queue/delete": () => ok({ deleted: true }) }), async (path, server) => {
    const ticks = clock()
    await createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep }).wake({ text: "t", attemptId: "a", until: ticks.now() + 5000 })
    for (let waited = 0; server.state.open && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(server.state.open, 0)
  })
})

// ---- a wake acts on the newest reading of the thread ------------------------------------------------------------

const active = { "thread/read": () => ok({ thread: thread({ status: { type: "active", activeFlags: [] } }) }) }
const resumeWith = (body, mode = { mode: "default", settings: {} }) => ({ "thread/resume": () => ok({ ...body, collaborationMode: mode }) })

// The resume answer is the newest record: it must show the thread idle in default mode and agree with the read.
for (const [label, over, reason] of [
  ["the resume answer shows the thread active", resumeWith({ thread: thread({ status: { type: "active", activeFlags: [] } }) }), "busy"],
  ["the resume answer shows the thread in Plan Mode", resumeWith({ thread: thread() }, { mode: "plan", settings: {} }), "plan"],
  ["the resume answer has no collaboration mode", { "thread/resume": () => ok({ thread: thread() }) }, "unknown"],
  ["the resume answer has a mode that is not known", resumeWith({ thread: thread() }, { mode: "future-mode" }), "unknown"],
  ["the resume answer has no thread record", resumeWith({}), "unknown"],
  ["the resume answer is another thread's record", resumeWith({ thread: thread({ id: "thread-2" }) }), "unknown"],
  ["the resume answer has a record without a status", resumeWith({ thread: { id: THREAD } }), "unknown"],
  ["the resume answer shows a status the read did not", resumeWith({ thread: thread({ status: { type: "systemError" } }) }), "unknown"],
  ["the resume request is refused", { "thread/resume": () => ({ error: { code: -32600, message: "no rollout found" } }) }, "unknown"],
  ["the resume answer shows a child", resumeWith({ thread: thread({ parentThreadId: "p" }) }), "offline"],
]) {
  test(`a wake whose reads are idle but where ${label} sends no add, and defers as ${reason}`, async () => {
    const { result, methods } = await wakeWith(over)
    assert.deepEqual(result, { outcome: "deferred", reason })
    assert.deepEqual(methods, [...OPENS, ...READS], "all four reads were made, and no add frame after them")
  })
}

test("a wake whose resume answer shows another provider than the bound one is refused as stale_binding", async () => {
  await withServer(queueServer(resumeWith({ thread: thread({ modelProvider: "other" }) })), async (path, server) => {
    const bound = createThread({ path, threadId: THREAD })
    await bound.bind()
    server.log.length = 0
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until: Date.now() + 5000 }), { outcome: "deferred", reason: "stale_binding" })
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
    assert.equal((await bound.wake({ text: "t", attemptId: "attempt-9", until: Date.now() + 5000 })).outcome, "handed")
    busy = true
    server.log.length = 0
    assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until: Date.now() + 5000 }), { outcome: "deferred", reason: "busy" })
    assert.equal(server.methods().includes("thread/queue/add"), false)
  })
})

test("the add is the next request after the last read of the wake, and a failed read sends none", async () => {
  const { methods } = await wakeWith({})
  assert.deepEqual(methods.slice(0, 7), [...OPENS, ...READS, "thread/queue/add"], "nothing is asked between the last answer and the add")
  const { result, methods: failed } = await wakeWith({ "thread/turns/list": () => ({ error: { code: -32600, message: "x" } }) })
  assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
  assert.equal(failed.includes("thread/queue/add"), false)
})

// ---- the app-server socket is trusted before each connect --------------------------------------------------------

const ME = process.geteuid()
const OTHER = ME + 1
// A file system as a table of path -> { kind, uid, mode }; a path that is not in it is not there.
function table(entries) {
  const lstat = path => {
    const entry = entries[path]
    if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    return { isSocket: () => entry.kind === "socket", isDirectory: () => entry.kind === "dir", isSymbolicLink: () => entry.kind === "link", uid: entry.uid, mode: entry.mode }
  }
  return { lstat, realpath: path => path, uid: ME }
}
const SOCKET = "/run/user/app/s.sock"
const good = (over = {}) => table({
  "/": { kind: "dir", uid: 0, mode: 0o755 }, "/run": { kind: "dir", uid: 0, mode: 0o755 }, "/run/user": { kind: "dir", uid: 0, mode: 0o755 },
  "/run/user/app": { kind: "dir", uid: ME, mode: 0o700 }, [SOCKET]: { kind: "socket", uid: ME, mode: 0o600 }, ...over,
})
const untrusted = { code: "CHAT_APPSERVER_UNTRUSTED" }

test("a socket of the current user in a directory only the current user or root can change is trusted", () => {
  assert.equal(trustedSocket(SOCKET, good()), SOCKET)
  assert.equal(trustedSocket(SOCKET, good({ "/run/user/app": { kind: "dir", uid: 0, mode: 0o755 } })), SOCKET, "a root-owned directory counts")
})

for (const [label, over] of [
  ["a socket owned by another user", { [SOCKET]: { kind: "socket", uid: OTHER, mode: 0o600 } }],
  ["a path that is a regular file", { [SOCKET]: { kind: "file", uid: ME, mode: 0o600 } }],
  ["a path that is a symlink, even to a socket", { [SOCKET]: { kind: "link", uid: ME, mode: 0o777 } }],
  ["a directory owned by another user", { "/run/user/app": { kind: "dir", uid: OTHER, mode: 0o700 } }],
  ["a directory writable by its group", { "/run/user/app": { kind: "dir", uid: ME, mode: 0o770 } }],
  ["a directory writable by others", { "/run/user/app": { kind: "dir", uid: ME, mode: 0o707 } }],
  ["a directory that is a symlink", { "/run/user/app": { kind: "link", uid: ME, mode: 0o777 } }],
  ["a directory above it that others can write", { "/run/user": { kind: "dir", uid: 0, mode: 0o777 } }],
  ["a directory above it that another user owns", { "/run/user": { kind: "dir", uid: OTHER, mode: 0o755 } }],
  ["a sticky directory owned by another user", { "/run/user/app": { kind: "dir", uid: OTHER, mode: 0o1777 } }],
]) {
  test(`${label} is refused as CHAT_APPSERVER_UNTRUSTED`, () => {
    assert.throws(() => trustedSocket(SOCKET, good(over)), untrusted)
  })
}

test("a sticky directory, which keeps others from removing what the current user owns, is trusted when it is the current user's or root's", () => {
  assert.equal(trustedSocket(SOCKET, good({ "/run/user/app": { kind: "dir", uid: 0, mode: 0o1777 } })), SOCKET)
  assert.equal(trustedSocket(SOCKET, good({ "/run/user/app": { kind: "dir", uid: ME, mode: 0o1777 } })), SOCKET)
})

test("a socket that is not there is the closed app-server, not an untrusted one, and a directory that cannot be read is untrusted", () => {
  assert.throws(() => trustedSocket(SOCKET, good({ [SOCKET]: undefined })), { code: "APP_SERVER_CLOSED" })
  assert.throws(() => trustedSocket(SOCKET, table({})), { code: "APP_SERVER_CLOSED" })
  const denied = good()
  const lstat = path => { if (path === "/run/user/app") throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return denied.lstat(path) }
  assert.throws(() => trustedSocket(SOCKET, { ...denied, lstat }), untrusted)
})

test("the connection goes to the path that was checked, with the links above the directory resolved", () => {
  const entries = good({ "/real/app": { kind: "dir", uid: ME, mode: 0o700 }, "/real": { kind: "dir", uid: 0, mode: 0o755 }, "/real/app/s.sock": { kind: "socket", uid: ME, mode: 0o600 }, "/link/app": { kind: "dir", uid: ME, mode: 0o700 } })
  const resolving = { ...entries, realpath: path => (path === "/link/app" ? "/real/app" : path) }
  assert.equal(trustedSocket("/link/app/s.sock", resolving), "/real/app/s.sock")
})

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

test("an untrusted socket is refused before any connection: the bind says untrusted, the wake sends nothing, the read is offline", async () => {
  const base = mkdtempSync(join(tmpdir(), "acu-"))
  try {
    const open = mode => { const where = mkdtempSync(join(base, "d-")); chmodSync(where, mode); return where }
    const path = join(open(0o777), "s.sock")
    const server = await fakeAppServer(path, queueServer())
    try {
      const bound = createThread({ path, threadId: THREAD })
      assert.deepEqual(await bound.bind(), { status: "untrusted" })
      assert.equal(bound.provider, null)
      assert.equal(bound.route, null)
      assert.equal((await bound.observe()).reason, "offline")
      assert.deepEqual(await bound.wake({ text: "t", attemptId: "attempt-9", until: Date.now() + 5000 }), { outcome: "failed", reason: "native_unavailable" })
      assert.equal(server.state.connections, 0, "not one connection was made")
    } finally { await server.close() }
  } finally { rmSync(base, { recursive: true, force: true }) }
})
