import test from "node:test"
import assert from "node:assert/strict"
import { sameSocket, trustedDirectory, trustedSocket } from "../lib/trust.js"

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

test("the identity of a socket is its device and inode: the same socket is the same, a replacement is not", () => {
  const identity = trustedSocket(SOCKET, good())
  const view = over => ({ lstat: good(over).lstat, uid: ME })
  assert.equal(sameSocket(identity, view()), true)
  assert.equal(sameSocket(identity, view({ [SOCKET]: { kind: "socket", uid: ME, mode: 0o600, dev: 7, ino: 43 } })), false, "another inode")
  assert.equal(sameSocket(identity, view({ [SOCKET]: { kind: "socket", uid: ME, mode: 0o600, dev: 8, ino: 42 } })), false, "another device")
  assert.equal(sameSocket(identity, view({ [SOCKET]: { kind: "socket", uid: OTHER, mode: 0o600, dev: 7, ino: 42 } })), false, "another owner")
  assert.equal(sameSocket(identity, view({ [SOCKET]: { kind: "file", uid: ME, mode: 0o600, dev: 7, ino: 42 } })), false, "no longer a socket")
  assert.equal(sameSocket(identity, view({ [SOCKET]: undefined })), false, "gone")
})
