import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appServerPath, CODEX_CHAT_CONFIG_ENV, HARNESS, loadConfig } from "../lib/config.js"

const ENV = "AGENT_CHAT_CODEX_CONFIG"
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

test("the variable name and the harness are the documented ones", () => {
  assert.equal(CODEX_CHAT_CONFIG_ENV, ENV)
  assert.equal(HARNESS, "codex")
})

test("a private complete record is accepted", () => {
  assert.deepEqual(withConfig(base), base)
})

test("the optional noticeBodies flag is accepted as a boolean only", () => {
  assert.equal(withConfig({ ...base, noticeBodies: true }).noticeBodies, true)
  assert.equal(withConfig({ ...base, noticeBodies: false }).noticeBodies, false)
  assert.equal(withConfig({ ...base, noticeBodies: "yes" }), null)
})

test("the optional appServer is a unix:// absolute path and nothing else", () => {
  const socket = "unix:///tmp/agent-chat-app-server.sock"
  assert.equal(withConfig({ ...base, appServer: socket }).appServer, socket)
  for (const bad of ["unix://relative.sock", "unix://", "ws://127.0.0.1:1", "http://127.0.0.1:1", "/tmp/a.sock", "unix:///tmp/a\u0000b", "", 7, null]) {
    assert.equal(withConfig({ ...base, appServer: bad }), null, String(bad))
  }
})

test("appServerPath returns the socket path or null", () => {
  assert.equal(appServerPath("unix:///tmp/a.sock"), "/tmp/a.sock")
  assert.equal(appServerPath("unix://a.sock"), null)
  assert.equal(appServerPath(undefined), null)
})

test("a group- or world-readable record is refused", () => {
  assert.equal(withConfig(base, 0o640), null)
  assert.equal(withConfig(base, 0o604), null)
  assert.equal(withConfig(base, 0o644), null)
})

