import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as pathJoin } from "node:path"
import { createMember, createRegistry } from "../lib/owner.js"
import { createContext } from "../lib/context.js"
import { createLifecycle } from "../lib/lifecycle.js"
import { createDelivery, inboxIDOf } from "../lib/delivery.js"
import { EVENT_TYPES } from "../lib/manager.js"
import { loadConfig } from "../lib/config.js"
import { renderNotice } from "../lib/notice.js"
import { BINDING_KEY, CHAT_PREFIX, CHAT_SOURCE, MAX_CONTEXT_BYTES, NOTICE_BOUND } from "../lib/channel.js"

// The idle delivery, end to end below the plugin: a real owner, manager, lifecycle and binding context, over a host double
// that records every way in which input could reach a session, and a worker double that rejects an overlapping request as
// the real worker does (CHAT_WORKER_BUSY ends it). Time is a clock the test moves by hand, so no test waits for the budget.

const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let index = 0; index < 16; index++) await tick() }
// A promise the test settles by hand. The test's end releases it, with `value`, before the hooks registered after it run, so a
// failed assertion never leaves a worker or a host call waiting for it: node:test runs `t.after` hooks in registration order.
const defer = (t, value) => {
  const gate = {}
  gate.promise = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject })
  t.after(() => gate.resolve(value))
  return gate
}

const BASE = {
  chatEnabled: true,
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  python: "/usr/bin/python3",
}
const DELIVERING = { ...BASE, delivery: true }
const JOINED = {
  session_id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  room_id: "33333333-3333-4333-8333-333333333333",
  host: "synthetic-host",
  harness: "opencode",
  instance_file: "/tmp/agent-chat-state/boot-1.json",
}
const MESSAGE = { id: "44444444-4444-4444-8444-444444444444", kind: "message", room_id: JOINED.room_id, history_after: "42" }
const BUSY = { native_state: "busy", stopped: false, plan_mode: false }
const UNKNOWN = { native_state: "unknown", stopped: true, plan_mode: false }
const HANDED = { outcome: "handed", reason: null }
const UNCERTAIN = { outcome: "uncertain", reason: "transport_ambiguous" }
const BUDGET_MS = 1500
const DELIVERED = "session.inbox.delivered"
const attemptID = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
let sequence = 0
const ev = (type, sessionID, data = {}) => ({ id: `${type}-${sequence++}`, type, data: { sessionID, ...data } })
const delivered = (sessionID, inboxID) => ev(DELIVERED, sessionID, { inboxID })
const NO_TIMERS = { setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} }
const hangs = () => new Promise(() => {})

