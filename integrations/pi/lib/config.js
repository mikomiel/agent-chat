// The one explicit Agent Chat opt-in for a Pi process. Node builtins only.
//
// A user names a private JSON file in AGENT_CHAT_PI_CONFIG. There is no default
// path and no credential on the command line. Every failure returns null: chat
// stays off, and nothing is logged, so the host token never reaches a log line.
// A delegated child never joins, even when it inherits the variable.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { isAbsolute } from "node:path"

export const PI_CHAT_CONFIG_ENV = "AGENT_CHAT_PI_CONFIG"
const MAX_BYTES = 16 * 1024
const REQUIRED = ["chatEnabled", "directory", "serverOrigin", "hostToken", "python"]
const OPTIONAL = ["noticeBodies", "harness"]

export function loadConfig(env = process.env, name = PI_CHAT_CONFIG_ENV) {
  const raw = env[name]
  if (typeof raw !== "string" || !raw || env.AGENT_CHAT_DELEGATED_CHILD === "1" || !isAbsolute(raw)) return null
  let descriptor
  try {
    descriptor = openSync(raw, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch { return null }
  let data
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.uid !== process.geteuid() || (info.mode & 0o077) !== 0) return null
    const buffer = Buffer.alloc(MAX_BYTES)
    const length = readSync(descriptor, buffer, 0, MAX_BYTES, 0)
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)))
  } catch { return null }
  finally {
    try { closeSync(descriptor) } catch { /* nothing to recover */ }
  }
  if (
    data === null || typeof data !== "object" || Array.isArray(data) ||
    !REQUIRED.every(key => key in data) ||
    !Object.keys(data).every(key => REQUIRED.includes(key) || OPTIONAL.includes(key)) ||
    (OPTIONAL.includes("noticeBodies") && "noticeBodies" in data && typeof data.noticeBodies !== "boolean") ||
    ("harness" in data && data.harness !== "pi") ||
    data.chatEnabled !== true ||
    !REQUIRED.slice(1).every(key => typeof data[key] === "string" && data[key]) ||
    !["python", "directory"].every(key => isAbsolute(data[key]))
  ) return null
  return data
}
