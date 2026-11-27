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

test("a record larger than 16 KiB is refused, even when its first 16 KiB parse", () => {
  // A valid record padded to the read bound, then text that makes the whole file invalid JSON.
  const record = JSON.stringify(base)
  const dir = mkdtempSync(join(tmpdir(), "agent-chat-config-"))
  const file = join(dir, "chat.json")
  try {
    writeFileSync(file, record + " ".repeat(16 * 1024 - Buffer.byteLength(record, "utf8")) + "not json")
    chmodSync(file, 0o600)
    assert.equal(loadConfig({ AGENT_CHAT_PI_CONFIG: file }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

// Issue #163: `planEntries` is one optional key. Every malformed shape keeps chat off, as every other config error does.
const item = { customType: "example-orchestrator", field: "phase", values: ["planning", "planned"] }

test("planEntries is optional and a valid list is returned as written", () => {
  assert.equal(withConfig(base).planEntries, undefined)
  const one = [item]
  assert.deepEqual(withConfig({ ...base, planEntries: one }), { ...base, planEntries: one })
  const many = Array.from({ length: 8 }, (_, index) => ({ customType: `example-${index}`, field: "on", values: [true, "yes"] }))
  assert.deepEqual(withConfig({ ...base, planEntries: many }), { ...base, planEntries: many })
  const edge = [{ customType: "t".repeat(128), field: "f", values: Array.from({ length: 16 }, (_, index) => `v${index}`) }]
  assert.deepEqual(withConfig({ ...base, planEntries: edge }), { ...base, planEntries: edge })
})

test("any malformed planEntries keeps chat off", () => {
  const bad = {
    "not an array": item,
    "a string": "example-orchestrator",
    null: null,
    "an empty array": [],
    "nine items": Array.from({ length: 9 }, () => item),
    "an item that is not an object": ["example-orchestrator"],
    "a null item": [null],
    "an array item": [[item]],
    "a missing customType": [{ field: "phase", values: ["planning"] }],
    "a missing field": [{ customType: "example-orchestrator", values: ["planning"] }],
    "a missing values": [{ customType: "example-orchestrator", field: "phase" }],
    "an extra key": [{ ...item, extra: true }],
    "an empty customType": [{ ...item, customType: "" }],
    "a customType over 128 characters": [{ ...item, customType: "t".repeat(129) }],
    "a customType that is not a string": [{ ...item, customType: 1 }],
    "an empty field": [{ ...item, field: "" }],
    "a field that is not a string": [{ ...item, field: ["phase"] }],
    "empty values": [{ ...item, values: [] }],
    "values that are not an array": [{ ...item, values: "planning" }],
    "seventeen values": [{ ...item, values: Array.from({ length: 17 }, (_, index) => `v${index}`) }],
    "a number value": [{ ...item, values: ["planning", 1] }],
    "a null value": [{ ...item, values: [null] }],
    "an object value": [{ ...item, values: [{}] }],
    "an array value": [{ ...item, values: [["planning"]] }],
    "one bad item among good ones": [item, { ...item, values: [] }],
  }
  for (const [name, planEntries] of Object.entries(bad)) assert.equal(withConfig({ ...base, planEntries }), null, name)
})

test("a valid planEntries does not open the key set", () => {
  assert.equal(withConfig({ ...base, planEntries: [item], planFlag: true }), null)
})
