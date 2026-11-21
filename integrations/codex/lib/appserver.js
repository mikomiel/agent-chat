// The receiver's view of one Codex thread through the app-server control socket, and the idle wake.
//
// The app-server speaks JSON-RPC over a WebSocket. A control socket is a Unix socket, so this is a minimal RFC 6455
// client over node:net: one HTTP Upgrade, masked client text frames, unfragmented server text frames, ping answered
// with pong. It owns the wire, the thread reads and the add-then-delete fence. It owns no chat policy: the receiver
// decides when to read and what a refusal means, and settles the claim.
//
// Every operation opens its own connection and closes it. A connection that called thread/resume is subscribed to
// the thread's events, so it must not outlive the read. Methods named here are the documented ones: thread/read,
// thread/loaded/list, thread/turns/list, thread/items/list, thread/resume with excludeTurns, and the experimental
// thread/queue/add and thread/queue/delete, which need capabilities.experimentalApi at initialize.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import net from "node:net"
import { basename, dirname, join } from "node:path"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_HEAD = 16 * 1024
const MAX_FRAME = 4 * 1024 * 1024
const REQUEST_MS = 3_000
const CONNECT_MS = 2_000
// The client version is the package's own, read from package.json (the file lives one level above lib/ in a checkout and
// in the release tarball), so release-please moving the package version moves this one too.
const { version: PACKAGE_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const CLIENT = { name: "agent-chat-codex", title: "Agent Chat", version: PACKAGE_VERSION }
// The queue id prefix: the wake's client message id is this plus the attempt id.
export const CLIENT_ID_PREFIX = "agent-chat:"
// A wake is not started with less than this left of its reservation, after the settlement margin is taken off.
export const MIN_ADD_MS = 500
// The end of the reservation is for recording the result. Every request of a wake ends this long before it, so a slow
// fence leaves the receiver time to settle `deferred` or `uncertain` instead of letting the claim expire.
export const SETTLE_MS = 1_000
// The queue probe is the last step of a bind, after the thread read. The receiver's time for the read ends when the bind
// reports it done; the probe then has this long of its own. A probe that does not answer in time leaves the route
// undecided and the bind `unprobed`: it never fails a bind whose read came in on time.
const PROBE_MS = 1_000
const CONFIRM_MS = 250
const CONFIRM_MARGIN_MS = 300
const PAGE = 20

const failure = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra })

function encode(opcode, payload) {
  const length = payload.length
  const head = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | opcode
  if (length < 126) head[1] = 0x80 | length
  else if (length < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(length, 2) }
  else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(length), 2) }
  const mask = randomBytes(4)
  const body = Buffer.from(payload)
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4]
  return Buffer.concat([head, mask, body])
}

// One complete server frame from the front of `buffer`, or null when more bytes are needed.
function decode(buffer) {
  if (buffer.length < 2) return null
  if ((buffer[1] & 0x80) !== 0) throw failure("APP_SERVER_PROTOCOL") // a server never masks
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const wide = buffer.readBigUInt64BE(2)
    if (wide > BigInt(MAX_FRAME)) throw failure("APP_SERVER_PROTOCOL")
    length = Number(wide)
    offset = 10
  }
  if (length > MAX_FRAME) throw failure("APP_SERVER_PROTOCOL")
  if (buffer.length < offset + length) return null
  return { fin: (buffer[0] & 0x80) !== 0, opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + length), size: offset + length }
}

