import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { createReceiver } from "../lib/receiver.js"
import { runHook } from "../lib/hook.js"
import { connect, paths, serve } from "../lib/ipc.js"
import { CHAT_PREFIX } from "../lib/channel.js"

// Issue #133: what an idle-wake waiter does while the receiver rejoins. These cases pin behaviour that was only
// implied: the receiver owns the episode and the waiter's socket, so a registered waiter survives the back-off and a
// claim needs a live worker and a registered consumer. `receiver.test.js` holds the waiter cases that need no episode
// and the rejoin cases that need no waiter; the rig below is a copy of its rig without the event log.
const ROOM = "33333333-3333-4333-8333-333333333333"
const BODY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
const baseConfig = { python: "/usr/bin/python3", directory: "/tmp/agent-chat-state", serverOrigin: "https://chat.example", hostToken: "synthetic-host-token" }
const row = id => ({
  id, kind: "question", room_id: ROOM, history_after: `cursor-${id}`, body: `body of ${id}`,
  sender_session_id: "peer-1", created_at: "2026-01-01T00:00:00Z",
})
const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// A manual scheduler: nothing runs until the test advances the clock. `clock` is the monotonic clock and drives the
// timers; the wall clock is `clock` plus a `skew` that only `stepWall` moves, as an NTP step would.
function scheduler() {
  let clock = 1_000_000
  let skew = 0
  let next = 1
  const timers = new Map()
  const add = (fn, ms, repeat) => { const id = next++; timers.set(id, { fn, at: clock + ms, ms, repeat }); return id }
  return {
    now: () => clock + skew,
    mono: () => clock,
    stepWall: ms => { skew += ms },
    setTimeoutImpl: (fn, ms) => add(fn, ms, false),
    clearTimeoutImpl: id => { timers.delete(id) },
    setIntervalImpl: (fn, ms) => add(fn, ms, true),
    clearIntervalImpl: id => { timers.delete(id) },
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
      clock = Math.max(clock, end) // a timer callback may advance the clock itself; time never runs back
      await settle()
    },
  }
}

// The product's worker, as a double. `handlers` override one operation each; `joinErrors[n]` refuses the (n+1)th join.
// `joinHold()` runs as each worker starts; a promise it returns holds that join open until the promise settles.
function workerDouble({ handlers = {}, joinErrors = [], joinHold = () => undefined } = {}) {
  const log = []
  const bootIds = []
  const state = { stops: 0 }
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
      room_id: ROOM, host: "synthetic-host", harness: "claude", instance_file: `/tmp/agent-chat-state/${identity.bootId}.json`,
    }
    const refusal = joinErrors[bootIds.length - 1]
    const hold = joinHold()
    return {
      ready: hold ? hold.then(() => joined) : refusal ? Promise.reject(refusal) : Promise.resolve(joined),
      async request(op, fields = {}) {
        log.push({ op, ...fields })
        return answers[op](fields)
      },
      stop() { state.stops += 1; finish({ code: 0, signal: null }); return closed },
      closed,
    }
  }
  return { startProcess, log, bootIds, state, ops: name => log.filter(entry => entry.op === name) }
}

// The hook end of one connection, as a double. A context frame with `ack` is
// answered with the configured write receipt, like a hook that wrote the output.
function hookDouble({ receipt = "written", answer = true, sendOk = true } = {}) {
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
      if (!sendOk) return false
      if (value.ack === true && answer) queue.push({ op: "done", outcome: receipt })
      return true
    },
    async next() { return queue.shift() ?? null },
  }
}

async function rig({ handlers, joinErrors, joinHold, config = {} } = {}) {
  const clock = scheduler()
  const worker = workerDouble({ handlers, joinErrors, joinHold })
  const receiver = createReceiver({ ...baseConfig, ...config }, { sessionId: "session-1", ownerPid: 4242 }, {
    startProcess: worker.startProcess,
    now: clock.now,
    mono: clock.mono,
    random: () => 0.5,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    alive: () => true,
    startTime: () => null,
  })
  void receiver.start()
  await settle()
  const rigged = {
    receiver, clock, worker,
    async op(request, hook = hookDouble()) {
      await receiver.handle(request, hook)
      return hook
    },
    // The hook that opens a session: announce the binding, as session-start does.
    async begin() {
      const hook = await rigged.op({ op: "start", wait_ms: 5000 })
      worker.log.length = 0
      return hook
    },
  }
  return rigged
}

