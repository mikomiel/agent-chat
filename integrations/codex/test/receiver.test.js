import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createThread } from "../lib/appserver.js"
import { createReceiver, processStartTime, runReceiver } from "../lib/receiver.js"
import { startWorker } from "../lib/worker.js"
import { CHAT_PREFIX, MAX_BINDING_BYTES, MAX_OUTPUT_BYTES } from "../lib/channel.js"
import { fakeAppServer } from "./fake-app-server.js"

const ROOM = "33333333-3333-4333-8333-333333333333"
const baseConfig = { python: "/usr/bin/python3", directory: "/tmp/agent-chat-state", serverOrigin: "https://chat.example", hostToken: "synthetic-host-token" }
const row = id => ({
  id, kind: "question", room_id: ROOM, history_after: `cursor-${id}`, body: `body of ${id}`,
  sender_session_id: "peer-1", created_at: "2026-01-01T00:00:00Z",
})
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
const validRow = (id, extra = {}) => ({
  id, kind: "question", room_id: ROOM, history_after: "1234", body: `body of ${id}`,
  sender_session_id: uid(900), created_at: "2026-01-01T00:00:00+00:00", ...extra,
})
const APP_SERVER = "unix:///tmp/agent-chat-app-server.sock"
const ADMITTED = "2026-01-01T00:00:05+00:00"
const bytes = text => Buffer.byteLength(text, "utf8")
const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

// A manual scheduler: nothing runs until the test advances the clock.
function scheduler() {
  let clock = 1_000_000
  let next = 1
  const timers = new Map()
  const add = (fn, ms, repeat) => { const id = next++; timers.set(id, { fn, at: clock + ms, ms, repeat }); return id }
  return {
    now: () => clock,
    setTimeoutImpl: (fn, ms) => add(fn, ms, false),
    clearTimeoutImpl: id => { timers.delete(id) },
    setIntervalImpl: (fn, ms) => add(fn, ms, true),
    clearIntervalImpl: id => { timers.delete(id) },
    count: () => timers.size,
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        clock = timer.at
        if (timer.repeat) timer.at += timer.ms
        else timers.delete(id)
        timer.fn()
        await settle()
      }
      clock = end
      await settle()
    },
  }
}

// The product's worker, as a double. `handlers` override one operation each. `gate` holds a join open: one gate for
// every worker, or a function of the worker's number (1 is the first) that returns the gate of that worker, if any.
// Like the product's worker, a worker whose join is still open refuses every other request as busy.
function workerDouble({ events, handlers = {}, gate, joinErrors = [] } = {}) {
  const log = []
  const bootIds = []
  const state = { stops: 0, busy: 0 }
  const answers = {
    heartbeat: () => ({}),
    pending: () => ({ messages: [] }),
    claim: fields => ({ dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, messages: fields.messages.map(row) }),
    status: () => ({ muted: false }),
    settle: () => ({}),
    ...handlers,
  }
  const startProcess = (_config, identity) => {
    bootIds.push(identity.bootId)
    let finish
    const closed = new Promise(resolve => { finish = resolve })
    const joined = {
      session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
      room_id: ROOM, host: "synthetic-host", harness: "codex", instance_file: `/tmp/agent-chat-state/${identity.bootId}.json`,
    }
    const refusal = joinErrors[bootIds.length - 1]
    const hold = typeof gate === "function" ? gate(bootIds.length) : gate
    let joining = Boolean(hold)
    return {
      ready: refusal ? Promise.reject(refusal) : hold ? hold.promise.then(() => { joining = false; return joined }) : Promise.resolve(joined),
      async request(op, fields = {}) {
        if (joining) {
          state.busy += 1
          throw Object.assign(new Error("CHAT_WORKER_BUSY"), { code: "CHAT_WORKER_BUSY", operation: op })
        }
        log.push({ op, ...fields })
        events?.push(op === "heartbeat" ? `heartbeat:${fields.state.native_state}` : op === "settle" ? `settle:${fields.result.outcome}` : op)
        return answers[op](fields)
      },
      stop() { state.stops += 1; events?.push("stop"); finish({ code: 0, signal: null }); return closed },
      closed,
    }
  }
  return { startProcess, log, bootIds, state, ops: name => log.filter(entry => entry.op === name) }
}

// The hook end of one connection, as a double. A context frame with `ack` is
// answered with the configured write receipt, like a hook that wrote the output.
function hookDouble({ events, receipt = "written", answer = true, sendOk = true } = {}) {
  const sent = []
  const queue = []
  const listeners = []
  let closed = false
  return {
    sent,
    get closed() { return closed },
    onClose: fn => listeners.push(fn),
    close() { if (!closed) { closed = true; for (const fn of listeners) fn() } },
    async send(value) {
      if (closed) return false
      sent.push(value)
      if (typeof value.context === "string") events?.push("write")
      if (!sendOk) return false
      if (value.ack === true && answer) queue.push({ op: "done", outcome: receipt })
      return true
    },
    async next() {
      const frame = queue.shift() ?? null
      if (frame) events?.push("receipt")
      return frame
    },
  }
}

// `skew` returns milliseconds added to the receiver's clock, so a test can move the policy's time without moving the timers.
// `start` replaces the worker double's `startProcess`, to run the real worker wrapper over a fake child process.
async function rig({ handlers, gate, joinErrors, alive = () => true, startTime = () => null, config = {}, thread, skew = () => 0, start } = {}) {
  const clock = scheduler()
  const events = []
  const worker = workerDouble({ events, handlers, gate, joinErrors })
  let exitCode
  const receiver = createReceiver({ ...baseConfig, ...(thread ? { appServer: APP_SERVER } : {}), ...config }, { sessionId: "session-1", ownerPid: 4242 }, {
    startProcess: start ?? worker.startProcess,
    openThread: options => { thread?.opened.push(options); return thread },
    now: () => clock.now() + skew(),
    random: () => 0.5,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    alive: pid => alive(pid),
    startTime: pid => startTime(pid),
    release: () => events.push("release"),
    exit: code => { exitCode = code; events.push(`exit:${code}`) },
  })
  void receiver.start()
  await settle()
  const rigged = {
    receiver, clock, events, worker,
    get exitCode() { return exitCode },
    async op(request, hook = hookDouble({ events })) {
      await receiver.handle(request, hook)
      return hook
    },
    // The hook that opens a session: announce the binding, as session-start does.
    async begin() {
      const hook = await rigged.op({ op: "start", wait_ms: 5000 })
      events.length = 0
      worker.log.length = 0
      return hook
    },
  }
  return rigged
}

const turn = (extra = {}) => ({ op: "turn", event: "prompt", permission_mode: "default", patience_ms: 6000, ...extra })

test("a session start joins, reports unknown and stopped, and announces the binding", async () => {
  const r = await rig()
  assert.equal(r.worker.bootIds.length, 1)
  assert.deepEqual(r.worker.ops("heartbeat")[0].state, { native_state: "unknown", stopped: true, plan_mode: false })
  const hook = await r.op({ op: "start", wait_ms: 5000 })
  const reply = hook.sent[0]
  assert.equal(reply.ack, true)
  assert.match(reply.message, /^Agent Chat: joined as 11111111-1111-4111-8111-111111111111 in room 33333333-/)
  assert.match(reply.context, /Agent Chat is available to this session/)
  assert.match(reply.context, /supersedes every earlier Agent Chat binding/)
  const binding = JSON.parse(reply.context.split("\n").at(-1))
  assert.equal(binding.harness, "codex")
  assert.equal(binding.native_session_id, "session-1")
  assert.equal(binding.python, baseConfig.python)
  assert.equal(binding.instance_file, `/tmp/agent-chat-state/${r.worker.bootIds[0]}.json`)
  assert.ok(bytes(reply.context) <= MAX_BINDING_BYTES)
  assert.doesNotMatch(JSON.stringify(reply), /synthetic-host-token/)
  assert.deepEqual(Object.keys(r.worker.log.find(entry => entry.op === "heartbeat").state).sort(), ["native_state", "plan_mode", "stopped"])
})

// A binding that could not be shown must not be joined for. The receiver renders the longest binding any join could give this
// config (UUIDs, `<boot id>.json` in the state directory, a 63-character host) and refuses before the join when it does not
// fit: chat stays off, with the code, and no worker starts. The bound is the worst case, so a path that fits with the host
// this join would give, but not with the longest one, is refused too.
test("an interpreter path that makes the longest binding too long starts no worker and says so; one byte shorter joins", async () => {
  const sized = await rig()
  const shown = bytes((await sized.begin()).sent[0].context)
  const host = "synthetic-host"
  const fits = baseConfig.python.length + (MAX_BINDING_BYTES - shown) - (63 - host.length) // the longest binding is exactly the limit
  const python = length => `/usr/bin/${"p".repeat(length - "/usr/bin/".length)}`
  const joins = await rig({ config: { python: python(fits) } })
  assert.equal(joins.worker.bootIds.length, 1, "the longest binding is exactly the limit: it joins")
  assert.ok(bytes((await joins.begin()).sent[0].context) <= MAX_BINDING_BYTES)
  for (const length of [fits + 1, 4000]) {
    const r = await rig({ config: { python: python(length) } })
    assert.equal(r.worker.bootIds.length, 0, `no worker for a ${length}-byte interpreter path`)
    assert.equal(r.receiver.state(), "offline")
    const start = await r.op({ op: "start", wait_ms: 5000 })
    assert.deepEqual(start.sent, [{ disabled: true, message: "Agent Chat stopped (CHAT_BINDING_TOO_LONG); the Codex session is unchanged." }])
  }
})

// The worst case rests on the core's grammar. A join whose own binding does not fit after all (a host outside that grammar),
// or lacks a field, is not kept: the worker is stopped at once and chat stays off with the code, not joined and silent.
test("a join whose own binding does not fit, or lacks a field, is ended at once and says so", async () => {
  for (const [change, code] of [
    [joined => ({ ...joined, host: "h".repeat(MAX_BINDING_BYTES) }), "CHAT_BINDING_TOO_LONG"],
    [joined => ({ ...joined, instance_file: "" }), "CHAT_PROTOCOL_INVALID"],
  ]) {
    const double = workerDouble()
    const r = await rig({ start: (config, identity) => {
      const worker = double.startProcess(config, identity)
      return { ...worker, ready: worker.ready.then(change) }
    } })
    assert.equal(double.bootIds.length, 1, code)
    assert.equal(double.state.stops, 1, `the joined worker is stopped (${code})`)
    assert.deepEqual(double.ops("heartbeat"), [], code)
    assert.equal(r.receiver.state(), "offline", code)
    const start = await r.op({ op: "start", wait_ms: 5000 })
    assert.deepEqual(start.sent, [{ disabled: true, message: `Agent Chat stopped (${code}); the Codex session is unchanged.` }])
  }
})

// Metadata mode has no retry marker, so it claims the candidates whole. When their widest rendering does not fit beside a
// binding still to be announced, nothing is claimed: the binding goes alone, and the next hook, with the room the binding
// left, is offered the same batch whole. No attempt is spent on a notice that could not be shown.
test("metadata rows that do not fit beside a long unannounced binding are not claimed; the binding goes alone, and the next hook delivers them", async () => {
  const sized = await rig()
  const shown = bytes((await sized.begin()).sent[0].context)
  const fits = baseConfig.python.length + (MAX_BINDING_BYTES - shown) - (63 - "synthetic-host".length)
  const ids = Array.from({ length: 16 }, (_, index) => uid(index + 1))
  const r = await rig({
    config: { python: `/usr/bin/${"p".repeat(fits - "/usr/bin/".length)}` },
    handlers: deliverable({ pending: () => ({ messages: ids }) }),
  })
  r.worker.log.length = 0
  const first = await r.op(turn())
  assert.ok(bytes(first.sent[0].context) > MAX_BINDING_BYTES - 100, "the binding is near the cap")
  assert.equal(r.worker.ops("pending").length, 1)
  assert.deepEqual(r.worker.ops("claim"), [], "nothing is claimed")
  assert.deepEqual(r.worker.ops("settle"), [], "no attempt is spent")
  assert.deepEqual(first.sent.map(frame => frame.context), [first.sent[0].context])
  assert.match(first.sent[0].context, /^Agent Chat is available/)
  assert.equal(first.sent[0].context.includes(uid(1)), false, "the binding goes alone")
  const next = await r.op(turn())
  assert.deepEqual(r.worker.ops("claim").map(entry => entry.messages), [ids], "the batch is claimed whole")
  for (const id of ids) assert.ok(next.sent[0].context.includes(id), id)
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "handed", reason: null }])
})