// A clock and timers the test moves by hand. Every timer is cleared by whoever set it, or fires when the clock reaches it.
function fakeClock(start = 1000) {
  let time = start
  const timers = []
  return {
    now: () => time,
    setTimeoutImpl(fn, delay) {
      const timer = { at: time + delay, delay, fn, live: true, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeoutImpl(timer) { if (timer) timer.live = false },
    advance(ms) {
      time += ms
      for (const timer of timers.filter(item => item.live && item.at <= time).sort((a, b) => a.at - b.at)) {
        timer.live = false
        timer.fn()
      }
    },
  }
}

// The worker double. It serves one request at a time and rejects an overlapping one with CHAT_WORKER_BUSY, which is what
// the real worker does and what turns a session's chat off. `answers` maps an operation to a function of its fields.
function strictWorker(answers = {}) {
  const requests = []
  const counters = { overlaps: 0, claims: 0 }
  let active = false
  let close
  const closed = new Promise(resolve => { close = resolve })
  const defaults = {
    heartbeat: () => ({}),
    pending: () => ({ messages: [MESSAGE.id] }),
    claim: () => ({ dispatch: true, attempt_id: attemptID(++counters.claims), reservation_ms: 20_000, messages: [MESSAGE] }),
    settle: () => ({}),
    receipts: () => ({ receipts: [] }),
  }
  return {
    requests, counters, closed,
    ready: Promise.resolve(JOINED),
    request(op, fields) {
      if (active) {
        counters.overlaps += 1
        return Promise.reject(Object.assign(new Error("CHAT_WORKER_BUSY"), { code: "CHAT_WORKER_BUSY", operation: op }))
      }
      active = true
      requests.push({ op, fields })
      const reply = answers[op] ?? defaults[op]
      return new Promise(resolve => resolve(reply(fields))).finally(() => { active = false })
    },
    stop() { close({ code: 0, signal: null }); return closed },
    ops: () => requests.map(item => item.op),
  }
}

// The host double. It records the calls that put input into a session and keeps the instruction entries in a map.
function hostContext({ info, synthetic, hook = true, registration } = {}) {
  const calls = { subscribe: [], get: [], synthetic: [], prompt: [], wait: [] }
  const entries = new Map()
  const hooks = []
  const queue = []
  const wake = { fn: null }
  const state = { info: info ?? (id => ({ id, agent: "build" })) }
  const session = {
    get: ({ sessionID }) => {
      calls.get.push(sessionID)
      return new Promise(resolve => resolve(typeof state.info === "function" ? state.info(sessionID) : state.info))
    },
    synthetic: input => {
      calls.synthetic.push(input)
      return synthetic ? synthetic(input) : Promise.resolve({ id: input.id })
    },
    prompt: input => { calls.prompt.push(input); return Promise.resolve({ id: "msg_unexpected" }) },
    wait: input => { calls.wait.push(input); return Promise.resolve({}) },
    instructions: {
      entry: {
        put: async ({ sessionID, key, value }) => { entries.set(`${sessionID}/${key}`, value) },
        list: async ({ sessionID }) => [...entries]
          .filter(([id]) => id.startsWith(`${sessionID}/`))
          .map(([id, value]) => ({ key: id.slice(sessionID.length + 1), value })),
        remove: async ({ sessionID, key }) => { entries.delete(`${sessionID}/${key}`) },
      },
    },
  }
  if (hook) {
    session.hook = (name, callback) => {
      const record = { name, callback, disposed: 0 }
      hooks.push(record)
      const held = { dispose: async () => { record.disposed += 1 } }
      return registration ? registration(held, record) : Promise.resolve(held)
    }
  }
  return {
    state, calls, entries, hooks, session,
    event: {
      subscribe(options) {
        calls.subscribe.push(options)
        return (async function* () {
          yield { type: "server.connected" }
          while (!options.signal.aborted) {
            if (queue.length) { yield queue.shift(); continue }
            await new Promise(resolve => { wake.fn = resolve; options.signal.addEventListener("abort", resolve, { once: true }) })
          }
        })()
      },
    },
    push(item) { queue.push(item); wake.fn?.() },
  }
}

// One member over the real parts. `worker` is one worker for every session, or a function of the join's identity.
function build({ config = DELIVERING, host = hostContext(), worker, clock = fakeClock(), registry = createRegistry(), delivery = createDelivery(clock) } = {}) {
  const workers = []
  const ticks = []
  const parts = {
    createContext: (hostCtx, id, options) => createContext(hostCtx, id, { ...options, ...NO_TIMERS }),
    createLifecycle: (bus, native, cfg, options) => createLifecycle(bus, native, cfg, {
      ...options,
      now: clock.now,
      ...NO_TIMERS,
      setIntervalImpl: fn => { ticks.push(fn); return ticks.length },
      clearIntervalImpl: () => {},
    }),
    startProcess: (_config, identity) => {
      const made = typeof worker === "function" ? worker(identity) : worker ?? strictWorker()
      if (!workers.includes(made)) workers.push(made)
      return made
    },
  }
  const member = createMember(host, config, parts, {
    managerOptions: { setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, delivery },
  })
  const detach = registry.attach(member)
  return { registry, member, detach, host, clock, workers, ticks }
}

async function join(h, sessionID = "ses_a") {
  await flush() // the registry promotes its first member asynchronously
  h.registry.dispatch(ev("session.created", sessionID))
  await flush()
}

const callbackOf = (h, index = 0) => h.host.hooks[index].callback
const idle = (h, sessionID = "ses_a") => callbackOf(h)({ sessionID, background: [] })
const opsOf = h => h.workers.flatMap(worker => worker.ops())
const claimsOf = h => opsOf(h).filter(op => op === "claim").length
const lastRequest = h => h.workers[0].requests.at(-1)

// A running hook that the test releases by moving the clock to the budget. A hook that is not released fails the test
// after a second of real time and does not hold the run.
async function pastBudget(h, running) {
  const state = { done: false }
  void running.then(() => { state.done = true })
  await flush()
  assert.equal(state.done, false, "the hook is still running before the budget")
  h.clock.advance(BUDGET_MS)
  let timer
  const verdict = await Promise.race([
    running.then(() => "released"),
    new Promise(resolve => { timer = setTimeout(() => resolve("held"), 1000) }),
  ])
  clearTimeout(timer)
  assert.equal(verdict, "released", "the hook is released at the budget")
}

function assertNoClaim(h, why) {
  assert.deepEqual(opsOf(h).filter(op => ["pending", "claim", "settle"].includes(op)), [], why)
  assert.deepEqual(h.host.calls.synthetic, [], why)
  assert.deepEqual(h.host.calls.prompt, [], why)
}

function withConfig(value) {
  const dir = mkdtempSync(pathJoin(tmpdir(), "agent-chat-config-"))
  const file = pathJoin(dir, "chat.json")
  writeFileSync(file, JSON.stringify(value))
  chmodSync(file, 0o600)
  try { return loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: file }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------------------------------------------------
// The switch

test("config: delivery is an optional boolean, absent by default, and the loader adds no default", () => {
  assert.equal("delivery" in withConfig(BASE), false)
  assert.deepEqual(withConfig(DELIVERING), DELIVERING)
  assert.deepEqual(withConfig({ ...BASE, delivery: false }), { ...BASE, delivery: false })
  for (const delivery of ["true", "false", "yes", 1, 0, null, [], {}]) {
    assert.equal(withConfig({ ...BASE, delivery }), null, JSON.stringify(delivery))
  }
  assert.equal(withConfig({ ...DELIVERING, extra: 1 }), null)
})

test("delivery off, absent or false in the file: no hook is registered and the stream is the seven events", async t => {
  for (const config of [BASE, { ...BASE, delivery: false }, withConfig({ ...BASE, delivery: false })]) {
    const h = build({ config })
    t.after(() => h.detach())
    await join(h)
    assert.deepEqual(h.host.hooks, [])
    assert.deepEqual(h.host.calls.subscribe[0].types, [...EVENT_TYPES])
    assert.deepEqual(h.workers[0].ops(), ["heartbeat"]) // joined, and nothing else
    assert.deepEqual(h.workers[0].requests[0].fields.state, UNKNOWN)
  }
  // The control: the same host and worker, with delivery on, do register the hook.
  const on = build({ config: withConfig(DELIVERING) })
  t.after(() => on.detach())
  await join(on)
  assert.equal(on.host.hooks.length, 1)
})

test("delivery on: the hook is registered once for experimental.idle, and the delivered event joins the stream", async t => {
  const h = build()
  t.after(() => h.detach())
  await join(h)
  assert.equal(h.host.hooks.length, 1)
  assert.equal(h.host.hooks[0].name, "experimental.idle")
  assert.equal(typeof callbackOf(h), "function")
  assert.deepEqual(h.host.calls.subscribe[0].types, [...EVENT_TYPES, DELIVERED])
})

test("delivery on with a host that has no session.hook: nothing is registered, nothing throws, and the stream is the seven events", async t => {
  const h = build({ host: hostContext({ hook: false }) })
  t.after(() => h.detach())
  await join(h)
  assert.deepEqual(h.host.hooks, [])
  assert.deepEqual(h.host.calls.subscribe[0].types, [...EVENT_TYPES])
  assert.equal(claimsOf(h), 0)
  // The control: the same config on a host that has the hook registers it, so the empty list above is the host's doing.
  const withHook = build()
  t.after(() => withHook.detach())
  await join(withHook)
  assert.equal(withHook.host.hooks.length, 1)
})

test("the registration is disposed once when the member is torn down, however late it arrives or badly it disposes", async t => {
  const first = build()
  await join(first)
  await first.detach()
  await first.detach()
  assert.equal(first.host.hooks[0].disposed, 1)

  const gate = defer(t)
  const late = build({ host: hostContext({ registration: held => gate.promise.then(() => held) }) })
  await join(late)
  await late.detach() // torn down while the host has not answered the registration yet
  assert.equal(late.host.hooks[0].disposed, 0)
  gate.resolve()
  await flush()
  assert.equal(late.host.hooks[0].disposed, 1)

  for (const registration of [
    () => Promise.reject(new Error("the host refused the hook")),
    () => { throw new Error("the host threw on the hook") },
    () => Promise.resolve({ dispose: () => Promise.reject(new Error("dispose rejected")) }),
    () => Promise.resolve({ dispose: () => { throw new Error("dispose threw") } }),
    () => Promise.resolve(undefined),
  ]) {
    const h = build({ host: hostContext({ registration }) })
    await join(h)
    assert.deepEqual(h.workers[0].ops(), ["heartbeat"], "chat still joins") // the member works whatever the registration does
    await assert.doesNotReject(h.detach())
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// The positive control, and what the hook sends

test("an eligible session: busy, pending, claim, one admission, then not-eligible, and settle only later", async t => {
  const h = build()
  t.after(() => h.detach())
  await join(h)
  assert.equal(await idle(h), undefined)
  assert.deepEqual(h.workers[0].ops(), ["heartbeat", "heartbeat", "pending", "claim", "heartbeat"])
  const states = h.workers[0].requests.filter(item => item.op === "heartbeat").map(item => item.fields.state)
  assert.deepEqual(states, [UNKNOWN, BUSY, UNKNOWN]) // the join's own, the hook's busy, then busy does not outlive the hook
  assert.equal(h.workers[0].requests[2].fields, undefined)
  assert.deepEqual(Object.keys(h.workers[0].requests[3].fields).sort(), ["key", "messages"]) // metadata mode: no bodies
  assert.deepEqual(h.workers[0].requests[3].fields.messages, [MESSAGE.id])
  assert.equal(h.host.calls.synthetic.length, 1)
  assert.equal(h.workers[0].counters.overlaps, 0)
  // Nothing is settled until the host says the input was promoted.
  await flush()
  assert.equal(h.workers[0].ops().includes("settle"), false)
})

test("the hook admits one steer input with resume false and a msg_ id, and never prompts or waits", async t => {
  const h = build()
  t.after(() => h.detach())
  await join(h)
  await idle(h)
  assert.equal(h.host.calls.synthetic.length, 1)
  const [input] = h.host.calls.synthetic
  assert.deepEqual(Object.keys(input).sort(), ["delivery", "description", "id", "metadata", "resume", "sessionID", "text"])
  assert.equal(input.delivery, "steer")
  assert.equal(input.resume, false)
  assert.equal(input.sessionID, "ses_a")
  assert.equal(input.id, inboxIDOf(attemptID(1)))
  assert.match(input.id, /^msg_[0-9a-f]{32}$/)
  assert.deepEqual(input.metadata, { source: CHAT_SOURCE })
  assert.deepEqual(h.host.calls.prompt, [])
  assert.deepEqual(h.host.calls.wait, [])
})

test("the admitted text is the delivery line and the shared renderer's notice, inside the context limit, on the configured route", async t => {
  for (const toolRoute of [undefined, "cli", "mcp", "mcp-with-cli-fallback"]) {
    const h = build({ config: { ...DELIVERING, ...(toolRoute ? { toolRoute } : {}) } })
    t.after(() => h.detach())
    await join(h)
    await idle(h)
    const [input] = h.host.calls.synthetic
    const notice = renderNotice(JOINED, BASE.python, [MESSAGE], { bound: NOTICE_BOUND, route: toolRoute })
    assert.equal(input.text, CHAT_PREFIX + notice, `${toolRoute}`)
    assert.ok(Buffer.byteLength(input.text, "utf8") <= MAX_CONTEXT_BYTES)
    assert.ok(input.text.startsWith("Agent Chat message(s) delivered by the native adapter.\n"))
    assert.ok(input.text.includes(MESSAGE.id))
  }
})

test("a batch that fills the context limit is admitted whole, and one message more cannot be rendered, so it is settled and not admitted", async t => {
  const rows = count => Array.from({ length: count }, (_, index) => ({ ...MESSAGE, id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, history_after: String(index) }))
  const fits = count => renderNotice(JOINED, BASE.python, rows(count), { bound: NOTICE_BOUND }) !== null
  let largest = 1
  while (fits(largest + 1)) largest += 1
  assert.ok(largest > 10 && largest < 200, `${largest} rows fit`) // the search ended inside the range of the fixture
  const workerFor = count => strictWorker({
    pending: () => ({ messages: rows(count).map(item => item.id) }),
    claim: () => ({ dispatch: true, attempt_id: attemptID(1), reservation_ms: 20_000, messages: rows(count) }),
  })

  const full = build({ worker: workerFor(largest) })
  t.after(() => full.detach())
  await join(full)
  await idle(full)
  assert.equal(full.host.calls.synthetic.length, 1)
  const bytes = Buffer.byteLength(full.host.calls.synthetic[0].text, "utf8")
  assert.ok(bytes <= MAX_CONTEXT_BYTES, `${bytes} bytes`)
  assert.ok(bytes > MAX_CONTEXT_BYTES - 200, `${bytes} bytes: the batch fills the limit`)

  const over = build({ worker: workerFor(largest + 1) })
  t.after(() => over.detach())
  await join(over)
  await idle(over)
  assert.deepEqual(over.host.calls.synthetic, [])
  assert.deepEqual(over.workers[0].requests.find(item => item.op === "settle").fields, { attempt: attemptID(1), result: { outcome: "deferred", reason: "offline" } })
})

test("a session with no agent in its record is not Plan: the check is the one the brief states", async t => {
  const h = build({ host: hostContext({ info: id => ({ id }) }) })
  t.after(() => h.detach())
  await join(h)
  await idle(h)
  assert.equal(claimsOf(h), 1)
  assert.equal(h.host.calls.synthetic.length, 1)
})

// ---------------------------------------------------------------------------------------------------------------------
// The hook never rejects, and never stalls the host

test("the callback resolves for bad input, a throwing host, a throwing worker and a rejected admission", async t => {
  const h = build()
  t.after(() => h.detach())
  await join(h)
  const callback = callbackOf(h)
  for (const input of [undefined, null, {}, { sessionID: 7 }, { sessionID: "" }, { sessionID: "ses_unseen" }, "ses_a", 7]) {
    await assert.doesNotReject(Promise.resolve(callback(input)), JSON.stringify(input))
  }
  const hostile = { get sessionID() { throw new Error("getter") } }
  assert.equal(await callback(hostile), undefined)
  assertNoClaim(h, "bad input claims nothing")

  const failures = {
    "session.get throws": host => { host.state.info = () => { throw new Error("get") } },
    "session.get rejects": host => { host.state.info = () => Promise.reject(new Error("get")) },
    "the entry list throws": host => { host.session.instructions.entry.list = async () => { throw new Error("list") } },
  }
  for (const [label, arrange] of Object.entries(failures)) {
    const broken = build()
    t.after(() => broken.detach())
    await join(broken)
    arrange(broken.host)
    await assert.doesNotReject(Promise.resolve(idle(broken)), label)
    assertNoClaim(broken, label)
  }

  const workerFailures = {
    "heartbeat rejects": { heartbeat: fields => (fields.state.native_state === "busy" ? Promise.reject(Object.assign(new Error("x"), { code: "CHAT_PROTOCOL_INVALID" })) : {}) },
    "pending rejects": { pending: () => Promise.reject(Object.assign(new Error("x"), { code: "REQUEST_UNCERTAIN" })) },
    "claim rejects": { claim: () => Promise.reject(Object.assign(new Error("x"), { code: "CHAT_PROTOCOL_INVALID" })) },
    "pending throws": { pending: () => { throw new Error("worker threw") } },
  }
  for (const [label, answers] of Object.entries(workerFailures)) {
    const broken = build({ worker: strictWorker(answers) })
    t.after(() => broken.detach())
    await join(broken)
    await assert.doesNotReject(Promise.resolve(idle(broken)), label)
    assert.deepEqual(broken.host.calls.synthetic, [], label)
  }

  const rejected = build({ host: hostContext({ synthetic: () => Promise.reject(new Error("admission refused")) }) })
  t.after(() => rejected.detach())
  await join(rejected)
  await assert.doesNotReject(Promise.resolve(idle(rejected)))
  const thrown = build({ host: hostContext({ synthetic: () => { throw new Error("admission threw") } }) })
  t.after(() => thrown.detach())
  await join(thrown)
  await assert.doesNotReject(Promise.resolve(idle(thrown)))
})

test("a hung worker, a hung session read and a hung entry read each release the hook at the budget", async t => {
  const cases = {
    "the busy heartbeat hangs": { worker: strictWorker({ heartbeat: fields => (fields.state.native_state === "busy" ? hangs() : {}) }) },
    "pending hangs": { worker: strictWorker({ pending: hangs }) },
    "claim hangs": { worker: strictWorker({ claim: hangs }) },
    "session.get hangs": {},
    "synthetic hangs": { host: hostContext({ synthetic: hangs }) },
  }
  for (const [label, options] of Object.entries(cases)) {
    const h = build(options)
    t.after(() => h.detach())
    await join(h) // the session joins with a working read: the hook is what finds it hung
    if (label === "session.get hangs") h.host.state.info = () => hangs()
    const running = idle(h)
    await pastBudget(h, running)
    assert.equal(h.workers[0].counters.overlaps, 0, label)
    if (label !== "synthetic hangs") assert.deepEqual(h.host.calls.synthetic, [], label)
  }

  const slowList = build()
  t.after(() => slowList.detach())
  await join(slowList)
  slowList.host.session.instructions.entry.list = hangs
  await pastBudget(slowList, idle(slowList))
  assertNoClaim(slowList, "a hung entry read claims nothing")
})

test("a hook that runs out of time after the claim settles uncertain, sends no admission, reports not-eligible, and overlaps nothing", async t => {
  const gate = defer(t)
  const worker = strictWorker({
    claim: () => gate.promise.then(() => ({ dispatch: true, attempt_id: attemptID(1), reservation_ms: 20_000, messages: [MESSAGE] })),
  })
  const h = build({ worker })
  t.after(() => h.detach())
  await join(h)
  const running = idle(h)
  await pastBudget(h, running)
  assert.deepEqual(worker.ops(), ["heartbeat", "heartbeat", "pending", "claim"]) // still waiting for the worker's answer
  gate.resolve()
  await flush()
  // The sequence ends in the background: nothing moves forward, the grant is settled, and busy does not stay.
  assert.deepEqual(worker.ops(), ["heartbeat", "heartbeat", "pending", "claim", "settle", "heartbeat"])
  assert.deepEqual(worker.requests[4].fields, { attempt: attemptID(1), result: UNCERTAIN })
  assert.deepEqual(worker.requests[5].fields.state, UNKNOWN)
  assert.deepEqual(h.host.calls.synthetic, [])
  assert.equal(worker.counters.overlaps, 0)
})

test("a hook that runs out of time while the admission is in flight settles that attempt uncertain", async t => {
  const h = build({ host: hostContext({ synthetic: hangs }) })
  t.after(() => h.detach())
  await join(h)
  await pastBudget(h, idle(h))
  await flush()
  assert.equal(h.host.calls.synthetic.length, 1)
  assert.deepEqual(h.workers[0].ops(), ["heartbeat", "heartbeat", "pending", "claim", "heartbeat", "settle"])
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: UNCERTAIN })
  assert.equal(h.workers[0].counters.overlaps, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// No claim

// An eligible session, then one thing that makes it ineligible: the same fixture claims when nothing is changed.
async function eligible(t, options = {}) {
  const h = build(options)
  t.after(() => h.detach())
  await join(h)
  return h
}

test("the fixture of the refusals below does claim when nothing is wrong with it", async t => {
  const h = await eligible(t)
  await idle(h)
  assert.equal(claimsOf(h), 1)
  assert.equal(h.host.calls.synthetic.length, 1)
})

test("no claim for the Plan agent, and not even a busy report", async t => {
  const h = await eligible(t)
  h.host.state.info = id => ({ id, agent: "plan" })
  await idle(h)
  assertNoClaim(h, "plan")
  assert.deepEqual(h.workers[0].ops(), ["heartbeat"])
})

test("no claim when the session read throws, rejects or times out", async t => {
  const reads = {
    throws: [() => { throw new Error("get") }, false],
    rejects: [() => Promise.reject(new Error("get")), false],
    "times out": [() => hangs(), true],
  }
  for (const [label, [read, hung]] of Object.entries(reads)) {
    const h = await eligible(t)
    h.host.state.info = read
    const running = idle(h)
    if (hung) await pastBudget(h, running)
    else await running
    assertNoClaim(h, label)
    assert.deepEqual(h.workers[0].ops(), ["heartbeat"], label)
  }
})

test("no claim when the binding entry is missing, different or unreadable", async t => {
  for (const damage of [
    host => host.entries.clear(),
    host => host.entries.set(`ses_a/${BINDING_KEY}`, "another binding"),
    host => { host.session.instructions.entry.list = async () => { throw new Error("list") } },
    host => { host.session.instructions.entry.list = async () => "not a list" },
  ]) {
    const h = await eligible(t)
    damage(h.host)
    await idle(h)
    assertNoClaim(h, damage.toString())
    assert.deepEqual(h.workers[0].ops(), ["heartbeat"])
  }
})

test("no claim for a child or a fork, whether the host said so before the hook or only at the hook", async t => {
  const h = await eligible(t)
  h.registry.dispatch(ev("session.created", "ses_child", { parentID: "ses_a" }))
  h.registry.dispatch(ev("session.forked", "ses_fork"))
  await flush()
  assert.equal(idle(h, "ses_child"), undefined)
  assert.equal(idle(h, "ses_fork"), undefined)
  assertNoClaim(h, "no record for a child or a fork")

  for (const answer of [id => ({ id, parentID: "ses_x" }), id => ({ id, fork: { sessionID: "ses_x" } }), () => ({ id: "ses_other" }), () => null]) {
    const late = await eligible(t)
    late.host.state.info = answer
    await idle(late)
    assertNoClaim(late, answer.toString())
  }
})

test("no claim for a session the manager has no joined record for: unseen, not joined yet, or turned off", async t => {
  const h = await eligible(t)
  assert.equal(idle(h, "ses_unseen"), undefined)
  assert.deepEqual(h.host.calls.get.filter(id => id === "ses_unseen"), [])

  const gate = defer(t, JOINED)
  const slow = await eligible(t, { worker: Object.assign(strictWorker(), { ready: gate.promise }) })
  assert.equal(idle(slow), undefined) // a record whose worker has not joined
  assertNoClaim(slow, "not joined")
  gate.resolve(JOINED)

  const off = await eligible(t, { worker: strictWorker({ heartbeat: () => Promise.reject(Object.assign(new Error("x"), { code: "CHAT_PROTOCOL_INVALID", operation: "heartbeat" })) }) })
  off.ticks[0]() // a heartbeat the worker refuses for good turns this session's chat off
  await flush()
  const before = off.workers[0].requests.length
  assert.equal(idle(off), undefined)
  assert.equal(off.workers[0].requests.length, before)
  assert.deepEqual(off.host.calls.synthetic, [])
})

test("no claim before the join's first heartbeat: the binding is not proved yet", async t => {
  const gate = defer(t)
  const host = hostContext()
  const put = host.session.instructions.entry.put
  host.session.instructions.entry.put = async input => { await gate.promise; return put(input) }
  const h = build({ host })
  t.after(() => h.detach())
  await join(h)
  assert.equal(idle(h), undefined)
  assertNoClaim(h, "unproved binding")
  assert.deepEqual(h.workers[0].ops(), [])
  gate.resolve()
})

test("a member that is not the owner makes no claim, and two members for one session make one", async t => {
  const registry = createRegistry()
  const owner = build({ registry })
  const standby = build({ registry })
  t.after(() => standby.detach())
  t.after(() => owner.detach())
  await join(owner)
  assert.equal(registry.owner() !== null, true)
  assert.equal(owner.host.hooks.length, 1)
  assert.equal(standby.host.hooks.length, 1)
  const [mine, theirs] = await Promise.all([idle(owner), idle(standby)])
  assert.equal(mine, undefined)
  assert.equal(theirs, undefined)
  assert.equal(claimsOf(owner), 1)
  assert.equal(owner.host.calls.synthetic.length, 1)
  assert.equal(claimsOf(standby), 0)
  assert.deepEqual(standby.host.calls.synthetic, [])
  assert.deepEqual(standby.host.calls.get, []) // the fast path asked the host nothing
  // Called twice at once, the standby is still a no-op and the owner's turn at the worker holds the second hook off.
  await Promise.all([idle(standby), idle(standby)])
  assert.equal(claimsOf(standby), 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// The worker's answers

test("no admission when the worker has nothing, refuses, or gives a grant that cannot be used", async t => {
  const none = { pending: () => ({ messages: [] }) }
  const refusedPending = { pending: () => ({ refused: "SERVICE_UNAVAILABLE" }) }
  const refusedBusy = { heartbeat: fields => (fields.state.native_state === "busy" ? { refused: "SERVICE_UNAVAILABLE" } : {}) }
  const refusedClaim = { claim: () => ({ refused: "DELIVERY_BLOCKED" }) }
  const noDispatch = { claim: () => ({ dispatch: false }) }
  const badAttempt = { claim: () => ({ dispatch: true, attempt_id: "not-a-uuid", reservation_ms: 20_000, messages: [MESSAGE] }) }
  for (const [label, answers] of Object.entries({ none, refusedPending, refusedBusy, refusedClaim, noDispatch, badAttempt })) {
    const h = await eligible(t, { worker: strictWorker(answers) })
    await idle(h)
    assert.deepEqual(h.host.calls.synthetic, [], label)
    assert.equal(h.workers[0].ops().includes("settle"), false, label)
    // busy does not outlive the hook, wherever the sequence stopped
    assert.deepEqual(h.workers[0].requests.at(-1).fields.state, UNKNOWN, label)
    assert.equal(h.workers[0].counters.overlaps, 0, label)
  }
})

test("a grant that cannot be rendered settles deferred offline, and one with too little time left settles uncertain, with no admission", async t => {
  const empty = await eligible(t, { worker: strictWorker({ claim: () => ({ dispatch: true, attempt_id: attemptID(1), reservation_ms: 20_000, messages: [] }) }) })
  await idle(empty)
  assert.deepEqual(empty.host.calls.synthetic, [])
  assert.deepEqual(empty.workers[0].ops(), ["heartbeat", "heartbeat", "pending", "claim", "settle", "heartbeat"])
  assert.deepEqual(empty.workers[0].requests[4].fields, { attempt: attemptID(1), result: { outcome: "deferred", reason: "offline" } })

  for (const reservation of [0, 400, 500, "soon", undefined]) {
    const short = await eligible(t, { worker: strictWorker({ claim: () => ({ dispatch: true, attempt_id: attemptID(2), reservation_ms: reservation, messages: [MESSAGE] }) }) })
    await idle(short)
    assert.deepEqual(short.host.calls.synthetic, [], `${reservation}`)
    assert.deepEqual(short.workers[0].requests[4].fields, { attempt: attemptID(2), result: UNCERTAIN }, `${reservation}`)
  }
})

test("a claim refusal that ends an instance takes the lifecycle's rejoin path, not a settlement", async t => {
  const h = await eligible(t, { worker: strictWorker({ claim: () => ({ refused: "STALE_INSTANCE" }) }) })
  await idle(h)
  assert.deepEqual(h.host.calls.synthetic, [])
  assert.equal(h.workers[0].ops().includes("settle"), false)
  assert.equal(h.workers[0].counters.overlaps, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// Settlement

async function admitted(t, options = {}) {
  const h = await eligible(t, options)
  await idle(h)
  assert.equal(h.host.calls.synthetic.length, 1)
  return h
}

test("handed only when the delivered event for the exact inbox id arrives before the deadline", async t => {
  const h = await admitted(t)
  h.clock.advance(19_000)
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1))))
  await flush()
  assert.equal(lastRequest(h).op, "settle")
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: HANDED })
  assert.equal(h.workers[0].counters.overlaps, 0)
})

test("another plugin's input is promoted first and ours arrives before the deadline: handed, and nothing settled in between", async t => {
  const h = await admitted(t)
  h.clock.advance(5_000)
  h.registry.dispatch(delivered("ses_a", "msg_another_plugins_continuation")) // an input that is not ours, promoted first
  await flush()
  assert.equal(h.workers[0].ops().includes("settle"), false) // it says nothing about our input
  h.clock.advance(5_000)
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1))))
  await flush()
  assert.deepEqual(h.workers[0].requests.filter(item => item.op === "settle").map(item => item.fields), [{ attempt: attemptID(1), result: HANDED }])
  assert.equal(h.workers[0].counters.overlaps, 0)
})

test("the exact event of another session, an unknown id or a bad envelope changes nothing: only the exact event hands", async t => {
  const h = await admitted(t)
  h.registry.dispatch(delivered("ses_b", inboxIDOf(attemptID(1))))
  h.registry.dispatch({ type: DELIVERED })
  h.registry.dispatch({ type: DELIVERED, data: null })
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(9)))) // another id for this session
  await flush()
  assert.equal(h.workers[0].ops().includes("settle"), false) // nothing about this attempt was said
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1))))
  await flush()
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: HANDED })
})