const turn = (extra = {}) => ({ op: "turn", permission_mode: "default", patience_ms: 6000, ...extra })
const joinRefusal = workerCode => Object.assign(new Error("x"), { code: "CHAT_WORKER_REFUSED", workerCode, operation: "join" })

async function idle(r) {
  await r.begin()
  await r.op(turn())
  await r.op({ op: "stop", permission_mode: "default" })
  r.worker.log.length = 0
}

// A stopped session with an idle-wake waiter registered. `control.stale` makes the next heartbeat answer
// STALE_INSTANCE, which starts a rejoin episode while the waiter is registered; `control.queued` is what the service
// holds for the session, and the waiter would claim it on its next poll if a worker were live.
async function armed({ joinErrors, joinHold } = {}) {
  const control = { stale: false, queued: [] }
  const r = await rig({
    joinErrors, joinHold,
    handlers: {
      heartbeat: () => (control.stale ? { refused: "STALE_INSTANCE" } : {}),
      pending: () => ({ messages: control.queued }),
    },
  })
  await idle(r)
  const wake = hookDouble()
  const waiting = r.receiver.handle({ op: "wait" }, wake)
  await settle()
  return { r, control, wake, waiting }
}

// The heartbeat tick that finds the lease gone. The episode begins: the old worker is stopped and the first retry
// waits 3.75 s (5 s base, jitter 0.5 to 1.0, a random source fixed at 0.5). The waiter stays registered.
async function leaseGone({ r, control, wake }) {
  control.stale = true
  await r.clock.advance(30_000)
  assert.equal(r.worker.state.stops, 1, "the episode began: the old worker is stopped")
  assert.equal(r.worker.bootIds.length, 1, "and no new worker has joined yet")
  assert.deepEqual(wake.sent, [], "the waiter is neither answered nor cancelled")
  assert.equal(wake.closed, false)
}

test("a waiter armed before an episode stays registered through the back-off and wakes after the join, naming the new boot id", async () => {
  const a = await armed()
  const { r, control, wake, waiting } = a
  await leaseGone(a)
  control.stale = false // the lease that the rejoin gets is good
  control.queued = ["m1"] // and a message is waiting
  r.worker.log.length = 0
  await r.clock.advance(3749)
  assert.equal(r.worker.bootIds.length, 1, "still backing off")
  assert.deepEqual(wake.sent, [], "unanswered through the back-off")
  assert.equal(wake.closed, false)
  assert.deepEqual(r.worker.log, [], "no worker request runs while no worker is live, so nothing is claimed")
  await r.clock.advance(1)
  assert.equal(r.worker.bootIds.length, 2, "the rejoin joined a new worker")
  await r.clock.advance(2000) // the next poll on the core cadence
  assert.equal(wake.sent.length, 1)
  const [frame] = wake.sent
  assert.equal(frame.ack, true)
  assert.ok(frame.context.startsWith(CHAT_PREFIX), "the waiter hands the notice alone")
  assert.match(frame.context, /"id":"m1"/)
  assert.ok(frame.context.includes(`"instance_file":"/tmp/agent-chat-state/${r.worker.bootIds[1]}.json"`), "the notice names the new boot id")
  assert.equal(frame.context.includes(r.worker.bootIds[0]), false, "and never the old one")
  assert.equal(r.worker.ops("claim").length, 1)
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "handed", reason: null }])
  wake.close()
  await waiting
})