// The estimate holds every metadata row at its widest. The longest interpreter path whose hook, beside an unannounced
// binding, still claims is found by bisection: there the claimed rows at their widest are handed, and one byte longer the
// binding goes alone with nothing claimed. A claim is never spent on rows at their widest that cannot be shown.
test("beside an unannounced binding, widest metadata rows are claimed exactly when their notice fits", async () => {
  const ids = Array.from({ length: 16 }, (_, index) => uid(index + 1))
  const widestRow = id => validRow(id, { kind: "consultation", history_after: "9".repeat(19) })
  const hook = async length => {
    const r = await rig({
      config: { python: `/usr/bin/${"p".repeat(length - "/usr/bin/".length)}` },
      handlers: deliverable({
        pending: () => ({ messages: ids }),
        claim: fields => ({ dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, messages: fields.messages.map(widestRow) }),
      }),
    })
    const sent = await r.op(turn())
    return { claimed: r.worker.ops("claim").length > 0, settled: r.worker.ops("settle").map(entry => entry.result), sent: sent.sent }
  }
  let lo = baseConfig.python.length
  let hi = 1500
  assert.equal((await hook(lo)).claimed, true)
  assert.equal((await hook(hi)).claimed, false)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await hook(mid)).claimed) lo = mid
    else hi = mid
  }
  const last = await hook(lo)
  assert.deepEqual(last.settled, [{ outcome: "handed", reason: null }], `the longest path that claims (${lo} bytes) hands its notice`)
  assert.ok(bytes(last.sent[0].context) <= MAX_OUTPUT_BYTES)
  const over = await hook(hi)
  assert.deepEqual(over.settled, [], "one byte longer spends no attempt")
  assert.match(over.sent[0].context, /^Agent Chat is available/)
})

// A start drops the earlier receipt before it announces: a compaction may have removed the text, so a start whose write is
// not confirmed leaves the binding unannounced, and the next tool hook carries it.
test("a start whose announcement is not confirmed leaves the binding to the next tool hook", async () => {
  for (const hook of [{ receipt: "failed" }, { answer: false }]) {
    const r = await rig()
    await r.begin() // the first start is confirmed
    await r.op({ op: "start", wait_ms: 0 }, hookDouble({ events: r.events, ...hook })) // a compaction: no confirmed write
    const tool = await r.op(turn({ event: "tool" }))
    assert.match(tool.sent[0].context ?? "", /Agent Chat is available/, JSON.stringify(hook))
  }
})

test("the binding is announced once, then re-announced by every later start event", async () => {
  const r = await rig()
  await r.begin()
  const quiet = await r.op(turn())
  assert.deepEqual(quiet.sent, [{ context: null }], "a turn after the announcement adds nothing")
  const compact = await r.op({ op: "start", wait_ms: 0 })
  assert.match(compact.sent[0].context, /Agent Chat is available/, "a compaction may have dropped the earlier text")
})

test("a binding whose write was not confirmed is announced again", async () => {
  const r = await rig()
  await r.op({ op: "start", wait_ms: 5000 }, hookDouble({ events: r.events, receipt: "failed" }))
  const next = await r.op(turn())
  assert.match(next.sent[0].context, /Agent Chat is available/)
})

test("a start event does not wait past its budget for a join that is still pending", async () => {
  let open
  const gate = { promise: new Promise(resolve => { open = resolve }) }
  const r = await rig({ gate })
  const hook = hookDouble()
  const answered = r.receiver.handle({ op: "start", wait_ms: 5000 }, hook)
  await settle()
  assert.deepEqual(hook.sent, [], "still waiting")
  await r.clock.advance(5000)
  await answered
  assert.deepEqual(hook.sent, [{ context: null }])
  open()
  await settle()
  const later = await r.op(turn())
  assert.match(later.sent[0].context, /Agent Chat is available/, "the next event announces what the start could not")
})

test("a prompt event reports busy and delivers a claimed batch before it settles handed", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
  await r.begin()
  const hook = await r.op(turn(), hookDouble({ events: r.events }))
  assert.deepEqual(r.events, ["heartbeat:busy", "pending", "claim", "status", "write", "receipt", "settle:handed"])
  assert.deepEqual(r.worker.ops("heartbeat")[0].state, { native_state: "busy", stopped: false, plan_mode: false })
  const [frame] = hook.sent
  assert.equal(frame.ack, true)
  assert.ok(frame.context.startsWith(CHAT_PREFIX))
  assert.match(frame.context, /"id":"m1"/)
  assert.doesNotMatch(frame.context, /body of m1/, "metadata only by default")
  assert.equal(hook.sent.length, 1)
  assert.deepEqual(r.worker.ops("settle")[0], { op: "settle", attempt: "attempt-1", result: { outcome: "handed", reason: null } })
})

test("a tool event delivers the same way, with bodies when the config asks for them", async () => {
  const id = uid(1)
  const r = await rig({
    handlers: {
      pending: () => ({ messages: [id], sizes: { [id]: 12 } }),
      claim: fields => ({ dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, admitted_at: ADMITTED, messages: fields.messages.map(value => validRow(value)) }),
    },
    config: { noticeBodies: true },
  })
  await r.begin()
  const hook = await r.op(turn({ event: "tool" }))
  assert.match(hook.sent[0].context, new RegExp(`body of ${id}`))
  assert.equal(r.worker.ops("pending")[0].bodies, true)
  assert.equal(r.worker.ops("claim")[0].bodies, true)
})

test("an unannounced binding and a notice share one output under the 6,000-byte cap", async () => {
  const ids = Array.from({ length: 16 }, (_, index) => uid(index + 1))
  const sizes = Object.fromEntries(ids.map(id => [id, 15_000]))
  const r = await rig({
    handlers: {
      pending: () => ({ messages: ids, sizes }),
      claim: fields => ({
        dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, admitted_at: ADMITTED,
        messages: fields.messages.map(id => validRow(id, { body: "€".repeat(5000) })),
      }),
    },
    config: { noticeBodies: true },
  })
  const hook = await r.op(turn())
  const [frame] = hook.sent
  assert.ok(frame.context.startsWith("Agent Chat is available to this session."), "the binding leads")
  assert.ok(frame.context.includes(CHAT_PREFIX))
  assert.ok(bytes(frame.context) <= MAX_OUTPUT_BYTES, `${bytes(frame.context)} bytes`)
  assert.ok(r.worker.ops("claim")[0].messages.length < ids.length, "the claim is the prefix one notice can carry")
  assert.equal(r.worker.ops("settle")[0].result.outcome, "handed")
})

test("the worst announcement and the worst prefix still leave a notice its room", async () => {
  // The longest binding the receiver will announce, a delivery line and the widest metadata row.
  const limit = MAX_OUTPUT_BYTES - MAX_BINDING_BYTES - bytes("\n\n") - bytes(CHAT_PREFIX)
  assert.ok(limit >= 3_800, `${limit} bytes are left for the notice`)
})

test("a batch that cannot fit even as metadata is deferred and never handed", async () => {
  const rows = Array.from({ length: 16 }, (_, index) => `m${index}-${"c".repeat(600)}`)
  const r = await rig({ handlers: { pending: () => ({ messages: rows }) } })
  await r.begin()
  const hook = await r.op(turn())
  assert.deepEqual(hook.sent, [{ context: null }], "nothing is written to the model")
  assert.deepEqual(r.worker.ops("settle")[0].result, { outcome: "deferred", reason: "offline" })
})

test("a write the hook refused settles failed, never handed", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
  await r.begin()
  await r.op(turn(), hookDouble({ events: r.events, receipt: "refused" }))
  assert.deepEqual(r.worker.ops("settle")[0].result, { outcome: "failed", reason: "native_unavailable" })
})

test("a write that failed or went unconfirmed settles uncertain, never handed", async () => {
  for (const hook of [
    hookDouble({ receipt: "failed" }),
    hookDouble({ answer: false }),
    hookDouble({ sendOk: false }),
  ]) {
    const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
    await r.begin()
    await r.op(turn(), hook)
    assert.deepEqual(r.worker.ops("settle")[0].result, { outcome: "uncertain", reason: "transport_ambiguous" })
  }
})

// The hook waits for one reply, and the state report that comes first spends the same time: the deadline is taken when the
// request arrives, so a heartbeat that used up the hook's patience leaves no claim behind it.
test("a slow heartbeat leaves no time for the hook, so no claim starts, and one that leaves time does not stop it", async () => {
  for (const [took, claims] of [[5000, 0], [1000, 1]]) {
    let skewMs = 0
    const r = await rig({ skew: () => skewMs, handlers: { pending: () => ({ messages: ["m1"] }), heartbeat: () => { skewMs += took; return {} } } })
    await r.begin()
    const hook = await r.op(turn())
    assert.equal(r.worker.ops("heartbeat").length, 1, `the turn reported its state first (${took} ms)`)
    assert.equal(r.worker.ops("claim").length, claims, `claims after a ${took} ms heartbeat`)
    if (!claims) {
      assert.deepEqual(r.worker.ops("pending"), [], "not even the pending read")
      assert.deepEqual(r.worker.ops("settle"), [], "nothing to settle")
      assert.deepEqual(hook.sent, [{ context: null }])
    }
  }
})

// What happens to a batch that was claimed and then never sent: the hook was gone, or its time was up, before the write.
// Nothing reached its output, so the batch is not handed and the ledger can offer it again (failed), never uncertain.
test("a hook that is gone, or out of time, before the write settles failed and retryable, not uncertain", async () => {
  const gone = hookDouble()
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }), status: () => { gone.close(); return { muted: false } } } })
  await r.begin()
  await r.op(turn(), gone)
  assert.deepEqual(gone.sent, [], "nothing was sent to the hook")
  assert.deepEqual(r.worker.ops("settle")[0].result, { outcome: "failed", reason: "native_unavailable" })
  let skewMs = 0
  const late = await rig({ skew: () => skewMs, handlers: { pending: () => ({ messages: ["m1"] }), status: () => { skewMs += 6500; return { muted: false } } } })
  await late.begin()
  const hook = await late.op(turn())
  assert.equal(hook.sent.some(frame => typeof frame.context === "string" && frame.context.includes("m1")), false, "the notice was not sent past the hook's time")
  assert.deepEqual(late.worker.ops("settle")[0].result, { outcome: "failed", reason: "native_unavailable" })
})

// The claim can take long, and the hook can go or run out of time meanwhile. That is asked as soon as the grant is in: a hook
// that cannot be written to makes no status request, and the batch settles failed (offered again), never uncertain, even
// when the reservation has also run short by then.
test("a claim that comes back after the hook went, or after its time, asks for no status and settles failed, not uncertain", async () => {
  for (const [label, took, close] of [["gone", 0, true], ["out of time", 6500, false], ["gone with the reservation used up", 29_800, true]]) {
    let skewMs = 0
    const hook = hookDouble()
    const r = await rig({ skew: () => skewMs, handlers: {
      pending: () => ({ messages: ["m1"] }),
      claim: fields => { skewMs += took; if (close) hook.close(); return { dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, messages: fields.messages.map(row) } },
    } })
    await r.begin()
    await r.op(turn(), hook)
    assert.deepEqual(r.worker.ops("status"), [], `no status request (${label})`)
    assert.equal(hook.sent.some(frame => typeof frame.context === "string" && frame.context.includes("m1")), false, `nothing written (${label})`)
    assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "failed", reason: "native_unavailable" }], label)
  }
})

test("a hook that goes while the status request uses up the reservation settles failed, not uncertain", async () => {
  let skewMs = 0
  const hook = hookDouble()
  const r = await rig({ skew: () => skewMs, handlers: { pending: () => ({ messages: ["m1"] }), status: () => { skewMs += 29_800; hook.close(); return { muted: false } } } })
  await r.begin()
  await r.op(turn({ patience_ms: 30_000 }), hook)
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "failed", reason: "native_unavailable" }])
})

// The hook is asked once more right before the write: the status request can come back just in time and the notice be
// rendered after the hook's time ran out. Nothing is sent then, and the batch is offered again.
test("a notice that is ready only after the hook's time ran out is not sent, and settles failed", async () => {
  let skewMs = 0
  let afterStatus = 0
  const r = await rig({ skew: () => (afterStatus > 0 && ++afterStatus > 3 ? skewMs + 2000 : skewMs), handlers: {
    pending: () => ({ messages: ["m1"] }),
    status: () => { skewMs += 5900; afterStatus = 1; return { muted: false } }, // 100 ms before the 6-second deadline
  } })
  await r.begin()
  const hook = await r.op(turn())
  assert.equal(r.worker.ops("status").length, 1)
  assert.equal(hook.sent.some(frame => typeof frame.context === "string" && frame.context.includes("m1")), false, "nothing was sent")
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "failed", reason: "native_unavailable" }])
})

// Right before the write, a hook that is gone or out of time comes first: nothing can be written to it, so the batch is
// not handed and is offered again, even when the reservation ran out too.
test("right before the write, a hook out of time settles failed even when the reservation ran out too", async () => {
  let skewMs = 0
  let afterStatus = 0
  const r = await rig({ skew: () => (afterStatus > 0 && ++afterStatus > 3 ? skewMs + 30_000 : skewMs), handlers: {
    pending: () => ({ messages: ["m1"] }),
    status: () => { skewMs += 5900; afterStatus = 1; return { muted: false } },
  } })
  await r.begin()
  const hook = await r.op(turn())
  assert.equal(hook.sent.some(frame => typeof frame.context === "string" && frame.context.includes("m1")), false, "nothing was sent")
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "failed", reason: "native_unavailable" }])
})

