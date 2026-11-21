// One trust rule for the two local sockets this package talks to: the app-server control socket (lib/appserver.js) and the
// receiver's own socket, which a hook prints the answer of (lib/ipc.js). A socket's peer is whoever owns its path, and a
// WebSocket upgrade or a JSON line proves nothing about who that is. So the path is checked before each connect:
//   - the socket is a socket (not a symlink) owned by the current user;
//   - its directory is not a symlink, however its name ends (`link/` and `link/.` are the link too), and neither it nor any
//     directory above it (a symlink above it is resolved first) can be changed by anyone else: each is owned by the current
//     user or root, and is not writable by group or other, unless the sticky bit is set, which stops others from removing
//     or renaming what the current user owns. The directories are judged from the root down, each only after every one
//     above it has passed, and after the name in the last one is looked at, every directory on the way is looked at again:
//     it must still be the same directory (device and inode), so one swapped between the two looks is refused.
// A caller that passes `follow` accepts that the last name is a symlink, up to that many hops: `codex app-server --listen
// unix://PATH` leaves PATH as a symlink to the socket it binds in its own private directory. Every hop is judged by the same
// rule: the link is owned by the current user and its directory passes the directory rule, and the socket at the end is a
// socket owned by the current user whose directory passes it too. A loop, or a chain longer than `follow`, is refused.
// The caller connects to the checked socket, with the links resolved, and keeps its identity (device and inode) to tell
// later that the path still names the same socket, by calling `trustedSocket` again on the configured path.
//
// A socket path also has a length limit, checked here on the exact pathname that is handed to Node (the resolved one, not the
// one the caller wrote): see MAX_SOCKET_PATH_BYTES.
//
// Node has no portable way to read a peer's credentials, so this is a check of the path, not of the peer: a process of
// the same user, or a root process, that answers on a trusted path is trusted.
//
// A refusal is an error whose code is the caller's `refuse`. A path that is not there (ENOENT, ENOTDIR) is not untrusted:
// that error is rethrown as it came, for the caller to treat as an absent peer.
import { lstatSync, readlinkSync, realpathSync } from "node:fs"
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

// `directory` as the symlink check must be given it. `lstat` looks through a link when the name ends in a separator or in a `.`
// name: `lstat("link/")` and `lstat("link/.")` describe the link's target, so a link would pass as the directory it names.
// Those endings are dropped (the root, "/", stays) and nothing else is rewritten. A `..` is not dropped: after a link it names
// the parent of the link's target, which only the kernel can walk (see `trustedDirectory`). `dirname("link//s.sock")` is
// `link/`, so a socket path with a doubled separator reaches this too.
function unfollowed(directory) {
  const names = directory.split("/")
  while (names.length > 1 && ["", "."].includes(names.at(-1))) names.pop()
  return names.join("/") || (directory.startsWith("/") ? "/" : "")
}

const settings = ({
  refuse = "CHAT_UNTRUSTED", lstat = lstatSync, realpath = realpathSync.native, readlink = readlinkSync, uid = process.geteuid(),
} = {}) => ({ refuse, lstat, realpath, readlink, uid })

// The links in a row that a walk follows: on the way to a directory (each walk has its own count), and, for a caller that
// follows a socket's name, from that name to the socket.
export const MAX_LINK_HOPS = 8

// A name that a link holds: a non-empty string that is valid UTF-8. A name that is not comes back with U+FFFD in it, which can
// spell another name, and is refused.
const heldName = (held, refuse) => {
  if (typeof held !== "string" || !held || held.includes("\uFFFD")) throw refusal(refuse)
  return held
}

// A directory that nobody else can change: it is not a symlink, and every directory on the way to it passes `guarded`. The
// way is walked as the kernel walks it, one name at a time from the root down, and a name is trusted only once the directory
// that holds it has passed: so a link on the way is followed only when nobody else can change the directory it is in, and
// the link is the current user's or root's (a `/tmp` that is root's link to `/private/tmp` passes). Its target goes on the
// same walk: an absolute one from the root, a relative one from the link's directory. A `..` names the parent of the
// directory the walk has reached, so after a link it is the parent of the link's target, as for the kernel (a `..`
// collapsed on the string would name another directory). More than MAX_LINK_HOPS links, a loop included, is refused. The
// walk must reach the directory that realpath(3) gives for the spelling, which names one that is not valid UTF-8 with
// U+FFFD. Every directory judged, those reached through a link included, is kept with its identity (device and inode):
// { spelled, real, chain: [{ path, dev, ino }, ...] }, in the order judged, the root first.
function checkedChain(directory, { refuse, lstat, realpath, readlink, uid }) {
  const spelled = unfollowed(directory)
  if (lstat(spelled).isSymbolicLink()) throw refusal(refuse)
  const judged = new Map()
  const judge = (path, info) => {
    if (!guarded(info, uid)) throw refusal(refuse)
    if (!judged.has(path)) judged.set(path, { path, dev: info.dev, ino: info.ino })
  }
  const names = (spelled.startsWith("/") ? spelled : `${process.cwd()}/${spelled}`).split("/")
  let current = "/"
  judge(current, lstat(current))
  for (let hops = 0; names.length;) {
    const name = names.shift()
    if (name === "" || name === ".") continue
    if (name === "..") { current = dirname(current); continue } // every directory above `current` has been judged
    const next = join(current, name)
    const info = lstat(next)
    if (info.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS || (info.uid !== uid && info.uid !== 0)) throw refusal(refuse)
      const held = heldName(readlink(next), refuse)
      names.unshift(...held.split("/"))
      if (held.startsWith("/")) current = "/"
      continue
    }
    judge(next, info)
    current = next
  }
  if (realpath(spelled) !== current) throw refusal(refuse)
  return { spelled, real: current, chain: [...judged.values()] }
}