test("a waiter armed during a lease-lost episode wakes after the join", async () => {
  // The rig and idle session of armed(), but no waiter until the episode has begun.
  const control = { stale: false, queued: [] }
  const r = await rig({
    handlers: {
      heartbeat: () => (control.stale ? { refused: "STALE_INSTANCE" } : {}),
      pending: () => ({ messages: control.queued }),
    },
  })
  await idle(r)
  const wake = hookDouble()
  await leaseGone({ r, control, wake })
  const waiting = r.receiver.handle({ op: "wait" }, wake)
  await settle()
  control.stale = false // the lease that the rejoin gets is good
  control.queued = ["m1"] // and a message is waiting
  r.worker.log.length = 0
  await r.clock.advance(3749)
  assert.equal(r.worker.bootIds.length, 1, "still backing off")
  assert.deepEqual(wake.sent, [], "unanswered through the back-off")
  assert.equal(wake.closed, false)
  await r.clock.advance(1)
  assert.equal(r.worker.bootIds.length, 2, "the rejoin joined a new worker")
  await r.clock.advance(2000) // the next poll on the core cadence
  assert.equal(wake.sent.length, 1)
  const [frame] = wake.sent
  assert.equal(frame.ack, true)
  assert.ok(frame.context.startsWith(CHAT_PREFIX), "the waiter hands the notice alone")
  assert.ok(frame.context.includes(`"instance_file":"/tmp/agent-chat-state/${r.worker.bootIds[1]}.json"`), "the notice names the new boot id")
  assert.equal(r.worker.ops("claim").length, 1, "exactly one claim after the join")
  wake.close()
  await waiting
})

// The receiver claims only for a consumer. A waiter that is gone before the join leaves the idle session with a
// message waiting and no consumer: nothing claims until the next turn event, which is the next consumer.
for (const [how, leave] of [
  ["its hook is killed", async (_r, wake) => { wake.close(); await settle() }],
  ["a turn event cancels it and the turn ends", async (r, wake) => {
    const during = await r.op(turn())
    assert.deepEqual(during.sent, [{ context: null }], "no binding is live to announce mid-episode")
    await settle()
    assert.deepEqual(wake.sent, [{ cancelled: true }])
    assert.equal(wake.closed, true)
    await r.op({ op: "stop", permission_mode: "default" })
  }],
]) {
  test(`a waiter that is gone mid-episode because ${how} causes no claim after the join`, async () => {
    const a = await armed()
    const { r, control, waiting } = a
    await leaseGone(a)
    control.stale = false
    control.queued = ["m1"]
    r.worker.log.length = 0
    await leave(r, a.wake)
    await r.clock.advance(3750)
    assert.equal(r.worker.bootIds.length, 2, "the rejoin joined a new worker")
    await r.clock.advance(120_000)
    assert.ok(r.worker.ops("heartbeat").length > 0, "the new worker is live and serving, so silence is not a dead receiver")
    assert.equal(r.receiver.state(), null, "the session is idle and chat is not offline")
    for (const op of ["pending", "claim", "settle"]) assert.deepEqual(r.worker.ops(op), [], op)
    const next = await r.op(turn())
    assert.equal(r.worker.ops("claim").length, 1, "the next turn event is the next consumer")
    assert.match(next.sent[0].context, /"id":"m1"/)
    await waiting
  })
}

// An exhausted episode latches chat off. A registered waiter gets `disabled` and is closed, and nothing claims after
// that. The first hook after the latch names the bound that ended the episode, so the two cases differ in evidence.
const stopped = reason => ({ disabled: true, message: `Agent Chat stopped (${reason}); the Claude Code session is unchanged.` })

test("an episode that spends the rejoin budget sends disabled to a registered waiter and claims nothing afterwards", async () => {
  const a = await armed()
  const { r, control, wake, waiting } = a
  await leaseGone(a) // every lease the service sees from here on is refused: three rejoins succeed and each is refused again
  control.queued = ["m1"]
  r.worker.log.length = 0
  for (let rejoin = 1; rejoin <= 3; rejoin += 1) {
    assert.deepEqual(wake.sent, [], `before rejoin ${rejoin} the waiter is still registered and unanswered`)
    await r.clock.advance(3750)
  }
  assert.equal(r.worker.bootIds.length, 4, "the initial join and three rejoins")
  assert.deepEqual(wake.sent, [{ disabled: true }])
  assert.equal(wake.closed, true)
  await waiting
  assert.equal(r.receiver.state(), "offline")
  assert.equal(r.worker.state.stops, 4, "no worker is left running")
  await r.clock.advance(600_000)
  assert.equal(r.worker.bootIds.length, 4, "no further join")
  for (const op of ["pending", "claim", "settle"]) assert.deepEqual(r.worker.ops(op), [], op)
  assert.deepEqual((await r.op(turn())).sent, [stopped("REJOIN_BUDGET")])
})

