import test from "node:test"
import assert from "node:assert/strict"
import { fittingSocketPath, MAX_SOCKET_PATH_BYTES, trustedDirectory, trustedSocket } from "../lib/trust.js"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The one trust rule for the app-server control socket and the receiver's own socket, against a file system that is a table
// of path -> { kind, uid, mode, dev, ino }; a path that is not in it is not there.
const ME = process.geteuid()
const OTHER = ME + 1
function table(entries) {
  const lstat = path => {
    const entry = entries[path]
    if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    return {
      isSocket: () => entry.kind === "socket", isDirectory: () => entry.kind === "dir", isSymbolicLink: () => entry.kind === "link",
      uid: entry.uid, mode: entry.mode, dev: entry.dev ?? 1, ino: entry.ino ?? 1,
    }
  }
  return { lstat, realpath: path => path, uid: ME, refuse: "TEST_UNTRUSTED" }
}
const SOCKET = "/run/user/app/s.sock"
const good = (over = {}) => table({
  "/": { kind: "dir", uid: 0, mode: 0o755 }, "/run": { kind: "dir", uid: 0, mode: 0o755 }, "/run/user": { kind: "dir", uid: 0, mode: 0o755 },
  "/run/user/app": { kind: "dir", uid: ME, mode: 0o700 }, [SOCKET]: { kind: "socket", uid: ME, mode: 0o600, dev: 7, ino: 42 }, ...over,
})
const untrusted = { code: "TEST_UNTRUSTED" }

test("a socket of the current user in a directory only the current user or root can change is trusted, and its identity is returned", () => {
  assert.deepEqual(trustedSocket(SOCKET, good()), { path: SOCKET, dev: 7, ino: 42 })
  assert.equal(trustedSocket(SOCKET, good({ "/run/user/app": { kind: "dir", uid: 0, mode: 0o755 } })).path, SOCKET, "a root-owned directory counts")
})

for (const [label, over] of [
  ["a socket owned by another user", { [SOCKET]: { kind: "socket", uid: OTHER, mode: 0o600 } }],
  ["a path that is a regular file", { [SOCKET]: { kind: "file", uid: ME, mode: 0o600 } }],
  ["a path that is a symlink, even to a socket", { [SOCKET]: { kind: "link", uid: ME, mode: 0o777 } }],
  ["a directory owned by another user", { "/run/user/app": { kind: "dir", uid: OTHER, mode: 0o700 } }],
  ["a directory writable by its group", { "/run/user/app": { kind: "dir", uid: ME, mode: 0o770 } }],
  ["a directory writable by others", { "/run/user/app": { kind: "dir", uid: ME, mode: 0o707 } }],
  ["a directory that is a symlink", { "/run/user/app": { kind: "link", uid: ME, mode: 0o777 } }],
  ["a directory above it that others can write", { "/run/user": { kind: "dir", uid: 0, mode: 0o777 } }],
  ["a directory above it that another user owns", { "/run/user": { kind: "dir", uid: OTHER, mode: 0o755 } }],
  ["a sticky directory owned by another user", { "/run/user/app": { kind: "dir", uid: OTHER, mode: 0o1777 } }],
]) {
  test(`${label} is refused with the caller's code`, () => {
    assert.throws(() => trustedSocket(SOCKET, good(over)), untrusted)
  })
}

test("a sticky directory, which keeps others from removing what the current user owns, is trusted when it is the current user's or root's", () => {
  assert.equal(trustedSocket(SOCKET, good({ "/run/user/app": { kind: "dir", uid: 0, mode: 0o1777 } })).path, SOCKET)
  assert.equal(trustedSocket(SOCKET, good({ "/run/user/app": { kind: "dir", uid: ME, mode: 0o1777 } })).path, SOCKET)
})

test("a socket that is not there is rethrown as absent, not refused, and a directory that cannot be read is refused", () => {
  assert.throws(() => trustedSocket(SOCKET, good({ [SOCKET]: undefined })), { code: "ENOENT" })
  assert.throws(() => trustedSocket(SOCKET, table({})), { code: "ENOENT" })
  const denied = good()
  const lstat = path => { if (path === "/run/user/app") throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return denied.lstat(path) }
  assert.throws(() => trustedSocket(SOCKET, { ...denied, lstat }), untrusted)
})

test("the caller connects to the path that was checked, with the links above the directory resolved", () => {
  const entries = good({ "/real/app": { kind: "dir", uid: ME, mode: 0o700 }, "/real": { kind: "dir", uid: 0, mode: 0o755 }, "/real/app/s.sock": { kind: "socket", uid: ME, mode: 0o600 }, "/link/app": { kind: "dir", uid: ME, mode: 0o700 } })
  const resolving = { ...entries, realpath: path => (path === "/link/app" ? "/real/app" : path) }
  assert.equal(trustedSocket("/link/app/s.sock", resolving).path, "/real/app/s.sock")
})

