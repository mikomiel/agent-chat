import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLIENT_ID_PREFIX, createThread, isChildThread, MIN_ADD_MS, openAppServer } from "../lib/appserver.js"
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

test("a probe that cannot be completed leaves the route undecided and the thread unbound", async () => {
  await withServer(main({ "thread/queue/delete": (_message, { socket }) => { socket.destroy() } }), async path => {
    const bound = createThread({ path, threadId: THREAD })
    assert.deepEqual(await bound.bind(), { status: "unavailable" })
    assert.equal(bound.route, null, "a transport failure is not an answer: the probe runs again at the next bind")
  })
  const gone = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.deepEqual(await gone.bind(), { status: "unavailable" })
  assert.equal(gone.route, null)
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
const queueServer = (over = {}) => main({
  "thread/queue/add": message => ok({ queuedSubmission: { id: "q1", input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } }),
  "thread/queue/delete": () => ok({ deleted: false }),
  "thread/items/list": () => ok({ data: [], nextCursor: null }),
  ...over,
})
async function wakeWith(over, { reservation = 5000, text = "queued text" } = {}) {
  return withServer(queueServer(over), async (path, server) => {
    const ticks = clock()
    const bound = createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep })
    const result = await bound.wake({ text, attemptId: "attempt-9", until: ticks.now() + reservation })
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
  assert.deepEqual(methods, ["initialize", "thread/queue/add", "thread/queue/delete", "thread/items/list"])
  const add = log[1].params
  assert.deepEqual(add, { threadId: THREAD, clientUserMessageId: "agent-chat:attempt-9", input: [{ type: "text", text: "queued text", text_elements: [] }] })
  assert.deepEqual(log[2].params, { threadId: THREAD, queuedSubmissionId: "q1" })
  assert.equal(seen[0].threadId, THREAD)
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
  const { result, methods } = await wakeWith({ "thread/queue/add": () => undefined }, { reservation: 700 })
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(methods.filter(method => method === "thread/queue/add").length, 1)
  assert.equal(methods.includes("thread/queue/delete"), false)
})

test("a failure before the add frame is written is failed, and a reservation under half a second sends nothing", async () => {
  const absent = createThread({ path: join(dir, "absent.sock"), threadId: THREAD })
  assert.deepEqual(await absent.wake({ text: "t", attemptId: "a", until: Date.now() + 5000 }), { outcome: "failed", reason: "native_unavailable" })
  assert.equal(MIN_ADD_MS, 500)
  const { result, methods } = await wakeWith({}, { reservation: MIN_ADD_MS - 1 })
  assert.deepEqual(result, { outcome: "failed", reason: "native_unavailable" })
  assert.deepEqual(methods, ["initialize"], "no add frame")
  const exactly = await wakeWith({}, { reservation: MIN_ADD_MS })
  assert.ok(exactly.methods.includes("thread/queue/add"), "half a second left is enough")
})

test("the wake connection is closed when it is done", async () => {
  await withServer(queueServer({ "thread/queue/delete": () => ok({ deleted: true }) }), async (path, server) => {
    const ticks = clock()
    await createThread({ path, threadId: THREAD, now: ticks.now, sleep: ticks.sleep }).wake({ text: "t", attemptId: "a", until: ticks.now() + 5000 })
    for (let waited = 0; server.state.open && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(server.state.open, 0)
  })
})