test("an episode that outlives its window sends disabled to a registered waiter and claims nothing afterwards", async () => {
  // The first join works. Every rejoin is refused with an outage code until the two-hour episode window is spent.
  const outage = Array.from({ length: 200 }, () => joinRefusal("SERVICE_UNAVAILABLE"))
  const a = await armed({ joinErrors: [undefined, ...outage] })
  const { r, control, wake, waiting } = a
  await leaseGone(a)
  control.stale = false
  control.queued = ["m1"]
  r.worker.log.length = 0
  await r.clock.advance(3_600_000)
  assert.ok(r.worker.bootIds.length > 2, "the rejoins keep failing")
  assert.deepEqual(wake.sent, [], "an hour into the episode the waiter is still registered and unanswered")
  assert.notEqual(r.receiver.state(), "offline")
  await r.clock.advance(3_700_000) // past the 7,200,000 ms window
  assert.deepEqual(wake.sent, [{ disabled: true }])
  assert.equal(wake.closed, true)
  await waiting
  assert.equal(r.receiver.state(), "offline")
  const boots = r.worker.bootIds.length
  assert.equal(r.worker.state.stops, boots, "every worker that started was stopped")
  await r.clock.advance(600_000)
  assert.equal(r.worker.bootIds.length, boots, "no further join")
  for (const op of ["pending", "claim", "settle"]) assert.deepEqual(r.worker.ops(op), [], op)
  assert.deepEqual((await r.op(turn())).sent, [stopped("REJOIN_WINDOW")])
})

// The two-hour window bounds when a retry may start (the core policy, pinned by policy.test.js). A retry that started
// inside the window and completes after it is served normally: the join stands and a registered waiter can be woken.
test("a rejoin that starts just before the episode window ends and completes after it joins, and a registered waiter wakes", async () => {
  const control = { clock: null, episodeStart: null, startedAt: null }
  let release
  const hold = new Promise(resolve => { release = resolve })
  // Every rejoin is refused with an outage code until one starts more than 7,100 s into the episode; that one is held open.
  const outage = Array.from({ length: 200 }, () => joinRefusal("SERVICE_UNAVAILABLE"))
  const a = await armed({
    joinErrors: [undefined, ...outage],
    joinHold: () => {
      if (control.episodeStart === null || control.startedAt !== null) return undefined
      if (control.clock.now() - control.episodeStart < 7_100_000) return undefined
      control.startedAt = control.clock.now()
      return hold
    },
  })
  const { r, control: service, wake, waiting } = a
  control.clock = r.clock
  await leaseGone(a)
  control.episodeStart = r.clock.now()
  service.queued = ["m1"]
  r.worker.log.length = 0
  await r.clock.advance(7_150_000)
  const offset = control.startedAt - control.episodeStart
  assert.ok(offset > 7_100_000 && offset < 7_200_000, `a retry started inside the window (${offset} ms into the episode)`)
  const boots = r.worker.bootIds.length
  assert.ok(boots > 2, "earlier retries were refused")
  await r.clock.advance(100_000) // the window ends while that retry is still joining
  assert.ok(r.clock.now() - control.episodeStart >= 7_200_000, "the window has ended")
  assert.equal(r.worker.bootIds.length, boots, "no retry starts after the window")
  assert.deepEqual(wake.sent, [], "the waiter is still registered and unanswered")
  assert.equal(wake.closed, false)
  assert.notEqual(r.receiver.state(), "offline", "the episode has not latched chat off")
  service.stale = false // the lease that this join got is good
  release()
  await settle()
  assert.equal(r.worker.bootIds.length, boots, "the late join did not start another worker")
  assert.equal(wake.closed, false, "the join was not turned into disabled")
  await r.clock.advance(2000) // the next poll on the core cadence
  assert.equal(wake.sent.length, 1)
  const [frame] = wake.sent
  assert.match(frame.context, /"id":"m1"/)
  assert.ok(frame.context.includes(`"instance_file":"/tmp/agent-chat-state/${r.worker.bootIds[boots - 1]}.json"`), "the notice names the late join's boot id")
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "handed", reason: null }])
  wake.close()
  await waiting
})