test("a directory is trusted by the same rule: not a symlink, and no directory from it up to the root that others can change", () => {
  assert.equal(trustedDirectory("/run/user/app", good()), "/run/user/app")
  assert.throws(() => trustedDirectory("/run/user/app", good({ "/run/user": { kind: "dir", uid: 0, mode: 0o775 } })), untrusted, "a group-writable ancestor")
  assert.throws(() => trustedDirectory("/run/user/app", good({ "/run/user": { kind: "dir", uid: 0, mode: 0o777 } })), untrusted, "an ancestor others can write")
  assert.throws(() => trustedDirectory("/run/user/app", good({ "/run/user/app": { kind: "link", uid: ME, mode: 0o777 } })), untrusted, "a symlink")
  assert.equal(trustedDirectory("/run/user/app", good({ "/run": { kind: "dir", uid: 0, mode: 0o1777 } })), "/run/user/app", "a sticky ancestor, as /tmp is")
})

test("a socket path that ends in a separator is refused, never resolved to the socket it would connect to", () => {
  assert.equal(trustedSocket(SOCKET, good()).path, SOCKET)
  assert.throws(() => trustedSocket(`${SOCKET}/`, good()), untrusted)
  assert.throws(() => trustedSocket(`${SOCKET}//`, good()), untrusted)
})

// The length limit is on the exact pathname handed to Node: the real path of the socket, in bytes.
const socketOfBytes = (bytes, name = "s.sock") => { // a directory below the root, then the socket, of exactly `bytes` bytes
  const directory = `/${"d".repeat(bytes - name.length - 2)}`
  return { directory, socket: `${directory}/${name}` }
}
const roomy = (directory, socket) => ({ "/": { kind: "dir", uid: 0, mode: 0o755 }, [directory]: { kind: "dir", uid: ME, mode: 0o700 }, [socket]: { kind: "socket", uid: ME, mode: 0o600 } })

test("a socket path is at most 103 bytes, the longest that fits sun_path on every platform, and a longer one is refused with the caller's code", () => {
  assert.equal(MAX_SOCKET_PATH_BYTES, 103)
  const fits = socketOfBytes(103)
  assert.equal(Buffer.byteLength(fits.socket), 103)
  assert.equal(trustedSocket(fits.socket, table(roomy(fits.directory, fits.socket))).path, fits.socket)
  const long = socketOfBytes(104)
  assert.equal(Buffer.byteLength(long.socket), 104)
  assert.throws(() => trustedSocket(long.socket, table(roomy(long.directory, long.socket))), untrusted)
  assert.throws(() => trustedSocket(long.socket, table({ ...roomy(long.directory, long.socket), [long.socket]: undefined })), untrusted, "refused before the socket is looked up, so a long path is not an absent one")
  assert.equal(fittingSocketPath(fits.socket, "X"), fits.socket)
  assert.throws(() => fittingSocketPath(long.socket, "X"), { code: "X" })
})

test("the limit counts bytes, not characters", () => {
  const fits = `/${"d".repeat(85)}\u00e9\u00e9\u00e9\u00e9\u00e9/s.sock` // 98 characters, 103 bytes
  const over = `/${"d".repeat(86)}\u00e9\u00e9\u00e9\u00e9\u00e9/s.sock` // 99 characters, 104 bytes
  assert.equal(Buffer.byteLength(fits), 103)
  assert.ok(over.length < 103 && Buffer.byteLength(over) === 104)
  const at = path => roomy(path.slice(0, path.lastIndexOf("/")), path)
  assert.equal(trustedSocket(fits, table(at(fits))).path, fits)
  assert.throws(() => trustedSocket(over, table(at(over))), untrusted)
})

test("the limit is measured on the real path: a short spelling that resolves to a long path is refused", () => {
  const long = socketOfBytes(104)
  const entries = { ...roomy(long.directory, long.socket), "/short": { kind: "dir", uid: ME, mode: 0o700 } }
  const resolving = { ...table(entries), realpath: path => (path === "/short" ? long.directory : path) }
  assert.ok(Buffer.byteLength("/short/s.sock") < 103)
  assert.throws(() => trustedSocket("/short/s.sock", resolving), untrusted)
})

// ---- the real file system: a path is resolved the way the kernel walks it -------------------------------------------------

// `link/../state` names the parent of the link's target and then `state`. `fs.realpathSync` collapses the `..` against the
// link's own directory first, so it names another directory: one that the `lstat` of the very same string never looked at.
// The layout holds both directories, so a wrong answer is the wrong directory and not an error. Every directory gets an
// explicit mode, because a umask of 002 would leave the default one group-writable, which the rule refuses.
function walked(stateMode = 0o700) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "act-")))
  const make = (mode, ...names) => {
    const path = join(root, ...names)
    mkdirSync(path, { mode })
    chmodSync(path, mode)
    return path
  }
  const lexical = make(0o700, "state") // what a `..` collapsed on the string names
  make(0o755, "other")
  const inner = make(0o755, "other", "inner")
  const kernel = make(stateMode, "other", "state") // what the kernel reaches: the parent of the link's target, then `state`
  symlinkSync(inner, join(root, "link"))
  return { root, lexical, kernel, named: `${root}/link/../state` } // `join` would collapse the `..`, and the string is the point
}