test("a hook that goes after the status check and before the write gets nothing, and the batch settles failed", async () => {
  let afterStatus = 0
  let hook
  const r = await rig({ skew: () => { if (afterStatus > 0 && ++afterStatus === 3) hook.close(); return 0 }, handlers: {
    pending: () => ({ messages: ["m1"] }),
    status: () => { afterStatus = 1; return { muted: false } },
  } })
  await r.begin()
  hook = hookDouble({ events: r.events })
  await r.op(turn(), hook)
  assert.equal(hook.sent.some(frame => typeof frame.context === "string" && frame.context.includes("m1")), false, "nothing was sent")
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "failed", reason: "native_unavailable" }])
})

test("Plan Mode is reported and nothing is claimed", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
  await r.begin()
  const hook = await r.op(turn({ permission_mode: "plan" }))
  assert.deepEqual(r.worker.ops("heartbeat")[0].state, { native_state: "unknown", stopped: false, plan_mode: true })
  assert.deepEqual(r.worker.ops("pending"), [])
  assert.deepEqual(r.worker.ops("claim"), [])
  assert.deepEqual(hook.sent, [{ context: null }])
  const after = await r.op(turn())
  assert.equal(r.worker.ops("claim").length, 1, "leaving Plan Mode restores delivery at the next event")
  assert.match(after.sent[0].context, /"id":"m1"/)
})

test("a missing or unusable permission mode is unknown and claims nothing", async () => {
  for (const mode of [undefined, "", 7, null]) {
    const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
    await r.begin()
    const hook = await r.op(turn({ permission_mode: mode }))
    assert.equal(r.receiver.state(), "unknown", String(mode))
    assert.deepEqual(r.worker.ops("claim"), [], String(mode))
    assert.deepEqual(hook.sent, [{ context: null }], String(mode))
  }
})

test("a muted session settles deferred and writes nothing", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }), status: () => ({ muted: true }) } })
  await r.begin()
  const hook = await r.op(turn())
  assert.deepEqual(r.worker.ops("settle")[0].result, { outcome: "deferred", reason: "muted" })
  assert.deepEqual(hook.sent, [{ context: null }])
})

test("a reservation too short to write inside is uncertain and asks for no status", async () => {
  const r = await rig({
    handlers: {
      pending: () => ({ messages: ["m1"] }),
      claim: fields => ({ dispatch: true, attempt_id: "attempt-1", reservation_ms: 400, messages: fields.messages.map(row) }),
    },
  })
  await r.begin()
  const hook = await r.op(turn())
  assert.deepEqual(r.worker.ops("status"), [])
  assert.deepEqual(r.worker.ops("settle")[0].result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.deepEqual(hook.sent, [{ context: null }])
})

test("a refused claim writes nothing and settles nothing", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }), claim: () => ({ refused: "DELIVERY_BLOCKED" }) } })
  await r.begin()
  const hook = await r.op(turn())
  assert.deepEqual(r.worker.ops("settle"), [])
  assert.deepEqual(hook.sent, [{ context: null }])
  assert.equal(r.receiver.state(), "busy", "an ordinary refusal does not end chat")
})

test("a hook that is gone before the claim, or has too little time left, claims nothing", async () => {
  const leaving = hookDouble()
  const gone = await rig({ handlers: { pending: () => { leaving.close(); return { messages: ["m1"] } } } })
  await gone.begin()
  await gone.op(turn(), leaving)
  assert.deepEqual(gone.worker.ops("claim"), [])

  const hurried = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
  await hurried.begin()
  await hurried.op(turn({ patience_ms: 1000 }))
  assert.deepEqual(hurried.worker.ops("claim"), [])
})

test("parallel tool events never stack a second claim behind a slow request", async () => {
  let release
  const r = await rig({ handlers: { pending: () => new Promise(resolve => { release = () => resolve({ messages: [] }) }) } })
  await r.begin()
  const first = hookDouble()
  const firstDone = r.receiver.handle(turn(), first)
  await settle()
  const second = hookDouble()
  await r.receiver.handle(turn(), second)
  assert.deepEqual(second.sent, [{ context: null }], "the second event answers at once")
  assert.equal(r.worker.ops("pending").length, 1)
  release()
  await firstDone
  assert.deepEqual(first.sent, [{ context: null }])
})

test("a stop event reports idle and starts no delivery", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
  await r.begin()
  await r.op(turn())
  r.worker.log.length = 0
  const hook = await r.op({ op: "stop", permission_mode: "default" })
  assert.deepEqual(r.worker.ops("heartbeat")[0].state, { native_state: "idle", stopped: false, plan_mode: false })
  assert.deepEqual(r.worker.ops("pending"), [])
  assert.deepEqual(hook.sent, [{ ok: true }])
})

async function idle(r) {
  await r.begin()
  await r.op(turn())
  await r.op({ op: "stop", permission_mode: "default" })
  r.worker.log.length = 0
  r.events.length = 0
}

test("a worker refusal that proves the lease gone starts the bounded rejoin and re-announces the binding", async () => {
  let refuse = true
  const r = await rig({ handlers: { pending: () => (refuse ? { refused: "STALE_INSTANCE" } : { messages: [] }) } })
  await r.begin()
  const first = await r.op(turn())
  assert.deepEqual(first.sent, [{ context: null }])
  assert.equal(r.worker.state.stops, 1, "the old worker is stopped")
  assert.equal(r.worker.bootIds.length, 1)
  refuse = false
  await r.clock.advance(3749)
  assert.equal(r.worker.bootIds.length, 1, "5 s base, jitter 0.5 to 1.0: this run waits 3.75 s")
  await r.clock.advance(1)
  assert.equal(r.worker.bootIds.length, 2)
  assert.notEqual(r.worker.bootIds[0], r.worker.bootIds[1])
  const after = await r.op(turn())
  assert.match(after.sent[0].context, new RegExp(r.worker.bootIds[1]))
  assert.match(after.sent[0].context, /previous instance_file is no longer valid/)
  assert.doesNotMatch(after.sent[0].context, new RegExp(r.worker.bootIds[0]))
})

test("a binding retired while the first turn runs is never announced, and the rejoin announces the new one", async () => {
  let refuse = true
  const r = await rig({ handlers: { pending: () => (refuse ? { refused: "STALE_INSTANCE" } : { messages: [] }) } })
  // No start event ran, so the first binding is still unannounced when the turn begins.
  const failed = await r.op(turn())
  assert.deepEqual(failed.sent, [{ context: null }], "the lease the turn found gone is not announced")
  assert.equal(r.worker.state.stops, 1)
  refuse = false
  await r.clock.advance(3750)
  assert.equal(r.worker.bootIds.length, 2)
  const next = await r.op(turn())
  assert.match(next.sent[0].context, new RegExp(r.worker.bootIds[1]), "the new binding is announced")
  assert.doesNotMatch(next.sent[0].context, new RegExp(r.worker.bootIds[0]))
})

// The two awaits in a turn, the state report and the delivery, can each end the
// binding the turn started with; neither may leave its announcement behind.
const fatal = Object.assign(new Error("x"), { code: "CHAT_PROTOCOL_INVALID", operation: "pending" })
for (const [label, answers] of [
  ["its state report finds the lease gone", () => { let beats = 0; return { heartbeat: () => (++beats > 1 ? { refused: "STALE_INSTANCE" } : {}) } }],
  ["its delivery fails chat closed", () => ({ pending: () => { throw fatal } })],
]) {
  test(`a turn announces nothing when ${label}`, async () => {
    const r = await rig({ handlers: answers() })
    const hook = await r.op(turn())
    assert.deepEqual(hook.sent, [{ context: null }])
    assert.equal(r.worker.state.stops, 1)
  })
}

// The core's worker answers a brief outage on a heartbeat or a pending read with a non-terminal `refused` reply and keeps
// the binding: its next heartbeat is the retry. The receiver must not retire a healthy worker or spend rejoin budget on it.
const BRIEF = ["SERVICE_UNAVAILABLE", "TRANSPORT_UNAVAILABLE", "REQUEST_UNCERTAIN"]

test("a brief outage reply on a heartbeat or a pending read keeps the worker, the binding and the rejoin budget", async () => {
  const answer = { heartbeat: null, pending: null }
  const served = []
  const r = await rig({ handlers: {
    heartbeat: () => { if (answer.heartbeat) served.push(`heartbeat:${answer.heartbeat}`); return answer.heartbeat ? { refused: answer.heartbeat } : {} },
    pending: () => { if (answer.pending) served.push(`pending:${answer.pending}`); return answer.pending ? { refused: answer.pending } : { messages: [] } },
  } })
  await r.begin()
  await r.op(turn())
  const timers = r.clock.count()
  for (const code of BRIEF) {
    for (const op of ["heartbeat", "pending"]) {
      const before = served.length
      answer[op] = code
      // A tick sends a heartbeat; a turn asks for the pending batch.
      const hook = op === "heartbeat" ? null : await r.op(turn())
      if (op === "heartbeat") await r.clock.advance(30_000)
      answer[op] = null
      assert.deepEqual(served.slice(before), [`${op}:${code}`], `the ${code} reply to ${op} reached the receiver`)
      if (hook) assert.deepEqual(hook.sent, [{ context: null }], "a pending read that was refused delivers nothing and disables nothing")
      assert.equal(r.worker.bootIds.length, 1, `${op} ${code}: one worker start`)
      assert.equal(r.worker.state.stops, 0, `${op} ${code}: the worker is not stopped`)
      assert.equal(r.clock.count(), timers, `${op} ${code}: no retry timer is set`)
      assert.notEqual(r.receiver.state(), "offline", `${op} ${code}: chat is not disabled`)
      const heartbeats = r.worker.ops("heartbeat").length
      await r.clock.advance(30_000)
      assert.equal(r.worker.ops("heartbeat").length, heartbeats + 1, `${op} ${code}: the same worker serves the next heartbeat`)
      assert.equal(r.worker.bootIds.length, 1)
    }
  }
  assert.equal(served.length, 6)
})

// Only the reply is a no-op. A worker error frame (the core refusing the request outright) is the product's own failure
// and still ends the worker and starts the bounded rejoin.
test("a worker error on a heartbeat still retires the worker and rejoins", async () => {
  let fail = false
  const failure = Object.assign(new Error("x"), { code: "CHAT_WORKER_REFUSED", workerCode: "SERVICE_UNAVAILABLE", operation: "heartbeat" })
  const r = await rig({ handlers: { heartbeat: () => { if (fail) throw failure; return {} } } })
  await r.begin()
  fail = true
  await r.clock.advance(30_000)
  assert.equal(r.worker.state.stops, 1, "the worker that threw is stopped")
  assert.equal(r.worker.bootIds.length, 1)
  fail = false
  await r.clock.advance(3750)
  assert.equal(r.worker.bootIds.length, 2, "and the rejoin starts a new one")
  assert.notEqual(r.receiver.state(), "offline")
})

// The real worker wrapper over a fake child process, so the receiver meets the codes the product's worker gives. The
// wrapper's own deadline timer is the one stub: a hand-written replacement for the global, restored when the test ends.
function realWorkers(t) {
  const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis
  const timers = new Map()
  let next = 1
  globalThis.setTimeout = (fn, ms) => { timers.set(next, { fn, ms }); return next++ }
  globalThis.clearTimeout = id => { timers.delete(id) }
  t.after(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout })
  const children = []
  const start = (workerConfig, identity) => startWorker(workerConfig, identity, {
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.kill = () => {}
      child.frames = []
      child.stdin.on("data", chunk => { for (const line of chunk.toString().split("\n").filter(Boolean)) child.frames.push(JSON.parse(line)) })
      children.push(child)
      return child
    },
  })
  const joined = child => child.stdout.write(`${JSON.stringify({ id: 0, result: {
    session_id: "11111111-1111-4111-8111-111111111111", instance_id: "22222222-2222-4222-8222-222222222222",
    room_id: ROOM, host: "synthetic-host", harness: "codex", instance_file: "/tmp/agent-chat-state/boot.json",
  } })}\n`)
  const fire = ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() } }
  return { children, start, joined, fire }
}

