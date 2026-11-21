// Process identity for the owner and lock checks: whether a pid is alive, and when it started. A pid says only which
// process holds the id now; the start time tells that process from an earlier one that held it.
import { readFileSync } from "node:fs"

export function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}

// The start time of a process, in clock ticks since boot: field 22 of /proc/<pid>/stat.
// `comm`, field 2, can hold spaces and parentheses, so the fields are counted from the last ")".
// Null where /proc cannot be read (it does not exist off Linux); the check then goes by pid alone.
export function processStartTime(pid, read = path => readFileSync(path, "utf8")) {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const stat = read(`/proc/${pid}/stat`)
    const field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] // index 0 is field 3, so field 22 is 19
    return /^\d+$/.test(field) ? field : null
  } catch { return null }
}
