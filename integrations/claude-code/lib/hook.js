// Hook commands. Claude Code runs one short-lived process per hook event. Each
// asks the session's receiver (lib/receiver.js) over its private socket and
// prints at most one documented output.
//
// Every refusal is silent and exits 0: a hook must never block a prompt, a tool
// result or a stop. Only the idle-wake waiter exits 2, and only after the
// notice is written, because that is the documented way for an asyncRewake hook
// to wake the model. A delegated agent never joins and never receives a
// delivery: a payload that carries `agent_id` is ignored, and so is a process
// that inherited AGENT_CHAT_DELEGATED_CHILD=1 (the config loader refuses it).
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CLAUDE_CHAT_CONFIG_ENV, loadConfig } from "./config.js"
import { assertPrivateDirectory, connect, connectOrStart, paths } from "./ipc.js"
import { MAX_OUTPUT_BYTES } from "./notice.js"

// hooks/hooks.json sets the matching `timeout` values in seconds. The waiter
// holds for less than its timeout, because Claude Code kills an asyncRewake hook
// at the timeout; test/plugin.test.js pins both relations.
export const HOLD_MS = 3_540_000
export const LIMITS_MS = { "session-start": 13_000, prompt: 9_000, tool: 9_000, stop: 4_000, "session-end": 1_000 }
const PATIENCE_MS = 6_000
const MAX_STDIN = 32 * 1024 * 1024
const ORPHAN_MS = 5_000
const RECEIVER = fileURLToPath(new URL("../scripts/receiver.js", import.meta.url))

// The cap is on characters; a UTF-8 byte count is never smaller, so one bound serves.
const fits = text => text.length <= MAX_OUTPUT_BYTES && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES

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
    if (Object.keys(output).length && !(await io.write("stdout", `${JSON.stringify(output)}\n`))) outcome = "failed"
    if (reply.ack === true) await link.send({ op: "done", outcome })
    return 0
  } finally { link.close() }
}

async function quiet(link, request, waitMs) {
  try { await link.call(request, waitMs) } finally { link.close() }
  return 0
}

// The asyncRewake waiter: it holds the connection open and exits 2 with the
// notice on stderr when the receiver delivers one. Everything else, including
// the hold running out and a vanished parent process, exits 0 without output.
async function waitForWake(link, io) {
  const origin = io.ppid()
  let watch
  try {
    if (!(await link.send({ op: "wait" }))) return 0
    const orphan = new Promise(resolve => {
      watch = setInterval(() => { if (io.ppid() !== origin) resolve(null) }, io.orphanMs ?? ORPHAN_MS)
    })
    const reply = await Promise.race([link.next(io.holdMs ?? HOLD_MS), orphan])
    const context = reply?.context
    if (typeof context !== "string" || !context) return 0
    const ok = fits(context)
    const written = ok && (await io.write("stderr", context))
    await link.send({ op: "done", outcome: !ok ? "refused" : written ? "written" : "failed" })
    return written ? 2 : 0
  } finally {
    clearInterval(watch)
    link.close()
  }
}

async function dispatch(name, { payload, config, where, io }) {
  const mode = typeof payload.permission_mode === "string" ? payload.permission_mode : undefined
  // Only a session start and a prompt start a missing receiver; tool, stop and
  // end events just connect, so a receiver that cannot start costs one refused
  // connect per tool call and nothing more.
  const open = startMs => (startMs
    ? connectOrStart(where, {
      start: () => io.startReceiver(config, payload.session_id), connectImpl: io.connect, startMs,
    })
    : io.connect(where.socket))
  const turn = { op: "turn", permission_mode: mode, patience_ms: PATIENCE_MS }
  switch (name) {
    case "session-start":
      return converse(await open(4_000), "SessionStart", { op: "start", wait_ms: 5_000 }, 8_000, io)
    case "prompt": return converse(await open(2_500), "UserPromptSubmit", turn, 7_500, io)
    case "tool": return converse(await open(0), "PostToolUse", turn, 7_500, io)
    case "stop": return quiet(await open(0), { op: "stop", permission_mode: mode }, 3_500)
    case "wait": return waitForWake(await open(0), io)
    default: return quiet(await open(0), { op: "end" }, 800)
  }
}

export async function runHook(name, io) {
  const limit = LIMITS_MS[name]
  if (limit === undefined && name !== "wait") return 0
  const payload = await readPayload(io.stdin)
  if (!payload || "agent_id" in payload) return 0
  const sessionId = payload.session_id
  if (typeof sessionId !== "string" || !sessionId) return 0
  const config = loadConfig(io.env)
  if (!config) return 0
  try {
    const where = paths(config.directory, sessionId)
    assertPrivateDirectory(config.directory)
    const task = dispatch(name, { payload, config, where, io })
    return limit === undefined ? await task : await Promise.race([task, io.sleep(limit).then(() => 0)])
  } catch { return 0 }
}

export function nodeIo() {
  const raw = process.env[CLAUDE_CHAT_CONFIG_ENV]
  return {
    stdin: process.stdin,
    env: process.env,
    connect,
    ppid: () => process.ppid,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    write: (stream, text) => new Promise(resolve => {
      try { process[stream].write(text, error => resolve(!error)) } catch { resolve(false) }
    }),
    // The receiver must outlive this hook and carry no session credential: it is
    // detached, its stdio is ignored and its whole environment is the config path.
    startReceiver(config, sessionId) {
      const child = spawn(process.execPath, [RECEIVER, sessionId, String(process.ppid)], {
        detached: true, stdio: "ignore", cwd: config.directory, env: { [CLAUDE_CHAT_CONFIG_ENV]: raw },
      })
      child.on("error", () => {})
      child.unref()
    },
  }
}
