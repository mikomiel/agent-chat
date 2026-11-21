import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { startWorker } from "../lib/worker.js"

const config = {
  python: "/usr/bin/python3",
  directory: "/tmp/agent-chat-state",
  serverOrigin: "https://chat.example",
  hostToken: "synthetic-host-token",
  enabled: true,
}
const identity = { nativeSessionId: "native-1", bootId: "boot-1" }

function harness() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = () => {}
  const frames = []
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) frames.push(JSON.parse(line))
  })
  return { child, frames }
}

const spawnReturning = (child, captured = {}) => (_command, args, options) => {
  captured.args = args
  captured.options = options
  return child
}

test("the join frame carries the binding on stdin, never on argv", async () => {
  const { child, frames } = harness()
  const captured = {}
  const worker = startWorker(config, identity, { spawnImpl: spawnReturning(child, captured) })
  await Promise.resolve()
  assert.deepEqual(captured.args, ["-I", "-m", "agent_chat.instance_worker"])
  assert.equal(captured.options.cwd, config.directory)
  assert.deepEqual(captured.options.env, {})
  assert.deepEqual(captured.options.stdio, ["pipe", "pipe", "ignore"])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].op, "join")
  assert.equal(frames[0].enabled, true)
  assert.equal(frames[0].directory, config.directory)
  assert.equal(frames[0].server_origin, config.serverOrigin)
  assert.equal(frames[0].host_token, config.hostToken)
  assert.equal(frames[0].native_session_id, "native-1")
  assert.equal(frames[0].boot_id, "boot-1")
  assert.equal(frames[0].harness, "deepseek")
  assert.equal(captured.args.includes(config.hostToken), false)
  const joined = { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "deepseek", instance_file: "/tmp/s.json" }
  child.stdout.write(`${JSON.stringify({ id: 0, result: joined })}\n`)
  assert.deepEqual(await worker.ready, joined)
})

test("one request is in flight and a well-formed reply resolves it", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "deepseek", instance_file: "/tmp/s.json" } })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: { native_state: "idle", stopped: false, plan_mode: false } })
  await assert.rejects(worker.request("status"), { code: "CHAT_WORKER_BUSY" })
  child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`)
  assert.deepEqual(await heartbeat, { ok: true })
})

test("a worker error frame rejects with a fixed code", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, error: { code: "BINDING_FILE_UNSAFE" } })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_WORKER_REFUSED", workerCode: "BINDING_FILE_UNSAFE" })
})

test("an unknown error code is not passed through as a label", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, error: { code: "SYNTHETIC_LEAK" } })}\n`)
  await assert.rejects(worker.ready, error => error.code === "CHAT_WORKER_REFUSED" && error.workerCode === undefined)
})

test("a malformed frame is refused and the worker is stopped", async () => {
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0 })}\n`)
  await assert.rejects(worker.ready, { code: "CHAT_PROTOCOL_INVALID" })
})

test("a relative directory or an unexpected harness is refused before spawn", () => {
  const { child } = harness()
  let spawns = 0
  const spawnImpl = () => { spawns += 1; return child }
  assert.throws(() => startWorker({ ...config, directory: "state" }, identity, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.throws(() => startWorker(config, { ...identity, harness: "pi" }, { spawnImpl }), { code: "CHAT_CONFIGURATION_INVALID" })
  assert.equal(spawns, 0)
})

test("a request that outlives the parent-side deadline rejects with the core's REQUEST_UNCERTAIN", async t => {
  mock.timers.enable({ apis: ["setTimeout"] })
  t.after(() => mock.timers.reset())
  const { child } = harness()
  const worker = startWorker(config, identity, { spawnImpl: () => child })
  child.stdout.write(`${JSON.stringify({ id: 0, result: { session_id: "s", instance_id: "i", room_id: "r", host: "h", harness: "deepseek", instance_file: "/tmp/s.json" } })}\n`)
  await worker.ready
  const heartbeat = worker.request("heartbeat", { state: { native_state: "idle", stopped: false, plan_mode: false } })
  mock.timers.tick(22_000)
  await assert.rejects(heartbeat, { code: "REQUEST_UNCERTAIN", operation: "heartbeat" })
})
