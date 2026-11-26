// The receiver's view of one Codex thread through the app-server control socket, and the idle wake.
//
// The app-server speaks JSON-RPC over a WebSocket. A control socket is a Unix socket, so this is a minimal RFC 6455
// client over node:net: one HTTP Upgrade, which the answer must complete (a 101 status line, header lines of the form
// `name: value`, Upgrade: websocket, a Connection header with the Upgrade token, the Accept proof, and no extension or
// subprotocol, none being offered), masked client text frames, and server frames that are whole and unfragmented (text,
// close, ping, pong) without reserved bits (no extension is negotiated), with the shortest form of the length, UTF-8 text
// and control frames of at most 125 bytes; ping is answered with pong. It owns the wire, the thread reads and the wake's
// add-then-delete fence. It owns no chat policy: the receiver decides when to read, when to wake and what a refusal means,
// and settles the claim.
//
// Every operation opens its own connection and closes it. A connection that called thread/resume is subscribed to the
// thread's events, so it must not outlive the read. The wake is the one operation with two: one for the reading, which
// asks thread/resume and is closed first, and one for the add, the fence and the confirmation, which never calls
// thread/resume. Methods named here are thread/loaded/list, thread/read, thread/resume with excludeTurns (for the
// collaboration mode), thread/turns/list and thread/items/list, and the experimental thread/queue/add and
// thread/queue/delete; the thread/* methods are experimental, so `initialize` declares capabilities.experimentalApi. Only
// the wake sends a turn: one queued user turn, and nothing else here changes the thread.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import net from "node:net"
import { performance } from "node:perf_hooks"
import { MAX_LINK_HOPS, trustedSocket } from "./trust.js"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_HEAD = 16 * 1024
// The whole status line of the upgrade answer: HTTP/1.1 and exactly 101, then nothing, or a space and a reason phrase of visible
// ASCII, spaces and tabs. So 1010, 101-x, a tab after the code and a control byte anywhere in the line are not it.
const STATUS_LINE = /^HTTP\/1\.1 101(?: [\t\x20-\x7e]*)?$/
// A header field line: a token for a name (the characters of RFC 9110 section 5.6.2), a colon, optional spaces and tabs, a value,
// optional spaces and tabs. The value holds tabs, visible ASCII, spaces and bytes from 0x80 up (RFC 9110 section 5.5), and no
// control byte: NUL, the rest of C0 (a bare CR or LF included) and DEL are refused. A line with no colon, a name with a space in
// it and a continuation line do not match. Only SP and HTAB are ever trimmed, never what String.trim would take.
const FIELD = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\t\x20-\x7e\x80-\xff]*?)[ \t]*$/
const trimOws = text => text.replace(/^[ \t]+|[ \t]+$/g, "")
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

// The default clock of the receiver and of its thread. A claim's reservation, the deadlines of a wake and the rejoin
// policy's waits are durations, so an adjustable wall clock must not move them: a step back would let a wake start after
// its reservation ran out. What is compared with a file's mtime (lib/ipc.js) stays on `Date.now`. On Linux this clock does
// not count time spent suspended, so the wake also takes the wall clock as a second check before its add (`wallUntil`).
export const monotonic = () => performance.now()

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