// The control socket is the peer of every read and of the wake, and a WebSocket upgrade proves nothing about who answers it.
// So the path is trusted before each connect, or the connect is refused with CHAT_APPSERVER_UNTRUSTED. The rule:
//   - the socket is a socket (not a symlink) owned by the current user;
//   - its directory is not a symlink, and neither it nor any directory above it (a symlink above it is resolved first)
//     can be changed by anyone else: each is owned by the current user or root, and is not writable by group or other,
//     unless the sticky bit is set, which stops others from removing or renaming what the current user owns.
// The connection goes to the path that was checked, with those links resolved. A socket that is not there is not untrusted:
// that is the closed app-server (`APP_SERVER_CLOSED`), and nothing is connected to.
const untrusted = () => failure("CHAT_APPSERVER_UNTRUSTED")
const guarded = (info, uid) => info.isDirectory() && (info.uid === uid || info.uid === 0) && ((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0)

export function trustedSocket(path, { lstat = lstatSync, realpath = realpathSync, uid = process.geteuid() } = {}) {
  try {
    const parent = dirname(path)
    if (lstat(parent).isSymbolicLink()) throw untrusted()
    const real = realpath(parent)
    for (let directory = real; ; directory = dirname(directory)) {
      if (!guarded(lstat(directory), uid)) throw untrusted()
      if (dirname(directory) === directory) break
    }
    const target = join(real, basename(path))
    const info = lstat(target)
    if (!info.isSocket() || info.uid !== uid) throw untrusted()
    return target
  } catch (error) {
    if (error?.code === "CHAT_APPSERVER_UNTRUSTED") throw error
    throw error?.code === "ENOENT" || error?.code === "ENOTDIR" ? failure("APP_SERVER_CLOSED") : untrusted()
  }
}

// A connected, upgraded and initialized app-server connection. `request` resolves with the JSON-RPC result and
// rejects with { code: "APP_SERVER_ERROR", rpc } for an error reply, or a fixed local code.
export function openAppServer(path, { createConnection = net.createConnection, connectMs = CONNECT_MS, trust = trustedSocket } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try { target = trust(path) } catch (error) { return reject(error) }
    const socket = createConnection(target)
    const key = randomBytes(16).toString("base64")
    const accept = createHash("sha1").update(key + GUID).digest("base64")
    const calls = new Map()
    let buffer = Buffer.alloc(0)
    let upgraded = false
    let closed = false
    let sequence = 0
    let settled = false

    const fail = code => {
      if (!settled) { settled = true; clearTimeout(timer); reject(failure(code)) }
      closed = true
      for (const call of calls.values()) { clearTimeout(call.timer); call.reject(failure(code)) }
      calls.clear()
      socket.destroy()
    }
    const timer = setTimeout(() => fail("APP_SERVER_TIMEOUT"), connectMs)
    const write = (opcode, payload) => new Promise(done => {
      if (closed || socket.destroyed) return done(false)
      try { socket.write(encode(opcode, payload), error => done(!error)) } catch { done(false) }
    })

    function request(method, params, ms = REQUEST_MS) {
      if (closed) return Promise.reject(failure("APP_SERVER_CLOSED", { sent: false }))
      const id = sequence++
      return new Promise((resolveCall, rejectCall) => {
        const call = { resolve: resolveCall, reject: rejectCall, timer: setTimeout(() => {
          calls.delete(id)
          rejectCall(failure("APP_SERVER_TIMEOUT", { sent: true }))
        }, Math.max(1, ms)) }
        calls.set(id, call)
        // `sent` is false only when the frame never left: the caller can then treat the call as not made.
        write(0x1, Buffer.from(JSON.stringify({ method, id, params }))).then(ok => {
          if (ok || !calls.has(id)) return
          calls.delete(id)
          clearTimeout(call.timer)
          rejectCall(failure("APP_SERVER_CLOSED", { sent: false }))
        })
      })
    }

    function dispatch(text) {
      let message
      try { message = JSON.parse(text) } catch { return fail("APP_SERVER_PROTOCOL") }
      if (message === null || typeof message !== "object") return fail("APP_SERVER_PROTOCOL")
      if (typeof message.method === "string") {
        // A request from the server (an approval, say) is not ours to answer; a notification is ignored.
        if ("id" in message) void write(0x1, Buffer.from(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } })))
        return undefined
      }
      const call = calls.get(message.id)
      if (!call) return undefined
      calls.delete(message.id)
      clearTimeout(call.timer)
      if (message.error !== undefined) {
        const rpc = Number.isInteger(message.error?.code) ? message.error.code : null
        call.reject(failure("APP_SERVER_ERROR", { rpc, sent: true }))
      } else if (message.result !== null && typeof message.result === "object" && !Array.isArray(message.result)) call.resolve(message.result)
      else call.reject(failure("APP_SERVER_PROTOCOL", { sent: true }))
      return undefined
    }

    function frames() {
      for (;;) {
        let frame
        try { frame = decode(buffer) } catch (error) { return fail(error.code) }
        if (!frame) return undefined
        buffer = buffer.subarray(frame.size)
        if (frame.opcode === 0x1 && frame.fin) dispatch(frame.payload.toString("utf8"))
        else if (frame.opcode === 0x9 && frame.payload.length <= 125) void write(0xa, frame.payload)
        else if (frame.opcode === 0xa) continue
        else if (frame.opcode === 0x8) return fail("APP_SERVER_CLOSED")
        else return fail("APP_SERVER_PROTOCOL") // fragmented, binary or unknown: refuse
        if (closed) return undefined
      }
    }

    const client = {
      request,
      notify: (method, params) => write(0x1, Buffer.from(JSON.stringify(params === undefined ? { method } : { method, params }))),
      close() {
        if (closed) return
        void write(0x8, Buffer.from([0x03, 0xe8])).then(() => socket.end())
        closed = true
        for (const call of calls.values()) { clearTimeout(call.timer); call.reject(failure("APP_SERVER_CLOSED")) }
        calls.clear()
        setTimeout(() => socket.destroy(), 200).unref()
      },
    }

    socket.on("error", () => fail("APP_SERVER_CLOSED"))
    socket.on("close", () => fail("APP_SERVER_CLOSED"))
    socket.on("data", async chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n")
        if (end < 0) { if (buffer.length > MAX_HEAD) fail("APP_SERVER_PROTOCOL"); return }
        const head = buffer.subarray(0, end).toString("latin1").split("\r\n")
        buffer = buffer.subarray(end + 4)
        const header = name => head.slice(1).find(line => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim()
        if (!/^HTTP\/1\.1 101\b/.test(head[0]) || header("sec-websocket-accept") !== accept) return fail("APP_SERVER_PROTOCOL")
        upgraded = true
        try {
          await request("initialize", { clientInfo: CLIENT, capabilities: { experimentalApi: true } })
          await client.notify("initialized")
        } catch (error) { return fail(error?.code ?? "APP_SERVER_PROTOCOL") }
        if (!settled) { settled = true; clearTimeout(timer); resolve(client) }
      }
      frames()
    })
    socket.once("connect", () => {
      socket.write([
        "GET /rpc HTTP/1.1", "Host: localhost", "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "", "",
      ].join("\r\n"))
    })
  })
}

