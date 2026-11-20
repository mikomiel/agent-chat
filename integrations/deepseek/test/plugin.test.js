import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyChatEligibility, createAgentChat, isChatEligibleAgent, isSubagentChild } from "../extensions/agent-chat.js"

const config = {
  chatEnabled: true,
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  python: "/usr/bin/python3",
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function configFile() {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-plugin-"))
  const file = join(dir, "chat.json")
  writeFileSync(file, JSON.stringify(config))
  chmodSync(file, 0o600)
  return { dir, file }
}

// The plugin logs to this context, not to the web context. `logs` records each line.
function roots() {
  const injected = []
  const logs = []
  const ctx = {
    logger: {
      info: message => logs.push({ level: "info", message }),
      warn: message => logs.push({ level: "warn", message }),
    },
    inject(deps, callback) { injected.push({ deps, callback }); return {} },
  }
  return { ctx, injected, logs }
}

// The two registry surfaces the plugin supports. `rc.1` is DSH 0.2.2-rc.1, the
// release the package was verified on: roots() and isOwnedBy(). `rc.2+` is
// 0.2.2-rc.2 and later: get() and list() only.
function fakeWebCtx(shape = "rc.1") {
  const handlers = new Map()
  const agents = new Map()
  const webCtx = {
    agents: shape === "rc.1"
      ? {
        roots: () => [...agents.values()],
        get: id => agents.get(id),
        isOwnedBy: () => false,
      }
      : {
        get: id => agents.get(id),
        list: () => [...agents.values()],
      },
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn])
      return () => {
        handlers.set(name, (handlers.get(name) ?? []).filter(entry => entry !== fn))
      }
    },
  }
  const fire = (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) }
  return { webCtx, fire, agents }
}

function parts() {
  const created = []
  const starts = []
  const inputs = []
  const disposed = []
  const stops = []
  const deliveries = []
  const settles = []
  const loadParts = async () => ({
    createDelivery() {
      let stopped = true
      const delivery = {
        state() { return stopped ? "stopped" : null },
        dispose() { disposed.push(true) },
        onInserted(message) {
          const source = message?.source
          if (source?.kind !== "user" || typeof source.rpcId !== "string" || !source.rpcId) return false
          stopped = false
          return true
        },
        onClaimed: () => {},
        onDiscarded: () => {},
        onTurnEnd(reason) {
          if (reason?.kind === "aborted" && reason.reason?.kind === "user") stopped = true
        },
      }
      deliveries.push(delivery)
      return delivery
    },
    createLifecycle(bus, delivery, received, options) {
      const record = { bus, delivery, config: received, options }
      created.push(record)
      bus.on("session_start", event => starts.push(event))
      bus.on("input", event => inputs.push(event))
      bus.on("agent_settled", event => settles.push(event))
      return {
        context: () => "synthetic binding metadata",
        stop() { stops.push(true); return Promise.resolve({ code: 0, signal: null }) },
      }
    },
    startProcess() { throw new Error("this test starts no worker") },
  })
  return { loadParts, created, starts, inputs, disposed, stops, deliveries, settles }
}

function pluginWith(file) {
  return createAgentChat({
    env: { AGENT_CHAT_DEEPSEEK_CONFIG: file },
    loadParts: parts().loadParts,
  })
}

// Runs one scenario against both registry shapes. The unsuffixed title is the
// rc.1 shape, so each name that existed before the rc.2+ double still exists.
function eachShape(title, scenario) {
  test(title, () => scenario("rc.1"))
  test(`${title} (rc.2+ registry)`, () => scenario("rc.2+"))
}

test("a missing config registers nothing", () => {
  const { ctx, injected } = roots()
  createAgentChat({ env: {} })(ctx)
  assert.equal(injected.length, 0)
})

