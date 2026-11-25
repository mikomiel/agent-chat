import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAUDE_CHAT_CONFIG_ENV, loadConfig } from "../lib/config.js"

const ENV = "AGENT_CHAT_CLAUDE_CONFIG"
const base = {
  chatEnabled: true,
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  python: "/usr/bin/python3",
}

function fixture(value, mode = 0o600, text) {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-config-"))
  const file = join(dir, "chat.json")
  writeFileSync(file, text ?? JSON.stringify(value))
  chmodSync(file, mode)
  return { dir, file }
}

function withConfig(value, mode = 0o600) {
  const { dir, file } = fixture(value, mode)
  try { return loadConfig({ [ENV]: file }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

test("the variable name is the documented one", () => {
  assert.equal(CLAUDE_CHAT_CONFIG_ENV, ENV)
})

test("a private complete record is accepted", () => {
  assert.deepEqual(withConfig(base), base)
})

test("the optional noticeBodies flag is accepted as a boolean only", () => {
  assert.equal(withConfig({ ...base, noticeBodies: true }).noticeBodies, true)
  assert.equal(withConfig({ ...base, noticeBodies: false }).noticeBodies, false)
  assert.equal(withConfig({ ...base, noticeBodies: "yes" }), null)
})

test("a group- or world-readable record is refused", () => {
  assert.equal(withConfig(base, 0o640), null)
  assert.equal(withConfig(base, 0o604), null)
  assert.equal(withConfig(base, 0o644), null)
})

test("a record with an unknown key is refused", () => {
  assert.equal(withConfig({ ...base, extra: true }), null)
  assert.equal(withConfig({ ...base, harness: "claude" }), null)
})

test("a record with a missing key is refused", () => {
  for (const key of Object.keys(base)) {
    const { [key]: _omitted, ...rest } = base
    assert.equal(withConfig(rest), null, key)
  }
})

test("a relative interpreter, directory or config path is refused", () => {
  assert.equal(withConfig({ ...base, python: "python3" }), null)
  assert.equal(withConfig({ ...base, directory: "state" }), null)
  const { dir, file } = fixture(base)
  try { assert.equal(loadConfig({ [ENV]: file.replace(dir, ".") }), null) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test("chat must be enabled explicitly", () => {
  assert.equal(withConfig({ ...base, chatEnabled: false }), null)
  assert.equal(withConfig({ ...base, chatEnabled: "true" }), null)
})

test("a delegated child and a missing variable stay off", () => {
  const { dir, file } = fixture(base)
  try {
    assert.equal(loadConfig({ [ENV]: file, AGENT_CHAT_DELEGATED_CHILD: "1" }), null)
    assert.deepEqual(loadConfig({ [ENV]: file, AGENT_CHAT_DELEGATED_CHILD: "0" }), base)
    assert.equal(loadConfig({}), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a symlinked record is refused", () => {
  const { dir, file } = fixture(base)
  const link = join(dir, "link.json")
  try {
    symlinkSync(file, link)
    assert.equal(loadConfig({ [ENV]: link }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a directory or malformed record is refused", () => {
  const { dir } = fixture(base)
  try {
    assert.equal(loadConfig({ [ENV]: dir }), null)
    const malformed = fixture(undefined, 0o600, "{not json")
    try { assert.equal(loadConfig({ [ENV]: malformed.file }), null) }
    finally { rmSync(malformed.dir, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a record larger than 16 KiB is refused before it can be used", () => {
  const oversized = { ...base, serverOrigin: `https://chat.example/${"a".repeat(17 * 1024)}` }
  const { dir, file } = fixture(oversized)
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > 16 * 1024)
    assert.equal(loadConfig({ [ENV]: file }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a FIFO is refused without blocking the hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-config-"))
  const fifo = join(dir, "chat.json")
  try {
    execFileSync("mkfifo", [fifo])
    const started = Date.now()
    assert.equal(loadConfig({ [ENV]: fifo }), null)
    assert.ok(Date.now() - started < 1000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Issue #131: the tool route is one optional key with a closed enum. Absent means "cli".
test("toolRoute is optional and takes exactly cli, mcp or mcp-with-cli-fallback", () => {
  assert.equal(withConfig(base).toolRoute, undefined)
  for (const toolRoute of ["cli", "mcp", "mcp-with-cli-fallback"]) {
    assert.deepEqual(withConfig({ ...base, toolRoute }), { ...base, toolRoute })
  }
})

test("any other toolRoute keeps chat off and logs nothing", () => {
  const writes = []
  const saved = { error: console.error, warn: console.warn, log: console.log, stderr: process.stderr.write, stdout: process.stdout.write }
  try {
    console.error = console.warn = console.log = (...args) => { writes.push(args) }
    for (const toolRoute of ["MCP", "CLI", "Mcp", "", "http", "mcp-with-fallback", " mcp", null, 1, 0, true, false, ["mcp"], {}]) {
      process.stderr.write = process.stdout.write = chunk => { writes.push(chunk); return true }
      const loaded = withConfig({ ...base, toolRoute })
      process.stderr.write = saved.stderr
      process.stdout.write = saved.stdout
      assert.equal(loaded, null, JSON.stringify(toolRoute))
    }
  } finally {
    Object.assign(console, { error: saved.error, warn: saved.warn, log: saved.log })
    process.stderr.write = saved.stderr
    process.stdout.write = saved.stdout
  }
  assert.deepEqual(writes, [])
})

test("a valid toolRoute does not open the key set: an unknown sibling key still keeps chat off", () => {
  assert.equal(withConfig({ ...base, toolRoute: "mcp", toolRouteFallback: "cli" }), null)
  assert.equal(withConfig({ ...base, toolRoute: "cli", mcpServer: "agent-chat" }), null)
})

// Issue #133: the idle-wake hold is one optional key, a count of whole seconds. The loader sets no upper bound:
// the hook clamps a long hold where it uses it, so a value above the longest hold never keeps chat off.
test("idleWakeHoldSeconds is optional and takes a positive integer", () => {
  assert.equal(withConfig(base).idleWakeHoldSeconds, undefined)
  for (const idleWakeHoldSeconds of [1, 60, 3540, 8385, 8386, 100_000]) {
    assert.deepEqual(withConfig({ ...base, idleWakeHoldSeconds }), { ...base, idleWakeHoldSeconds })
  }
})

test("any other idleWakeHoldSeconds keeps chat off", () => {
  for (const idleWakeHoldSeconds of [0, -1, -3540, 0.5, 1.5, 3540.25, "60", "", " 60", null, true, false, [60], {}]) {
    assert.equal(withConfig({ ...base, idleWakeHoldSeconds }), null, JSON.stringify(idleWakeHoldSeconds))
  }
  // JSON text that a typed value cannot show: numbers that overflow to infinity, and minus zero.
  for (const number of ["1e400", "-1e400", "-0"]) {
    const { dir, file } = fixture(undefined, 0o600, `${JSON.stringify(base).slice(0, -1)},"idleWakeHoldSeconds":${number}}`)
    try { assert.equal(loadConfig({ [ENV]: file }), null, number) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

// The loader validates the parsed number, not the JSON text. JSON.parse turns 1.0000000000000001 into 1 (it is
// beyond double precision), so this literal is the whole number 1 by JSON number semantics. Accepted on purpose.
test("a literal that JSON parses to a whole number is accepted as that number", () => {
  const { dir, file } = fixture(undefined, 0o600, `${JSON.stringify(base).slice(0, -1)},"idleWakeHoldSeconds":1.0000000000000001}`)
  try { assert.equal(loadConfig({ [ENV]: file }).idleWakeHoldSeconds, 1) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a valid idleWakeHoldSeconds does not open the key set: a misspelled sibling still keeps chat off", () => {
  assert.equal(withConfig({ ...base, idleWakeHoldSeconds: 60, idleWakeHoldSecond: 60 }), null)
  assert.equal(withConfig({ ...base, idleWakeHold: 60 }), null)
})