// "cli" and the other interactive origins pass. A one-shot exec thread and any sub-agent origin do not.
const childSource = source => source === "exec" ||
  (source !== null && typeof source === "object" && ("subAgent" in source || "subagent" in source))

// Whether a thread record is a delegated, ephemeral or non-interactive one.
export const isChildThread = thread =>
  thread.parentThreadId != null || thread.agentRole != null || thread.ephemeral === true || childSource(thread.source)

// Whether a thread record can show that the thread is a main one. Not being a child is not enough: a record without
// its origin (`source`) or its `ephemeral` flag says nothing about either, so it proves nothing.
const isCompleteRecord = thread =>
  typeof thread.ephemeral === "boolean" && (typeof thread.source === "string" || (thread.source !== null && typeof thread.source === "object"))

const STATUS = { idle: "idle", active: "busy", notLoaded: "offline" }

// The thread behind one hook session. `open` is replaceable so tests can run a fake server on a real socket.
export function createThread({ path, threadId, open = openAppServer, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let provider = null
  let queue = null // null: not probed, true: the documented answer came back, false: it did not

  async function withConnection(task, options) {
    const link = await open(path, options)
    try { return await task(link) } finally { link.close() }
  }

  // The time one request may take: the usual limit, or what is left before `deadline` when there is one.
  const allowed = deadline => Math.max(1, Math.min(REQUEST_MS, deadline - now()))

  async function loaded(link, deadline = Infinity) {
    for (let cursor = null, page = 0; page < 10; page += 1) {
      const answer = await link.request("thread/loaded/list", cursor ? { cursor } : {}, allowed(deadline))
      if (!Array.isArray(answer.data)) throw failure("APP_SERVER_PROTOCOL")
      if (answer.data.includes(threadId)) return true
      if (typeof answer.nextCursor !== "string") return false
      cursor = answer.nextCursor
    }
    return false
  }

  async function read(link, deadline = Infinity) {
    const answer = await link.request("thread/read", { threadId }, allowed(deadline))
    const thread = answer.thread
    if (thread === null || typeof thread !== "object" || thread.id !== threadId) throw failure("APP_SERVER_PROTOCOL")
    return thread
  }

  // A thread that was never queued answers the delete with { deleted: false }. Any other answer, an error included,
  // is not the documented one, and the route stays off.
  async function probe(link) {
    try {
      const answer = await link.request("thread/queue/delete", { threadId, queuedSubmissionId: randomUUID() }, PROBE_MS)
      return answer.deleted === false
    } catch (error) {
      if (error?.code === "APP_SERVER_ERROR") return false
      throw error
    }
  }

  // Why a thread record refuses a wake whatever its state: a child, or a provider that is no longer the bound one.
  const refusing = (record, checkProvider = true) => {
    if (isChildThread(record)) return "child"
    return checkProvider && provider !== null && record.modelProvider !== provider ? "stale_binding" : null
  }

  // The thread as the app-server shows it now, for the wake or the heartbeat: loaded, read, its newest turn, and last the
  // `thread/resume` answer, which is a record of its own and the newest of the four. It must show the thread idle, in
  // default mode, and agree with the read; an answer that does not is no basis for a wake. Every request ends by
  // `deadline`. observed: { status, stopped, plan }; `reason` is null only when the thread is clear.
  async function evaluate(link, deadline) {
    const observed = { status: "unknown", stopped: false, plan: null }
    if (!(await loaded(link, deadline))) return { reason: "offline", observed: { ...observed, status: "offline" } }
    const thread = await read(link, deadline)
    const refusal = refusing(thread)
    if (refusal) return { reason: refusal, observed }
    observed.status = STATUS[thread.status?.type] ?? "unknown"
    if (observed.status !== "idle") return { reason: observed.status, observed }
    const turns = await link.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" }, allowed(deadline))
    if (!Array.isArray(turns.data)) throw failure("APP_SERVER_PROTOCOL")
    observed.stopped = turns.data[0]?.status === "interrupted"
    if (observed.stopped) return { reason: "stopped", observed }
    // thread/resume subscribes this connection; the connection closes as soon as the answer is read.
    let resumed = null
    try { resumed = await link.request("thread/resume", { threadId, excludeTurns: true }, allowed(deadline)) } catch (error) { if (error?.code !== "APP_SERVER_ERROR") throw error }
    const record = resumed?.thread
    if (record === null || typeof record !== "object" || record.id !== threadId || typeof record.status?.type !== "string") {
      return { reason: "unknown", observed } // no record of its own: nothing newer than the read, and nothing to check it against
    }
    const newer = refusing(record, typeof record.modelProvider === "string") // the provider is checked when the record carries one
    if (newer) return { reason: newer, observed }
    observed.status = STATUS[record.status.type] ?? "unknown"
    if (observed.status !== "idle") return { reason: observed.status, observed }
    const mode = resumed.collaborationMode?.mode
    observed.plan = mode === "default" ? false : mode === "plan" ? true : null
    return { reason: observed.plan === false ? null : observed.plan === true ? "plan" : "unknown", observed }
  }

  return {
    get provider() { return provider },
    get route() { return queue },

    // Check the thread before the receiver joins: it must be loaded, its record must be complete, it must not be a
    // child, and it fixes the provider. The answer is about this call's reads alone, so a main thread shows only in
    // "bound", "unprobed" and "stale_binding"; nothing recorded by an earlier call counts.
    // status: "bound" | "unprobed" | "child" | "unloaded" | "stale_binding" | "unavailable" | "untrusted"
    //   unprobed - a main thread, but the queue probe did not finish: the route stays undecided and the next bind probes again.
    //   unloaded - not in the loaded list, or listed but read as `notLoaded` (it unloaded between the two requests).
    //
    // `signal` belongs to this one call: once the caller aborts it (its time ran out), the call records nothing, neither
    // the provider nor the route, and its answer is "unavailable". `owns` is the same for a caller that stopped being
    // the owner of the answer (the worker it binds for was retired): asked at every check, it must stay true. What the
    // call learns is held in locals and committed together at the end, after the last check of both, in the same turn.
    // `onRead` is called once the thread read has passed, before the queue probe: the caller's read deadline ends there,
    // and the probe has PROBE_MS. A socket that cannot be trusted (see `trustedSocket`) answers "untrusted".
    async bind({ signal, onRead, owns } = {}) {
      const expired = () => signal?.aborted === true || owns?.() === false
      try {
        return await withConnection(async link => {
          if (!(await loaded(link))) return { status: "unloaded" }
          const thread = await read(link)
          if (expired()) return { status: "unavailable" }
          if (isChildThread(thread)) return { status: "child" }
          if (thread.status?.type === "notLoaded") return { status: "unloaded" }
          if (!isCompleteRecord(thread)) return { status: "unavailable" }
          if (typeof thread.modelProvider !== "string" || !thread.modelProvider) return { status: "unavailable" }
          if (provider !== null && provider !== thread.modelProvider) return { status: "stale_binding" }
          onRead?.()
          let route = queue
          if (route === null) {
            try { route = await probe(link) } catch {
              if (expired()) return { status: "unavailable" }
              provider = thread.modelProvider // a main thread was read; only the probe did not finish
              return { status: "unprobed" }
            }
          }
          if (expired()) return { status: "unavailable" }
          provider = thread.modelProvider
          queue = route
          return { status: "bound", route }
        })
      } catch (error) { return { status: error?.code === "CHAT_APPSERVER_UNTRUSTED" ? "untrusted" : "unavailable" } }
    },

    // What the thread is now, from reads only. `reason` is the delivery refusal a wake would give, or null.
    // observed: { status: "idle"|"busy"|"offline"|"unknown", stopped, plan: true|false|null }
    async observe() {
      try {
        return await withConnection(link => evaluate(link, Infinity))
      } catch { return { reason: "offline", observed: { status: "offline", stopped: false, plan: null } } }
    },

    // Queue `text` as one user turn and fence it. Resolves { outcome, reason } for the settle call.
    //   deleted:true  - it never dispatched: deferred.
    //   deleted:false - it dispatched: handed once a userMessage with its client id shows, else uncertain.
    // A failure before the add frame is written is failed; any failure after it is uncertain. Nothing retries.
    // The wake reads the thread again (`evaluate`: the same four reads as `observe`, the `thread/resume` answer last), and
    // `proceed` is asked once with that reading, right before the add frame is written, with nothing awaited in between:
    // the add goes out in the same turn as the last answer. `thread/resume` subscribes the connection that asks, so the
    // reading is taken on a second connection that is closed first, and the connection for the add, the fence and the
    // confirmation is opened before it and never asks. The queue has no condition of its own (see the README), so what
    // remains is the add's own round trip. `proceed` returns null to go on, or the
    // `deferred` reason that the reading and the receiver's state now give: nothing is sent then. Without one, the
    // reading alone decides. `until` is the end of the reservation, and every request stops SETTLE_MS before it.
    async wake({ text, attemptId, until, proceed = fresh => (fresh.reason === "child" ? "offline" : fresh.reason) }) {
      const clientUserMessageId = `${CLIENT_ID_PREFIX}${attemptId}`
      const UNCERTAIN = { outcome: "uncertain", reason: "transport_ambiguous" }
      const limit = until - SETTLE_MS
      let link
      // The connection, the upgrade and `initialize` end by the limit too: nothing has been sent yet when they fail.
      try { link = await open(path, { connectMs: Math.max(1, Math.min(CONNECT_MS, limit - now())) }) } catch { return { outcome: "failed", reason: "native_unavailable" } }
      try {
        if (limit - now() < MIN_ADD_MS) return { outcome: "failed", reason: "native_unavailable" }
        let fresh
        try {
          fresh = await withConnection(seen => evaluate(seen, limit), { connectMs: Math.max(1, Math.min(CONNECT_MS, limit - now())) })
        } catch { return { outcome: "failed", reason: "native_unavailable" } }
        if (limit - now() < MIN_ADD_MS) return { outcome: "failed", reason: "native_unavailable" }
        const stale = proceed(fresh)
        if (stale !== null) return { outcome: "deferred", reason: stale }
        let added
        try {
          added = await link.request("thread/queue/add", {
            threadId, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }],
          }, limit - now())
        } catch (error) { return error?.sent === false ? { outcome: "failed", reason: "native_unavailable" } : UNCERTAIN }
        const id = added.queuedSubmission?.id
        if (typeof id !== "string" || !id) return UNCERTAIN
        let fence
        try { fence = await link.request("thread/queue/delete", { threadId, queuedSubmissionId: id }, limit - now()) }
        catch { return UNCERTAIN }
        if (fence.deleted === true) return { outcome: "deferred", reason: "busy" }
        if (fence.deleted !== false) return UNCERTAIN
        while (now() < limit - CONFIRM_MARGIN_MS) {
          try {
            const page = await link.request("thread/items/list", { threadId, limit: PAGE, sortDirection: "desc" }, limit - now())
            const seen = Array.isArray(page.data) && page.data.some(entry => entry?.item?.type === "userMessage" && entry.item.clientId === clientUserMessageId)
            if (seen) return { outcome: "handed", reason: null }
          } catch { return UNCERTAIN }
          await sleep(CONFIRM_MS)
        }
        return UNCERTAIN
      } finally { link.close() }
    },
  }
}