test("a valid config injects the Web services only", () => {
  const { dir, file } = configFile()
  try {
    const { ctx, injected } = roots()
    pluginWith(file)(ctx)
    assert.equal(injected.length, 1)
    assert.deepEqual(injected[0].deps, ["agents", "webServer"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

eachShape("an eligible root agent gets one lifecycle; a subagent child gets none", async shape => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx(shape)
    const disposer = injected[0].callback(webCtx)

    const root = { id: "native-1", session: { id: "native-1", header: {} } }
    agents.set(root.id, root)
    fire("agent/created", { agent: root })
    await flush()
    await flush()
    assert.equal(loaded.created.length, 1)
    assert.deepEqual(loaded.starts[0], { nativeSessionId: "native-1" })

    fire("agent/inbox/inserted", { agent: root, message: { source: { kind: "user", rpcId: "rpc-1" } } })
    assert.deepEqual(loaded.inputs, [{ source: "local" }])

    const child = { id: "native-2", session: { id: "native-2", header: { origin: "subagent" } } }
    agents.set(child.id, child)
    fire("agent/created", { agent: child })
    await flush()
    await flush()
    assert.equal(loaded.created.length, 1)
    assert.equal(isChatEligibleAgent(webCtx, child), false)

    disposer()
    assert.equal(loaded.stops.length, 1)
    assert.equal(loaded.disposed.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

eachShape("disposal proves the worker ended before a replacement joins", async shape => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx(shape)
    injected[0].callback(webCtx)

    const first = { id: "native-1", session: { id: "native-1", header: {} } }
    agents.set(first.id, first)
    fire("agent/created", { agent: first })
    await flush()
    await flush()
    assert.equal(loaded.created.length, 1)

    fire("agent/disposed", { agent: first })
    await flush()
    await flush()
    assert.equal(loaded.stops.length, 1)

    // The same native session under a new agent object: the previous end was
    // proved, so the replacement may join.
    agents.delete(first.id)
    const replacement = { id: "native-1", session: { id: "native-1", header: {} } }
    agents.set(replacement.id, replacement)
    fire("agent/created", { agent: replacement })
    await flush()
    await flush()
    assert.equal(loaded.created.length, 2)
    assert.deepEqual(loaded.starts[1], { nativeSessionId: "native-1" })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the ownership mirror excludes a real subagent child, not a fork root", () => {
  const parent = { id: "parent" }
  const child = { id: "child", session: { header: { parentSession: "parent" } } }
  const fork = { id: "fork", session: { header: { parentSession: "parent" } } }
  const ctx = {
    agents: {
      get: id => (id === "parent" ? parent : undefined),
      isOwnedBy: (id, owner) => id === "child" && owner === parent,
    },
  }
  assert.equal(isSubagentChild(ctx, child), true)
  assert.equal(isSubagentChild(ctx, fork), false)
  assert.equal(isSubagentChild(ctx, { id: "root", session: { header: {} } }), false)
  assert.equal(isSubagentChild(ctx, { id: "sub", session: { header: { origin: "subagent" } } }), true)
})

eachShape("a user prompt during adoption is replayed after the lifecycle starts", async shape => {
  const { dir, file } = configFile()
  try {
    let releaseParts
    const ready = new Promise(resolve => { releaseParts = resolve })
    const loaded = parts()
    const loadParts = async () => { await ready; return loaded.loadParts() }
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts })
    const { ctx, injected } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx(shape)
    injected[0].callback(webCtx)
    const root = { id: "native-1", session: { id: "native-1", header: {} } }
    agents.set(root.id, root)
    fire("agent/created", { agent: root })
    await flush()
    // The lifecycle does not exist yet; the prompt must still be remembered.
    fire("agent/inbox/inserted", { agent: root, message: { source: { kind: "user", rpcId: "rpc-1" } } })
    releaseParts()
    await flush()
    await flush()
    assert.equal(loaded.created.length, 1)
    assert.equal(loaded.inputs.length, 1)
    assert.equal(loaded.deliveries[0].state(), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

eachShape("a buffered prompt followed by a user abort leaves both latches stopped", async shape => {
  const { dir, file } = configFile()
  try {
    let releaseParts
    const ready = new Promise(resolve => { releaseParts = resolve })
    const loaded = parts()
    const loadParts = async () => { await ready; return loaded.loadParts() }
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts })
    const { ctx, injected } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx(shape)
    injected[0].callback(webCtx)
    const root = { id: "native-1", session: { id: "native-1", header: {} } }
    agents.set(root.id, root)
    fire("agent/created", { agent: root })
    await flush()
    fire("agent/inbox/inserted", { agent: root, message: { source: { kind: "user", rpcId: "rpc-1" } } })
    fire("session/event", root.session, { type: "turn/end", data: { reason: { kind: "aborted", reason: { kind: "user" } } } })
    releaseParts()
    await flush()
    await flush()
    assert.equal(loaded.deliveries[0].state(), "stopped")
    assert.equal(loaded.settles.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The eligibility classifier. Each reason is a fixed code that reaches the log.

const agentOf = (id, header) => ({ id, session: { id, header } })

// A bare context for the classifier. The registry holds exactly `live`. On the
// rc.1 shape `rootList` and `isOwnedBy` replace the permissive defaults.
function registryCtx(shape, live, { rootList, isOwnedBy = () => false } = {}) {
  const byId = new Map(live.map(agent => [agent.id, agent]))
  const get = id => byId.get(id)
  return {
    agents: shape === "rc.1"
      ? { get, roots: rootList ?? (() => [...byId.values()]), isOwnedBy }
      : { get, list: () => [...byId.values()] },
  }
}

eachShape("the classifier admits a root and skips a subagent child with a reason", shape => {
  const root = agentOf("root", {})
  const child = agentOf("child", { origin: "subagent" })
  const ctx = registryCtx(shape, [root, child])
  assert.deepEqual(classifyChatEligibility(ctx, root), { eligible: true, reason: null })
  assert.deepEqual(classifyChatEligibility(ctx, child), { eligible: false, reason: "subagent_child" })
  assert.equal(isChatEligibleAgent(ctx, root), true)
  assert.equal(isChatEligibleAgent(ctx, child), false)
})

eachShape("the classifier names a header-less agent and a non-live agent", shape => {
  const bare = [
    { id: "no-session" },
    { id: "no-header", session: {} },
    { id: "null-header", session: { header: null } },
    { id: "string-header", session: { header: "subagent" } },
    { id: "list-header", session: { header: [] } },
  ]
  const bareCtx = registryCtx(shape, bare)
  for (const agent of bare) {
    assert.deepEqual(classifyChatEligibility(bareCtx, agent), { eligible: false, reason: "header_unreadable" }, agent.id)
    assert.equal(isChatEligibleAgent(bareCtx, agent), false, agent.id)
  }
  const ctx = registryCtx(shape, [agentOf("root", {})])
  // Never registered, the same id under another object, and not an agent at all.
  for (const agent of [agentOf("stranger", {}), agentOf("root", {}), undefined, null]) {
    assert.deepEqual(classifyChatEligibility(ctx, agent), { eligible: false, reason: "agent_not_live" })
    assert.equal(isChatEligibleAgent(ctx, agent), false)
  }
})

test("the classifier names a registry without get as unreadable", () => {
  const root = agentOf("root", {})
  const unreadable = [
    undefined,
    {},
    { agents: {} },
    { agents: { get: "not a function", roots: () => [root] } },
    { agents: { roots: () => [root], isOwnedBy: () => false } },
  ]
  for (const ctx of unreadable) {
    assert.deepEqual(classifyChatEligibility(ctx, root), { eligible: false, reason: "registry_unreadable" })
    assert.equal(isChatEligibleAgent(ctx, root), false)
  }
})

eachShape("a registry call that throws is a refusal named eligibility_fault, never a throw", shape => {
  const root = agentOf("root", {})
  const ctx = registryCtx(shape, [root])
  ctx.agents.get = () => { throw new Error("registry fault") }
  assert.deepEqual(classifyChatEligibility(ctx, root), { eligible: false, reason: "eligibility_fault" })
  assert.equal(isChatEligibleAgent(ctx, root), false)
})

test("a fork root with a parentSession and no origin is eligible on the rc.2+ registry", () => {
  const parent = agentOf("parent", {})
  const fork = agentOf("fork", { parentSession: "parent" })
  const orphan = agentOf("orphan", { parentSession: "not-live" })
  const ctx = registryCtx("rc.2+", [parent, fork, orphan])
  assert.deepEqual(classifyChatEligibility(ctx, fork), { eligible: true, reason: null })
  assert.deepEqual(classifyChatEligibility(ctx, orphan), { eligible: true, reason: null })
})

test("a parentSession never makes a fork root a child where the registry has no isOwnedBy", () => {
  const parent = { id: "parent" }
  const fork = agentOf("fork", { parentSession: "parent" })
  // The parent is live, so only the isOwnedBy guard keeps this from throwing.
  const get = id => ({ parent, fork })[id]
  assert.equal(isSubagentChild({ agents: { get } }, fork), false)
  assert.equal(isSubagentChild({ agents: { get } }, agentOf("sub", { origin: "subagent" })), true)
  // A partial rc.1 surface (roots() without isOwnedBy) cannot tell a child from a
  // fork root, so it fails closed for every agent.
  const rootsOnly = { agents: { get, roots: () => [fork] } }
  assert.deepEqual(classifyChatEligibility(rootsOnly, fork), { eligible: false, reason: "registry_unreadable" })
  const ownedOnly = { agents: { get, isOwnedBy: () => false } }
  assert.deepEqual(classifyChatEligibility(ownedOnly, fork), { eligible: false, reason: "registry_unreadable" })
})

test("the rc.1 registry keeps its roots and ownership rules", () => {
  const parent = agentOf("parent", {})
  const fork = agentOf("fork", { parentSession: "parent" })
  const child = agentOf("child", { parentSession: "parent" })
  const listedChild = agentOf("listed-child", { parentSession: "parent" })
  const unlisted = agentOf("unlisted", {})
  const ctx = registryCtx("rc.1", [parent, fork, child, listedChild, unlisted], {
    rootList: () => [parent, fork, listedChild],
    isOwnedBy: (id, owner) => ["child", "listed-child"].includes(id) && owner === parent,
  })
  assert.deepEqual(classifyChatEligibility(ctx, parent), { eligible: true, reason: null })
  assert.deepEqual(classifyChatEligibility(ctx, fork), { eligible: true, reason: null })
  // Owned by its parentSession agent: the expected skip, listed as a root or not.
  assert.deepEqual(classifyChatEligibility(ctx, child), { eligible: false, reason: "subagent_child" })
  assert.deepEqual(classifyChatEligibility(ctx, listedChild), { eligible: false, reason: "subagent_child" })
  assert.deepEqual(classifyChatEligibility(ctx, unlisted), { eligible: false, reason: "not_registry_root" })
})

test("a malformed or throwing roots() is a refusal on the rc.1 registry", () => {
  const root = agentOf("root", {})
  const malformed = registryCtx("rc.1", [root], { rootList: () => undefined })
  assert.deepEqual(classifyChatEligibility(malformed, root), { eligible: false, reason: "registry_unreadable" })
  const throwing = registryCtx("rc.1", [root], { rootList: () => { throw new Error("roots fault") } })
  assert.deepEqual(classifyChatEligibility(throwing, root), { eligible: false, reason: "eligibility_fault" })
})

test("an unreadable registry logs one warning, however many agents are created", async () => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected, logs } = roots()
    plugin(ctx)
    const { webCtx, fire } = fakeWebCtx()
    webCtx.agents = {}
    injected[0].callback(webCtx)
    for (const id of ["secret-id-1", "secret-id-2", "secret-id-3"]) fire("agent/created", { agent: agentOf(id, {}) })
    await flush()
    await flush()
    const warnings = logs.filter(entry => entry.level === "warn")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /chat not joined for one agent \(registry_unreadable\)/)
    assert.equal(loaded.created.length, 0)
    assert.equal(logs.some(entry => entry.message.includes("secret-id")), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("each skip reason is logged once per plugin instance, a subagent child only at info", async () => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected, logs } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx("rc.2+")
    injected[0].callback(webCtx)
    const live = [
      agentOf("child-1", { origin: "subagent" }),
      agentOf("child-2", { origin: "subagent" }),
      { id: "bare-1", session: {} },
      { id: "bare-2", session: {} },
    ]
    for (const agent of live) {
      agents.set(agent.id, agent)
      fire("agent/created", { agent })
    }
    // A ghost is announced but never entered in the registry.
    for (const id of ["ghost-1", "ghost-2"]) fire("agent/created", { agent: agentOf(id, {}) })
    await flush()
    await flush()
    const skips = logs.filter(entry => entry.message.includes("chat not joined"))
    assert.deepEqual(skips.map(entry => [entry.level, /\((\w+)\)/.exec(entry.message)[1]]), [
      ["info", "subagent_child"],
      ["warn", "header_unreadable"],
      ["warn", "agent_not_live"],
    ])
    assert.equal(loaded.created.length, 0)
    assert.equal(logs.some(entry => /child-|bare-|ghost-/.test(entry.message)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a skip reason is not logged again when the plugin registers a second time", async () => {
  const { dir, file } = configFile()
  try {
    const plugin = pluginWith(file)
    const { ctx, injected, logs } = roots()
    plugin(ctx)
    const first = fakeWebCtx()
    first.webCtx.agents = {}
    const stop = injected[0].callback(first.webCtx)
    first.fire("agent/created", { agent: agentOf("first-1", {}) })
    stop()
    // The same process registers again, for example after the Web server service reloads.
    const second = fakeWebCtx()
    second.webCtx.agents = {}
    injected[0].callback(second.webCtx)
    second.fire("agent/created", { agent: agentOf("second-1", {}) })
    await flush()
    assert.equal(logs.filter(entry => entry.level === "warn").length, 1)
    assert.equal(logs.filter(entry => entry.message.includes("registered")).length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a throwing registry never fails agent creation and the log carries only the code", async () => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected, logs } = roots()
    plugin(ctx)
    const { webCtx, fire } = fakeWebCtx()
    webCtx.agents.get = () => { throw new Error("registry fault with detail") }
    injected[0].callback(webCtx)
    for (const id of ["fault-1", "fault-2"]) {
      assert.doesNotThrow(() => fire("agent/created", { agent: agentOf(id, {}) }))
    }
    await flush()
    await flush()
    const warnings = logs.filter(entry => entry.level === "warn")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /chat not joined for one agent \(eligibility_fault\)/)
    assert.equal(loaded.created.length, 0)
    assert.equal(logs.some(entry => /detail|fault-/.test(entry.message)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the registered line names the registry surface the plugin found", () => {
  const { dir, file } = configFile()
  try {
    const cases = [
      ["rc.1 registry", "registry-roots", fakeWebCtx("rc.1").webCtx],
      ["rc.2+ registry", "header-origin", fakeWebCtx("rc.2+").webCtx],
      ["registry without get", "unreadable", Object.assign(fakeWebCtx().webCtx, { agents: {} })],
      ["registry that throws on access", "unreadable",
        Object.defineProperty(fakeWebCtx().webCtx, "agents", { get() { throw new Error("no registry") } })],
    ]
    for (const [label, mode, webCtx] of cases) {
      const { ctx, injected, logs } = roots()
      pluginWith(file)(ctx)
      // Registration must still finish and hand back its disposer.
      assert.equal(typeof injected[0].callback(webCtx), "function", label)
      const line = logs.find(entry => entry.message.includes("registered"))
      assert.equal(line?.level, "info", label)
      assert.equal(line.message, `agent-chat: registered (Web profile, opt-in, eligibility=${mode})`, label)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