// The receiver owns both the episode and the waiter's socket, so a receiver that dies takes the socket with it. The
// hook sees the connection close, not a frame: it must leave at once, print nothing and send no receipt. This runs
// the real hook over the real socket layer, with the receiver's end closing 100 ms into a 30-second hold.
test("a waiter whose connection closes mid-hold exits 0 at once, with no output and no receipt", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-"))
  const state = join(root, "s")
  mkdirSync(state, { mode: 0o700 })
  chmodSync(state, 0o700)
  const file = join(root, "chat.json")
  writeFileSync(file, JSON.stringify({ ...baseConfig, chatEnabled: true, directory: state }))
  chmodSync(file, 0o600)
  const received = []
  const server = await serve(paths(state, "session-1").socket, async (first) => {
    received.push(first)
    await delay(100) // the handler returns, and serve closes the connection: the receiver is gone
  })
  const sent = []
  const written = []
  const io = {
    stdin: Readable.from([Buffer.from(JSON.stringify({ session_id: "session-1", permission_mode: "default", hook_event_name: "Stop" }))]),
    env: { AGENT_CHAT_CLAUDE_CONFIG: file },
    connect: async path => {
      const link = await connect(path)
      return { ...link, send: frame => { sent.push(frame); return link.send(frame) } }
    },
    write: async (stream, text) => { written.push([stream, text]); return true },
    ppid: () => 100, orphanMs: 60_000, holdMs: 30_000, sleep: () => new Promise(() => {}),
  }
  const began = Date.now()
  let code
  try { code = await runHook("wait", io) } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
  const elapsed = Date.now() - began
  assert.equal(code, 0)
  assert.deepEqual(written, [], "no output")
  assert.deepEqual(received, [{ op: "wait", hold_ms: 30_000 }], "the waiter registered with the receiver, naming its hold")
  assert.deepEqual(sent, [{ op: "wait", hold_ms: 30_000 }], "and sent nothing after it: no done frame")
  assert.ok(elapsed >= 90, `it was held until the connection closed (${elapsed} ms)`)
  assert.ok(elapsed < 5000, `the close, not the 30-second hold, ended the wait (${elapsed} ms)`)
})

// A waiter that leaves between the claim and the notice has been shown nothing. The claimed batch must settle
// `deferred`, not `uncertain`: an uncertain batch is excluded from later delivery. A write that was attempted and
// never confirmed stays uncertain; `receiver.test.js` pins that ("a write that failed or went unconfirmed settles
// uncertain, never handed", and "a wake whose write failed settles uncertain and leaves no waiter"). The worker
// double applies no deferral backoff or attempt limit; the ledger owns them (1 s after the first attempt, 5 s after
// the second, three attempts in all).
for (const [later, again] of [
  ["a later turn", async r => {
    const next = await r.op(turn())
    assert.match(next.sent[0].context, /"id":"m1"/, "the turn can claim the same message")
    return next
  }],
  ["a later waiter", async r => {
    const wake = hookDouble()
    const waiting = r.receiver.handle({ op: "wait" }, wake)
    await r.clock.advance(2000)
    assert.equal(wake.sent.length, 1, "the waiter can claim the same message")
    assert.match(wake.sent[0].context, /"id":"m1"/)
    wake.close()
    await waiting
    return wake
  }],
]) {
  test(`a waiter that leaves after the claim but before the notice is written defers the batch, and ${later} can claim it again`, async () => {
    const control = { onStatus: () => {} }
    const r = await rig({
      handlers: { pending: () => ({ messages: ["m1"] }), status: () => { control.onStatus(); return { muted: false } } },
    })
    await idle(r)
    const wake = hookDouble()
    control.onStatus = () => wake.close() // the hold ends while the status call is in flight, after the claim
    const waiting = r.receiver.handle({ op: "wait" }, wake)
    await r.clock.advance(2000)
    await waiting
    assert.equal(r.worker.ops("claim").length, 1, "the message was claimed while the waiter was open")
    assert.deepEqual(wake.sent, [], "no notice was written")
    assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "deferred", reason: "offline" }])
    control.onStatus = () => {}
    await again(r)
    assert.equal(r.worker.ops("claim").length, 2, "the same message was claimed again")
    assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [
      { outcome: "deferred", reason: "offline" }, { outcome: "handed", reason: null },
    ])
  })
}