test("a late event, and an event after the deadline's own settlement, settle uncertain once", async t => {
  const h = await admitted(t)
  h.clock.advance(20_000)
  await flush()
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: UNCERTAIN })
  const settles = () => h.workers[0].ops().filter(op => op === "settle").length
  assert.equal(settles(), 1)
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1)))) // late
  await flush()
  assert.equal(settles(), 1)
})

test("a duplicate of the exact event settles one handed, and an old id's replay does not touch the newer attempt", async t => {
  const h = await admitted(t)
  const exact = delivered("ses_a", inboxIDOf(attemptID(1)))
  h.registry.dispatch(exact)
  h.registry.dispatch(exact) // the same event from a second stream
  await flush()
  assert.deepEqual(h.workers[0].requests.filter(item => item.op === "settle").map(item => item.fields.result), [HANDED])

  await idle(h) // a second delivery in the same execution
  h.registry.dispatch(exact) // a replay of the first one's event while the second is open
  await flush()
  assert.deepEqual(h.workers[0].requests.filter(item => item.op === "settle").map(item => item.fields.attempt), [attemptID(1)])
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(2))))
  await flush()
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(2), result: HANDED })
})

test("a rejected or throwing admission settles uncertain, and the event of an input that may exist is not trusted afterwards", async t => {
  for (const synthetic of [() => Promise.reject(new Error("refused")), () => { throw new Error("threw") }]) {
    const h = await eligible(t, { host: hostContext({ synthetic }) })
    await idle(h)
    await flush()
    assert.deepEqual(h.workers[0].ops(), ["heartbeat", "heartbeat", "pending", "claim", "heartbeat", "settle"])
    assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: UNCERTAIN })
    h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1)))) // too late to change the answer
    await flush()
    assert.equal(h.workers[0].ops().filter(op => op === "settle").length, 1)
  }
})

