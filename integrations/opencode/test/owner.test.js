import test from "node:test"
import assert from "node:assert/strict"
import { createMember, createRegistry, globalRegistry } from "../lib/owner.js"
import { EVENT_TYPES } from "../lib/manager.js"

const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let index = 0; index < 8; index++) await tick() }
const event = (id, type = "session.execution.started") => ({ id, type, data: { sessionID: "ses_a" } })

function fakeMember(name, log, { feedThrows = false } = {}) {
  const member = {
    name,
    dispatch: null,
    resetStream: null,
    pump(dispatch, reset) {
      member.dispatch = dispatch
      member.resetStream = reset
      return () => log.push(`stop-pump ${name}`)
    },
    activate() { log.push(`activate ${name}`) },
    async deactivate() {
      log.push(`deactivate-start ${name}`)
      await tick()
      log.push(`deactivate-end ${name}`)
      return true
    },
    feed(item) {
      if (feedThrows) throw new Error("boom")
      log.push(`feed ${name} ${item.id}`)
    },
    reset() { log.push(`reset ${name}`) },
  }
  return member
}

test("the first member owns the joins and the others stand by", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  registry.attach(second)
  await flush()
  assert.deepEqual(log, ["activate first"])
  assert.equal(registry.owner(), first)
  // An event read by any member goes to the owner, once.
  first.dispatch(event("e1"))
  second.dispatch(event("e1"))
  second.dispatch(event("e2"))
  assert.deepEqual(log.slice(1), ["feed first e1", "feed first e2"])
  second.resetStream()
  assert.equal(log.at(-1), "reset first")
})

test("an event without an id is passed on every time, and a seen id is dropped", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  member.dispatch({ type: "session.execution.started", data: { sessionID: "ses_a" } })
  member.dispatch({ type: "session.execution.started", data: { sessionID: "ses_a" } })
  assert.equal(log.filter(line => line.startsWith("feed")).length, 2)
})

test("the seen-id memory is bounded", async () => {
  const registry = createRegistry()
  const log = []
  const member = fakeMember("only", log)
  registry.attach(member)
  await flush()
  member.dispatch(event("first"))
  for (let index = 0; index < 1100; index++) member.dispatch(event(`e${index}`))
  member.dispatch(event("first")) // forgotten: passed on again
  assert.equal(log.filter(line => line === "feed only first").length, 2)
})

test("failover: the next owner starts only after the old owner's workers ended, and events in between are dropped", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  const detachFirst = registry.attach(first)
  registry.attach(second)
  await flush()
  log.length = 0
  const closing = detachFirst()
  await tick()
  second.dispatch(event("during")) // nobody owns during the change
  await closing
  assert.deepEqual(log, ["stop-pump first", "deactivate-start first", "deactivate-end first", "activate second"])
  assert.equal(registry.owner(), second)
  second.dispatch(event("after"))
  assert.equal(log.at(-1), "feed second after")
})

test("a member that is not the owner leaves without disturbing the owner", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  const second = fakeMember("second", log)
  registry.attach(first)
  const detachSecond = registry.attach(second)
  await flush()
  log.length = 0
  await detachSecond()
  assert.deepEqual(log, ["stop-pump second"])
  assert.equal(registry.owner(), first)
  assert.deepEqual(registry.members(), [first])
})

test("the last member leaving leaves no owner, and a later member becomes owner", async () => {
  const registry = createRegistry()
  const log = []
  const detach = registry.attach(fakeMember("first", log))
  await flush()
  await detach()
  assert.equal(registry.owner(), null)
  registry.attach(fakeMember("next", log))
  await flush()
  assert.equal(registry.owner().name, "next")
})

test("detach is idempotent and shares one result", async () => {
  const registry = createRegistry()
  const log = []
  const detach = registry.attach(fakeMember("only", log))
  await flush()
  const [one, two] = [detach(), detach()]
  assert.equal(one, two)
  await one
  assert.equal(log.filter(line => line === "deactivate-start only").length, 1)
})

test("an owner that throws on an event does not break the stream", async () => {
  const registry = createRegistry()
  const member = fakeMember("only", [], { feedThrows: true })
  registry.attach(member)
  await flush()
  assert.doesNotThrow(() => member.dispatch(event("e1")))
})