// A request that gets no answer is uncertain, and the worker's deadline says so with the core's code: the receiver
// rejoins. A worker that exits is another matter, and chat stays off.
test("a heartbeat that outlives the worker's deadline retires that worker and rejoins with a fresh one", async t => {
  const workers = realWorkers(t)
  const r = await rig({ start: workers.start })
  workers.joined(workers.children[0])
  await settle() // joined; its first heartbeat is written and never answered
  assert.equal(workers.children[0].frames.at(-1).op, "heartbeat")
  workers.fire(22_000)
  await settle()
  assert.notEqual(r.receiver.state(), "offline", "a timeout is not a permanent disable")
  assert.equal(workers.children[0].stdin.writableEnded, true, "the worker that missed its deadline is stopped")
  assert.equal(workers.children.length, 1, "and the new one waits out the back-off")
  await r.clock.advance(3750)
  assert.equal(workers.children.length, 2, "a fresh worker joins")
  assert.equal(workers.children[1].frames[0].op, "join")
  assert.notEqual(workers.children[1].frames[0].boot_id, workers.children[0].frames[0].boot_id)
  workers.joined(workers.children[1])
  await settle()
  assert.notEqual(r.receiver.state(), "offline")
  assert.equal(workers.children[1].frames.at(-1).op, "heartbeat", "the rejoined worker reports")
})

test("a worker that exits with a heartbeat in flight latches chat off and starts no other", async t => {
  const workers = realWorkers(t)
  const r = await rig({ start: workers.start })
  workers.joined(workers.children[0])
  await settle()
  assert.equal(workers.children[0].frames.at(-1).op, "heartbeat")
  workers.children[0].emit("close", 1, null)
  await settle()
  assert.equal(r.receiver.state(), "offline")
  assert.match((await r.op(turn())).sent[0].message, /Agent Chat stopped \(heartbeat:CHAT_REQUEST_UNCERTAIN\)/)
  await r.clock.advance(120_000)
  assert.equal(workers.children.length, 1, "no rejoin")
})

const joinRefusal = workerCode => Object.assign(new Error("x"), { code: "CHAT_WORKER_REFUSED", workerCode, operation: "join" })

test("a join conflict is the previous lease and rejoins; any other conflict fails closed", async () => {
  const r = await rig({ joinErrors: [joinRefusal("BINDING_CONFLICT")] })
  assert.equal(r.worker.bootIds.length, 1)
  assert.notEqual(r.receiver.state(), "offline", "a join conflict waits for the previous lease")
  await r.clock.advance(3750)
  assert.equal(r.worker.bootIds.length, 2)
  assert.notEqual(r.receiver.state(), "offline")

  const other = await rig({ handlers: { heartbeat: () => ({ refused: "BINDING_CONFLICT" }) } })
  assert.equal(other.receiver.state(), "offline", "a conflict after the join is not the previous lease")
})

test("a refused join latches chat off, and the session start says so once", async () => {
  const r = await rig({ joinErrors: [joinRefusal("UNAUTHENTICATED")] })
  assert.equal(r.receiver.state(), "offline")
  const first = await r.op({ op: "start", wait_ms: 5000 })
  assert.deepEqual(first.sent, [{
    disabled: true,
    message: "Agent Chat stopped (join:CHAT_WORKER_REFUSED:UNAUTHENTICATED); the Codex session is unchanged.",
  }])
  const second = await r.op({ op: "start", wait_ms: 0 })
  assert.deepEqual(second.sent, [{ disabled: true }])
  assert.equal(r.worker.bootIds.length, 1, "no retry for a refusal that is not a lease")
})

test("a malformed worker answer fails closed once and the hooks fall silent", async () => {
  const boom = Object.assign(new Error("x"), { code: "CHAT_PROTOCOL_INVALID", operation: "claim" })
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }), claim: () => { throw boom } } })
  await r.begin()
  await r.op(turn())
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 1)
  const first = await r.op(turn())
  assert.deepEqual(first.sent, [{
    disabled: true, message: "Agent Chat stopped (claim:CHAT_PROTOCOL_INVALID); the Codex session is unchanged.",
  }])
  const second = await r.op(turn())
  assert.deepEqual(second.sent, [{ disabled: true }], "the user is told once")
  const stop = await r.op({ op: "stop", permission_mode: "default" })
  assert.deepEqual(stop.sent, [{ ok: true }])
  const interrupt = await r.op({ op: "interrupt" })
  assert.deepEqual(interrupt.sent, [{ ok: true }])
  const settles = r.worker.ops("settle").length
  await r.clock.advance(120_000)
  assert.equal(r.worker.ops("settle").length, settles)
})

test("an exhausted rejoin budget fails closed instead of retrying forever", async () => {
  const r = await rig({ handlers: { heartbeat: () => ({ refused: "STALE_INSTANCE" }) } })
  for (let rejoin = 0; rejoin < 3; rejoin += 1) {
    assert.notEqual(r.receiver.state(), "offline")
    await r.clock.advance(3750)
  }
  assert.equal(r.worker.bootIds.length, 4, "the initial join and three rejoins")
  assert.equal(r.receiver.state(), "offline")
  await r.clock.advance(600_000)
  assert.equal(r.worker.bootIds.length, 4)
})

test("the heartbeat repeats on the core cadence", async () => {
  const r = await rig()
  await r.begin()
  await r.clock.advance(30_000)
  assert.equal(r.worker.ops("heartbeat").length, 1)
  await r.clock.advance(30_000)
  assert.equal(r.worker.ops("heartbeat").length, 2)
})

test("a session end closes the listener first, ends the worker and exits", async () => {
  const r = await rig()
  await r.begin()
  const hook = await r.op({ op: "end" })
  await settle()
  assert.deepEqual(hook.sent, [{ ok: true }])
  assert.deepEqual(r.events, ["release", "stop", "exit:0"])
  assert.equal(r.clock.count(), 0, "every timer is cleared")
  const late = await r.op(turn())
  assert.deepEqual(late.sent, [{ disabled: true }])
  await r.receiver.shutdown()
  assert.deepEqual(r.events.filter(event => event === "exit:0").length, 1)
})

// A resumed session's new process adopts the receiver. A late end from the old one changes nothing; the new one's end ends it.
test("a late session end from a replaced owner leaves the receiver to the owner that adopted it", async () => {
  const r = await rig()
  await r.op({ op: "start", wait_ms: 5000, owner_pid: 4242, permission_mode: "default" })
  await r.op({ op: "start", wait_ms: 0, owner_pid: 5151, permission_mode: "default" }) // the resume in a new process
  const late = await r.op({ op: "end", owner_pid: 4242 })
  await settle()
  assert.deepEqual(late.sent, [{ ok: true }])
  assert.equal(r.exitCode, undefined, "the old process's end does not end the receiver")
  assert.equal(r.worker.state.stops, 0)
  const tool = await r.op(turn({ event: "tool", owner_pid: 5151 }))
  assert.equal(tool.sent.length, 1)
  assert.notEqual(tool.sent[0].disabled, true, "the new owner's hook is still served")
  const end = await r.op({ op: "end", owner_pid: 5151 })
  await settle()
  assert.deepEqual(end.sent, [{ ok: true }])
  assert.equal(r.exitCode, 0, "the adopting owner's end ends it")
  assert.equal(r.worker.state.stops, 1)
})

test("a receiver whose owner is gone and that nothing has contacted ends itself", async () => {
  let owner = true
  const r = await rig({ alive: () => owner })
  await r.begin()
  await r.clock.advance(3_600_000)
  assert.equal(r.exitCode, undefined, "a live owner keeps it up however long it is idle")
  owner = false
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(150_000)
  assert.equal(r.exitCode, undefined, "inside the quiet window")
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(150_000)
  assert.equal(r.exitCode, undefined, "a hook contact restarts the quiet window")
  await r.clock.advance(60_000)
  assert.equal(r.exitCode, 0)
  assert.ok(r.events.includes("release") && r.events.includes("stop"))
})

test("a session resumed by a new Codex process hands the owner watch to it", async () => {
  const running = new Set([4242, 5151]) // the first owner, and the process that resumes the session
  const r = await rig({ alive: pid => running.has(pid) })
  await r.begin()
  running.delete(4242) // the first process exits without a SessionEnd
  await r.op({ op: "start", wait_ms: 0, owner_pid: 5151 }) // the resume reattaches before any cleanup
  await r.clock.advance(1_200_000) // one long tool call: twenty minutes with no hook contact
  assert.equal(r.exitCode, undefined, "the live new owner keeps the receiver and its instance up")
  const later = await r.op(turn({ owner_pid: 5151 }))
  assert.deepEqual(later.sent, [{ context: null }], "later hooks still reach the receiver")
  running.delete(5151)
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(210_000)
  assert.equal(r.exitCode, 0, "once the new owner is gone and quiet, the receiver still ends itself")
})

test("an owner hint that is not a live process never displaces the owner being watched", async () => {
  const r = await rig({ alive: pid => pid === 4242 })
  await r.begin()
  await r.op(turn({ owner_pid: 6000 }))
  await r.op({ op: "start", wait_ms: 0, owner_pid: 6000 })
  await r.clock.advance(1_200_000)
  assert.equal(r.exitCode, undefined, "the running owner is still the one watched")
})

// `kill(pid, 0)` says only that some process holds the id. The owner is the process
// recorded with its start time, so an id that another process reuses is not the owner.
test("an owner whose pid another process now holds is gone, and the receiver ends after the quiet window", async () => {
  const started = new Map([[4242, "1000"]]) // the start time each running process reports
  const r = await rig({ startTime: pid => started.get(pid) ?? null })
  await r.begin()
  started.set(4242, "2000") // the owner exited without a SessionEnd; another process took its pid
  await r.clock.advance(150_000)
  assert.equal(r.exitCode, undefined, "inside the quiet window")
  await r.clock.advance(60_000)
  assert.equal(r.exitCode, 0, "the pid still answers, but the process that holds it is not the owner")
  assert.ok(r.events.includes("release") && r.events.includes("stop"))
})

test("an adopted owner is followed by its start time as well as its pid", async () => {
  const running = new Set([4242, 5151])
  const started = new Map([[4242, "1000"], [5151, "3000"]])
  const r = await rig({ alive: pid => running.has(pid), startTime: pid => started.get(pid) ?? null })
  await r.begin()
  running.delete(4242)
  await r.op({ op: "start", wait_ms: 0, owner_pid: 5151 }) // the resume names its own process
  await r.clock.advance(1_200_000)
  assert.equal(r.exitCode, undefined, "the new owner is compared with its own start time, not the first owner's")
  started.set(5151, "3500") // that process exited without a SessionEnd and another took its pid
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(210_000)
  assert.equal(r.exitCode, 0)
})

test("a live owner is never mistaken for a reused pid, even when its start time cannot be read", async () => {
  let reading = "1000"
  const r = await rig({ startTime: () => reading })
  await r.begin()
  await r.clock.advance(1_200_000)
  assert.equal(r.exitCode, undefined, "the same process keeps the receiver up however long it is quiet")
  reading = null // the pid still answers but /proc does not
  await r.clock.advance(1_200_000)
  assert.equal(r.exitCode, undefined, "an unreadable start time falls back to the pid check")
})

test("the start time is field 22 of /proc stat, counted after the last parenthesis", () => {
  const rest = "S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654321 1000 100 18446744073709551615"
  for (const comm of ["node", "two words", "odd) name (x", "))", "("]) {
    assert.equal(processStartTime(4242, () => `4242 (${comm}) ${rest}\n`), "987654321", comm)
  }
  for (const stat of ["", "garbage", "4242 (node) S 1 2", `4242 (node) ${rest.replace("987654321", "later")}`]) {
    assert.equal(processStartTime(4242, () => stat), null, JSON.stringify(stat))
  }
  assert.equal(processStartTime(4242, () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }) }), null)
  for (const pid of [0, 1, -5, 1.5, Number.NaN, "4242", null, undefined]) {
    assert.equal(processStartTime(pid, () => `1 (a) ${rest}`), null, String(pid))
  }
})

test("the real reader returns this process's start time on Linux, and nothing for a pid nobody holds", t => {
  if (!existsSync("/proc/self/stat")) return t.skip("no /proc on this system")
  const mine = processStartTime(process.pid)
  assert.match(mine, /^\d+$/)
  assert.equal(processStartTime(process.pid), mine, "stable for the life of the process")
  assert.equal(processStartTime(2_147_483_647), null)
})

test("an unknown operation is refused without touching the worker", async () => {
  const r = await rig()
  await r.begin()
  const hook = await r.op({ op: "nope" })
  assert.deepEqual(hook.sent, [{ error: "bad_op" }])
  assert.deepEqual(r.worker.log, [])
})

// ---- app-server: thread reads and state ----------------------------------------------------------------------

// The app-server end of one thread, as a double. `observation` answers what lib/appserver.js would.
const IDLE = { reason: null, observed: { status: "idle", stopped: false, plan: false } }
function threadDouble({ bind = { status: "bound" }, observation = IDLE } = {}) {
  const thread = {
    opened: [], calls: [],
    async bind(options) { thread.calls.push("bind"); return typeof bind === "function" ? bind(options) : bind },
    async observe() { thread.calls.push("observe"); return typeof observation === "function" ? observation() : observation },
  }
  return thread
}
const deliverable = (extra = {}) => ({
  pending: () => ({ messages: [uid(1)] }),
  claim: fields => ({ dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, messages: fields.messages.map(id => validRow(id)) }),
  ...extra,
})
async function idleSession(r) {
  await r.begin()
  await r.op(turn())
  await r.op({ op: "stop", permission_mode: "default" })
  r.worker.log.length = 0
  r.events.length = 0
}