test("a stream gap settles the open attempt uncertain", async t => {
  const h = await admitted(t)
  h.member.reset()
  await flush()
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: UNCERTAIN })
})

test("the settlement comes after the hook returned, and a worker refusal of it is not a failure", async t => {
  const h = await admitted(t, { worker: strictWorker({ settle: () => ({ refused: "DELIVERY_CLOSED" }) }) })
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1))))
  await flush()
  assert.equal(lastRequest(h).op, "settle")
  await idle(h) // the session still delivers: the refusal did not turn chat off
  assert.equal(claimsOf(h), 2)
})

test("an event never opens a record, and never claims", async t => {
  const h = await eligible(t)
  h.registry.dispatch(delivered("ses_never_seen", inboxIDOf(attemptID(1))))
  await flush()
  assert.deepEqual(h.host.calls.get.filter(id => id === "ses_never_seen"), [])
  assertNoClaim(h, "a delivered event")
})

// ---------------------------------------------------------------------------------------------------------------------
// The turn at the worker

test("a hook that finds the heartbeat in flight claims nothing, and the heartbeat is never overlapped", async t => {
  const gate = defer(t)
  let beating = false
  const worker = strictWorker({ heartbeat: fields => { if (beating && fields.state.native_state === "unknown") return gate.promise.then(() => ({})); return {} } })
  const h = await eligible(t, { worker })
  beating = true
  h.ticks[0]() // the tick's heartbeat is now in flight
  await flush()
  const before = worker.requests.length
  await idle(h)
  assert.equal(worker.requests.length, before) // the hook sent nothing at all
  assert.deepEqual(h.host.calls.synthetic, [])
  gate.resolve()
  await flush()
  assert.equal(worker.counters.overlaps, 0)
  beating = false
  await idle(h) // the control: with the turn free, the same session does claim
  assert.equal(claimsOf(h), 1)
  assert.equal(h.host.calls.synthetic.length, 1)
  assert.equal(worker.counters.overlaps, 0)
})

