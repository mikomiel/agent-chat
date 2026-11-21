import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  REJOIN_BACKOFF_BASE_MS, REJOIN_BACKOFF_CAP_MS, REJOIN_BUDGET_WINDOW_MS, REJOIN_EPISODE_MS,
  REJOIN_JITTER_MIN, REJOIN_PER_HOUR, createRejoinPolicy,
} from "../lib/policy.js"

const models = readFileSync(new URL("../../../agent_chat/models.py", import.meta.url), "utf8")
const constant = name => Number(models.match(new RegExp(`^${name} = ([0-9.]+)$`, "m"))?.[1])

test("the rejoin constants match the product core", () => {
  assert.equal(REJOIN_BACKOFF_BASE_MS, constant("REJOIN_BACKOFF_BASE_S") * 1000)
  assert.equal(REJOIN_BACKOFF_CAP_MS, constant("REJOIN_BACKOFF_CAP_S") * 1000)
  assert.equal(REJOIN_JITTER_MIN, constant("REJOIN_JITTER_MIN"))
  assert.equal(REJOIN_EPISODE_MS, constant("REJOIN_EPISODE_S") * 1000)
  assert.equal(REJOIN_PER_HOUR, constant("REJOIN_PER_HOUR"))
  assert.equal(REJOIN_BUDGET_WINDOW_MS, constant("REJOIN_BUDGET_WINDOW_S") * 1000)
})

test("the wait starts at the base, doubles and stays inside the jitter band", () => {
  let now = 0
  const policy = createRejoinPolicy({ now: () => now, random: () => 0 })
  assert.equal(policy.next("TRANSPORT_UNAVAILABLE"), REJOIN_BACKOFF_BASE_MS * REJOIN_JITTER_MIN)
  assert.equal(policy.next("TRANSPORT_UNAVAILABLE"), REJOIN_BACKOFF_BASE_MS * 2 * REJOIN_JITTER_MIN)
  const full = createRejoinPolicy({ now: () => 0, random: () => 1 })
  assert.equal(full.next("SERVICE_UNAVAILABLE"), REJOIN_BACKOFF_BASE_MS)
})

test("the cap bounds a long episode", () => {
  const policy = createRejoinPolicy({ now: () => 0, random: () => 1 })
  let last = 0
  for (let i = 0; i < 12; i += 1) last = policy.next("REQUEST_UNCERTAIN")
  assert.equal(last, REJOIN_BACKOFF_CAP_MS)
})

test("four completed rejoins inside the window fail the budget", () => {
  let now = 0
  const policy = createRejoinPolicy({ now: () => now, random: () => 0 })
  for (let i = 0; i < REJOIN_PER_HOUR; i += 1) { policy.next("STALE_INSTANCE"); policy.succeeded() }
  assert.throws(() => policy.next("STALE_INSTANCE"), { code: "REJOIN_BUDGET" })
})

test("an episode that outlives its window fails, including a wait that would cross it", () => {
  let now = 0
  const policy = createRejoinPolicy({ now: () => now, random: () => 0 })
  policy.next("TRANSPORT_UNAVAILABLE")
  now = REJOIN_EPISODE_MS - 1000
  assert.throws(() => policy.next("TRANSPORT_UNAVAILABLE"), { code: "REJOIN_WINDOW" })
  now = 0
  const late = createRejoinPolicy({ now: () => now, random: () => 0 })
  late.next("TRANSPORT_UNAVAILABLE")
  now = REJOIN_EPISODE_MS
  assert.throws(() => late.next("TRANSPORT_UNAVAILABLE"), { code: "REJOIN_WINDOW" })
})

test("the initial join is not a rejoin", () => {
  let now = 0
  const policy = createRejoinPolicy({ now: () => now, random: () => 0 })
  policy.succeeded()
  for (let i = 0; i < 3; i += 1) { policy.next("STALE_INSTANCE"); policy.succeeded() }
  assert.throws(() => policy.next("STALE_INSTANCE"), { code: "REJOIN_BUDGET" })
})

test("a non-rejoin refusal fails closed", () => {
  const policy = createRejoinPolicy()
  assert.throws(() => policy.next("DELIVERY_BLOCKED"), { code: "CHAT_LIFECYCLE_FAILED" })
  assert.ok(policy.next("BINDING_CONFLICT") > 0)
})