const models = readFileSync(new URL("../../../agent_chat/models.py", import.meta.url), "utf8")
const REASONS = Object.fromEntries([...models.matchAll(/^\s+"(\w+)": frozenset\(\{([^}]*)\}\),$/gm)].map(([, outcome, list]) => [
  outcome, list.split(",").map(item => item.trim()).filter(Boolean).map(item => (item === "None" ? null : item.replaceAll('"', ""))),
]))
const settleVocabulary = result => REASONS[result.outcome]?.includes(result.reason)

test("the delivery vocabulary is the core's, and every reason this package can settle is in it", () => {
  assert.deepEqual(Object.keys(REASONS).sort(), ["deferred", "failed", "handed", "uncertain"])
  assert.ok(REASONS.deferred.includes("stale_binding"))
  for (const result of [
    { outcome: "handed", reason: null }, { outcome: "failed", reason: "native_unavailable" },
    { outcome: "uncertain", reason: "transport_ambiguous" }, { outcome: "deferred", reason: "busy" },
    ...["muted", "unknown", "offline", "plan", "stopped"].map(reason => ({ outcome: "deferred", reason })),
  ]) assert.ok(settleVocabulary(result), JSON.stringify(result))
})

test("with no clock injected the receiver runs on the monotonic clock, and the wall clock is never read", t => {
  const wall = t.mock.method(Date, "now", () => 0) // a wall clock that was stepped back to the epoch
  createReceiver({ ...baseConfig, appServer: APP_SERVER }, { sessionId: "session-1", ownerPid: 4242 }, {
    openThread: () => threadDouble(),
  })
  assert.equal(wall.mock.callCount(), 0, "no clock of the receiver is the wall clock")
})

test("without an app-server the package is hook-only: no thread is opened and an idle session waits for its next turn", async () => {
  const r = await rig({ handlers: deliverable() })
  await idleSession(r)
  await r.clock.advance(30_000)
  assert.deepEqual(r.worker.ops("pending"), [])
  assert.equal(r.receiver.state(), null, "idle, from the hooks alone")
})

test("a delegated thread never joins: the thread is checked before the worker starts", async () => {
  const thread = threadDouble({ bind: { status: "child" } })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 0, "no worker, so no join")
  assert.equal(r.receiver.state(), "offline")
  const hook = await r.op({ op: "start", wait_ms: 5000 })
  assert.deepEqual(hook.sent, [{
    disabled: true, message: "Agent Chat stopped (CHAT_CHILD_THREAD); the Codex session is unchanged.",
  }])
  assert.deepEqual((await r.op(turn())).sent, [{ disabled: true }])
})

test("a thread the app-server does not list yet does not join: each heartbeat period looks again, and a positive check joins", async () => {
  let answer = { status: "unloaded" }
  const thread = threadDouble({ bind: () => answer })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 0, "a thread that is not there verifies nothing, so no join")
  const hook = await r.op({ op: "start", wait_ms: 5000 })
  assert.deepEqual(hook.sent, [{ context: null }], "the start hook does not wait for a join that is not coming yet")
  await r.clock.advance(29_000)
  assert.equal(thread.calls.filter(call => call === "bind").length, 1, "the next look is a full heartbeat period away")
  for (let period = 0; period < 5; period += 1) await r.clock.advance(30_000)
  assert.equal(r.worker.bootIds.length, 0, "still nothing verified")
  assert.ok(thread.calls.filter(call => call === "bind").length >= 6, "and it kept looking, more often than the rejoin budget allows")
  answer = { status: "bound" }
  await r.clock.advance(30_000)
  assert.equal(r.worker.bootIds.length, 1, "bound, so the join follows the next look")
})

test("a thread that turns out to be a child at a later check ends chat and never joins", async () => {
  let answer = { status: "unloaded" }
  const thread = threadDouble({ bind: () => answer })
  const r = await rig({ thread })
  answer = { status: "child" }
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.bootIds.length, 0, "no worker, so no join")
})

test("a thread that turns out to be a child at a later heartbeat read ends chat and stops the worker", async () => {
  let observation = IDLE
  const thread = threadDouble({ observation: () => observation })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 1)
  observation = { reason: "child", observed: { status: "unknown", stopped: false, plan: null } }
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 1)
})

// A read that a hook event overtook says nothing about the thread now. The session start is such an event: what the read found
// is dropped, and the next read decides.
test("a child answer that lands after a session start does not disable chat, and a current child answer still does", async () => {
  let release
  let reads = 0
  let answer = IDLE
  const child = { reason: "child", observed: { status: "unknown", stopped: false, plan: null } }
  const thread = threadDouble({ observation: () => (++reads === 1 ? new Promise(resolve => { release = () => resolve(child) }) : answer) })
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn())
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(30_000) // the tick's read is out
  assert.equal(reads, 1)
  await r.op({ op: "start", wait_ms: 5000 }) // the session start resets what the read was about
  release() // the child answer lands after the reset
  await settle()
  assert.notEqual(r.receiver.state(), "offline", "the stale answer did not disable chat")
  assert.equal(r.worker.state.stops, 0)
  await r.clock.advance(30_000) // the next read decides: the thread is no child
  assert.equal(reads, 2)
  assert.notEqual(r.receiver.state(), "offline")
  answer = child
  await r.clock.advance(30_000) // and a current child answer still ends chat
  assert.equal(reads, 3)
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 1)
})

// A heartbeat rebind is an answer like a read: one that a hook event (a session start) overtook commits nothing and never
// disables. The next tick binds again, and a current child answer still ends chat.
test("a rebind that a session start overtook does not disable chat on a child answer, and a current one still does", async () => {
  let release
  let held
  let binds = 0
  let answer = { status: "stale_binding" }
  const thread = threadDouble({ bind: options => {
    binds += 1
    if (binds !== 2) return answer
    held = options
    return new Promise(resolve => { release = () => resolve({ status: "child" }) })
  } })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 1, "a changed provider joins, unbound")
  await r.begin()
  await r.clock.advance(30_000) // the tick's rebind is out
  assert.equal(binds, 2)
  await r.op({ op: "start", wait_ms: 5000 })
  assert.equal(held.owns(), false, "the overtaken bind owns nothing it could commit")
  release()
  await settle()
  assert.notEqual(r.receiver.state(), "offline", "the stale child answer did not disable chat")
  assert.equal(r.worker.state.stops, 0)
  answer = { status: "child" }
  await r.clock.advance(30_000) // a current child answer still ends chat
  assert.equal(binds, 3)
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 1)
})

// The real thread against a fake app-server: the resume confirms Plan Mode and the newest-turn lookup then fails. The mode
// is kept over the Stop hook's default hint, and the running state is unknown, so the session is reported stopped.
test("a Stop hook with a default hint, then a resume that confirms Plan Mode and a failed newest-turn lookup, reports Plan Mode and unknown", async () => {
  const waitFor = async (check, what) => {
    for (let waited = 0; !check() && waited < 3000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(check(), `${what} never happened`)
  }
  const dir = mkdtempSync(join(tmpdir(), "acr-"))
  const record = {
    id: "session-1", parentThreadId: null, agentRole: null, ephemeral: false, source: "cli", modelProvider: "openai", status: { type: "idle" },
  }
  const answers = {
    "thread/loaded/list": () => ({ result: { data: ["session-1"], nextCursor: null } }),
    "thread/read": () => ({ result: { thread: record } }),
    "thread/resume": () => ({ result: { thread: record, collaborationMode: { mode: "plan", settings: {} } } }),
    "thread/turns/list": () => ({ error: { code: -32000, message: "no" } }),
  }
  const server = await fakeAppServer(join(dir, "s.sock"), message => answers[message.method]?.() ?? { error: { code: -32601, message: "no" } })
  try {
    const thread = Object.assign(createThread({ path: join(dir, "s.sock"), threadId: "session-1" }), { opened: [] })
    const r = await rig({ thread })
    await waitFor(() => r.worker.bootIds.length === 1, "the join")
    await r.begin()
    await r.op(turn())
    await r.op({ op: "stop", permission_mode: "default" })
    assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "idle", stopped: false, plan_mode: false })
    await r.clock.advance(30_000) // the tick reads the thread
    await waitFor(() => server.methods().includes("thread/turns/list"), "the newest-turn lookup")
    await waitFor(() => r.worker.ops("heartbeat").at(-1).state.plan_mode === true, "the tick's report")
    assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: true })
    assert.notEqual(r.receiver.state(), "offline")
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A current read that finds another provider unbinds the thread, as a bind would: the state follows the hooks (not unknown
// and stopped), the worker stays, and the next tick binds again.
test("a heartbeat read that finds another provider unbinds the thread, follows the hooks and binds again at the next tick", async () => {
  const stale = { reason: "stale_binding", observed: { status: "unknown", stopped: false, plan: null } }
  const thread = threadDouble({ observation: stale })
  const r = await rig({ thread })
  await r.begin()
  await r.op({ op: "stop", permission_mode: "default" })
  thread.calls.length = 0
  await r.clock.advance(30_000) // the read finds provider B
  assert.deepEqual(thread.calls, ["observe"])
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "idle", stopped: false, plan_mode: false })
  assert.notEqual(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 0, "the worker stays")
  await r.clock.advance(30_000) // unbound: the next tick binds again
  assert.equal(thread.calls[1], "bind")
})

test("a provider answer from a read that a hook event overtook is dropped: the thread stays bound", async () => {
  let release
  let reads = 0
  const stale = { reason: "stale_binding", observed: { status: "unknown", stopped: false, plan: null } }
  const thread = threadDouble({ observation: () => (++reads === 1 ? new Promise(resolve => { release = () => resolve(stale) }) : IDLE) })
  const r = await rig({ thread })
  await r.begin()
  await r.op({ op: "stop", permission_mode: "default" })
  thread.calls.length = 0
  await r.clock.advance(30_000) // the tick's read is out
  await r.op({ op: "stop", permission_mode: "default" }) // a hook event overtakes it
  release()
  await settle()
  await r.clock.advance(30_000)
  assert.deepEqual(thread.calls, ["observe", "observe"], "still bound: the next tick reads, it does not bind")
})

test("a changed provider leaves the thread unbound: the worker joins and hook delivery continues", async () => {
  const thread = threadDouble({ bind: { status: "stale_binding" } })
  const r = await rig({ handlers: deliverable(), thread })
  assert.equal(r.worker.bootIds.length, 1, "the thread is a main thread, so it joins")
  await r.begin()
  await r.clock.advance(30_000)
  assert.deepEqual(thread.calls.filter(call => call === "observe"), [], "an unbound thread is never read")
  assert.notEqual(r.receiver.state(), "offline")
  const busy = await r.op(turn())
  assert.match(busy.sent[0].context, /"id":/, "busy delivery through the hook is unchanged")
})

test("a bind that does not answer in time verifies nothing: no join yet, and the next heartbeat period asks again", async () => {
  let asked = 0
  const thread = threadDouble({ bind: () => (++asked === 1 ? new Promise(() => {}) : { status: "bound" }) })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 0)
  await r.clock.advance(3000)
  assert.equal(r.worker.bootIds.length, 0, "the timeout is not a positive check")
  await r.clock.advance(29_000)
  assert.equal(asked, 1)
  await r.clock.advance(1000)
  assert.equal(asked, 2)
  assert.equal(r.worker.bootIds.length, 1, "the second look answered bound")
})

// A bind that is still running when the receiver stops waiting is dropped. What it learns later counts for nothing:
// only the answer of a call that finishes inside the time allowed verifies the thread.
test("a bind that answers after its deadline verifies nothing, and a later `unloaded` does not join on its account", async () => {
  let late
  let asked = 0
  const thread = threadDouble({ bind: () => (++asked === 1
    ? new Promise(resolve => { late = () => { thread.provider = "openai"; resolve({ status: "bound" }) } }) // the real read records the provider as it goes
    : { status: "unloaded" }) })
  const r = await rig({ thread })
  await r.clock.advance(3000)
  assert.equal(r.worker.bootIds.length, 0, "the first bind missed its deadline")
  late() // it finishes after the receiver stopped waiting
  await settle()
  assert.equal(r.worker.bootIds.length, 0, "the late answer is dropped")
  await r.clock.advance(30_000)
  assert.equal(asked, 2)
  assert.equal(r.worker.bootIds.length, 0, "the next bind found the thread unloaded, so there is still nothing verified")
})