// The close can also come while the claim is in flight, with the reservation still ample. The delivery checks the link
// as soon as the grant is valid: it makes no status call, which a transient failure could turn into an unsettled batch,
// and it settles the batch `deferred`, so a later claim gets it.
test("a waiter that closes while the claim is in flight settles the batch deferred without a status call, and a later turn claims it again", async () => {
  const control = { onClaim: () => {} }
  const r = await rig({
    handlers: {
      pending: () => ({ messages: ["m1"] }),
      claim: fields => {
        control.onClaim()
        return { dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, messages: fields.messages.map(row) }
      },
    },
  })
  await idle(r)
  const wake = hookDouble()
  control.onClaim = () => wake.close() // the hold ends while the claim is in flight
  const waiting = r.receiver.handle({ op: "wait" }, wake)
  await r.clock.advance(2000)
  await waiting
  assert.equal(r.worker.ops("claim").length, 1, "the message was claimed while the waiter was open")
  assert.deepEqual(r.worker.ops("status"), [], "no status call for a consumer that is already gone")
  assert.deepEqual(wake.sent, [], "no notice was written")
  assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [{ outcome: "deferred", reason: "offline" }])
  control.onClaim = () => {}
  r.worker.log.length = 0
  const next = await r.op(turn())
  assert.equal(r.worker.ops("claim").length, 1, "a later turn claims the same message")
  assert.match(next.sent[0].context, /"id":"m1"/)
})

// The two pre-write timeout branches of a delivery settle `uncertain` only when the consumer is still there: with the
// link already closed, nothing was written and nothing can have been shown, so the batch settles `deferred`, exactly as
// it does when the close comes just before the write. Each case ends the hold at the point the branch tests the clock.
for (const [branch, reservation, setup] of [
  ["the claim leaves less than the minimum reservation", 400,
    (control, wake) => { control.onClaim = () => wake.close() }],
  ["the status call used the reservation", 700,
    (control, wake) => {
      control.onStatus = async () => { wake.close(); await control.clock.advance(450) } // 250 ms of 700 are left
    }],
]) {
  for (const [link, expected] of [
    ["closed", { outcome: "deferred", reason: "offline" }],
    ["open", { outcome: "uncertain", reason: "transport_ambiguous" }],
  ]) {
    test(`${branch} and the waiter's link is ${link}: the batch settles ${expected.outcome}, with no write attempted`, async () => {
      const control = { onClaim: () => {}, onStatus: () => {}, clock: null }
      const r = await rig({
        handlers: {
          pending: () => ({ messages: ["m1"] }),
          claim: fields => {
            control.onClaim()
            return { dispatch: true, attempt_id: "attempt-1", reservation_ms: reservation, messages: fields.messages.map(row) }
          },
          status: async () => { await control.onStatus(); return { muted: false } },
        },
      })
      control.clock = r.clock
      await idle(r)
      const wake = hookDouble()
      if (link === "closed") setup(control, wake)
      else if (reservation === 700) control.onStatus = () => r.clock.advance(450)
      const waiting = r.receiver.handle({ op: "wait" }, wake)
      await r.clock.advance(2000)
      if (link === "open") wake.close()
      await waiting
      assert.equal(r.worker.ops("claim").length, 1, "the message was claimed while the waiter was open")
      assert.deepEqual(wake.sent, [], "no notice was written")
      assert.deepEqual(r.worker.ops("settle").map(entry => entry.result), [expected])
    })
  }
}

