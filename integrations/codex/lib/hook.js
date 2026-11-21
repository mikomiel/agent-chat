// Hook commands. Codex runs one short-lived process per hook event. Each asks the
// session's receiver (lib/receiver.js) over its private socket and prints at most
// one documented output.
//
// Every refusal is silent and exits 0: a hook must never block a prompt, a tool
// result or a stop. Stop and Interrupt print nothing at all: Stop expects JSON
// on exit 0 and a decision there would continue the turn. A delegated agent never
// joins and never receives a delivery: a payload that carries `agent_id` is
// ignored, and so is a process that inherited AGENT_CHAT_DELEGATED_CHILD=1 (the
// config loader refuses it).
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MAX_OUTPUT_BYTES } from "./channel.js"
import { CODEX_CHAT_CONFIG_ENV, loadConfig } from "./config.js"
import { assertPrivateDirectory, connect, connectOrStart, paths } from "./ipc.js"

// hooks/hooks.json sets the matching `timeout` values in seconds (SessionEnd and
// Interrupt are limited to 3); test/plugin.test.js pins every relation.
export const LIMITS_MS = {
  "session-start": 13_000, prompt: 9_000, tool: 9_000, stop: 4_000, interrupt: 2_000, "session-end": 2_000,
}
const PATIENCE_MS = 6_000
const MAX_STDIN = 32 * 1024 * 1024
const RECEIVER = fileURLToPath(new URL("../scripts/receiver.js", import.meta.url))
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash"])

// The output cap is on UTF-8 bytes, which is never below the token count Codex limits.
const fits = text => Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES

async function readPayload(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_STDIN) return null
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch { return null }
}

// One request, one reply, and a write receipt when the reply carries context.
async function converse(link, event, request, waitMs, io) {
  try {
    const reply = await link.call(request, waitMs)
    const output = {}
    if (typeof reply.message === "string" && reply.message) output.systemMessage = reply.message.slice(0, 500)
    let outcome = "written"
    if (typeof reply.context === "string" && reply.context) {
      if (fits(reply.context)) output.hookSpecificOutput = { hookEventName: event, additionalContext: reply.context }
      else outcome = "refused"
    }
    if (Object.keys(output).length && !(await io.write(`${JSON.stringify(output)}\n`))) outcome = "failed"
    if (reply.ack === true) await link.send({ op: "done", outcome })
    return 0
  } finally { link.close() }
}

async function quiet(link, request, waitMs) {
  try { await link.call(request, waitMs) } finally { link.close() }
  return 0
}

async function dispatch(name, { payload, config, where, io }) {
  const mode = typeof payload.permission_mode === "string" ? payload.permission_mode : undefined
  // Only a session start and a prompt start a missing receiver; tool, stop,
  // interrupt and end events just connect, so a receiver that cannot start costs
  // one refused connect per tool call and nothing more.
  const open = startMs => (startMs
    ? connectOrStart(where, {
      start: () => io.startReceiver(config, payload.session_id), connectImpl: io.connect, startMs,
    })
    : io.connect(where.socket))
  // A start and a turn name the process that runs this hook's command, Codex. A
  // session resumed in a new process reattaches to the old receiver, which must
  // then watch the new one.
  const owner = io.owner()
  const turn = event => ({ op: "turn", event, permission_mode: mode, patience_ms: PATIENCE_MS, owner_pid: owner })
  switch (name) {
    case "session-start":
      return converse(await open(4_000), "SessionStart", { op: "start", wait_ms: 5_000, owner_pid: owner, permission_mode: mode }, 8_000, io)
    case "prompt": return converse(await open(2_500), "UserPromptSubmit", turn("prompt"), 7_500, io)
    case "tool": return converse(await open(0), "PostToolUse", turn("tool"), 7_500, io)
    case "stop": return quiet(await open(0), { op: "stop", permission_mode: mode }, 3_500)
    case "interrupt": return quiet(await open(0), { op: "interrupt" }, 1_500)
    default: return quiet(await open(0), { op: "end" }, 800)
  }
}

export async function runHook(name, io) {
  const limit = LIMITS_MS[name]
  if (limit === undefined) return 0
  const payload = await readPayload(io.stdin)
  if (!payload || "agent_id" in payload) return 0
  const sessionId = payload.session_id
  if (typeof sessionId !== "string" || !sessionId) return 0
  const loaded = loadConfig(io.env)
  if (!loaded) return 0
  try {
    // The state directory is resolved and checked once. Its canonical path then stands for it everywhere in this hook: the
    // start lock, the socket, and the working directory of a receiver that the hook starts (`config.directory`).
    const config = { ...loaded, directory: assertPrivateDirectory(loaded.directory) }
    const where = paths(config.directory, sessionId)
    return await Promise.race([dispatch(name, { payload, config, where, io }), io.sleep(limit).then(() => 0)])
  } catch { return 0 }
}

// The process that runs Codex. A hook command is a string, so Codex may run it through
// a shell, and then this process's parent is that shell, which exits with the hook.
// Skip up to two shells by reading /proc; where /proc is absent the parent is the answer.
export function ownerOf(pid, read = path => readFileSync(path, "utf8")) {
  let current = pid
  for (let hop = 0; hop < 2; hop += 1) {
    try {
      const stat = read(`/proc/${current}/stat`)
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
      if (!SHELLS.has(name)) return current
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) // field 4: index 0 is field 3
      if (!Number.isInteger(parent) || parent <= 1) return current
      current = parent
    } catch { return current }
  }
  return current
}

export function nodeIo() {
  const raw = process.env[CODEX_CHAT_CONFIG_ENV]
  // A reader that closed the pipe gets EPIPE twice: through the write callback, which
  // reports the write as failed, and then as an 'error' event. Left unhandled, that
  // event ends the hook with a trace before it can send its receipt.
  process.stdout.on("error", () => {})
  return {
    stdin: process.stdin,
    env: process.env,
    connect,
    owner: () => ownerOf(process.ppid),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    write: text => new Promise(resolve => {
      try { process.stdout.write(text, error => resolve(!error)) } catch { resolve(false) }
    }),
    // The receiver must outlive this hook and carry no session credential: it is
    // detached, its stdio is ignored and its whole environment is the config path.
    // The directory this hook resolved goes in its arguments (a path is not a credential):
    // the receiver resolves the config path itself and refuses to run unless it finds this one.
    startReceiver(config, sessionId) {
      const child = spawn(process.execPath, [RECEIVER, sessionId, String(ownerOf(process.ppid)), config.directory], {
        detached: true, stdio: "ignore", cwd: config.directory, env: { [CODEX_CHAT_CONFIG_ENV]: raw },
      })
      child.on("error", () => {})
      child.unref()
    },
  }
}
