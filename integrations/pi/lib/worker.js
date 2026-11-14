// The product's stdin/stdout lifecycle worker, driven by a Pi process.
//
// This module owns process lifetime, one in-flight request and frame validation.
// It owns no chat policy: join, heartbeat, pending, claim and settle are the
// product's `agent_chat.instance_worker` requests. Nothing starts on import.
import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"

const MAX_FRAME = 128 * 1024
const REQUEST_MS = 22_000 // the worker's 20s I/O deadline plus exit/IPC margin
const CLOSE_MS = 5000
const OPERATIONS = new Set(["join", "heartbeat", "status", "end", "pending", "claim", "settle"])

const failure = (code, operation) => Object.assign(new Error(code), operation === undefined ? { code } : { code, operation })

// Local and remote codes that may reach a notice. Only fixed values, never raw
// output or a remote label. A code outside this set becomes CHAT_WORKER_REFUSED.
const SAFE_CODES = new Set([
  "UNAUTHENTICATED", "SESSION_FORBIDDEN", "CSRF_FORBIDDEN", "ROOM_FORBIDDEN", "STATE_KEY_FORBIDDEN",
  "BINDING_CONFLICT", "ROOM_CONFLICT", "ROLE_CONFLICT", "STALE_INSTANCE", "IDEMPOTENCY_CONFLICT",
  "NOT_FOUND", "MESSAGE_EXPIRED", "CURSOR_EXPIRED", "INVALID_REQUEST", "INVALID_RESPONSE",
  "INVALID_RECIPIENT", "INVALID_CURSOR", "INVALID_ORIGIN", "DELIVERY_DISABLED", "DELIVERY_BLOCKED",
  "DELIVERY_INELIGIBLE", "DELIVERY_IN_FLIGHT", "DELIVERY_BATCH_CONFLICT", "DELIVERY_CLOSED",
  "DELIVERY_EXHAUSTED", "DELIVERY_BACKOFF", "CONSULTATION_LIMIT", "WAKE_LIMIT", "INSTANCE_LIMIT",
  "REGISTRATION_LIMIT", "PUBLICATION_LIMIT", "BINDING_FILE_UNSAFE", "BINDING_FILE_INVALID",
  "BINDING_FILE_CONFLICT", "REQUEST_UNCERTAIN", "TRANSPORT_UNAVAILABLE", "SERVICE_UNAVAILABLE",
  "REDIRECT_REFUSED", "HTTP_REFUSED",
])

export function describeFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "CHAT_LIFECYCLE_FAILED"
  const workerCode = typeof error?.workerCode === "string" && SAFE_CODES.has(error.workerCode) ? error.workerCode : null
  return [OPERATIONS.has(error?.operation) ? error.operation : null, code, workerCode].filter(Boolean).join(":")
}

// The worker is a Python program in the configured interpreter. The parent
// environment is deliberately empty: a Pi process carries provider and gate
// credentials that do not belong in the worker. The host token travels on
// stdin after imports; -I keeps the working directory off sys.path.
export function startWorker(config, { nativeSessionId, bootId, harness = "pi" }, { spawnImpl = spawn } = {}) {
  if (![config.python, config.directory].every(value => typeof value === "string" && isAbsolute(value)) ||
      typeof nativeSessionId !== "string" || !nativeSessionId ||
      typeof bootId !== "string" || !bootId) {
    throw failure("CHAT_CONFIGURATION_INVALID")
  }
  const child = spawnImpl(config.python, ["-I", "-m", "agent_chat.instance_worker"], {
    cwd: config.directory, env: {}, stdio: ["pipe", "pipe", "ignore"],
  })
  let pending = null
  let buffer = Buffer.alloc(0)
  let sequence = 0
  let stopping = false
  let exited = false
  let termTimer = null
  let killTimer = null
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })

  function rejectPending(code, workerCode) {
    if (!pending) return
    const request = pending
    pending = null
    clearTimeout(request.timer)
    request.reject(Object.assign(failure(code, request.op), workerCode === undefined ? {} : { workerCode }))
  }

  function stop() {
    if (stopping || exited) return closed
    stopping = true
    rejectPending("CHAT_REQUEST_UNCERTAIN")
    try { child.stdin.end() } catch { /* already closed */ }
    termTimer = setTimeout(() => { try { child.kill("SIGTERM") } catch { /* gone */ } }, 3000)
    killTimer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* gone */ } }, CLOSE_MS)
    return closed
  }

  child.stdin.on("error", () => { rejectPending("CHAT_REQUEST_UNCERTAIN"); void stop() })
  child.on("error", () => { rejectPending("CHAT_WORKER_UNAVAILABLE"); void stop() })
  child.on("close", (code, signal) => {
    exited = true
    clearTimeout(termTimer)
    clearTimeout(killTimer)
    rejectPending("CHAT_REQUEST_UNCERTAIN")
    buffer = Buffer.alloc(0)
    resolveClosed({ code, signal })
  })
  child.stdout.on("data", chunk => {
    if (stopping) return
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > MAX_FRAME) { rejectPending("CHAT_PROTOCOL_INVALID"); void stop(); return }
    const newline = buffer.indexOf(10)
    if (newline < 0) return
    // One request in flight. A trailing or unsolicited frame is not a receipt.
    let workerCode
    try {
      if (!pending || newline !== buffer.length - 1) throw failure("CHAT_PROTOCOL_INVALID")
      const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8"))
      buffer = Buffer.alloc(0)
      if (!frame || frame.id !== pending.id) throw failure("CHAT_PROTOCOL_INVALID")
      if (frame.error) {
        if (!frame.result && SAFE_CODES.has(frame.error.code)) workerCode = frame.error.code
        throw failure("CHAT_WORKER_REFUSED")
      }
      if (!frame.result || typeof frame.result !== "object" || Array.isArray(frame.result)) {
        throw failure("CHAT_PROTOCOL_INVALID")
      }
      const request = pending
      pending = null
      clearTimeout(request.timer)
      request.resolve(frame.result)
    } catch (error) {
      const code = error?.code === "CHAT_PROTOCOL_INVALID" || error?.code === "CHAT_WORKER_REFUSED"
        ? error.code : "CHAT_PROTOCOL_INVALID"
      rejectPending(code, code === "CHAT_WORKER_REFUSED" ? workerCode : undefined)
      void stop()
    }
  })

  function request(op, fields = {}) {
    if (stopping || exited) return Promise.reject(failure("CHAT_WORKER_CLOSED", op))
    if (pending) return Promise.reject(failure("CHAT_WORKER_BUSY", op))
    if (!OPERATIONS.has(op)) return Promise.reject(failure("CHAT_REQUEST_INVALID", op))
    let frame
    try { frame = JSON.stringify({ ...fields, op, id: sequence++ }) + "\n" }
    catch { return Promise.reject(failure("CHAT_REQUEST_INVALID", op)) }
    if (Buffer.byteLength(frame) > MAX_FRAME) return Promise.reject(failure("CHAT_REQUEST_INVALID", op))
    return new Promise((resolve, reject) => {
      const id = sequence - 1
      pending = { id, op, resolve, reject, timer: setTimeout(() => {
        rejectPending("CHAT_REQUEST_UNCERTAIN")
        void stop()
      }, REQUEST_MS) }
      child.stdin.write(frame)
    })
  }

  const ready = request("join", {
    enabled: config.enabled !== false,
    directory: config.directory,
    server_origin: config.serverOrigin,
    host_token: config.hostToken,
    native_session_id: nativeSessionId,
    boot_id: bootId,
    harness,
  })
  return { ready, request, stop, closed }
}