// Every worker start binds the thread again. What the first bind found does not carry over to a rejoin: the thread can be
// unloaded, or turn out to be a child, while the receiver waits out its backoff.
async function rejoining(second) {
  let answer = { status: "bound" }
  let refuse = true
  const thread = threadDouble({ bind: () => answer })
  const r = await rig({ thread, handlers: { pending: () => (refuse ? { refused: "STALE_INSTANCE" } : { messages: [] }) } })
  await r.begin()
  assert.equal(r.worker.bootIds.length, 1, "the first join is verified by the first bind")
  await r.op(turn()) // the lease is gone: the worker stops and the bounded rejoin starts
  assert.equal(r.worker.state.stops, 1)
  answer = second
  refuse = false
  await r.clock.advance(3750) // the rejoin fires
  return { r, thread, answer: next => { answer = next }, binds: () => thread.calls.filter(call => call === "bind").length }
}

test("a rejoin binds again: a thread that is no longer loaded starts no worker, and a later positive bind does", async () => {
  const { r, answer, binds } = await rejoining({ status: "unloaded" })
  assert.equal(binds(), 2, "the rejoin looked at the thread again")
  assert.equal(r.worker.bootIds.length, 1, "and no worker started on the strength of the first bind")
  await r.clock.advance(29_000)
  assert.equal(binds(), 2, "the next look is a heartbeat period away")
  assert.equal(r.worker.bootIds.length, 1)
  answer({ status: "bound" })
  await r.clock.advance(1000)
  assert.equal(binds(), 3)
  assert.equal(r.worker.bootIds.length, 2, "a bind that finds the thread joins it")
})

test("a rejoin binds again: a thread that has become a child ends chat the way the first join would, and starts no worker", async () => {
  const { r, binds } = await rejoining({ status: "child" })
  assert.equal(binds(), 2)
  assert.equal(r.worker.bootIds.length, 1, "no new worker")
  assert.equal(r.receiver.state(), "offline")
  assert.deepEqual((await r.op(turn())).sent, [{
    disabled: true, message: "Agent Chat stopped (CHAT_CHILD_THREAD); the Codex session is unchanged.",
  }])
  await r.clock.advance(120_000)
  assert.equal(binds(), 2, "chat stays off: nothing looks again")
  assert.equal(r.worker.bootIds.length, 1)
})

// A retry inside a rejoin episode belongs to that episode: it spends no budget, but the two-hour window still ends it. A
// first join has no episode, so its retries have no end.
test("a rejoin whose thread stays unloaded ends with the rejoin episode window, which a first join does not have", async () => {
  const { r, binds } = await rejoining({ status: "unloaded" })
  await r.clock.advance(7_000_000) // inside the two hours counted from the first refusal: still looking
  assert.equal(r.receiver.state() === "offline", false)
  assert.ok(binds() > 200)
  await r.clock.advance(200_000)
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.bootIds.length, 1, "no worker ever started on the strength of the first bind")
  const hook = await r.op(turn())
  assert.match(hook.sent[0].message, /REJOIN_WINDOW/)
})

// A bind takes time, and the two-hour episode of a rejoin can end while it runs.
test("a bind that carries a rejoin past the two-hour episode starts no worker", async () => {
  let jump = 0
  let asked = 0
  // The rejoin's own bind is the second one: it takes the policy's clock to the end of the episode.
  const thread = threadDouble({ bind: () => { if (++asked === 2) jump = 7_200_000; return { status: "bound" } } })
  let refuse = true
  const r = await rig({ thread, skew: () => jump, handlers: { pending: () => (refuse ? { refused: "STALE_INSTANCE" } : { messages: [] }) } })
  await r.begin()
  await r.op(turn()) // the lease is gone: the episode starts, and the rejoin is scheduled
  refuse = false
  await r.clock.advance(3750) // the rejoin fires inside the episode; its bind ends after the episode
  assert.equal(asked, 2)
  assert.equal(r.worker.bootIds.length, 1, "no worker starts after the episode ended")
  assert.equal(r.receiver.state(), "offline")
  assert.match((await r.op(turn())).sent[0].message, /REJOIN_WINDOW/)
})

// The old worker's heartbeat tick can be waiting on an app-server read when the worker is retired. When the read
// returns during the replacement's join, the worker must not be asked anything: it answers busy, and chat would end.
test("a heartbeat tick that was reading when its worker was retired sends nothing to the replacement and disables nothing", async () => {
  let release
  let reads = 0
  const thread = threadDouble({ observation: () => (++reads === 1 ? new Promise(resolve => { release = () => resolve(IDLE) }) : IDLE) })
  let refuse = false
  let open
  const second = { promise: new Promise(resolve => { open = resolve }) }
  const r = await rig({ thread, gate: boot => (boot === 2 ? second : undefined), handlers: { heartbeat: () => (refuse ? { refused: "STALE_INSTANCE" } : {}) } })
  await r.begin()
  await r.clock.advance(30_000) // the tick starts and waits on its read
  assert.equal(reads, 1)
  refuse = true
  await r.op(turn()) // a prompt's heartbeat finds the lease gone: the worker is retired
  assert.equal(r.worker.state.stops, 1)
  refuse = false
  await r.clock.advance(3750) // the rejoin starts, and its join stays open
  assert.equal(r.worker.bootIds.length, 2)
  release() // the old tick's read comes back during that join
  await settle()
  assert.equal(r.worker.state.busy, 0, "nothing was asked of a worker whose join is in flight")
  assert.notEqual(r.receiver.state(), "offline", "chat is not disabled")
  const heartbeats = r.worker.ops("heartbeat").length
  open()
  await settle()
  assert.notEqual(r.receiver.state(), "offline", "and the rejoin completes")
  assert.equal(r.worker.ops("heartbeat").length, heartbeats + 1, "with the replacement's own first heartbeat, and no other")
  assert.equal(r.worker.state.busy, 0)
  assert.match((await r.op(turn())).sent[0].context, /Agent Chat is available/)
})

// The real thread against a fake app-server: the thread is still in the loaded list when the rejoin asks, but its read
// says it has unloaded since. Only a worker started on a positive read may join.
test("a rejoin whose read finds a listed thread unloaded starts no worker, and a later read that finds it loaded does", async () => {
  const waitFor = async (check, what) => {
    for (let waited = 0; !check() && waited < 3000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(check(), `${what} never happened`)
  }
  const dir = mkdtempSync(join(tmpdir(), "acr-"))
  let status = "idle"
  const answers = {
    "thread/loaded/list": () => ({ result: { data: ["session-1"], nextCursor: null } }),
    "thread/read": () => ({ result: { thread: {
      id: "session-1", parentThreadId: null, agentRole: null, ephemeral: false, source: "cli", modelProvider: "openai", status: { type: status },
    } } }),
  }
  const server = await fakeAppServer(join(dir, "s.sock"), message => answers[message.method]?.() ?? { error: { code: -32601, message: "no" } })
  const reads = () => server.methods().filter(method => method === "thread/read").length
  try {
    const thread = Object.assign(createThread({ path: join(dir, "s.sock"), threadId: "session-1" }), { opened: [] })
    let refuse = false
    const r = await rig({ thread, handlers: { pending: () => (refuse ? { refused: "STALE_INSTANCE" } : { messages: [] }) } })
    await waitFor(() => r.worker.bootIds.length === 1, "the first join")
    await r.begin()
    refuse = true
    await r.op(turn()) // the lease is gone: the rejoin is scheduled
    refuse = false
    status = "notLoaded"
    await r.clock.advance(3750) // the rejoin binds: listed, but read as notLoaded
    await waitFor(() => reads() === 2, "the rejoin's read")
    await settle()
    assert.equal(r.worker.bootIds.length, 1, "no worker starts on a read that says notLoaded")
    status = "idle"
    await r.clock.advance(30_000) // the next look finds it loaded
    await waitFor(() => r.worker.bootIds.length === 2, "the join after a positive read")
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Positive evidence only. The real thread against a fake app-server: a record joins only when its origin is a non-empty string or an
// object and its status is one that a loaded thread documents. A record that shows less is no basis for a join, and nothing is
// asked of the app-server beyond the handshake, the list and the read.
const documented = (over = {}) => ({
  id: "session-1", parentThreadId: null, agentRole: null, ephemeral: false, source: "cli", modelProvider: "openai", status: { type: "idle" }, ...over,
})
const withoutStatus = () => { const record = documented(); delete record.status; return record }
for (const [label, record, joins] of [
  ["the documented shapes", documented(), true],
  ["an active thread", documented({ status: { type: "active", activeFlags: [] } }), true],
  ["a thread in systemError", documented({ status: { type: "systemError" } }), true],
  ["the record codex-cli 0.171.0 returns for a TUI attached with --remote", documented({
    sessionId: "session-1", forkedFromId: null, attachedToThreadId: null, source: "vscode", threadSource: "user", originator: "codex-tui",
    agentNickname: null, turns: [],
  }), true],
  ["an object origin", documented({ source: { custom: "x" } }), true],
  ["an empty origin", documented({ source: "" }), false],
  ["an array origin", documented({ source: ["cli"] }), false],
  ["an empty array origin", documented({ source: [] }), false],
  ["a numeric origin", documented({ source: 7 }), false],
  ["no status", withoutStatus(), false],
  ["a status without a type", documented({ status: {} }), false],
  ["a status type that is not known", documented({ status: { type: "future" } }), false],
  ["an empty status type", documented({ status: { type: "" } }), false],
  ["the status type unknown", documented({ status: { type: "unknown" } }), false],
  ["a status type that is not a string", documented({ status: { type: ["idle"] } }), false],
  ["a status that is only a string", documented({ status: "idle" }), false],
]) {
  test(`a thread read with ${label} ${joins ? "starts the worker" : "starts no worker and asks nothing more"}`, async () => {
    const waitFor = async (check, what) => {
      for (let waited = 0; !check() && waited < 3000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
      assert.ok(check(), `${what} never happened`)
    }
    const dir = mkdtempSync(join(tmpdir(), "acr-"))
    const answers = {
      "thread/loaded/list": () => ({ result: { data: ["session-1"], nextCursor: null } }),
      "thread/read": () => ({ result: { thread: record } }),
    }
    const server = await fakeAppServer(join(dir, "s.sock"), message => answers[message.method]?.() ?? { error: { code: -32601, message: "no" } })
    try {
      const thread = Object.assign(createThread({ path: join(dir, "s.sock"), threadId: "session-1" }), { opened: [] })
      const r = await rig({ thread })
      if (joins) await waitFor(() => r.worker.bootIds.length === 1, "the join")
      else {
        await waitFor(() => server.methods().includes("thread/read"), "the read")
        await waitFor(() => server.state.open === 0, "the bind to end")
        await settle()
        assert.equal(r.worker.bootIds.length, 0, "no worker starts")
        assert.deepEqual(server.methods().filter(method => !["initialize", "thread/loaded/list", "thread/read"].includes(method)), [], "nothing else is asked")
      }
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("a bind whose read is not in after 3 seconds is aborted at once, so what it learns later is recorded nowhere", async () => {
  const signals = []
  const thread = threadDouble({ bind: options => { signals.push(options?.signal); return new Promise(() => {}) } })
  const r = await rig({ thread })
  await r.clock.advance(2999)
  assert.equal(signals[0]?.aborted, false, "still within the read deadline")
  await r.clock.advance(1)
  assert.equal(signals[0]?.aborted, true, "the deadline aborts the call's own token")
  assert.equal(r.worker.bootIds.length, 0)
})

// ---- state mapping ---------------------------------------------------------------------------------------------

test("an interrupt reports stopped, survives a stop and a tool event, and only a prompt clears it", async () => {
  const r = await rig({ handlers: { pending: () => ({ messages: ["m1"] }) } })
  await r.begin()
  await r.op(turn())
  r.worker.log.length = 0
  await r.op({ op: "interrupt" })
  assert.deepEqual(r.worker.ops("heartbeat")[0].state, { native_state: "unknown", stopped: true, plan_mode: false })
  assert.equal(r.receiver.state(), "stopped")
  await r.op({ op: "stop", permission_mode: "default" })
  assert.equal(r.receiver.state(), "stopped", "a later Stop does not clear it")
  const late = await r.op(turn({ event: "tool" }))
  assert.equal(r.receiver.state(), "stopped", "a tool result that outran the interrupt does not clear it")
  assert.deepEqual(late.sent, [{ context: null }])
  assert.deepEqual(r.worker.ops("claim"), [], "nothing is claimed while stopped")
  const prompt = await r.op(turn({ event: "prompt" }))
  assert.equal(r.receiver.state(), "busy")
  assert.match(prompt.sent[0].context, /"id":"m1"/, "delivery resumes with the next turn")
})

test("an interrupt asks the worker for no delivery and answers at once", async () => {
  const r = await rig()
  await r.begin()
  const hook = await r.op({ op: "interrupt" })
  assert.deepEqual(hook.sent, [{ ok: true }])
  assert.deepEqual(r.worker.ops("pending"), [])
})

test("an app-server read that finds the newest turn interrupted reports stopped until the next prompt", async () => {
  const thread = threadDouble({ observation: { reason: "stopped", observed: { status: "idle", stopped: true, plan: null } } })
  const r = await rig({ thread })
  await idleSession(r)
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "stopped")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: false })
  await r.op(turn())
  assert.equal(r.receiver.state(), "busy", "a hook event discards the earlier read")
})

test("an interrupted session is not read by the heartbeat until a prompt clears the stop", async () => {
  const thread = threadDouble()
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn())
  await r.op({ op: "interrupt" })
  await r.op({ op: "stop", permission_mode: "default" }) // the Stop that follows an interrupt: not running, still stopped
  await r.clock.advance(30_000)
  assert.deepEqual(thread.calls.filter(call => call === "observe"), [], "stopped, so there is nothing to read")
  assert.equal(r.receiver.state(), "stopped")
})

test("a session with no hook event yet is idle only when the app-server says so", async () => {
  const thread = threadDouble()
  const r = await rig({ thread })
  assert.equal(r.receiver.state(), "unknown")
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), null, "idle, not in Plan Mode, from the read")
  const busy = threadDouble({ observation: { reason: "busy", observed: { status: "busy", stopped: false, plan: null } } })
  const other = await rig({ thread: busy })
  await other.clock.advance(30_000)
  assert.equal(other.receiver.state(), "busy")
})

test("a read that began before a hook event is not kept", async () => {
  let release
  const thread = threadDouble({ observation: () => new Promise(resolve => { release = () => resolve({ reason: null, observed: { status: "idle", stopped: false, plan: false } }) }) })
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn())
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(30_000)
  await r.op(turn({ permission_mode: "plan" }))
  release()
  await settle()
  assert.equal(r.receiver.state(), "plan", "the stale read did not override the newer hint")
})

// A turn that dies (the process is killed, the session is resumed elsewhere) sends no Stop, so the hooks leave the receiver busy
// for good. A session start, whatever its source, resets that as a fresh session would have, and drops the read.
test("a session start after a turn that died resets the running state: the heartbeat reads the thread again", async () => {
  const thread = threadDouble()
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn())
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "busy")
  assert.equal(thread.calls.filter(call => call === "observe").length, 0, "a busy session is not read")
  await r.op({ op: "start", wait_ms: 5000 })
  assert.equal(r.receiver.state(), "unknown")
  await r.clock.advance(30_000)
  assert.equal(thread.calls.filter(call => call === "observe").length, 1, "the heartbeat read the thread")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "idle", stopped: false, plan_mode: false })
})

