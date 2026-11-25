import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { HOLD_MS, LIMITS_MS, MAX_HOLD_MS } from "../lib/hook.js"

// The plugin surface is pinned here because Claude Code reads it, not this
// package: a renamed event, a dropped `asyncRewake` or a hook timeout that the
// code outruns would break delivery without failing any other test.
const root = fileURLToPath(new URL("..", import.meta.url))
const read = path => JSON.parse(readFileSync(`${root}${path}`, "utf8"))
const manifest = read(".claude-plugin/plugin.json")
const pkg = read("package.json")
const { hooks } = read("hooks/hooks.json")

const entries = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({
  event, hook, command: hook.args.at(-1),
}))))
const timeoutMs = (event, command) => entries.find(entry => entry.event === event && entry.command === command).hook.timeout * 1000

test("the manifest names the plugin and holds nothing else Claude Code would load", () => {
  assert.equal(manifest.name, "agent-chat")
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.equal(manifest.name.split("-").includes("claude"), false, "the name may not contain `claude` as a word")
  assert.equal(manifest.version, pkg.version)
  assert.deepEqual(readdirSync(`${root}.claude-plugin`), ["plugin.json"], "components live at the plugin root")
  assert.equal(existsSync(`${root}bin`), false, "a top-level bin/ lands on the Bash tool PATH")
})

test("hooks cover exactly the lifecycle events the receiver protocol uses", () => {
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"])
  assert.deepEqual(
    entries.map(entry => `${entry.event}:${entry.command}`),
    ["SessionStart:session-start", "UserPromptSubmit:prompt", "PostToolUse:tool", "Stop:stop", "Stop:wait", "SessionEnd:session-end"],
  )
  assert.deepEqual(
    entries.map(entry => entry.command).filter(command => command !== "wait").sort(),
    Object.keys(LIMITS_MS).sort(),
    "every in-process time limit belongs to one hook",
  )
})

test("every hook runs the packaged script in exec form from the plugin root", () => {
  for (const { event, hook } of entries) {
    assert.equal(hook.type, "command", event)
    assert.equal(hook.command, "node", `${event} resolves node on PATH, with no shell`)
    assert.equal(hook.args.length, 2, event)
    assert.equal(hook.args[0], "${CLAUDE_PLUGIN_ROOT}/scripts/hook.js", event)
    assert.equal(typeof hook.timeout, "number", `${event} sets a timeout`)
    assert.equal("shell" in hook, false, event)
    assert.equal(JSON.stringify(hook).includes("AGENT_CHAT"), false, "a hook line carries no configuration or credential")
  }
  assert.equal(existsSync(`${root}scripts/hook.js`), true)
  assert.equal(existsSync(`${root}scripts/receiver.js`), true)
  for (const group of Object.values(hooks).flat()) assert.equal("matcher" in group, false, "no matcher: every event fires")
})

test("only the idle-wake waiter is asynchronous, and it is the one that may wake the session", () => {
  const asynchronous = entries.filter(({ hook }) => "async" in hook || "asyncRewake" in hook)
  assert.deepEqual(asynchronous.map(({ event, command }) => `${event}:${command}`), ["Stop:wait"])
  assert.equal(asynchronous[0].hook.asyncRewake, true)
  assert.equal("async" in asynchronous[0].hook, false)
  assert.equal(entries.filter(({ event }) => event === "Stop").length, 2, "a synchronous stop report and the waiter")
})

test("the waiter holds for less than its timeout, because Claude Code kills it at the timeout", () => {
  const timeout = timeoutMs("Stop", "wait")
  assert.ok(HOLD_MS < timeout)
  assert.ok(timeout - HOLD_MS >= 30_000, "room to flush a notice and to exit before the kill")
})

// Issue #133: `idleWakeHoldSeconds` may raise the hold, never past MAX_HOLD_MS, and the cap keeps a wider margin.
test("the longest hold that the config allows also ends well before the waiter's timeout", () => {
  const timeout = timeoutMs("Stop", "wait")
  assert.ok(HOLD_MS <= MAX_HOLD_MS, "the default hold is inside the cap")
  assert.ok(MAX_HOLD_MS + 600_000 <= timeout, "10 minutes to flush a notice and to exit before Claude Code enforces the timeout")
})

test("every in-process time limit ends before the hook's own timeout", () => {
  const events = { "session-start": "SessionStart", prompt: "UserPromptSubmit", tool: "PostToolUse", stop: "Stop", "session-end": "SessionEnd" }
  for (const [command, limit] of Object.entries(LIMITS_MS)) assert.ok(limit < timeoutMs(events[command], command), command)
  assert.ok(LIMITS_MS["session-end"] <= 1500, "SessionEnd has a 1.5 s budget that a plugin timeout does not raise")
})

test("the package has no runtime dependency and tests with node --test", () => {
  assert.equal(pkg.type, "module")
  assert.equal("dependencies" in pkg, false)
  assert.equal("devDependencies" in pkg, false)
  assert.equal("optionalDependencies" in pkg, false)
  assert.equal(pkg.scripts.test, "node --test")
  assert.match(pkg.engines.node, /^>=\d+/)
})
