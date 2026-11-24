import test from "node:test"
import assert from "node:assert/strict"
import { createDelivery, normalizeTitle } from "../lib/delivery.js"

const ATTEMPT = "44444444-4444-4444-8444-444444444444"
const DEADLINE = 1000 + 5000

function fakeAgent({ status = "idle", removeResult = true, removeThrows = false,
  throwSteer = false, runningAfterSteer = true, beforeSteer = null } = {}) {
  const steers = []
  const removed = []
  const agent = {
    id: "native-1",
    status,
    session: { id: "native-1", header: {} },
    inbox: {
      nextStep: [],
      nextTurn: [],
      remove(id) {
        removed.push(id)
        if (removeThrows) throw new Error("remove refused")
        return removeResult
      },
    },
    steer(message) {
      steers.push(message)
      if (beforeSteer) beforeSteer(message)
      if (throwSteer) throw new Error("native steer refused")
      if (runningAfterSteer) agent.status = "running"
    },
  }
  return { agent, steers, removed }
}

// `registry` is the DSH surface: `rc.1` is 0.2.2-rc.1 (roots() and isOwnedBy());
// `rc.2+` is 0.2.2-rc.2 and later (get() and list() only).
function fakeCtx(agent, { plan = { active: false, pending: false }, planUnreadable = false,
  title, titleThrows = false, titleOwner = true, registry = "rc.1" } = {}) {
  const get = id => (id === agent.id ? agent : undefined)
  return {
    agents: registry === "rc.1"
      ? { get, isOwnedBy: () => false, roots: () => [agent] }
      : { get, list: () => [agent] },
    logger: { warn() {} },
    get(name) {
      if (name === "sessionProjections") {
        if (planUnreadable) return { snapshot() { throw new Error("plan unit unavailable") } }
        return { snapshot: () => ({ values: { plan } }) }
      }
      if (name === "sessionTitle") {
        if (!titleOwner) return undefined
        return {
          get: () => {
            if (titleThrows) throw new Error("title read failed")
            return title === undefined ? undefined : { title }
          },
        }
      }
      return undefined
    },
  }
}

const options = { now: () => 1000, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} }

function setup(agentOptions, ctxOptions) {
  const fake = fakeAgent(agentOptions)
  const ctx = fakeCtx(fake.agent, ctxOptions)
  return { ...fake, ctx, delivery: createDelivery(ctx, fake.agent, options) }
}

test("a new delivery object starts stopped; only a Web prompt clears it", () => {
  const { delivery } = setup()
  assert.equal(delivery.state(), "stopped")
  assert.equal(delivery.onInserted({ source: { kind: "plugin:other" } }), false)
  assert.equal(delivery.state(), "stopped")
  assert.equal(delivery.onInserted({ source: { kind: "user" } }), false)
  assert.equal(delivery.state(), "stopped")
  assert.equal(delivery.onInserted({ source: { kind: "user", rpcId: "" } }), false)
  assert.equal(delivery.state(), "stopped")
  assert.equal(delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } }), true)
  assert.equal(delivery.state(), null)
})

test("Plan Mode refuses delivery and is reported as its own heartbeat bit", () => {
  const { delivery, steers } = setup({}, { plan: { active: true, pending: false } })
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  assert.equal(delivery.state(), "plan")
  assert.deepEqual(delivery.heartbeatState(), {
    native_state: "unknown", stopped: false, plan_mode: true,
  })
  const result = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.equal(steers.length, 0)
  return result.then(value => assert.deepEqual(value, { outcome: "deferred", reason: "plan" }))
})

test("a pending Plan Mode selection also refuses delivery", () => {
  const { delivery } = setup({}, { plan: { active: false, pending: true } })
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  assert.equal(delivery.state(), "plan")
})

test("an unreadable plan projection latches stopped and reports unknown", () => {
  const { delivery } = setup({}, { planUnreadable: true })
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  assert.equal(delivery.state(), "unknown")
  assert.deepEqual(delivery.heartbeatState(), {
    native_state: "unknown", stopped: true, plan_mode: false,
  })
  assert.equal(delivery.state(), "stopped")
})

test("an idle empty agent is eligible", () => {
  const { delivery } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  assert.equal(delivery.state(), null)
})

test("a parked inbox item or a running turn reports busy", () => {
  const { delivery, agent } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  agent.inbox.nextStep.push({ id: "parked" })
  assert.equal(delivery.state(), "busy")
  agent.inbox.nextStep.length = 0
  agent.status = "running"
  assert.equal(delivery.state(), "busy")
})

test("a real claim event is the only source of handed", async () => {
  const { delivery, steers } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.equal(steers.length, 1)
  assert.equal(steers[0].role, "user")
  assert.deepEqual(steers[0].source, { kind: "plugin:agent-chat" })
  assert.match(steers[0].content[0].text, /^Agent Chat message\(s\) delivered by the native adapter\.\n/)
  delivery.onClaimed({ id: steers[0].id })
  assert.deepEqual(await result, { outcome: "handed", reason: null })
})