test("a settlement that finds the turn taken is parked, sent after it, and never dropped or overlapped", async t => {
  const gate = defer(t)
  let held = false
  const worker = strictWorker({ heartbeat: fields => { if (held && fields.state.native_state === "unknown") return gate.promise.then(() => ({})); return {} } })
  const h = await admitted(t, { worker })
  held = true
  h.ticks[0]() // a heartbeat takes the turn
  await flush()
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(1))))
  await flush()
  assert.equal(worker.ops().includes("settle"), false) // parked behind the heartbeat
  gate.resolve()
  await flush()
  assert.equal(lastRequest(h).op, "settle")
  assert.deepEqual(lastRequest(h).fields, { attempt: attemptID(1), result: HANDED })
  assert.equal(worker.counters.overlaps, 0)
})

test("settlements parked together are sent in the order they ended, one after the other", async t => {
  // Hook 1 admits input 1. Hook 2 opens attempt 2 while its admission is in flight, which ends attempt 1 uncertain while hook 2
  // holds the turn. The delivered event for input 2 then settles attempt 2 handed before the hook ends. Both settlements wait
  // for the hook, and the worker double rejects the first request that overlaps another.
  const gate = defer(t)
  let calls = 0
  const host = hostContext({ synthetic: () => (++calls === 1 ? Promise.resolve() : gate.promise) })
  const h = await admitted(t, { host })
  const running = idle(h)
  await flush()
  assert.equal(host.calls.synthetic.length, 2)
  assert.equal(h.workers[0].ops().includes("settle"), false) // both wait for the hook
  h.registry.dispatch(delivered("ses_a", inboxIDOf(attemptID(2))))
  await flush()
  gate.resolve()
  await running
  await flush()
  const settles = h.workers[0].requests.filter(item => item.op === "settle").map(item => [item.fields.attempt, item.fields.result.outcome])
  assert.deepEqual(settles, [[attemptID(1), "uncertain"], [attemptID(2), "handed"]])
  assert.equal(h.workers[0].counters.overlaps, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// The cap

test("the cap: the fourth hook delivery in one execution is refused before anything is asked, and a new execution clears it", async t => {
  const h = await eligible(t)
  for (let number = 1; number <= 3; number++) {
    await idle(h)
    assert.equal(h.host.calls.synthetic.length, number, `delivery ${number}`)
  }
  const before = h.workers[0].requests.length
  const gets = h.host.calls.get.length
  assert.equal(idle(h), undefined) // nothing awaited
  assert.equal(h.workers[0].requests.length, before)
  assert.equal(h.host.calls.get.length, gets)
  assert.equal(h.host.calls.synthetic.length, 3)

  h.registry.dispatch(ev("session.compaction.ended", "ses_a")) // other events do not clear it
  h.registry.dispatch(ev("session.execution.started", "ses_other"))
  await flush()
  assert.equal(idle(h), undefined)

  h.registry.dispatch(ev("session.execution.started", "ses_a"))
  await flush()
  await idle(h)
  assert.equal(h.host.calls.synthetic.length, 4)
})

test("the cap is per session", async t => {
  const h = build({ worker: () => strictWorker() })
  t.after(() => h.detach())
  await join(h, "ses_a")
  await join(h, "ses_b")
  for (let number = 1; number <= 3; number++) await idle(h, "ses_a")
  assert.equal(idle(h, "ses_a"), undefined)
  await idle(h, "ses_b")
  assert.deepEqual(h.host.calls.synthetic.map(input => input.sessionID), ["ses_a", "ses_a", "ses_a", "ses_b"])
})

test("a session that ended is forgotten by the delivery table, once, and then makes no claim", async t => {
  const clock = fakeClock()
  const real = createDelivery(clock)
  const forgotten = []
  const delivery = { ...real, forget: id => { forgotten.push(id); real.forget(id) } }
  const h = await eligible(t, { clock, delivery, worker: () => strictWorker() })
  await idle(h)
  assert.deepEqual(forgotten, [])
  h.registry.dispatch(ev("session.deleted", "ses_a"))
  await flush()
  assert.deepEqual(forgotten, ["ses_a"])
  assert.equal(idle(h), undefined) // gone
  assert.equal(h.host.calls.synthetic.length, 1)
})

// ---------------------------------------------------------------------------------------------------------------------
// Events alone never deliver

function generator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

test("property: any sequence of events with no hook call makes no claim and no admission, and the same session claims once the hook runs", async t => {
  const SESSIONS = ["ses_ctl", "ses_r1", "ses_r2"]
  const TYPES = [...EVENT_TYPES, DELIVERED, DELIVERED, DELIVERED, "session.inbox.enqueued", "session.agent.selected", "session.unknown", 7, undefined]
  for (let seed = 1; seed <= 25; seed++) {
    const random = generator(seed)
    const pick = list => list[Math.floor(random() * list.length)]
    const h = build({ worker: () => strictWorker() })
    t.after(() => h.detach())
    await join(h, "ses_ctl")
    const seen = []
    for (let step = 0; step < 80; step++) {
      const sessionID = pick(SESSIONS)
      let type = pick(TYPES)
      // The control session stays a joined root: the property is about the events that leave it eligible.
      if (sessionID === "ses_ctl" && (type === "session.deleted" || type === "session.forked")) type = "session.compaction.ended"
      const shapes = [
        () => ({ id: `e${step}`, type, data: { sessionID } }),
        () => ({ id: `e${step}`, type, data: { sessionID, inboxID: pick(["msg_x", inboxIDOf(attemptID(1)), 7, null, ""]) } }),
        () => ({ type, data: { sessionID, parentID: sessionID === "ses_ctl" ? undefined : "ses_p" } }),
        () => null,
        () => undefined,
        () => ({}),
        () => ({ type }),
        () => ({ type, data: null }),
        () => ({ type, data: { sessionID: 7 } }),
        () => "text",
        () => ({ type: 5, data: { sessionID } }),
        () => (seen.length ? pick(seen) : null), // a replay
      ]
      const item = pick(shapes)()
      if (item !== null && typeof item === "object" && item.type !== undefined) seen.push(item)
      h.registry.dispatch(item)
      if (random() < 0.1) h.member.reset() // a stream gap
      if (random() < 0.05) await tick()
    }
    await flush()
    assert.deepEqual(opsOf(h).filter(op => ["pending", "claim", "settle"].includes(op)), [], `seed ${seed}`)
    assert.deepEqual(h.host.calls.synthetic, [], `seed ${seed}`)
    assert.deepEqual(h.host.calls.prompt, [], `seed ${seed}`)
    assert.deepEqual(h.host.calls.wait, [], `seed ${seed}`)
    // The positive control: the check above could have failed, because the hook does claim for this session.
    await idle(h, "ses_ctl")
    assert.equal(claimsOf(h), 1, `seed ${seed}`)
    assert.equal(h.host.calls.synthetic.length, 1, `seed ${seed}`)
  }
})
