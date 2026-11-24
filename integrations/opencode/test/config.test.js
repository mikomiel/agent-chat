import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../lib/config.js"

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
  try { return loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: file }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

test("a private complete record is accepted", () => {
  assert.deepEqual(withConfig(base), base)
})

test("the removed noticeBodies flag is an unknown key: the plugin delivers notices without bodies, so it has no such option", () => {
  assert.equal(withConfig({ ...base, noticeBodies: true }), null)
  assert.equal(withConfig({ ...base, noticeBodies: false }), null)
})

test("a group- or world-readable record is refused", () => {
  assert.equal(withConfig(base, 0o640), null)
  assert.equal(withConfig(base, 0o604), null)
  assert.equal(withConfig(base, 0o644), null)
})

test("a record with an unknown key is refused", () => {
  assert.equal(withConfig({ ...base, extra: true }), null)
  // A selector key of another package is not a key of this one.
  assert.equal(withConfig({ ...base, harness: "opencode" }), null)
})

test("a relative interpreter, directory or config path is refused", () => {
  assert.equal(withConfig({ ...base, python: "python3" }), null)
  assert.equal(withConfig({ ...base, directory: "state" }), null)
  const { dir, file } = fixture(base)
  try { assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: file.replace(dir, ".") }), null) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test("chat must be enabled explicitly", () => {
  assert.equal(withConfig({ ...base, chatEnabled: false }), null)
  assert.equal(withConfig({ ...base, chatEnabled: "true" }), null)
})

test("a delegated child and a missing variable stay off", () => {
  const { dir, file } = fixture(base)
  try {
    assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: file, AGENT_CHAT_DELEGATED_CHILD: "1" }), null)
    assert.equal(loadConfig({}), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a symlinked record is refused", () => {
  const { dir, file } = fixture(base)
  const link = join(dir, "link.json")
  try {
    symlinkSync(file, link)
    assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: link }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a directory or malformed record is refused", () => {
  const { dir } = fixture(base)
  try {
    assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: dir }), null)
    const malformed = fixture(undefined, 0o600, "{not json")
    try { assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: malformed.file }), null) }
    finally { rmSync(malformed.dir, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a record larger than 16 KiB is refused before it can be used", () => {
  const oversized = { ...base, serverOrigin: `https://chat.example/${"a".repeat(17 * 1024)}` }
  const { dir, file } = fixture(oversized)
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > 16 * 1024)
    assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: file }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a FIFO is refused without blocking the server", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-config-"))
  const fifo = join(dir, "chat.json")
  try {
    execFileSync("mkfifo", [fifo])
    const started = Date.now()
    assert.equal(loadConfig({ AGENT_CHAT_OPENCODE_CONFIG: fifo }), null)
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