// The start resets the state, and the heartbeat says so at once: a session left busy by a turn that died is not shown busy
// until the next period. The announcement is not held back by that report.
test("a session start after a turn that left the session busy sends a heartbeat with the reset state before the next period", async () => {
  const r = await rig()
  await r.begin()
  await r.op(turn())
  assert.equal(r.worker.ops("heartbeat").at(-1).state.native_state, "busy")
  r.worker.log.length = 0
  const hook = await r.op({ op: "start", wait_ms: 5000 })
  await settle()
  assert.deepEqual(r.worker.ops("heartbeat").map(entry => entry.state), [{ native_state: "unknown", stopped: true, plan_mode: false }])
  assert.equal(typeof hook.sent[0].context, "string", "the binding was announced")
})

test("a session start's announcement does not wait for its heartbeat", async () => {
  let hold = false
  let answer
  const r = await rig({ handlers: { heartbeat: () => (hold ? new Promise(resolve => { answer = resolve }) : {}) } })
  await r.begin()
  await r.op(turn())
  hold = true
  r.worker.log.length = 0
  const hook = hookDouble()
  const started = r.receiver.handle({ op: "start", wait_ms: 5000 }, hook)
  await settle()
  assert.equal(r.worker.ops("heartbeat").length, 1, "the reset heartbeat is out, and has no answer yet")
  assert.equal(typeof hook.sent[0]?.context, "string", "the binding was announced while the heartbeat was still out")
  answer({})
  await started
})

test("a session start that resumes in Plan Mode keeps the hint until a read or hook says otherwise", async () => {
  const r = await rig({ thread: threadDouble() })
  await r.begin()
  await r.op({ op: "start", wait_ms: 5000, permission_mode: "plan" })
  assert.equal(r.receiver.state(), "plan")
  await r.op({ op: "start", wait_ms: 5000, permission_mode: "default" })
  assert.notEqual(r.receiver.state(), "plan")
})

test("a session start does not clear an interrupt that was latched: the state stays stopped until a prompt", async () => {
  const thread = threadDouble()
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn())
  await r.op({ op: "interrupt" })
  assert.equal(r.receiver.state(), "stopped")
  await r.op({ op: "start", wait_ms: 5000 })
  assert.equal(r.receiver.state(), "stopped")
  await r.clock.advance(30_000)
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: false })
  await r.op(turn())
  assert.equal(r.receiver.state(), "busy", "a prompt clears it")
})

test("a session start drops the Plan Mode hint that a dead turn left", async () => {
  const r = await rig()
  await r.begin()
  await r.op(turn({ permission_mode: "plan" }))
  assert.equal(r.receiver.state(), "plan")
  await r.op({ op: "start", wait_ms: 5000 })
  assert.equal(r.receiver.state(), "unknown")
})

// What a read showed is dropped by the start too, not only what the hooks set: until the next read the state is unknown.
for (const [label, observation] of [
  ["Plan Mode", { reason: "plan", observed: { status: "idle", stopped: false, plan: true } }],
  ["an interrupted turn", { reason: "stopped", observed: { status: "idle", stopped: true, plan: null } }],
]) {
  test(`a session start drops the read that showed ${label}`, async () => {
    const thread = threadDouble({ observation })
    const r = await rig({ thread })
    await idleSession(r)
    await r.clock.advance(30_000)
    assert.notEqual(r.receiver.state(), null)
    assert.notEqual(r.receiver.state(), "unknown", "the read set the state")
    await r.op({ op: "start", wait_ms: 5000 })
    assert.equal(r.receiver.state(), "unknown", "the read did not survive the start")
  })
}

test("a read that began before a session start is not kept", async () => {
  let release
  const thread = threadDouble({ observation: () => new Promise(resolve => { release = () => resolve(IDLE) }) })
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn())
  await r.op({ op: "stop", permission_mode: "default" })
  await r.clock.advance(30_000)
  await r.op({ op: "start", wait_ms: 5000 })
  release()
  await settle()
  assert.equal(r.receiver.state(), "unknown", "the stale read did not set the state the start reset")
})

test("an app-server that cannot be read leaves the hooks' state in place", async () => {
  const thread = threadDouble({ observation: { reason: "offline", observed: { status: "offline", stopped: false, plan: null } } })
  const r = await rig({ thread })
  await idleSession(r)
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), null)
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "idle", stopped: false, plan_mode: false })
})

test("the hook's plan hint yields to the app-server read, which is the authority", async () => {
  const cases = [
    { mode: "plan", plan: false, expected: { native_state: "idle", stopped: false, plan_mode: false } },
    { mode: "default", plan: true, expected: { native_state: "unknown", stopped: false, plan_mode: true } },
    { mode: "plan", plan: null, expected: { native_state: "unknown", stopped: true, plan_mode: true } },
    { mode: "default", plan: null, expected: { native_state: "unknown", stopped: true, plan_mode: false } },
  ]
  for (const { mode, plan, expected } of cases) {
    const thread = threadDouble({ observation: { reason: plan === null ? "unknown" : plan ? "plan" : null, observed: { status: "idle", stopped: false, plan } } })
    const r = await rig({ thread })
    await r.begin()
    await r.op(turn({ permission_mode: mode }))
    await r.op({ op: "stop", permission_mode: mode })
    r.worker.log.length = 0
    await r.clock.advance(30_000)
    assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, expected, `${mode} ${plan}`)
  }
})

// The read's two answers stand apart: a mode it confirmed decides Plan Mode even when its running state is unknown (the newest
// turn failed, or there is none), and the state stays unknown, not idle.
test("a read that confirmed the mode but not the running state keeps its plan answer, over the hint, and stays unknown", async () => {
  for (const [plan, hint, expected] of [
    [false, "plan", { native_state: "unknown", stopped: true, plan_mode: false }],
    [true, "default", { native_state: "unknown", stopped: true, plan_mode: true }],
  ]) {
    const thread = threadDouble({ observation: { reason: "unknown", observed: { status: "unknown", stopped: false, plan } } })
    const r = await rig({ thread })
    await r.begin()
    await r.op(turn({ permission_mode: hint }))
    await r.op({ op: "stop", permission_mode: hint })
    r.worker.log.length = 0
    await r.clock.advance(30_000)
    assert.equal(r.receiver.state(), plan ? "plan" : "unknown", `plan ${plan}, hint ${hint}`)
    assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, expected, `plan ${plan}, hint ${hint}`)
  }
})

// A read that answered, and said it does not know, is newer than the hooks' idle: the state stays unknown until a hook event.
// The mode falls back to the hint when the read could not tell it; the running state does not.
for (const [label, observation] of [
  ["a status the plugin does not know (systemError)", { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } }],
  ["no newest turn, in default mode", { reason: "unknown", observed: { status: "unknown", stopped: false, plan: false } }],
  ["no newest turn, in a mode it could not tell", { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } }],
]) {
  test(`a Stop hook and then a read that finds ${label} reports unknown, not idle`, async () => {
    const thread = threadDouble({ observation })
    const r = await rig({ thread })
    await idleSession(r)
    assert.equal(r.worker.ops("heartbeat").length, 0)
    assert.equal(r.receiver.state(), null, "control: the Stop hook alone says idle")
    await r.clock.advance(30_000)
    assert.equal(r.receiver.state(), "unknown")
    assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: false })
  })
}

test("an unknown read with no mode leaves Plan Mode to the hint, and the running state unknown", async () => {
  const thread = threadDouble({ observation: { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } } })
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn({ permission_mode: "plan" }))
  await r.op({ op: "stop", permission_mode: "plan" })
  r.worker.log.length = 0
  await r.clock.advance(30_000)
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: true })
  await r.op({ op: "stop", permission_mode: "default" }) // a hook event drops the read; the next one is read again
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "unknown", "the hint is default now, and the read still does not know the running state")
})

// `stopped` is the running state's, whatever the Plan Mode: a Plan Mode hint does not turn an unknown read into a running one.
test("a Plan Mode hint and then a systemError read report unknown and stopped, in Plan Mode", async () => {
  const thread = threadDouble({ observation: { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } } })
  const r = await rig({ thread })
  await r.begin()
  await r.op(turn({ permission_mode: "plan" }))
  await r.op({ op: "stop", permission_mode: "plan" })
  await r.clock.advance(30_000)
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: true })
  assert.equal(r.receiver.state(), "plan", "delivery is still decided by Plan Mode first")
})

// The heartbeat's flags are facts of their own. Plan Mode does not hide an interruption that a read found: both are reported.
// What a hook consumer may be given does not change: Plan Mode still decides that.
test("a read that shows Plan Mode and an interrupted newest turn reports both, with no Interrupt hook", async () => {
  const thread = threadDouble({ observation: { reason: "stopped", observed: { status: "idle", stopped: true, plan: true } } })
  const r = await rig({ thread })
  await idleSession(r)
  await r.clock.advance(30_000)
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: true })
  assert.equal(r.receiver.state(), "plan", "delivery is decided as before")
})

// A read decides Plan Mode only until a hook event discards it. After that the hook's permission_mode hint decides, as in the
// Claude and Pi packages, and it can be stale.
test("once a hook event has discarded the last read, Plan Mode and busy delivery follow the hook's permission_mode hint", async () => {
  for (const [read, hint] of [[true, "default"], [false, "plan"]]) {
    const thread = threadDouble({ observation: { reason: read ? "plan" : null, observed: { status: "idle", stopped: false, plan: read } } })
    const r = await rig({ thread, handlers: { pending: () => ({ messages: ["m1"] }) } })
    await r.begin()
    await r.clock.advance(30_000) // the tick reads the thread
    assert.equal(r.receiver.state(), read ? "plan" : null, `the read decides while nothing newer arrived (${hint})`)
    r.worker.log.length = 0
    const hook = await r.op(turn({ permission_mode: hint }))
    assert.equal(r.receiver.state(), hint === "plan" ? "plan" : "busy", `the hint decides once the hook event discarded the read (${hint})`)
    assert.equal(r.worker.ops("heartbeat").at(-1).state.plan_mode, hint === "plan", `heartbeat (${hint})`)
    assert.equal(r.worker.ops("claim").length, hint === "plan" ? 0 : 1, `claims (${hint})`)
    if (hint === "plan") assert.deepEqual(hook.sent, [{ context: null }])
    else assert.match(hook.sent[0].context, /"id":"m1"/)
  }
})