// The waiter's hold. The receiver learns it from the wait frame (`hold_ms`) and, before any write, treats a waiter whose
// hold has ended like one whose socket closed: the hook has left, so nothing can have been shown and the batch settles
// `deferred`. The close event can arrive after the receiver has already decided to write (a status reply and the
// socket's close are separate events), so the receiver cannot rely on seeing it. The rig below keeps the link open
// throughout: only the clock moves. A hold of 10,000 ms ends the receiver's view of the waiter at +9,000 ms (a 1,000 ms
// safety for the hook's start-up and the IPC lag), and the first poll is at +2,000 ms.
const holdRig = async ({ onPending = () => {}, onClaim = () => {}, onStatus = () => {}, receipt = "written", config = {} } = {}) => {
  const control = { onPending, onClaim, onStatus, clock: null }
  // Bodies mode needs the core's bodies shape: a full row, its size on `pending`, and the grant's admission time.
  const bodies = config.noticeBodies === true
  const rows = {
    [BODY_ID]: {
      id: BODY_ID, kind: "question", room_id: ROOM, history_after: "101", body: "synthetic body", body_truncated: false,
      sender_session_id: "66666666-6666-4666-8666-666666666666", sender_principal_id: "77777777-7777-4777-8777-777777777777",
      created_at: "2026-01-01T00:00:00+00:00", thread_id: "88888888-8888-4888-8888-888888888888",
    },
  }
  const r = await rig({
    handlers: {
      pending: async () => {
        await control.onPending(control)
        return bodies ? { messages: [BODY_ID], sizes: { [BODY_ID]: Buffer.byteLength(rows[BODY_ID].body) }, retry: false } : { messages: ["m1"] }
      },
      claim: async fields => {
        await control.onClaim(control)
        const messages = fields.messages.map(id => rows[id] ?? row(id))
        return { dispatch: true, attempt_id: "attempt-1", reservation_ms: 30_000, messages, ...(bodies ? { admitted_at: "2026-01-01T00:00:42+00:00" } : {}) }
      },
      status: async () => { await control.onStatus(control); return { muted: false } },
    },
    config,
  })
  control.clock = r.clock
  await idle(r)
  return { r, control, wake: hookDouble({ receipt }) }
}
// A handler that advances the clock runs timers of its own, so the delivery takes several turns of the event loop to finish.
const drain = async () => { for (let turns = 0; turns < 10; turns += 1) await settle() }
const settled = r => r.worker.ops("settle").map(entry => entry.result)

for (const [where, hook] of [
  ["the status call is in flight", { onStatus: control => control.clock.advance(8_000) }],
  ["the claim is in flight", { onClaim: control => control.clock.advance(8_000) }],
]) {
  test(`a waiter whose hold ends while ${where} and whose close is not yet observed gets no write, and a later claim gets the batch`, async () => {
    const { r, wake } = await holdRig(hook)
    const waiting = r.receiver.handle({ op: "wait", hold_ms: 10_000 }, wake)
    await r.clock.advance(2000)
    await drain()
    assert.equal(wake.closed, false, "the receiver has not seen the socket close")
    assert.equal(r.worker.ops("claim").length, 1, "the message was claimed while the hold had time left")
    assert.deepEqual(wake.sent, [], "no notice was written to a hook that has already left")
    assert.deepEqual(settled(r), [{ outcome: "deferred", reason: "offline" }])
    wake.close()
    await waiting
    r.worker.log.length = 0
    const next = await r.op(turn())
    assert.match(next.sent[0].context, /"id":"m1"/, "a later claim gets the same batch")
    assert.deepEqual(settled(r), [{ outcome: "handed", reason: null }])
  })
}

test("a write that was attempted to a waiter with hold left and never confirmed still settles uncertain", async () => {
  const { r, wake } = await holdRig({ receipt: null })
  const waiting = r.receiver.handle({ op: "wait", hold_ms: 10_000 }, wake)
  await r.clock.advance(2000)
  assert.equal(wake.sent.length, 1, "the notice was written")
  assert.deepEqual(settled(r), [{ outcome: "uncertain", reason: "transport_ambiguous" }])
  wake.close()
  await waiting
})

// The floor is 4,000 ms: the poll at +2,000 ms claims only when the waiter has at least that long left.
for (const [holdMs, claims] of [[6_999, false], [7_000, true]]) {
  test(`a waiter with ${claims ? "exactly the floor" : "less than the floor"} left at the poll ${claims ? "claims" : "starts no claim"} (hold_ms ${holdMs})`, async () => {
    const { r, wake } = await holdRig()
    const waiting = r.receiver.handle({ op: "wait", hold_ms: holdMs }, wake)
    await r.clock.advance(2000)
    assert.equal(r.worker.ops("claim").length, claims ? 1 : 0)
    assert.equal(r.worker.ops("pending").length, claims ? 1 : 0, "a short waiter does not even read the pending list")
    assert.equal(wake.sent.length, claims ? 1 : 0)
    wake.close()
    await waiting
    if (claims) return
    r.worker.log.length = 0
    const next = await r.op(turn())
    assert.match(next.sent[0].context, /"id":"m1"/, "the message stays claimable by a later consumer")
  })
}