test("a claim that fires inside steer still resolves handed", async () => {
  const hook = {}
  const fake = fakeAgent({ beforeSteer: message => hook.beforeSteer?.(message) })
  const ctx = fakeCtx(fake.agent)
  const delivery = createDelivery(ctx, fake.agent, options)
  hook.beforeSteer = message => delivery.onClaimed({ id: message.id })
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = await delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(result, { outcome: "handed", reason: null })
  assert.equal(fake.removed.length, 0)
})

test("a steer throw retracts the item and defers", async () => {
  const fake = setup({ throwSteer: true })
  fake.delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = await fake.delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(result, { outcome: "deferred", reason: "busy" })
  assert.equal(fake.removed.length, 1)
})

test("a steer throw with a failed removal is uncertain, never replayed", async () => {
  const fake = setup({ throwSteer: true, removeResult: false })
  fake.delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = await fake.delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("a steer that leaves the agent idle is a maintenance park, retracted", async () => {
  const fake = setup({ runningAfterSteer: false })
  fake.delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = await fake.delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(result, { outcome: "deferred", reason: "busy" })
  assert.equal(fake.removed.length, 1)
})

test("an unclaimed steer is retracted when the handoff timer expires", async () => {
  let timer = null
  const fake = fakeAgent()
  const ctx = fakeCtx(fake.agent)
  const delivery = createDelivery(ctx, fake.agent, {
    now: () => 1000, setTimeoutImpl: fn => { timer = fn; return 1 }, clearTimeoutImpl: () => {},
  })
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.equal(typeof timer, "function")
  timer()
  assert.deepEqual(await result, { outcome: "deferred", reason: "busy" })
  assert.equal(fake.removed.length, 1)
})

test("a discard of our own steered id defers as stopped", async () => {
  const { delivery, steers } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  delivery.onDiscarded({ id: steers[0].id })
  assert.deepEqual(await result, { outcome: "deferred", reason: "stopped" })
})

test("a mute or an unknown mute defers without steering", async () => {
  const { delivery, steers } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const muted = await delivery.sendChat(delivery.capture(), { content: "notice", attemptId: ATTEMPT, deadline: DEADLINE, muted: true })
  assert.deepEqual(muted, { outcome: "deferred", reason: "muted" })
  const unknown = await delivery.sendChat(delivery.capture(), { content: "notice", attemptId: ATTEMPT, deadline: DEADLINE })
  assert.deepEqual(unknown, { outcome: "deferred", reason: "unknown" })
  assert.equal(steers.length, 0)
})

test("an expired reservation is uncertain and never steers", async () => {
  const { delivery, steers } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = await delivery.deliver({ content: "notice", attemptId: ATTEMPT }, 1000)
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(steers.length, 0)
})

test("an attempt id is never replayed", async () => {
  const fake = setup()
  const { delivery, steers } = fake
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const first = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  delivery.onClaimed({ id: steers[0].id })
  assert.deepEqual(await first, { outcome: "handed", reason: null })
  fake.agent.status = "idle"
  const replay = await delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(replay, { outcome: "uncertain", reason: "transport_ambiguous" })
  assert.equal(steers.length, 1)
})

test("a throwing removal after a steer throw is uncertain", async () => {
  const fake = setup({ throwSteer: true, removeThrows: true })
  fake.delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const result = await fake.delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(result, { outcome: "uncertain", reason: "transport_ambiguous" })
})

test("content outside the notice budget or a malformed attempt id fails without steering", async () => {
  const { delivery, steers } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const oversized = await delivery.deliver({ content: "x".repeat(9000), attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(oversized, { outcome: "failed", reason: "native_unavailable" })
  const malformed = await delivery.deliver({ content: "notice", attemptId: "not-a-uuid" }, DEADLINE)
  assert.deepEqual(malformed, { outcome: "failed", reason: "native_unavailable" })
  assert.equal(steers.length, 0)
})

test("an operator Stop latches the stop until the next Web prompt", () => {
  const { delivery } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  assert.equal(delivery.state(), null)
  delivery.onTurnEnd({ kind: "aborted", reason: { kind: "user" } })
  assert.equal(delivery.state(), "stopped")
  delivery.onTurnEnd({ kind: "aborted", reason: { kind: "plugin" } })
  assert.equal(delivery.state(), "stopped")
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-2" } })
  assert.equal(delivery.state(), null)
})

test("dispose retracts a pending delivery and refuses further ones", async () => {
  const { delivery, steers, removed } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const pending = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  delivery.dispose()
  assert.deepEqual(await pending, { outcome: "deferred", reason: "stale_binding" })
  assert.equal(removed.length, 1)
  const after = await delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
  assert.deepEqual(after, { outcome: "failed", reason: "native_unavailable" })
  assert.equal(steers.length, 1)
})

test("disable reports offline and refuses delivery", async () => {
  const { delivery } = setup()
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  delivery.disable()
  assert.equal(delivery.state(), "offline")
  assert.deepEqual(delivery.heartbeatState(), {
    native_state: "unknown", stopped: true, plan_mode: false,
  })
  assert.deepEqual(await delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE),
    { outcome: "failed", reason: "native_unavailable" })
})

test("the optional title is normalized and omitted when unusable or absent", () => {
  const withTitle = setup({}, { title: " \u0000synthetic\u202e title " })
  assert.equal(withTitle.delivery.heartbeatState().title, "synthetic title")
  const absent = setup({}, { titleOwner: false })
  assert.equal("title" in absent.delivery.heartbeatState(), false)
  const throwing = setup({}, { titleThrows: true })
  assert.equal("title" in throwing.delivery.heartbeatState(), false)
  const unset = setup({}, { title: undefined })
  assert.equal("title" in unset.delivery.heartbeatState(), false)
  assert.equal(normalizeTitle("a".repeat(200)), "a".repeat(128))
  assert.equal(normalizeTitle("\u202e\u0000"), undefined)
  assert.equal(normalizeTitle(42), undefined)
})

for (const registry of ["rc.1", "rc.2+"]) {
  test(`the delivery needs only get() from the registry (${registry} registry)`, async () => {
    const { delivery, steers, ctx } = setup({}, { registry })
    delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
    assert.equal(delivery.state(), null)
    const result = delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
    delivery.onClaimed({ id: steers[0].id })
    assert.deepEqual(await result, { outcome: "handed", reason: null })
    // Once the registry no longer returns this agent object, the delivery is stale.
    ctx.agents.get = () => undefined
    assert.equal(delivery.state(), "stale_binding")
    const after = await delivery.deliver({ content: "notice", attemptId: ATTEMPT }, DEADLINE)
    assert.deepEqual(after, { outcome: "deferred", reason: "stale_binding" })
    assert.equal(steers.length, 1)
  })
}

// `peek` is the receipts' read: `state`'s classification with no side effect (#130).

test("peek classifies exactly as state does, in every state the delivery has", () => {
  const prompt = { source: { kind: "user", rpcId: "rpc-1" } }
  const cases = [
    ["stopped", {}, {}, delivery => delivery, "stopped"],
    ["idle", {}, {}, delivery => delivery.onInserted(prompt), null],
    ["running", { status: "running" }, {}, delivery => delivery.onInserted(prompt), "busy"],
    ["a parked inbox item", {}, {}, (delivery, fake) => { delivery.onInserted(prompt); fake.agent.inbox.nextStep.push({}) }, "busy"],
    ["Plan Mode", {}, { plan: { active: true, pending: false } }, delivery => delivery.onInserted(prompt), "plan"],
    ["a pending Plan Mode selection", {}, { plan: { active: false, pending: true } }, delivery => delivery.onInserted(prompt), "plan"],
    ["an unreadable plan projection", {}, { planUnreadable: true }, delivery => delivery.onInserted(prompt), "unknown"],
    ["a status that is not a state", { status: "paused" }, {}, delivery => delivery.onInserted(prompt), "unknown"],
    ["offline", {}, {}, delivery => { delivery.onInserted(prompt); delivery.disable() }, "offline"],
    ["a delivery that was disposed", {}, {}, delivery => { delivery.onInserted(prompt); delivery.dispose() }, "stale_binding"],
  ]
  for (const [name, agentOptions, ctxOptions, prepare, expected] of cases) {
    const fake = setup(agentOptions, ctxOptions)
    prepare(fake.delivery, fake)
    assert.equal(fake.delivery.peek(), expected, `${name}: peek`)
    assert.equal(fake.delivery.state(), expected, `${name}: state`)
  }
})

test("peek never latches, warns or fences: a state it cannot read is unknown and nothing else changes", () => {
  const fake = fakeAgent()
  const warnings = []
  const projection = { readable: false }
  const ctx = fakeCtx(fake.agent)
  const read = ctx.get
  ctx.logger = { warn: message => warnings.push(message) }
  ctx.get = name => (name === "sessionProjections" && !projection.readable ? { snapshot() { throw new Error("plan unit unavailable") } } : read(name))
  const delivery = createDelivery(ctx, fake.agent, options)
  delivery.onInserted({ source: { kind: "user", rpcId: "rpc-1" } })
  const token = delivery.capture()
  assert.equal(delivery.peek(), "unknown")
  assert.equal(delivery.peek(), "unknown", "and asked again")
  assert.deepEqual(warnings, [], "no warning")
  projection.readable = true
  assert.equal(delivery.state(token), null, "the token from before is still current, and nothing latched")
  // The delivery's own question latches on the same unreadable state, as it always has.
  projection.readable = false
  assert.equal(delivery.state(), "unknown")
  assert.equal(warnings.length, 1)
  projection.readable = true
  assert.equal(delivery.state(), "stopped", "and only a later Web prompt restores it")
  assert.equal(delivery.state(token), "stale_binding", "the latch fenced the old token")
})