// A text frame is UTF-8 (RFC 6455 section 5.6): the decoder throws on a byte sequence that is not, where `toString` would
// turn it into U+FFFD and let a reply that is not text say what it likes. A leading BOM is kept, as it is by `toString`.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// One complete server frame from the front of `buffer`, or null when more bytes are needed. Every rule of RFC 6455 section 5
// that this client relies on is checked here, in one place, and a frame that breaks one throws: the frame is never dispatched.
// What passes is whole and unfragmented, one of text, close, ping and pong, with `text` set for a text frame.
function decode(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  if ((buffer[0] & 0x70) !== 0) throw failure("APP_SERVER_PROTOCOL") // RSV1-3 mean an extension, and none was negotiated
  if ((buffer[0] & 0x80) === 0) throw failure("APP_SERVER_PROTOCOL") // FIN=0 starts a fragmented message, which is not supported
  // Opcode 0 is a continuation, which only follows a frame with FIN=0, so it is refused too; 2 is binary, and nothing here
  // sends or reads binary; the rest are reserved.
  if (opcode !== 0x1 && opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa) throw failure("APP_SERVER_PROTOCOL")
  if ((buffer[1] & 0x80) !== 0) throw failure("APP_SERVER_PROTOCOL") // a server never masks
  // A control frame carries at most 125 bytes, so a 126 or 127 in the length field is refused before the rest of it is waited for.
  if (opcode >= 0x8 && (buffer[1] & 0x7f) > 125) throw failure("APP_SERVER_PROTOCOL")
  let length = buffer[1] & 0x7f
  let offset = 2
  // RFC 6455 wants the shortest form of a length: a longer one is a protocol error, not another spelling of the same frame.
  // A 127-form with its top bit set is far over MAX_FRAME, so the size check below refuses it too.
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    if (length < 126) throw failure("APP_SERVER_PROTOCOL")
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const wide = buffer.readBigUInt64BE(2)
    if (wide > BigInt(MAX_FRAME) || wide < 65536n) throw failure("APP_SERVER_PROTOCOL")
    length = Number(wide)
    offset = 10
  }
  if (length > MAX_FRAME) throw failure("APP_SERVER_PROTOCOL")
  if (buffer.length < offset + length) return null
  const payload = buffer.subarray(offset, offset + length)
  let text = null
  if (opcode === 0x1) {
    try { text = UTF8.decode(payload) } catch { throw failure("APP_SERVER_PROTOCOL") }
  }
  return { opcode, payload, text, size: offset + length }
}

// The control socket is the peer of every read and of the wake, so it passes the trust check of lib/trust.js before each
// connect, or the connect is refused with CHAT_APPSERVER_UNTRUSTED. A socket that is not there is not untrusted: that is the
// closed app-server (`APP_SERVER_CLOSED`), and nothing is connected to. The configured path may be a symlink, as `codex
// app-server --listen unix://PATH` leaves it (to a socket in its own private directory): the check follows it, and the connection
// goes to the socket at the end.
const UNTRUSTED = "CHAT_APPSERVER_UNTRUSTED"
function trusted(path, lstat) {
  try { return trustedSocket(path, { refuse: UNTRUSTED, lstat, follow: MAX_LINK_HOPS }) } catch (error) {
    throw error?.code === "ENOENT" || error?.code === "ENOTDIR" ? failure("APP_SERVER_CLOSED") : error
  }
}

