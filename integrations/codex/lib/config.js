// The one explicit Agent Chat opt-in for a Codex session. Node builtins only.
//
// A user names a private JSON file in AGENT_CHAT_CODEX_CONFIG. There is no
// default path and no credential on a command line. Every failure returns null:
// chat stays off and nothing is logged, so the host token never reaches a log
// line. A delegated child never joins, even when it inherits the variable.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { isAbsolute } from "node:path"
import { TOOL_ROUTES } from "./notice.js"
import { trustedFile } from "./trust.js"

// The harness this package joins as. The join frame and the socket name prefix both read it, so the code that
// was copied from another package carries no harness name of its own.
export const HARNESS = "codex"
export const CODEX_CHAT_CONFIG_ENV = "AGENT_CHAT_CODEX_CONFIG"
const MAX_BYTES = 16 * 1024
const REQUIRED = ["chatEnabled", "directory", "serverOrigin", "hostToken", "python"]
const OPTIONAL = ["noticeBodies", "appServer", "toolRoute"]

// The app-server control socket named as unix://PATH: an absolute path and no other scheme. Null when it is not.
// This only parses the path. `trustedSocket` in trust.js decides before every connection whether the socket and its
// directories can be trusted (CHAT_APPSERVER_UNTRUSTED), so a path that anyone else could replace is never connected to.
export function appServerPath(value) {
  if (typeof value !== "string" || !value.startsWith("unix://")) return null
  const path = value.slice("unix://".length)
  return path && !path.includes("\0") && isAbsolute(path) ? path : null
}

// `trust` is for tests: the file-system seams of trust.js (lstat, realpath, uid).
export function loadConfig(env = process.env, name = CODEX_CHAT_CONFIG_ENV, trust = {}) {
  const raw = env[name]
  if (typeof raw !== "string" || !raw || env.AGENT_CHAT_DELEGATED_CHILD === "1" || !isAbsolute(raw)) return null
  // The way to the file is checked first, by the rule for the socket directories (trust.js): every directory on it is owned
  // by the user or root and nobody else can change it, so no entry on the way can be replaced to point at another file. The
  // file's own name is not followed. Its refusal (CHAT_CONFIG_UNTRUSTED) is a null like every other failure here.
  let checked
  let descriptor
  try {
    checked = trustedFile(raw, { ...trust, refuse: "CHAT_CONFIG_UNTRUSTED" })
    // O_NONBLOCK keeps a FIFO from blocking the hook before fstat can refuse
    // it; the regular-file check below is still the gate.
    descriptor = openSync(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch { return null }
  let data
  try {
    const info = fstatSync(descriptor)
    // What was opened must be the file that was checked: one swapped in between has another identity.
    if (info.dev !== checked.dev || info.ino !== checked.ino) return null
    if (!info.isFile() || info.uid !== process.geteuid() || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) return null
    const buffer = Buffer.alloc(MAX_BYTES)
    const length = readSync(descriptor, buffer, 0, MAX_BYTES, 0)
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)))
  } catch { return null }
  finally {
    try { closeSync(descriptor) } catch { /* nothing to recover */ }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null
  if (!REQUIRED.every(key => key in data)) return null
  if (!Object.keys(data).every(key => REQUIRED.includes(key) || OPTIONAL.includes(key))) return null
  if (data.chatEnabled !== true) return null
  if ("noticeBodies" in data && typeof data.noticeBodies !== "boolean") return null
  if ("toolRoute" in data && !TOOL_ROUTES.includes(data.toolRoute)) return null
  if ("appServer" in data && appServerPath(data.appServer) === null) return null
  if (!REQUIRED.slice(1).every(key => typeof data[key] === "string" && data[key])) return null
  if (!["python", "directory"].every(key => isAbsolute(data[key]))) return null
  return data
}
