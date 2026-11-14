import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentChat, isChatEligibleAgent, isSubagentChild } from "../extensions/agent-chat.js"

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

function roots() {
  const injected = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    inject(deps, callback) { injected.push({ deps, callback }); return {} },
  }
  return { ctx, injected }
}

function fakeWebCtx() {
  const handlers = new Map()
  const agents = new Map()
  const webCtx = {
    agents: {
      roots: () => [...agents.values()],
      get: id => agents.get(id),
      isOwnedBy: () => false,
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
  const loadParts = async () => ({
    createDelivery() {
      return {
        dispose() { disposed.push(true) },
        onInserted: message => message?.source?.kind === "user" && Boolean(message.source.rpcId),
        onClaimed: () => {},
        onDiscarded: () => {},
        onTurnEnd: () => {},
      }
    },
    createLifecycle(bus, delivery, received, options) {
      const record = { bus, delivery, config: received, options }
      created.push(record)
      bus.on("session_start", event => starts.push(event))
      bus.on("input", event => inputs.push(event))
      return {
        context: () => "synthetic binding metadata",
        stop() { stops.push(true); return Promise.resolve({ code: 0, signal: null }) },
      }
    },
    startProcess() { throw new Error("this test starts no worker") },
  })
  return { loadParts, created, starts, inputs, disposed, stops }
}

function pluginWith(file) {
  return createAgentChat({
    env: { AGENT_CHAT_DEEPSEEK_CONFIG: file },
    loadParts: parts().loadParts,
  })
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

test("an eligible root agent gets one lifecycle; a subagent child gets none", async () => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx()
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

test("disposal proves the worker ended before a replacement joins", async () => {
  const { dir, file } = configFile()
  try {
    const loaded = parts()
    const plugin = createAgentChat({ env: { AGENT_CHAT_DEEPSEEK_CONFIG: file }, loadParts: loaded.loadParts })
    const { ctx, injected } = roots()
    plugin(ctx)
    const { webCtx, fire, agents } = fakeWebCtx()
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