// The chain that `checkedChain` judged is still the one the name reaches: the spelling still resolves to the same real path,
// and every directory on it, root first, is still the directory (device and inode) that was judged. A directory swapped
// between the check and a later look is refused.
function unchanged({ spelled, real, chain }, { refuse, lstat, realpath }) {
  if (lstat(spelled).isSymbolicLink() || realpath(spelled) !== real) throw refusal(refuse)
  for (const { path, dev, ino } of chain) {
    const info = lstat(path)
    if (!info.isDirectory() || info.dev !== dev || info.ino !== ino) throw refusal(refuse)
  }
}

// The real path of a directory that nobody else can change (see `checkedChain`).
export function trustedDirectory(directory, options) {
  const rule = settings(options)
  try { return checkedChain(directory, rule).real } catch (error) { throw classify(error, rule.refuse) }
}

// { path, dev, ino }: a regular file whose directory nobody else can change, by the same rule as a socket's directory (see
// `checkedChain`), with its real path and its identity. Its own name is never followed: a symlink there is refused. The caller
// opens the returned path and compares what it opened (fstat) with the identity, so a file swapped between the two is refused.
export function trustedFile(path, options = {}) {
  const rule = settings(options)
  if (typeof path !== "string" || path.endsWith("/")) throw refusal(rule.refuse)
  try {
    const checked = checkedChain(dirname(path), rule)
    const target = join(checked.real, basename(path))
    const info = rule.lstat(target)
    unchanged(checked, rule)
    if (!info.isFile()) throw refusal(rule.refuse)
    return { path: target, dev: info.dev, ino: info.ino }
  } catch (error) { throw classify(error, rule.refuse) }
}

// { path, dev, ino }: the checked real path of the socket and its identity. The real path is the one that is measured against
// MAX_SOCKET_PATH_BYTES: a short spelling that resolves to a long path is refused like a long spelling. With `follow` above 0 the
// last name may be a symlink: it is read, and the name it holds (relative to the link's directory, or absolute) goes through the
// same check, so the returned path is the socket at the end and the identity is that socket's.
export function trustedSocket(path, options = {}) {
  const { follow = 0 } = options
  const rule = settings(options)
  const { refuse, lstat, readlink, uid } = rule
  // A socket is a file: a spelling that ends in a separator names a directory, and lstat of it fails where the connect
  // to the resolved name would not.
  if (typeof path !== "string" || path.endsWith("/")) throw refusal(refuse)
  // The spelling is bounded too, so the configured path that a later check looks at again is one the kernel can look up.
  fittingSocketPath(path, refuse)
  try {
    for (let name = path, hops = 0; ; hops += 1) {
      const checked = checkedChain(dirname(name), rule)
      const { real } = checked
      const target = join(real, basename(name))
      fittingSocketPath(target, refuse)
      const info = lstat(target)
      // What was looked at is in the directory that was judged only while that directory, and every one above it, is still
      // the one that was judged: so the chain is looked at again after the look at the name, for a link as for a socket.
      unchanged(checked, rule)
      if (info.uid !== uid) throw refusal(refuse)
      if (info.isSocket()) return { path: target, dev: info.dev, ino: info.ino }
      if (!info.isSymbolicLink() || hops >= follow) throw refusal(refuse)
      const held = readlink(target)
      // A name that ends in a separator names a directory, and one that is not valid UTF-8 comes back with U+FFFD in it, which
      // can spell another name: both are refused, as they are for a path. A `..` is left for the kernel to walk.
      if (typeof held !== "string" || !held || held.endsWith("/") || held.includes("\uFFFD")) throw refusal(refuse)
      name = held.startsWith("/") ? held : `${real === "/" ? "" : real}/${held}`
    }
  } catch (error) { throw classify(error, refuse) }
}