test("a member whose end fails still hands ownership on", async () => {
  const registry = createRegistry()
  const log = []
  const first = fakeMember("first", log)
  first.deactivate = async () => { throw new Error("unproved") }
  const second = fakeMember("second", log)
  const detach = registry.attach(first)
  registry.attach(second)
  await flush()
  await detach()
  assert.equal(registry.owner(), second)
})

test("the shared registry is one object per process and no member property carries the config", () => {
  assert.equal(globalRegistry(), globalRegistry())
  assert.equal(globalThis[Symbol.for("agent-chat.opencode.registry.v1")], globalRegistry())
  const config = { hostToken: "synthetic-host-token" }
  const member = createMember({ event: { subscribe: async function* () {} } }, config, {})
  for (const [name, value] of [...Object.entries(member), ...Object.entries(globalRegistry())]) {
    assert.equal(typeof value, "function", name)
  }
  assert.doesNotMatch(JSON.stringify({ ...member }), /synthetic-host-token/)
})

// A fake plugin context whose stream runs the scripted rounds in order.
function streamCtx(rounds) {
  const calls = []
  return {
    calls,
    event: {
      subscribe(options) {
        calls.push(options)
        const round = rounds.shift() ?? { events: [], hold: true }
        return (async function* () {
          for (const item of round.events ?? []) yield item
          if (round.throws) throw new Error("stream broke")
          if (round.hold) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))
        })()
      },
    },
  }
}

test("a member forwards its stream, ignores the first connect and treats a later connect as lost events", async () => {
  const ctx = streamCtx([
    { events: [{ type: "server.connected" }, event("e1"), { type: "server.connected" }, event("e2")], hold: true },
  ])
  const member = createMember(ctx, {}, {})
  const seen = []
  const resets = []
  const stop = member.pump(item => seen.push(item.id), () => resets.push("reset"))
  await flush()
  stop()
  assert.deepEqual(seen, ["e1", "e2"])
  assert.deepEqual(resets, ["reset"]) // only the second connect
  assert.deepEqual(ctx.calls[0].types, [...EVENT_TYPES])
  assert.ok(ctx.calls[0].signal instanceof AbortSignal)
})

test("a stream that throws or ends is reset and read again, with a growing wait, until the member is torn down", async () => {
  const ctx = streamCtx([{ events: [event("a")], throws: true }, { events: [event("b")] }, { events: [event("c")], hold: true }])
  const waits = []
  const member = createMember(ctx, {}, {}, { sleep: async ms => { waits.push(ms) } })
  const seen = []
  let resets = 0
  const stop = member.pump(item => seen.push(item.id), () => { resets += 1 })
  await flush()
  stop()
  assert.deepEqual(seen, ["a", "b", "c"])
  assert.equal(resets, 2)
  assert.deepEqual(waits, [1_000, 2_000])
  assert.equal(ctx.calls.length, 3)
})

test("tearing a member down stops its stream for good", async () => {
  const ctx = streamCtx([{ events: [], hold: true }])
  const member = createMember(ctx, {}, {})
  const stop = member.pump(() => {}, () => {})
  await flush()
  stop()
  await flush()
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].signal.aborted, true)
})

test("activate builds a manager that takes events, and deactivate stops it and proves the end", async () => {
  const lookups = []
  const ctx = { ...streamCtx([]), session: { get: async ({ sessionID }) => { lookups.push(sessionID); return { id: sessionID } } } }
  const stops = []
  const parts = {
    createDelivery: () => ({ seed() {}, observe: () => false, reset() {}, verifyContext: () => Promise.resolve(), dispose() {} }),
    createLifecycle: (bus) => { bus.on("session_start", () => {}); return { stop: () => { stops.push("stop"); return Promise.resolve({ code: 0 }) } } },
  }
  const member = createMember(ctx, {}, parts)
  member.feed(event("before")) // not active yet: nothing happens
  await flush()
  assert.deepEqual(lookups, [])
  member.activate()
  member.feed(event("e1"))
  await flush()
  assert.deepEqual(lookups, ["ses_a"])
  assert.equal(await member.deactivate(), true)
  assert.deepEqual(stops, ["stop"])
  assert.equal(await member.deactivate(), true) // already ended
})
