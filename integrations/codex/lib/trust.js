// One trust rule for the two local sockets this package talks to: the app-server control socket (lib/appserver.js) and the
// receiver's own socket, which a hook prints the answer of (lib/ipc.js). A socket's peer is whoever owns its path, and a
// WebSocket upgrade or a JSON line proves nothing about who that is. So the path is checked before each connect:
//   - the socket is a socket (not a symlink) owned by the current user;
//   - its directory is not a symlink, and neither it nor any directory above it (a symlink above it is resolved first)
//     can be changed by anyone else: each is owned by the current user or root, and is not writable by group or other,
//     unless the sticky bit is set, which stops others from removing or renaming what the current user owns.
// The caller connects to the checked path, with those links resolved, and keeps the socket's identity (device and inode)
// to tell later that the path still names the same socket (`sameSocket`).
//
// A socket path also has a length limit, checked here on the exact pathname that is handed to Node (the resolved one, not the
// one the caller wrote): see MAX_SOCKET_PATH_BYTES.
//
// Node has no portable way to read a peer's credentials, so this is a check of the path, not of the peer: a process of
// the same user, or a root process, that answers on a trusted path is trusted.
//
// A refusal is an error whose code is the caller's `refuse`. A path that is not there (ENOENT, ENOTDIR) is not untrusted:
// that error is rethrown as it came, for the caller to treat as an absent peer.
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

// The longest socket path, in bytes, that this package connects to or listens on. `sun_path` holds 104 bytes on macOS and the
// BSDs (108 on Linux), the terminator included, so 103 bytes is the longest path that fits on every platform that Node
// runs on. A longer path must never reach Node: a release that copies it into `sun_path` cut to fit, instead of refusing
// it, would connect to or bind a socket other than the one that was checked. That was reported for older Node releases and
// was not reproduced on the release this was written on, which refuses with EINVAL; the limit does not depend on it.
export const MAX_SOCKET_PATH_BYTES = 103

const refusal = code => Object.assign(new Error(code), { code })

// `path` itself when it fits, else a refusal with the caller's code. For a pathname that is about to be connected to or
// bound, in whatever form it takes then.
export function fittingSocketPath(path, refuse) {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) throw refusal(refuse)
  return path
}
const guarded = (info, uid) => info.isDirectory() && (info.uid === uid || info.uid === 0) && ((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0)

function classify(error, refuse) {
  if (error?.code === refuse || error?.code === "ENOENT" || error?.code === "ENOTDIR") return error
  return refusal(refuse)
}

// The real path of a directory that nobody else can change: it is not a symlink, and it and every directory above it
// pass `guarded`.
export function trustedDirectory(directory, { refuse = "CHAT_UNTRUSTED", lstat = lstatSync, realpath = realpathSync, uid = process.geteuid() } = {}) {
  try {
    if (lstat(directory).isSymbolicLink()) throw refusal(refuse)
    const real = realpath(directory)
    for (let current = real; ; current = dirname(current)) {
      if (!guarded(lstat(current), uid)) throw refusal(refuse)
      if (dirname(current) === current) break
    }
    return real
  } catch (error) { throw classify(error, refuse) }
}

// { path, dev, ino }: the checked real path of the socket and its identity. The real path is the one that is measured against
// MAX_SOCKET_PATH_BYTES: a short spelling that resolves to a long path is refused like a long spelling.
export function trustedSocket(path, options = {}) {
  const { refuse = "CHAT_UNTRUSTED", lstat = lstatSync, uid = process.geteuid() } = options
  const real = trustedDirectory(dirname(path), options)
  const target = join(real, basename(path))
  try {
    fittingSocketPath(target, refuse)
    const info = lstat(target)
    if (!info.isSocket() || info.uid !== uid) throw refusal(refuse)
    return { path: target, dev: info.dev, ino: info.ino }
  } catch (error) { throw classify(error, refuse) }
}

// Whether the checked path still names the same socket: the same device and inode, still a socket of the current user.
// Synchronous, so a caller can ask it in the turn before it sends.
export function sameSocket(identity, { lstat = lstatSync, uid = process.geteuid() } = {}) {
  try {
    const info = lstat(identity.path)
    return info.isSocket() && info.uid === uid && info.dev === identity.dev && info.ino === identity.ino
  } catch { return false }
}