// The floor is checked again right before the claim: a slow pending read can use up the time the poll saw. The poll at
// +2,000 ms of a 10,000 ms hold sees 7,000 ms left; a pending read of 3,000 ms leaves exactly the floor, one of 3,001 ms
// leaves less, and a claim then could finish with too little time to answer. In bodies mode the check follows the
// candidate packing, so nothing runs between it and the claim.
for (const noticeBodies of [false, true])
for (const [pendingMs, claims] of [[3_000, true], [3_001, false]]) {
  test(`a pending read of ${pendingMs} ms that leaves ${claims ? "exactly the floor" : "less than the floor"} ${claims ? "is followed by a claim" : "is followed by no claim"}${noticeBodies ? " (notice bodies)" : ""}`, async () => {
    const { r, control, wake } = await holdRig({ onPending: control => control.clock.advance(pendingMs), config: noticeBodies ? { noticeBodies: true } : {} })
    const id = noticeBodies ? BODY_ID : "m1"
    const waiting = r.receiver.handle({ op: "wait", hold_ms: 10_000 }, wake)
    await r.clock.advance(2000)
    await drain()
    assert.equal(r.worker.ops("pending").length, 1, "the poll saw enough time and read the pending list")
    assert.equal(r.worker.ops("claim").length, claims ? 1 : 0)
    assert.equal(wake.sent.length, claims ? 1 : 0)
    assert.deepEqual(settled(r), claims ? [{ outcome: "handed", reason: null }] : [], "an unclaimed batch has nothing to settle")
    wake.close()
    await waiting
    if (claims) return
    control.onPending = () => {}
    r.worker.log.length = 0
    const next = await r.op(turn())
    assert.ok(next.sent[0].context.includes(id), "the message stays claimable by a later consumer")
    assert.deepEqual(settled(r), [{ outcome: "handed", reason: null }])
  })
}

// The hook's timeout measures elapsed time, so the receiver measures the hold on a monotonic clock. A wall-clock step
// back while the status call is in flight must not hide that the hold has ended.
test("a wall-clock step back while the hold runs out does not hide that the waiter is gone: no write, and a later claim gets the batch", async () => {
  const { r, wake } = await holdRig({ onStatus: control => { control.clock.stepWall(-60_000); return control.clock.advance(8_000) } })
  const waiting = r.receiver.handle({ op: "wait", hold_ms: 10_000 }, wake)
  await r.clock.advance(2000)
  await drain()
  assert.equal(wake.closed, false, "the receiver has not seen the socket close")
  assert.equal(r.worker.ops("claim").length, 1, "the message was claimed while the hold had time left")
  assert.deepEqual(wake.sent, [], "no notice was written to a hook that has already left")
  assert.deepEqual(settled(r), [{ outcome: "deferred", reason: "offline" }])
  wake.close()
  await waiting
  r.worker.log.length = 0
  const next = await r.op(turn())
  assert.match(next.sent[0].context, /"id":"m1"/, "a later claim gets the same batch")
})

// An older hook sends no hold; a malformed one is no better. Either way the receiver knows no deadline and behaves as
// before: it writes even when the clock has run well past any hold.
for (const holdMs of [undefined, 0, -1, 1.5, "10000", null, true, Number.NaN, Infinity, 2 ** 60]) {
  test(`a wait with hold_ms ${String(holdMs)} is treated as no known deadline: the write happens as before`, async () => {
    const { r, wake } = await holdRig({ onStatus: control => control.clock.advance(8_000) })
    const request = holdMs === undefined ? { op: "wait" } : { op: "wait", hold_ms: holdMs }
    const waiting = r.receiver.handle(request, wake)
    await r.clock.advance(2000)
    await drain()
    assert.equal(wake.sent.length, 1, "the notice was written")
    assert.deepEqual(settled(r), [{ outcome: "handed", reason: null }])
    wake.close()
    await waiting
  })
}