test("with the real file system: `link/../state` is the directory the kernel reaches through the link, not the one a lexical `..` names", () => {
  const w = walked()
  try {
    assert.equal(trustedDirectory(w.named), w.kernel)
    assert.notEqual(w.kernel, w.lexical)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test("with the real file system: the trust decision is taken on the directory the kernel reaches, so a lexical twin that is private does not vouch for it", () => {
  const w = walked(0o770) // the directory behind the link is writable by its group; the one a lexical `..` names is private
  try {
    assert.throws(() => trustedDirectory(w.named), { code: "CHAT_UNTRUSTED" })
    assert.equal(trustedDirectory(w.lexical), w.lexical, "control: the lexical twin passes by itself")
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

// ---- how the directory is spelled ------------------------------------------------------------------------------------------

// A symlinked directory is refused by `lstat`, and `lstat` looks through a link when the name ends in a separator or in a `.`
// name: `lstat("link/")` and `lstat("link/.")` describe the link's target. So the check is made on the name without those
// endings. A `..` is left alone, as above. `dirname("link//s.sock")` is `link/`, so a socket path with a doubled separator
// reaches the same check. A real socket sits behind the link, so a path that is let through shows as an accepted socket and
// not as an error.
async function behindLink() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "act-")))
  const make = name => {
    const path = join(root, name)
    mkdirSync(path, { mode: 0o700 })
    chmodSync(path, 0o700)
    return path
  }
  const real = make("real")
  const dotted = make("dotted.") // a name that only ends in a dot is a name
  symlinkSync(real, join(root, "link"))
  const server = net.createServer()
  await new Promise(resolve => server.listen(join(real, "s.sock"), resolve))
  return { root, real, dotted, close() { server.close(); rmSync(root, { recursive: true, force: true }) } }
}

test("with the real file system: a symlinked directory is refused however its name ends, and a real one is trusted however its name ends", async () => {
  const w = await behindLink()
  try {
    for (const spelled of ["link", "link/", "link//", "link///", "link/.", "link/./", "link/./."]) {
      assert.throws(() => trustedDirectory(`${w.root}/${spelled}`), { code: "CHAT_UNTRUSTED" }, spelled)
    }
    for (const spelled of ["real", "real/", "real//", "real/.", "real/./"]) {
      assert.equal(trustedDirectory(`${w.root}/${spelled}`), w.real, `${spelled} is the directory itself`)
    }
    assert.equal(trustedDirectory(`${w.root}/dotted.`), w.dotted, "a name that ends in a dot is not a `.` name")
    assert.equal(trustedDirectory(`${w.root}/link/..`), w.root, "a `..` is not dropped: after a link it is the parent of the link's target")
  } finally { w.close() }
})

test("with the real file system: a socket below a symlinked directory is refused however the separator before its name is spelled", async () => {
  const w = await behindLink()
  try {
    for (const spelled of ["link/s.sock", "link//s.sock", "link///s.sock", "link/./s.sock"]) {
      assert.throws(() => trustedSocket(`${w.root}/${spelled}`), { code: "CHAT_UNTRUSTED" }, spelled)
    }
    for (const spelled of ["real/s.sock", "real//s.sock", "real///s.sock", "real/./s.sock"]) {
      assert.equal(trustedSocket(`${w.root}/${spelled}`).path, join(w.real, "s.sock"), `${spelled} is the socket itself`)
    }
  } finally { w.close() }
})

// The names that the table file system is asked about, in order.
function looked(spelled) {
  const names = []
  const fs = good()
  trustedSocket(spelled, { ...fs, lstat: path => { names.push(path); return fs.lstat(path) } })
  return names
}

test("repeated separators change nothing that is checked: `dir//s.sock` and `dir///s.sock` look at the names that `dir/s.sock` does", () => {
  const expected = looked(SOCKET)
  assert.ok(expected.includes("/run/user/app"), "control: the directory is looked at")
  assert.deepEqual(looked("/run/user/app//s.sock"), expected)
  assert.deepEqual(looked("/run/user/app///s.sock"), expected)
  assert.deepEqual(looked("/run/user/app/./s.sock"), expected)
})

test("the root is a directory of its own: `/`, `//`, `///` and `/.` are looked up as `/`, never as an empty name", () => {
  for (const spelled of ["/", "//", "///", "/.", "/./"]) {
    const names = []
    const fs = good()
    assert.equal(trustedDirectory(spelled, { ...fs, lstat: path => { names.push(path); return fs.lstat(path) }, realpath: () => "/" }), "/", spelled)
    assert.equal(names[0], "/", spelled)
  }
})