test("a record with an unknown key is refused", () => {
  assert.equal(withConfig({ ...base, extra: true }), null)
  assert.equal(withConfig({ ...base, harness: "codex" }), null)
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

// The way to the record is checked as the socket directories are (lib/trust.js): every directory on it is owned by the user or
// root, and nobody else can write to it unless it is sticky. Otherwise another user could replace an entry on the way and point
// the lookup at another private record of this user. The record's own name, and its directory's, are not followed; a link
// further up is resolved and the directories it reaches are judged.
function nested(mode = 0o700) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-chat-config-")))
  const dir = join(root, "d")
  mkdirSync(dir)
  chmodSync(dir, mode)
  const file = join(dir, "chat.json")
  writeFileSync(file, JSON.stringify(base))
  chmodSync(file, 0o600)
  return { root, dir, file }
}

test("a record in a private directory below private and sticky ones loads", () => {
  const { root, file } = nested()
  try { assert.deepEqual(loadConfig({ [ENV]: file }), base) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test("a record whose own name holds U+FFFD is refused, though its directory is private; the same record by a valid name loads", () => {
  const { root, dir, file } = nested()
  try {
    const lossy = join(dir, "\uFFFD.json")
    renameSync(file, lossy)
    assert.equal(loadConfig({ [ENV]: lossy }), null)
    renameSync(lossy, file)
    assert.deepEqual(loadConfig({ [ENV]: file }), base, "control: the same record by a valid name loads")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a record below a group- or world-writable directory that is not sticky is refused", () => {
  for (const mode of [0o770, 0o707, 0o777]) {
    const { root, file } = nested(mode)
    try { assert.equal(loadConfig({ [ENV]: file }), null, mode.toString(8)) }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
  const { root, file } = nested(0o1777) // sticky: others cannot rename or remove what the user owns there, as for sockets
  try { assert.deepEqual(loadConfig({ [ENV]: file }), base) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test("a record below a directory that another user owns is refused", () => {
  const { root, dir, file } = nested()
  const other = process.geteuid() + 1
  const lstat = path => { const info = lstatSync(path); return path === dir ? Object.create(info, { uid: { value: other } }) : info }
  try {
    assert.equal(loadConfig({ [ENV]: file }, ENV, { lstat }), null)
    assert.deepEqual(loadConfig({ [ENV]: file }, ENV, { lstat: lstatSync }), base, "control: the same record through the real lstat")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a record whose directory is a symlink is refused; a link further up is resolved and judged", () => {
  const { root, dir, file } = nested()
  try {
    symlinkSync(dir, join(root, "via"))
    assert.equal(loadConfig({ [ENV]: join(root, "via", "chat.json") }), null, "the record's own directory is a link")
    mkdirSync(join(dir, "inner"), { mode: 0o700 })
    chmodSync(join(dir, "inner"), 0o700)
    writeFileSync(join(dir, "inner", "chat.json"), JSON.stringify(base))
    chmodSync(join(dir, "inner", "chat.json"), 0o600)
    assert.deepEqual(loadConfig({ [ENV]: join(root, "via", "inner", "chat.json") }), base, "a link above it is resolved")
    chmodSync(dir, 0o777)
    assert.equal(loadConfig({ [ENV]: join(root, "via", "inner", "chat.json") }), null, "and the directory it reaches is judged")
    assert.equal(loadConfig({ [ENV]: file }), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a record swapped for another private record between the check and the open is refused", () => {
  const { root, dir, file } = nested()
  const decoy = join(dir, "decoy.json")
  writeFileSync(decoy, JSON.stringify({ ...base, hostToken: "decoy-token" }))
  chmodSync(decoy, 0o600)
  let swapped = false
  const lstat = path => {
    const info = lstatSync(path)
    if (path === file && !swapped) { swapped = true; renameSync(decoy, file) } // right after the record was looked at
    return info
  }
  try {
    assert.equal(loadConfig({ [ENV]: file }, ENV, { lstat }), null)
    assert.equal(swapped, true)
    assert.equal(loadConfig({ [ENV]: file }).hostToken, "decoy-token", "control: the swapped-in record itself is a valid one")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a directory swapped between the check of the way and the look at the record is refused", () => {
  const { root, dir, file } = nested()
  let swapped = false
  let looks = 0
  const lstat = path => {
    const info = lstatSync(path)
    // The directory is looked at twice before the record: as a name (is it a link?), then in the walk from the root. The
    // swap comes right after the walk judged it.
    if (path === dir && ++looks === 2) {
      swapped = true
      renameSync(dir, join(root, "old"))
      mkdirSync(dir, { mode: 0o700 })
      writeFileSync(file, JSON.stringify({ ...base, hostToken: "decoy-token" }))
      chmodSync(file, 0o600)
    }
    return info
  }
  try {
    assert.equal(loadConfig({ [ENV]: file }, ENV, { lstat }), null)
    assert.equal(swapped, true)
    assert.equal(loadConfig({ [ENV]: file }).hostToken, "decoy-token", "control: the swapped-in record itself is a valid one")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// An alias on the way to the record (team/profile -> real) is followed only when the directory that holds it is one that nobody
// else can change: in one that its group can write, the alias could be repointed at another private record of the user.
test("a record reached through an alias in a directory that its group can write is refused; in a private one it loads", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-chat-config-")))
  try {
    for (const name of ["team", "real", "real/cfg"]) { mkdirSync(join(root, name)); chmodSync(join(root, name), 0o700) }
    writeFileSync(join(root, "real", "cfg", "chat.json"), JSON.stringify(base))
    chmodSync(join(root, "real", "cfg", "chat.json"), 0o600)
    symlinkSync(join(root, "real"), join(root, "team", "profile"))
    const aliased = join(root, "team", "profile", "cfg", "chat.json")
    assert.deepEqual(loadConfig({ [ENV]: aliased }), base, "the alias in a private directory")
    chmodSync(join(root, "team"), 0o770)
    assert.equal(loadConfig({ [ENV]: aliased }), null, "the same alias in a directory that its group can write")
    assert.deepEqual(loadConfig({ [ENV]: join(root, "real", "cfg", "chat.json") }), base, "control: the record by its own path")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
