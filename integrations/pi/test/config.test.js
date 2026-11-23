import test from "node:test"
import assert from "node:assert/strict"
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

function fixture(value, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-config-"))
  const file = join(dir, "chat.json")
  writeFileSync(file, JSON.stringify(value))
  chmodSync(file, mode)
  return { dir, file }
}

function withConfig(value, mode = 0o600) {
  const { dir, file } = fixture(value, mode)
  try { return loadConfig({ AGENT_CHAT_PI_CONFIG: file }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

test("a private complete record is accepted", () => {
  assert.deepEqual(withConfig(base), base)
})

test("a group- or world-readable record is refused", () => {
  assert.equal(withConfig(base, 0o644), null)
})

test("a record with an unknown key is refused", () => {
  assert.equal(withConfig({ ...base, extra: true }), null)
})

test("a relative interpreter or directory is refused", () => {
  assert.equal(withConfig({ ...base, python: "python3" }), null)
  assert.equal(withConfig({ ...base, directory: "state" }), null)
})

test("chat must be enabled explicitly", () => {
  assert.equal(withConfig({ ...base, chatEnabled: false }), null)
})

test("a delegated child and a missing variable stay off", () => {
  const { dir, file } = fixture(base)
  try {
    assert.equal(loadConfig({ AGENT_CHAT_PI_CONFIG: file, AGENT_CHAT_DELEGATED_CHILD: "1" }), null)
    assert.equal(loadConfig({}), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a symlinked record is refused", () => {
  const { dir, file } = fixture(base)
  const link = join(dir, "link.json")
  try {
    symlinkSync(file, link)
    assert.equal(loadConfig({ AGENT_CHAT_PI_CONFIG: link }), null)
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