// A connected, upgraded and initialized app-server connection. `request` resolves with the JSON-RPC result and
// rejects with { code: "APP_SERVER_ERROR", rpc } for an error reply, or a fixed local code.
// `identity` is the checked socket the connection was made to: the socket at the end of the followed link (its real path,
// dev and ino). `same()` says whether the configured path still names it: the path is resolved again from its first name
// through the whole trust check, links included, so a link in it that has moved since, a replaced socket and any failure of
// the check all answer false, whatever the real path of the connection still holds. `expect` is the identity of another
// connection that this one must reach too: a socket that has been replaced since is refused as untrusted, before anything
// is connected to. `lstat` replaces the file system that the trust check looks at, for tests. `answerRequests` false leaves every
// request from the server unanswered (see `readMode`).
export function openAppServer(path, { createConnection = net.createConnection, connectMs = CONNECT_MS, lstat = lstatSync, expect = null, answerRequests = true } = {}) {
  return new Promise((resolve, reject) => {
    let identity
    try { identity = trusted(path, lstat) } catch (error) { return reject(error) }
    if (expect && (identity.dev !== expect.dev || identity.ino !== expect.ino)) return reject(failure(UNTRUSTED))
    const socket = createConnection(identity.path)
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
        if ("id" in message && answerRequests) void write(0x1, Buffer.from(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } })))
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
        // `decode` passed only text, close, ping and pong, whole; a pong answers nothing this client sent, so it is dropped.
        if (frame.opcode === 0x1) dispatch(frame.text)
        else if (frame.opcode === 0x9) void write(0xa, frame.payload)
        else if (frame.opcode === 0x8) return fail("APP_SERVER_CLOSED")
        if (closed) return undefined
      }
    }

    const client = {
      identity,
      same() {
        try {
          const seen = trusted(path, lstat)
          return seen.dev === identity.dev && seen.ino === identity.ino
        } catch { return false }
      },
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
        // The limit is on the whole head, terminator included, whether or not the terminator has come yet.
        if ((end < 0 ? buffer.length : end + 4) > MAX_HEAD) return fail("APP_SERVER_PROTOCOL")
        if (end < 0) return
        const head = buffer.subarray(0, end).toString("latin1").split("\r\n")
        buffer = buffer.subarray(end + 4)
        // Every line after the status line must be `name: value` with a token for a name (RFC 9110 sections 5.1 and 5.6.2), or the
        // answer is not an HTTP response this client reads. A header may repeat, so a name has a list of values.
        const fields = head.slice(1).map(line => FIELD.exec(line))
        const values = name => fields.filter(field => field?.[1].toLowerCase() === name).map(field => field[2])
        // RFC 6455 section 4.1: the answer must name the protocol and the connection. Nothing was offered, so an extension or
        // a subprotocol in it is a protocol failure.
        const tokens = values("connection").flatMap(value => value.toLowerCase().split(",").map(trimOws))
        if (!STATUS_LINE.test(head[0]) || fields.includes(null) || values("sec-websocket-accept").join(",") !== accept
          || values("upgrade").join(",").toLowerCase() !== "websocket" || !tokens.includes("upgrade")
          || values("sec-websocket-extensions").length > 0 || values("sec-websocket-protocol").length > 0) return fail("APP_SERVER_PROTOCOL")
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

// An origin shows as a non-empty string ("cli", "vscode") or as an object (a sub-agent's is `{ subAgent }`). An empty string, an
// array, a number or nothing is no origin.
const hasOrigin = source => (typeof source === "string" && source !== "") || (source !== null && typeof source === "object" && !Array.isArray(source))

// Whether a thread record can show that the thread is a main one. Not being a child is not enough: a record without
// its origin (`source`) or its `ephemeral` flag says nothing about either, so it proves nothing.
const isCompleteRecord = thread => typeof thread.ephemeral === "boolean" && hasOrigin(thread.source)

// The statuses that a loaded thread documents. A bind accepts these and nothing else: no status, or one that is not known, proves nothing.
const LOADED_STATUS = new Set(["idle", "active", "systemError"])

const STATUS = Object.assign(Object.create(null), { idle: "idle", active: "busy", notLoaded: "offline" }) // no prototype: `constructor` is not a status
// The status a record shows, in this package's words: "unknown" for anything that is not a known status. The type must be a
// string before it is looked up, because a table lookup turns its key into text: `["idle"]` would find `idle`.
const statusOf = record => (typeof record.status?.type === "string" ? STATUS[record.status.type] : undefined) ?? "unknown"

// The thread behind one hook session. `open` is replaceable so tests can run a fake server on a real socket; `now` and `sleep`
// are the clock of a wake's deadlines, `wall` the wall clock of its `wallUntil` check, and `lstat` is the file system that
// `replaced` looks at, for tests.
export function createThread({ path, threadId, open = openAppServer, now = monotonic, wall = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), lstat = lstatSync }) {
  let provider = null // the provider of the bound thread: what each later record is compared with, whatever socket it comes from
  // What the queue probe answered, and on which socket: { route, dev, ino }. `route` is true when the documented answer came
  // back and false when it did not. A probe says what the app-server behind one socket does, so it counts only for the socket
  // it was taken on: another device or inode (a replaced socket, another app-server) has not been probed.
  let probed = null
  const probedOn = identity => (probed !== null && probed.dev === identity.dev && probed.ino === identity.ino ? probed.route : null)

  async function withConnection(task, options) {
    const link = await open(path, options)
    try { return await task(link) } finally { link.close() }
  }

  // The time one request may take: the usual limit, or what `left` says is left when there is a budget. `left` is asked
  // again for each request, so a wake's budget, which counts the wall clock too, bounds every one of them.
  const allowed = left => Math.max(1, Math.min(REQUEST_MS, left()))
  const unbounded = () => Infinity

  async function loaded(link, left = unbounded) {
    for (let cursor = null, page = 0; page < 10; page += 1) {
      const answer = await link.request("thread/loaded/list", cursor ? { cursor } : {}, allowed(left))
      if (!Array.isArray(answer.data)) throw failure("APP_SERVER_PROTOCOL")
      if (answer.data.includes(threadId)) return true
      if (typeof answer.nextCursor !== "string") return false
      cursor = answer.nextCursor
    }
    return false
  }

  async function read(link, left = unbounded) {
    const answer = await link.request("thread/read", { threadId }, allowed(left))
    const thread = answer.thread
    if (thread === null || typeof thread !== "object" || thread.id !== threadId) throw failure("APP_SERVER_PROTOCOL")
    return thread
  }

  // A thread that was never queued answers the delete with { deleted: false }. Any other answer, an error reply included,
  // is not the documented one, and the route is off. A probe that times out or loses its connection is no answer: it is
  // thrown, and the route stays undecided.
  async function probe(link, ms = PROBE_MS) {
    try {
      const answer = await link.request("thread/queue/delete", { threadId, queuedSubmissionId: randomUUID() }, ms)
      return answer.deleted === false
    } catch (error) {
      if (error?.code === "APP_SERVER_ERROR") return false
      throw error
    }
  }

  // Why a thread record is no longer the one that was bound: a child, or a provider that is not the bound one. Only a
  // provider that the record names (a non-empty string) can show a change; a missing or invalid one shows nothing, and the
  // record is judged as an incomplete one is.
  const refusing = record => {
    if (isChildThread(record)) return "child"
    const named = typeof record.modelProvider === "string" && record.modelProvider !== ""
    return provider !== null && named && record.modelProvider !== provider ? "stale_binding" : null
  }

  // A record that can show what the thread is: the origin, the `ephemeral` flag and a model provider, next to the id and a status.
  const complete = record => isCompleteRecord(record) && typeof record.modelProvider === "string" && record.modelProvider !== ""

  // Whether a `thread/resume` answer carries this thread's own record: an object with this id and a status.
  const resumedRecord = record => record !== null && typeof record === "object" && record.id === threadId && typeof record.status?.type === "string"

  // The thread as the app-server shows it now, for the heartbeat and for the wake: loaded, read, then the `thread/resume` answer, which
  // is a record of its own and carries the collaboration mode, and last the newest turn. The resume record must be
  // complete and agree with the read and the bound provider, or the answer says nothing. The mode decides Plan Mode:
  // "default" is not, "plan" is, and no answer or another mode is unknown (`plan: null`); a resume that the app-server
  // refuses (before the first user message codex-cli 0.171.0 answers -32600 "no rollout found") is unknown too.
  // The mode and the running state are two answers: `plan` comes from the mode alone, `status` and `stopped` from the
  // record and the newest turn, and one does not erase the other (Plan Mode with a newest turn that is not known is
  // { status: "unknown", plan: true }). The newest-turn read is last because an interruption is the one change that the
  // other answers cannot show: the thread is idle after it too. The read record must be complete too before an idle read
  // goes on (the origin, the `ephemeral` flag and a named provider, as a bind requires); a child, an offline thread and a
  // thread that is not idle are answered before that, as they are. Nothing is written to the thread. Every request ends
  // within `left`, the budget that the caller gives (none for the heartbeat's read).
  // observed: { status, stopped, plan }; `reason` is null only when the thread is clear: idle, finished and not in Plan Mode.
  async function evaluate(link, left = unbounded) {
    const observed = { status: "unknown", stopped: false, plan: null }
    if (!(await loaded(link, left))) return { reason: "offline", observed: { ...observed, status: "offline" } }
    const thread = await read(link, left)
    const refusal = refusing(thread)
    if (refusal) return { reason: refusal, observed }
    observed.status = statusOf(thread)
    if (observed.status !== "idle") return { reason: observed.status, observed }
    if (!complete(thread)) return { reason: "unknown", observed } // an idle read record that cannot show the origin or the provider
    // thread/resume subscribes this connection; the connection closes as soon as the reading ends.
    let resumed = null
    try { resumed = await link.request("thread/resume", { threadId, excludeTurns: true }, allowed(left)) } catch (error) { if (error?.code !== "APP_SERVER_ERROR") throw error }
    const record = resumed?.thread
    if (!resumedRecord(record)) {
      return { reason: "unknown", observed } // no record of its own: nothing newer than the read, and nothing to check it against
    }
    if (!isChildThread(record) && !complete(record)) return { reason: "unknown", observed } // it cannot show the origin or the provider
    const newer = refusing(record)
    if (newer) return { reason: newer, observed }
    const mode = resumed.collaborationMode?.mode
    observed.plan = mode === "default" ? false : mode === "plan" ? true : null
    const unclear = () => (observed.plan === true ? "plan" : observed.plan === null ? "unknown" : null)
    observed.status = statusOf(record)
    if (observed.status !== "idle") return { reason: observed.status, observed }
    // The mode is known from here on. A newest-turn lookup that fails (an error reply, a dropped connection) or answers in
    // a shape that is not the documented one keeps it: the running state is unknown, and the read is not offline.
    let turns = null
    try { turns = await link.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" }, allowed(left)) } catch { /* unknown */ }
    // Only a newest turn that is known to be finished clears the thread. A turn that is running is busy; an interrupted one is
    // stopped; no turn, a turn without a status and a status that is not known say nothing, and an unknown state is not idle.
    const newest = Array.isArray(turns?.data) ? turns.data[0]?.status : undefined
    if (newest === "interrupted") { observed.stopped = true; return { reason: "stopped", observed } }
    if (newest === "inProgress") { observed.status = "busy"; return { reason: "busy", observed } }
    if (newest !== "completed") { observed.status = "unknown"; return { reason: "unknown", observed } }
    return { reason: unclear(), observed }
  }

  return {
    get provider() { return provider },
    // The answer of the newest probe that finished, whichever socket it was taken on: true, false, or null before any. `wake`
    // probes again when the socket it reaches is another one.
    get route() { return probed === null ? null : probed.route },

    // Whether the configured path now names another socket than the one of the newest probe, and no connection is made. The
    // path goes through the same trust check as a connection (links followed), so the socket compared is the one at the end
    // of the link, as the probe's was. False before any probe has finished, and false whenever the check fails: no socket at
    // all (the app-server is down), a path that is not a socket, another user's socket, a link or directory that the rule
    // refuses. There is no other socket to probe then, and the heartbeat's read keeps reporting offline. A route that is off
    // was decided on one socket and nothing would look at another: the receiver asks this of such a route and binds again
    // when it is true, which probes the socket that is there.
    replaced() {
      if (probed === null) return false
      let seen
      try { seen = trusted(path, lstat) } catch { return false }
      return seen.dev !== probed.dev || seen.ino !== probed.ino
    },

    // Check the thread before the receiver joins: it must be loaded with a documented status (idle, active or systemError),
    // its record must be complete (a documented origin, the `ephemeral` flag, a model provider), it must not be a child, and
    // it fixes the provider. Then the queue is probed on the same connection, unless this socket's answer is known. The
    // answer is about this call's reads alone, so a main thread shows only in "bound", "unprobed" and "stale_binding";
    // nothing recorded by an earlier call counts. The route that the probe decided is read from `route`.
    // status: "bound" | "unprobed" | "child" | "unloaded" | "stale_binding" | "unavailable" | "untrusted"
    //   unprobed - a main thread, but the queue probe did not finish (it timed out or lost its connection): the provider is
    //              fixed, the route stays undecided, and the next bind probes again.
    //   unloaded - not in the loaded list, or listed but read as `notLoaded` (it unloaded between the two requests).
    //
    // `signal` belongs to this one call: once the caller aborts it (its time ran out), the call records nothing, neither
    // the provider nor the route, and its answer is "unavailable". `owns` is the same for a caller that stopped being the
    // owner of the answer (the worker it binds for was retired): asked at every check, it must stay true. What the call
    // learns is committed after the last check, in the same turn. `onRead` is called once the thread read has passed,
    // before the queue probe: the caller's read deadline ends there, and the probe has PROBE_MS of its own. A socket that
    // cannot be trusted (see `trustedSocket`) answers "untrusted".
    async bind({ signal, onRead, owns } = {}) {
      const expired = () => signal?.aborted === true || owns?.() === false
      try {
        return await withConnection(async link => {
          if (!(await loaded(link))) return { status: "unloaded" }
          const thread = await read(link)
          if (expired()) return { status: "unavailable" }
          if (isChildThread(thread)) return { status: "child" }
          if (thread.status?.type === "notLoaded") return { status: "unloaded" }
          if (!isCompleteRecord(thread) || !LOADED_STATUS.has(thread.status?.type)) return { status: "unavailable" }
          if (typeof thread.modelProvider !== "string" || !thread.modelProvider) return { status: "unavailable" }
          if (provider !== null && provider !== thread.modelProvider) return { status: "stale_binding" }
          onRead?.()
          let route = probedOn(link.identity)
          if (route === null) {
            try { route = await probe(link) } catch {
              if (expired()) return { status: "unavailable" }
              provider = thread.modelProvider // a main thread was read; only the probe did not finish
              return { status: "unprobed" }
            }
          }
          if (expired()) return { status: "unavailable" }
          provider = thread.modelProvider
          probed = { route, dev: link.identity.dev, ino: link.identity.ino }
          return { status: "bound" }
        })
      } catch (error) { return { status: error?.code === "CHAT_APPSERVER_UNTRUSTED" ? "untrusted" : "unavailable" } }
    },

    // What the thread is now, from reads only. `reason` is why the thread is not clear (a child, a changed provider, busy,
    // Plan Mode, stopped, offline or unknown), or null.
    // observed: { status: "idle"|"busy"|"offline"|"unknown", stopped, plan: true|false|null }
    async observe() {
      try {
        return await withConnection(link => evaluate(link))
      } catch { return { reason: "offline", observed: { status: "offline", stopped: false, plan: null } } }
    },

    // The collaboration mode alone, whatever the thread's status: the read that the receiver takes before an output during a
    // running turn. `observe` cannot give it then, because it stops at a thread that is not idle. `plan` is true for "plan",
    // false for "default", and null for anything else: another mode, a thread that is not loaded, an error, a timeout, and a
    // resume record that does not pass the checks of `observe` (this thread's own, complete, not a child) or that does not
    // name the provider that the bind fixed. No bind fixed one: null too. A thread that is not loaded is not resumed, since a
    // resume would load it. Every step ends within `ms`. `thread/resume` reports the thread's mode, the one that the next turn takes
    // (`thread/settings/update` sets it "for subsequent turns"): no request reads the mode of the turn that runs.
    // A resume of a running thread sends that connection the thread's pending server requests (an approval, say), and the
    // first connection that answers one settles it: an error reply aborts it. So this connection answers none, and closing
    // it leaves them to the session's own client.
    async readMode({ ms }) {
      const end = now() + ms
      const left = () => end - now()
      try {
        return await withConnection(async link => {
          if (!(await loaded(link, left))) return { plan: null }
          const resumed = await link.request("thread/resume", { threadId, excludeTurns: true }, allowed(left))
          const record = resumed.thread
          if (!resumedRecord(record) || isChildThread(record) || !complete(record) || record.modelProvider !== provider) return { plan: null }
          const mode = resumed.collaborationMode?.mode
          return { plan: mode === "default" ? false : mode === "plan" ? true : null }
        }, { connectMs: Math.max(1, Math.min(CONNECT_MS, left())), answerRequests: false })
      } catch { return { plan: null } }
    },

    // Queue `text` as one user turn and fence it. Resolves { outcome, reason } for the settle call. Three things prove
    // something, and everything else is uncertain:
    //   deleted:true                       - the delete removed it before it dispatched: deferred (busy).
    //   a userMessage with its client id   - it dispatched: handed.
    //   anything else is uncertain: `deleted:false` says only that it is no longer queued (it may have dispatched or been
    //   dropped), so without the matching userMessage by the settlement deadline (`limit`, SETTLE_MS before the end of the
    //   reservation) it is uncertain; so is a lost add reply, a reply whose submission does not echo this attempt's client
    //   id (no delete is sent then: an id this attempt did not queue could be another turn), and a delete that fails or is
    //   not answered, which prove neither removal nor dispatch.
    // A failure before the add frame is written is failed; any failure after it is uncertain. Nothing retries.
    // The wake reads the thread again (`evaluate`: the same reads as `observe`, the newest turn last), and `proceed` is asked
    // once with that reading, right before the add frame is written, with nothing awaited in between: the add goes out with
    // no request between the last answer and itself. `thread/resume` subscribes the connection that asks, so the reading is
    // taken on a second connection that is closed first, and the connection for the add, the fence and the confirmation is
    // opened before it and never asks. Both connections must reach the same checked socket (the same device and inode): the
    // second is refused when the path names another one, and the first is asked, in the turn before the add, whether the
    // configured path, resolved again through the whole trust check, still names its own (a link in the path that has moved
    // is not seen by the real path of the connection). Either mismatch, and any failure of that check, sends nothing and
    // settles `failed`.
    // `proceed` returns null to go on, or the `deferred` reason that the reading and the receiver's state now give: nothing
    // is sent then. Without one, the reading alone decides. `until` is the end of the reservation, and every request
    // stops SETTLE_MS before it. `wallUntil`, when given, is the same end on the wall clock (`wall`), taken at the claim: the
    // monotonic clock stops while the host is suspended and the server's reservation does not, so right before the add the
    // wake also asks the wall clock, and the larger of the two elapsed times counts. A wall clock that was stepped back
    // extends nothing: the monotonic check still holds. Without `wallUntil` the wall clock is never read.
    // `ready`, when given, is awaited once after the reading and before those last checks: the caller's own late checks
    // that need a request of theirs (the receiver asks the ledger whether the session is muted). It sends nothing to the
    // app-server. It answers null to go on or a `deferred` reason; one that throws sends nothing and settles `failed`. Its
    // time counts: the two-clock check after it refuses an add that it left too late.
    async wake({ text, attemptId, until, wallUntil = null, ready = null, proceed = fresh => (fresh.reason === "child" ? "offline" : fresh.reason) }) {
      const clientUserMessageId = `${CLIENT_ID_PREFIX}${attemptId}`
      const UNCERTAIN = { outcome: "uncertain", reason: "transport_ambiguous" }
      const limit = until - SETTLE_MS
      // What is left of the reservation: the tighter of the monotonic and the wall-clock budgets. The monotonic clock does not
      // count a suspend and the server's reservation does, and a wall clock stepped back extends nothing. Every time decision
      // and every request of the wake up to the add check takes this; the add and what follows it end by `end`, derived once.
      const left = () => Math.min(limit - now(), wallUntil === null ? Infinity : wallUntil - SETTLE_MS - wall())
      let link
      // The connection, the upgrade and `initialize` end by the limit too: nothing has been sent yet when they fail.
      try { link = await open(path, { connectMs: Math.max(1, Math.min(CONNECT_MS, left())) }) } catch { return { outcome: "failed", reason: "native_unavailable" } }
      try {
        if (left() < MIN_ADD_MS) return { outcome: "failed", reason: "native_unavailable" }
        // The probe says what the app-server behind one socket does, so only a positive answer taken on this very socket (its
        // device and inode) counts. Without one, because no bind has probed, the socket is another one or the answer was negative,
        // the wake probes it now, on the connection that will carry the add, and adds only on a positive answer. This is the one
        // request before the reading. (The receiver wakes a thread only when its bind probed positive, so this is a second guard.)
        if (probedOn(link.identity) !== true) {
          let route
          try { route = await probe(link, Math.max(1, Math.min(PROBE_MS, left()))) } catch { return { outcome: "failed", reason: "native_unavailable" } }
          probed = { route, dev: link.identity.dev, ino: link.identity.ino }
          if (!route) return { outcome: "failed", reason: "native_unavailable" }
        }
        let fresh
        try {
          fresh = await withConnection(seen => evaluate(seen, left), { connectMs: Math.max(1, Math.min(CONNECT_MS, left())), expect: link.identity })
        } catch { return { outcome: "failed", reason: "native_unavailable" } }
        if (ready) {
          // `ready` is not started without the time for an add after it, so a wake that resumes from a suspend near its end
          // sends nothing more and settles in time. Its own request has no timer: the worker serves one request at a time, so
          // an abandoned one would collide with the settle. The check after it refuses an add that it left too late.
          if (left() < MIN_ADD_MS) return { outcome: "failed", reason: "native_unavailable" }
          let held
          try { held = await ready() } catch { return { outcome: "failed", reason: "native_unavailable" } }
          if (held !== null) return { outcome: "deferred", reason: held }
        }
        // The path is checked first and the time after it: the check makes synchronous file system calls that can stall. The
        // time is checked on both clocks, in this turn, so a suspend since the claim sends nothing. `end` is the tighter of the
        // two budgets, derived once here: the add, the fence and the confirmation all end by it, so a wake that resumes from a
        // suspend with little wall time left does not hold the worker queue for the monotonic rest, and a wall clock stepped
        // back later extends nothing.
        if (!link.same()) return { outcome: "failed", reason: "native_unavailable" }
        const checked = now()
        const end = checked + left()
        if (end - checked < MIN_ADD_MS) return { outcome: "failed", reason: "native_unavailable" }
        const stale = proceed(fresh)
        if (stale !== null) return { outcome: "deferred", reason: stale }
        let added
        try {
          added = await link.request("thread/queue/add", {
            threadId, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }],
          }, end - now())
        } catch (error) { return error?.sent === false ? { outcome: "failed", reason: "native_unavailable" } : UNCERTAIN }
        // The fence deletes only a submission that the reply ties to this attempt: codex-cli 0.171.0 echoes the client id
        // inside `queuedSubmission`. Without the echo the id may be another turn's, and nothing is deleted.
        const submission = added.queuedSubmission
        const id = submission?.id
        if (typeof id !== "string" || !id || submission.clientUserMessageId !== clientUserMessageId) return UNCERTAIN
        let fence
        try { fence = await link.request("thread/queue/delete", { threadId, queuedSubmissionId: id }, end - now()) }
        catch { return UNCERTAIN }
        if (fence.deleted === true) return { outcome: "deferred", reason: "busy" }
        if (fence.deleted !== false) return UNCERTAIN
        while (now() < end - CONFIRM_MARGIN_MS) {
          try {
            const page = await link.request("thread/items/list", { threadId, limit: PAGE, sortDirection: "desc" }, end - now())
            const seen = Array.isArray(page.data) && page.data.some(entry => entry?.item?.type === "userMessage" && entry.item.clientId === clientUserMessageId)
            if (seen) return { outcome: "handed", reason: null }
          } catch { return UNCERTAIN }
          if (now() + CONFIRM_MS >= end - CONFIRM_MARGIN_MS) return UNCERTAIN // no other poll fits: do not wait past `end`
          await sleep(CONFIRM_MS)
        }
        return UNCERTAIN
      } finally { link.close() }
    },
  }
}