// Before the first user message codex-cli 0.171.0 refuses the resume and the turns list, so the read is unknown: Plan Mode
// is not known, and the thread is not idle. That is no child and no failure: chat stays on, and a later read decides.
test("a read before the first user message is unknown: the heartbeat says so, and chat stays on", async () => {
  let observation = { reason: "unknown", observed: { status: "idle", stopped: false, plan: null } }
  const thread = threadDouble({ observation: () => observation })
  const r = await rig({ thread })
  await r.op({ op: "start", wait_ms: 5000, permission_mode: "default" })
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "unknown")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: false })
  assert.equal(r.worker.state.stops, 0, "the worker is not stopped")
  observation = IDLE
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), null, "the next read decides")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "idle", stopped: false, plan_mode: false })
})

// ---- a read and a bind that are out when something newer arrives -----------------------------------------------

const reading = (reason, observed) => ({ reason, observed: { status: "idle", stopped: false, plan: false, ...observed } })

// A rejoin's bind that leaves the thread unbound (the provider changed) drops the answer held in `observed`: the state and the
// heartbeat follow the hooks at once, with no hook event in between to discard it.
test("a bind that leaves the thread unbound drops the read's answer: state and heartbeat follow the hooks at once, with no hook event", async () => {
  let answer = { status: "bound" }
  let refuse = false
  const thread = threadDouble({ bind: () => answer, observation: reading("stopped", { stopped: true }) })
  const r = await rig({ thread, handlers: { heartbeat: () => (refuse ? { refused: "STALE_INSTANCE" } : {}) } })
  await idleSession(r)
  await r.clock.advance(30_000) // the tick reads: interrupted
  assert.equal(r.receiver.state(), "stopped")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: false })
  answer = { status: "stale_binding" }
  refuse = true
  await r.clock.advance(30_000) // the next tick reads, then finds the lease gone: the worker is retired
  assert.equal(r.worker.state.stops, 1)
  refuse = false
  await r.clock.advance(3750) // the rejoin binds: the provider changed, so the thread joins unbound
  assert.equal(r.worker.bootIds.length, 2)
  assert.equal(r.receiver.state(), null, "the hooks said idle: no hook event came, and the read is gone")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "idle", stopped: false, plan_mode: false })
})

// A read that refuses moves the epoch, so the older read that lands after it does not replace it.
test("an idle read that started before a refusing read and lands after it does not replace it", async () => {
  let release
  let reads = 0
  const thread = threadDouble({ observation: () => (++reads === 1 ? new Promise(resolve => { release = () => resolve(IDLE) }) : reading("stopped", { stopped: true })) })
  const r = await rig({ thread })
  await idleSession(r)
  await r.clock.advance(30_000) // the first read starts and stays out
  await r.clock.advance(30_000) // the second starts and answers: interrupted
  assert.equal(r.receiver.state(), "stopped")
  release() // the first one answers idle, and no hook event has made it stale
  await settle()
  assert.equal(r.receiver.state(), "stopped", "the older read is not the newest word on the thread")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: true, plan_mode: false })
})

test("a default-mode read that started before a Plan Mode read and lands after it does not replace it", async () => {
  let release
  let reads = 0
  const thread = threadDouble({ observation: () => (++reads === 1 ? new Promise(resolve => { release = () => resolve(IDLE) }) : reading("plan", { plan: true })) })
  const r = await rig({ thread })
  await idleSession(r)
  await r.clock.advance(30_000) // the first read starts and stays out
  await r.clock.advance(30_000) // the second starts and answers: Plan Mode
  assert.equal(r.receiver.state(), "plan")
  release() // the first one answers default mode, and no hook event has made it stale
  await settle()
  assert.equal(r.receiver.state(), "plan", "the older read is not the newest word on the thread")
  assert.deepEqual(r.worker.ops("heartbeat").at(-1).state, { native_state: "unknown", stopped: false, plan_mode: true })
})

// A read that was overtaken is dropped and moves nothing, so its refusal cannot make a newer read stale: only a kept refusal
// moves the epoch.
test("a read that a session start overtook and that refuses does not make the newer read stale", async () => {
  const releases = []
  const thread = threadDouble({ observation: () => new Promise(resolve => { releases.push(resolve) }) })
  const r = await rig({ thread })
  await idleSession(r)
  await r.clock.advance(30_000) // the first read is out
  await r.op({ op: "start", wait_ms: 5000 }) // a session start overtakes it
  await r.clock.advance(30_000) // the second read is out, and began after the start
  assert.equal(releases.length, 2)
  releases[0](reading("stopped", { stopped: true })) // the overtaken read refuses: dropped, and it moves nothing
  await settle()
  releases[1](IDLE)
  await settle()
  assert.equal(r.receiver.state(), null, "the newer read is kept")
})

// Reads can overlap: one that is slow is still out when the next tick reads. Only the newest read that started is kept, so the
// older one, landing late with an answer of its own, neither replaces the newer one nor makes it stale.
test("an older read that lands after a newer one started is dropped, and the newer one's Plan Mode or child answer applies", async () => {
  const UNKNOWN = { reason: "unknown", observed: { status: "unknown", stopped: false, plan: null } }
  const CHILD = { reason: "child", observed: { status: "unknown", stopped: false, plan: null } }
  for (const [newer, expected] of [[reading("plan", { plan: true }), "plan"], [CHILD, "offline"]]) {
    const releases = []
    const thread = threadDouble({ observation: () => new Promise(resolve => { releases.push(resolve) }) })
    const r = await rig({ thread })
    await idleSession(r)
    await r.clock.advance(30_000) // the older read is out
    await r.clock.advance(30_000) // the newer read starts
    assert.equal(releases.length, 2)
    releases[0](UNKNOWN) // the older one lands first, after the newer one started
    await settle()
    assert.equal(r.receiver.state(), null, "the older read is dropped: it did not set unknown")
    releases[1](newer)
    await settle()
    assert.equal(r.receiver.state(), expected, `the newer read applies (${expected})`)
    if (expected === "offline") assert.equal(r.worker.state.stops, 1, "the child answer ended chat")
  }
})

// ---- a retired worker's tick commits nothing -----------------------------------------------------------------------

const STOPPED = reading("stopped", { stopped: true })

// The old worker's tick is reading the thread when the worker is retired by the next tick's refused heartbeat (no hook
// event, so the read is still current when it comes back). The replacement's join is held open.
async function retiredTick(first = STOPPED) {
  let release
  let reads = 0
  let refuse = false
  let open
  const second = { promise: new Promise(resolve => { open = resolve }) }
  const thread = threadDouble({ observation: () => (++reads === 1 ? new Promise(resolve => { release = () => resolve(first) }) : IDLE) })
  const r = await rig({ thread, gate: boot => (boot === 2 ? second : undefined), handlers: { heartbeat: () => (refuse ? { refused: "STALE_INSTANCE" } : {}) } })
  await idleSession(r)
  await r.clock.advance(30_000) // the tick starts and waits on its read
  assert.equal(reads, 1)
  refuse = true
  await r.clock.advance(30_000) // the next tick reads, finds the lease gone on its heartbeat: the worker is retired
  assert.equal(r.worker.state.stops, 1)
  refuse = false
  await r.clock.advance(3750) // the rejoin starts, and its join stays open
  assert.equal(r.worker.bootIds.length, 2)
  return { r, release: () => release(), open: () => open(), reads: () => reads }
}
const lastBeat = r => r.worker.ops("heartbeat").at(-1).state
const CLEAR_BEAT = { native_state: "idle", stopped: false, plan_mode: false }

test("a retired tick's read that comes back before the replacement has read anything leaves the state it found", async () => {
  const { r, release, open } = await retiredTick()
  release()
  await settle()
  assert.equal(r.receiver.state(), null, "the old read's stopped is not the replacement's state")
  open()
  await settle()
  assert.deepEqual(lastBeat(r), CLEAR_BEAT, "the replacement's first heartbeat does not carry it")
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), null)
  assert.deepEqual(lastBeat(r), CLEAR_BEAT)
})

test("a retired tick's read that shows Plan Mode comes back late and leaves the replacement nothing of it", async () => {
  const { r, release, open } = await retiredTick(reading("plan", { plan: true }))
  release()
  await settle()
  assert.equal(r.receiver.state(), null, "the old read's Plan Mode is not the replacement's")
  open()
  await settle()
  assert.deepEqual(lastBeat(r), CLEAR_BEAT, "the replacement's first heartbeat does not carry it")
})

test("a retired tick's read that comes back after the replacement has read leaves the replacement's reading", async () => {
  const { r, release, open, reads } = await retiredTick()
  open()
  await settle()
  await r.clock.advance(30_000) // the replacement's own tick reads, and finds the thread clear
  assert.equal(reads(), 3)
  assert.equal(r.receiver.state(), null)
  release() // the old read lands last
  await settle()
  assert.equal(r.receiver.state(), null, "it overwrote nothing: no stopped, no refusal, no new generation")
  await r.clock.advance(30_000)
  assert.deepEqual(lastBeat(r), CLEAR_BEAT)
})

// ---- a control socket that cannot be trusted ---------------------------------------------------------------------------

test("a control socket that cannot be trusted is no positive check: no join, chat is not latched off, and the join follows once it can be", async () => {
  let answer = { status: "untrusted" }
  const thread = threadDouble({ bind: () => answer })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 0, "an untrusted socket verifies nothing, so no join")
  const hook = await r.op({ op: "start", wait_ms: 5000 })
  assert.deepEqual(hook.sent, [{ context: null }], "no refusal text: the receiver is not disabled, it is waiting")
  for (let period = 0; period < 4; period += 1) await r.clock.advance(30_000)
  assert.equal(r.worker.bootIds.length, 0)
  assert.ok(thread.calls.filter(call => call === "bind").length >= 5, "it keeps looking every heartbeat period")
  answer = { status: "bound" }
  await r.clock.advance(30_000)
  assert.equal(r.worker.bootIds.length, 1, "the path is fixed: the join follows the next look")
})

test("a bind that finds the socket untrusted after the join does not end chat, and hook delivery is unchanged", async () => {
  let answer = { status: "stale_binding" }
  const thread = threadDouble({ bind: () => answer })
  const r = await rig({ handlers: deliverable(), thread })
  assert.equal(r.worker.bootIds.length, 1, "the join came with a main thread whose provider changed")
  await idleSession(r)
  answer = { status: "untrusted" }
  await r.clock.advance(30_000) // the tick binds again and the socket is refused
  assert.notEqual(r.receiver.state(), "offline", "chat is not latched off")
  const busy = await r.op(turn())
  assert.match(busy.sent[0].context, /"id":/, "busy delivery through the hook is unchanged")
})

// A thread that joined unbound is bound by a later heartbeat, as a rejoin binds again: it is read from then on, and a child
// found by that bind ends chat the way the first join would.
test("a thread that joined unbound is bound by a later heartbeat and read from then on", async () => {
  let answer = { status: "stale_binding" }
  const thread = threadDouble({ bind: () => answer, observation: reading("stopped", { stopped: true }) })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 1, "the thread is a main thread, so it joins")
  await idleSession(r)
  await r.clock.advance(30_000)
  assert.deepEqual(thread.calls.filter(call => call === "observe"), [], "unbound, so never read")
  assert.equal(r.receiver.state(), null)
  answer = { status: "bound" }
  await r.clock.advance(30_000) // the tick binds again and finds the recorded provider, then reads
  assert.equal(thread.calls.filter(call => call === "observe").length, 1)
  assert.equal(r.receiver.state(), "stopped", "the read is kept once the thread is bound")
})

test("a thread that joined unbound and is found to be a child by a later heartbeat ends chat and stops the worker", async () => {
  let answer = { status: "stale_binding" }
  const thread = threadDouble({ bind: () => answer })
  const r = await rig({ thread })
  assert.equal(r.worker.bootIds.length, 1)
  await idleSession(r)
  answer = { status: "child" }
  await r.clock.advance(30_000)
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 1)
})


// A receiver is a long-lived process that keeps a socket, a lock and the worker's binding file in the state directory, so it
// does not start below a directory that others can change: it refuses before it creates, binds or starts anything.
test("a receiver does not start in a state directory below a directory that others can change, and creates nothing there", async () => {
  const root = mkdtempSync(join(tmpdir(), "acr-"))
  try {
    const parent = join(root, "p")
    mkdirSync(parent)
    chmodSync(parent, 0o777)
    const state = join(parent, "s")
    mkdirSync(state, { mode: 0o700 })
    chmodSync(state, 0o700)
    const file = join(root, "chat.json")
    writeFileSync(file, JSON.stringify({ ...baseConfig, chatEnabled: true, directory: state }))
    chmodSync(file, 0o600)
    await assert.rejects(runReceiver(["session-1", "1"], { AGENT_CHAT_CODEX_CONFIG: file }), { code: "CHAT_SOCKET_DIRECTORY" })
    assert.deepEqual(readdirSync(state), [], "no socket, no lock, no worker directory")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
