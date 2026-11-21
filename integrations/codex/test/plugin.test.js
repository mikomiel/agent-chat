import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { ADDITIONAL_CONTEXT_LIMIT, MAX_OUTPUT_BYTES } from "../lib/channel.js"
import { LIMITS_MS } from "../lib/hook.js"

// The plugin surface is pinned here because Codex reads it, not this package: a
// renamed event, a hook line in the wrong form or a timeout that the code outruns
// would break delivery without failing any other test.
const root = fileURLToPath(new URL("..", import.meta.url))
const read = path => JSON.parse(readFileSync(`${root}${path}`, "utf8"))
const manifest = read(".codex-plugin/plugin.json")
const pkg = read("package.json")
const { hooks } = read("hooks/hooks.json")

const entries = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({
  event, hook, command: hook.command.split(" ").at(-1),
}))))
const timeoutMs = (event, command) => entries.find(entry => entry.event === event && entry.command === command).hook.timeout * 1000
const COMMANDS = {
  SessionStart: "session-start", UserPromptSubmit: "prompt", PostToolUse: "tool", Stop: "stop", Interrupt: "interrupt", SessionEnd: "session-end",
}

test("the manifest names the plugin, points at the hooks file and holds nothing else Codex would load", () => {
  assert.equal(manifest.name, "agent-chat")
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.hooks, "./hooks/hooks.json")
  assert.deepEqual(readdirSync(`${root}.codex-plugin`), ["plugin.json"], "components live at the plugin root")
  assert.equal(existsSync(`${root}bin`), false)
})

test("hooks cover exactly the lifecycle events the receiver protocol uses, in order", () => {
  assert.deepEqual(Object.keys(hooks), Object.keys(COMMANDS))
  assert.deepEqual(entries.map(entry => `${entry.event}:${entry.command}`), Object.entries(COMMANDS).map(([event, command]) => `${event}:${command}`))
  assert.deepEqual(entries.map(entry => entry.command).sort(), Object.keys(LIMITS_MS).sort(), "every in-process time limit belongs to one hook")
})

test("every hook line is the exact command string, from the plugin root", () => {
  for (const { event, command, hook } of entries) {
    assert.equal(hook.type, "command", event)
    assert.equal(hook.command, `node "\${PLUGIN_ROOT}/scripts/hook.js" ${command}`, `${event} uses the string form, not the exec form`)
    assert.equal("args" in hook, false, `${event} has no args: the exec form is not used`)
    assert.equal(typeof hook.timeout, "number", `${event} sets a timeout`)
    assert.equal("async" in hook, false, `${event} runs synchronously: a background hook cannot wake a session`)
    assert.equal("asyncRewake" in hook, false, event)
    assert.equal(JSON.stringify(hook).includes("AGENT_CHAT"), false, "a hook line carries no configuration or credential")
  }
  assert.equal(existsSync(`${root}scripts/hook.js`), true)
  assert.equal(existsSync(`${root}scripts/receiver.js`), true)
  for (const group of Object.values(hooks).flat()) assert.equal("matcher" in group, false, "no matcher: every event fires")
})

test("only the events that can carry context set additionalContextLimit, to the byte budget", () => {
  for (const { event, hook } of entries) {
    const carries = ["SessionStart", "UserPromptSubmit", "PostToolUse"].includes(event)
    assert.equal("additionalContextLimit" in hook, carries, event)
    if (carries) assert.equal(hook.additionalContextLimit, ADDITIONAL_CONTEXT_LIMIT, event)
  }
  assert.equal(ADDITIONAL_CONTEXT_LIMIT, MAX_OUTPUT_BYTES, "a token is at least a byte, so bytes bound the tokens")
  assert.ok(ADDITIONAL_CONTEXT_LIMIT > 2_500, "above the 2,500-token default, so the explicit limit is what lets the output through whole")
})

test("SessionEnd and Interrupt stay inside the 3 s Codex allows", () => {
  for (const [event, command] of [["SessionEnd", "session-end"], ["Interrupt", "interrupt"]]) {
    assert.ok(timeoutMs(event, command) <= 3000, event)
    assert.ok(timeoutMs(event, command) >= 1000, event)
  }
})

test("every in-process time limit ends before the hook's own timeout", () => {
  const events = Object.fromEntries(Object.entries(COMMANDS).map(([event, command]) => [command, event]))
  for (const [command, limit] of Object.entries(LIMITS_MS)) assert.ok(limit < timeoutMs(events[command], command), command)
})

test("the package has no runtime dependency and tests with node --test", () => {
  assert.equal(pkg.name, "agent-chat-codex")
  assert.equal(pkg.type, "module")
  assert.equal("dependencies" in pkg, false)
  assert.equal("devDependencies" in pkg, false)
  assert.equal("optionalDependencies" in pkg, false)
  assert.equal(pkg.scripts.test, "node --test")
  assert.match(pkg.engines.node, /^>=\d+/)
})

test("the harness name is spelled in one place, and no other harness name is left in the neutral files", () => {
  for (const file of ["receiver", "ipc", "policy", "worker"]) {
    const text = readFileSync(`${root}lib/${file}.js`, "utf8")
    assert.doesNotMatch(text, /claude/i, `lib/${file}.js`)
    assert.doesNotMatch(text, /["'`]codex["'`]/, `lib/${file}.js reads the harness from lib/config.js`)
  }
})
