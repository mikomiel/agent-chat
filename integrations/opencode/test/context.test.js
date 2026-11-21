import test from "node:test"
import assert from "node:assert/strict"
import { createContext, CALL_TIMEOUT_MS } from "../lib/context.js"
import { BINDING_KEY } from "../lib/channel.js"

const SESSION = "ses_synthetic0001"
const event = (type, data = {}) => ({ type, data: { sessionID: SESSION, ...data } })

// A double of the three instruction-entry calls the context makes. Entries live in a map that the double reads back.
function fakeCtx({ putFails = false, listLies = false, removeFails = false } = {}) {
  const calls = { put: [], remove: [], list: 0 }
  const entries = new Map()
  return {
    calls,
    entries,
    session: {
      instructions: {
        entry: {
          async put(input) {
            calls.put.push(input)
            if (putFails) throw new Error("unavailable")
            entries.set(input.key, input.value)
          },
          async list() {
            calls.list += 1
            if (listLies) return []
            return [...entries].map(([key, value]) => ({ key, value }))
          },
          async remove(input) {
            calls.remove.push(input)
            if (removeFails) throw new Error("unavailable")
            entries.delete(input.key)
          },
        },
      },
    },
  }
}

// Injected timers: a test fires a timer by hand, and no test waits for the clock.
function timers() {
  const all = []
  return {
    all,
    setTimeoutImpl(fn, ms) { const timer = { fn, ms, cleared: false }; all.push(timer); return timer },
    clearTimeoutImpl(timer) { if (timer) timer.cleared = true },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

function make(ctx = fakeCtx()) {
  const clock = timers()
  return { ctx, clock, context: createContext(ctx, SESSION, clock) }
}

// Any event of the session. After a gap it shows that the stream is up.
const resumed = context => context.observe(event("session.execution.started"))
// A gap and the first event after it: a read-back is owed, and it may start.
const gap = context => { context.reset(); resumed(context) }
const compacted = context => context.observe(event("session.compaction.ended"))

// Wraps one host call so that its first invocation waits until the test settles it.
function holdFirst(target, name) {
  const original = target[name]
  const held = { entered: false, settle: null }
  target[name] = async (...args) => {
    if (held.entered) return original(...args)
    held.entered = true
    await new Promise((resolve, reject) => { held.settle = { resolve, reject } })
    return original(...args)
  }
  return held
}

// A session that has just had a gap: the entry is gone, a read-back is owed, and the first event after the gap came.
async function gapped() {
  const { ctx, clock, context } = make()
  await context.context("binding")
  ctx.entries.clear() // a compaction dropped the entry
  gap(context)
  return { ctx, clock, context, calls: { lists: ctx.calls.list, puts: ctx.calls.put.length } }
}

// The same, with nothing published yet: there is nothing to read back, so the obligation stays owed.
function gappedWithNoBinding() {
  const made = make()
  gap(made.context)
  return made
}

test("context: the binding is put under one key, confirmed by a read-back, and replaced on a rejoin", async () => {
  const { ctx, context } = make()
  await context.context("binding one")
  assert.deepEqual(ctx.calls.put[0], { sessionID: SESSION, key: BINDING_KEY, value: "binding one" })
  assert.match(BINDING_KEY, /^[a-z0-9][a-z0-9._-]*$/)
  await context.context("binding two")
  assert.equal(ctx.calls.put.length, 2)
  assert.deepEqual([...ctx.entries], [[BINDING_KEY, "binding two"]]) // replaced, never appended
  await context.context(null)
  assert.equal(ctx.entries.size, 0)
  assert.deepEqual(ctx.calls.remove, [{ sessionID: SESSION, key: BINDING_KEY }])
})

test("context: an unavailable or unconfirmed entry rejects, so the session's chat can fail closed", async () => {
  await assert.rejects(make(fakeCtx({ putFails: true })).context.context("text"), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  await assert.rejects(make(fakeCtx({ listLies: true })).context.context("text"), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  await assert.rejects(make().context.context(""), { code: "CHAT_CONTEXT_UNAVAILABLE" })
  await assert.rejects(make().context.context(42), { code: "CHAT_CONTEXT_UNAVAILABLE" })
})

test("context: a failing removal is not an error and a disposed object publishes nothing", async () => {
  const { ctx, context } = make(fakeCtx({ removeFails: true }))
  await context.context("text")
  await context.context(null)
  context.dispose()
  await context.context("after")
  assert.equal(ctx.calls.put.length, 1)
})

test("context: a compaction that dropped the entry is repaired, and an intact entry is left alone", async () => {
  const { ctx, context } = make()
  compacted(context) // a read-back is owed after it, and only then does a check read
  assert.equal(await context.repair(), false) // nothing published yet
  assert.equal(ctx.calls.put.length, 0)
  await context.context("binding")
  compacted(context)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.calls.put.length, 1)
  ctx.entries.clear()
  compacted(context)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.calls.put.length, 2)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  ctx.entries.set(BINDING_KEY, "stale")
  compacted(context)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
})

test("context: operations run in order, so a clear never overtakes a publish", async () => {
  const { ctx, context } = make()
  const publish = context.context("binding")
  const clear = context.context(null)
  await Promise.all([publish, clear])
  assert.equal(ctx.entries.size, 0)
})

test("context: the object reads no session state and sends no input: only the three entry calls exist", async () => {
  const ctx = fakeCtx()
  const touched = []
  const guarded = new Proxy(ctx.session, { get(target, name) { touched.push(String(name)); return target[name] } })
  const { context } = make({ ...ctx, session: guarded })
  await context.context("binding")
  compacted(context)
  await context.repair()
  context.reset()
  resumed(context)
  await context.repair()
  await context.context(null)
  assert.deepEqual([...new Set(touched)], ["instructions"])
})

// A compaction signal owes the read-back: the entry may have been dropped, and an earlier proof says nothing about it.
const SIGNALS = {
  "a gap": { apply: context => context.reset(), resume: resumed },
  "a compaction that started": { apply: context => context.observe(event("session.compaction.started")), resume: () => {} },
  "a compaction that ended": { apply: compacted, resume: () => {} },
  "a compaction that failed": { apply: context => context.observe(event("session.compaction.failed")), resume: () => {} },
  "a compaction that started and failed": { apply: context => {
    context.observe(event("session.compaction.started"))
    context.observe(event("session.compaction.failed"))
  }, resume: () => {} },
}

for (const [name, signal] of Object.entries(SIGNALS)) {
  test(`${name} owes a proved binding again once it is applied`, async () => {
    const { context } = make()
    await context.context("binding")
    compacted(context) // owed, then proved
    assert.equal(await context.repair(), true)
    assert.equal(context.owed(), false)
    signal.apply(context)
    signal.resume(context)
    assert.equal(context.owed(), true)
    assert.equal(await context.repair(), true)
    assert.equal(context.owed(), false)
  })

  test(`a repair put that landed before ${name} was applied is owed again by it, and the next check proves`, async () => {
    const { ctx, context } = await gapped()
    const held = holdFirst(ctx.session.instructions.entry, "list")
    const read = context.repair()
    await flush()
    // The signal has been received but not applied, so the check is still current: it puts the entry back and proves.
    held.settle.resolve()
    assert.equal(await read, true)
    assert.equal(ctx.entries.get(BINDING_KEY), "binding")
    assert.equal(context.owed(), false)
    // The signal is applied now, and what it dropped is not there.
    ctx.entries.clear()
    signal.apply(context)
    signal.resume(context)
    assert.equal(context.owed(), true)
    assert.equal(await context.repair(), true)
    assert.equal(ctx.entries.get(BINDING_KEY), "binding") // put back by the next check
    assert.equal(context.owed(), false)
  })
}

test("a read-back that finishes after a second compaction ended does not prove the binding", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  const releases = []
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { await new Promise(resolve => releases.push(resolve)); return list() }
  compacted(context)
  const first = context.repair()
  await flush()
  context.observe(event("session.compaction.started"))
  compacted(context)
  const second = context.repair()
  await flush()
  releases[0]()
  assert.equal(await first, false)
  assert.equal(context.owed(), true) // the second compaction has not been read back yet
  await flush() // the queue is serial: the second read-back starts only now
  releases[1]()
  assert.equal(await second, true)
  assert.equal(context.owed(), false)
})

test("a stream gap owes a read-back that may run at once, and it puts a missing entry back", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  ctx.entries.clear() // a compaction removed the entry, and the event that ends it fell into the gap
  context.reset()
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding") // put back
  assert.equal(context.owed(), false)
})

// The heartbeat tick. An entry can change with no signal this object sees: a compaction that ends inside a gap after the
// read-back, a call that lands after its time limit, a host that answers again after a failed check.
test("each refresh reads the entry back with nothing owed: an intact entry costs one list, a missing one is put back", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  assert.equal(context.owed(), false)
  const lists = ctx.calls.list
  const puts = ctx.calls.put.length
  assert.equal(await context.refresh(), true)
  assert.equal(ctx.calls.list, lists + 1)
  assert.equal(ctx.calls.put.length, puts) // intact: no put
  ctx.entries.clear() // removed with no signal, for example by a removal that landed late
  assert.equal(await context.refresh(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  assert.equal(context.owed(), false)
})

test("a compaction that ends inside a gap after the gap's read-back is repaired by the next refresh", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  context.reset()
  assert.equal(await context.repair(), true) // the gap's read-back proves the entry
  ctx.entries.clear() // and a compaction that ended in the rest of the gap drops it, with its end unseen
  assert.equal(await context.repair(), false) // nothing seen owes it
  assert.equal(await context.refresh(), true) // the next tick reads it back
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
})

test("a refresh does not move the epoch: a publish in flight still discharges, and a queued check answers the tick", async () => {
  const { ctx, context } = await (async () => { const made = make(); await made.context.context("binding"); return made })()
  const held = holdFirst(ctx.session.instructions.entry, "put")
  const publish = context.context("binding two")
  await flush()
  assert.equal(held.entered, true)
  const lists = ctx.calls.list
  const refreshed = context.refresh() // queued behind the publish: it reads after the tick
  held.settle.resolve()
  await publish
  assert.equal(await refreshed, false) // the confirmed publish discharged it before the check began: no host call
  assert.equal(ctx.calls.list, lists + 1) // only the publish's own confirmation
  assert.equal(context.owed(), false)
})

test("a tick that lands while a check's read is in flight is not answered by that read: the check runs once more", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  const listHeld = holdFirst(ctx.session.instructions.entry, "list")
  const first = context.refresh() // its list is issued and waits
  await flush()
  assert.equal(listHeld.entered, true)
  ctx.entries.clear() // an unseen compaction drops the entry after the list read it
  const second = context.refresh() // the next tick: the running check is not doubled now
  listHeld.settle.resolve() // the old list answers with the entry present
  assert.equal(await second, false)
  assert.equal(await first, true) // the follow-up check found the entry gone and put it back
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  assert.equal(context.owed(), false)
})

test("a check that a tick overlapped runs once more and no more, even when the follow-up fails", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  const entry = ctx.session.instructions.entry
  const listHeld = holdFirst(entry, "list")
  const first = context.refresh()
  await flush()
  context.refresh()
  let calls = 0
  entry.list = async () => { calls += 1; throw new Error("unavailable") } // later lists fail; the held one still answers
  listHeld.settle.resolve()
  assert.equal(await first, false) // the follow-up's list failed
  assert.equal(calls, 1) // one follow-up, no loop
  assert.equal(context.owed(), true) // owed until the next ask
})

test("a refresh on a disabled or disposed context makes no host call", async () => {
  for (const end of ["disable", "dispose"]) {
    const { ctx, context } = make()
    await context.context("binding")
    context[end]()
    const lists = ctx.calls.list
    assert.equal(await context.refresh(), false)
    assert.equal(ctx.calls.list, lists)
  }
})

test("a read-back that began before a gap does not prove the binding", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  const releases = []
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { await new Promise(resolve => releases.push(resolve)); return list() }
  gap(context)
  const first = context.repair()
  await flush()
  gap(context) // the stream broke again while the first read-back was running
  const second = context.repair()
  releases[0]()
  assert.equal(await first, false)
  assert.equal(context.owed(), true) // the second gap has not been read back yet
  await flush()
  releases[1]()
  assert.equal(await second, true)
  assert.equal(context.owed(), false)
})

test("a compaction that started before a gap holds no read-back back: the event after the gap asks, and the compaction's end owes it again", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  context.observe(event("session.compaction.started", { reason: "auto" }))
  context.reset() // the stream broke while the compaction ran
  resumed(context)
  const lists = ctx.calls.list
  assert.equal(await context.repair(), true) // no end was seen, and nothing waits for one
  assert.equal(ctx.calls.list, lists + 1)
  ctx.entries.clear() // the compaction ends and drops the entry
  context.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  assert.equal(context.owed(), false)
})

test("a read-back queued behind an earlier operation does not read once a compaction signal arrived, and stays owed", async () => {
  const { ctx, context } = make()
  const list = ctx.session.instructions.entry.list
  let lists = 0
  let releaseList = null
  ctx.session.instructions.entry.list = async () => {
    lists += 1
    if (lists === 1) await new Promise(resolve => { releaseList = resolve }) // the earlier operation's own check
    return list()
  }
  const earlier = context.context("binding")
  await flush()
  assert.equal(typeof releaseList, "function")
  gap(context) // a read-back is owed and may start
  const read = context.repair() // queued behind the earlier operation
  context.observe(event("session.compaction.started", { reason: "auto" })) // arrives before the read can begin
  releaseList()
  await earlier
  assert.equal(await read, false)
  assert.equal(lists, 1) // no read began after the signal
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true) // asked again: the skipped read proved nothing
  assert.equal(lists, 2)
  assert.equal(context.owed(), false)
})

test("a read-back is asked for once per obligation, and again after a newer one", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  const lists = ctx.calls.list
  assert.equal(await context.repair(), false) // nothing is owed
  assert.equal(ctx.calls.list, lists)
  gap(context)
  const first = context.repair()
  const same = context.repair() // the same obligation, already queued: not asked twice
  assert.equal(await same, false)
  assert.equal(await first, true)
  assert.equal(ctx.calls.list, lists + 1)
  gap(context)
  const queued = context.repair()
  gap(context) // a newer gap makes the queued read prove nothing, and asks again
  const newer = context.repair()
  assert.equal(await queued, false)
  assert.equal(await newer, true)
  compacted(context)
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.equal(await context.repair(), false)
  assert.equal(context.owed(), true) // a read that failed is still owed: the next ask repeats it
  ctx.session.instructions.entry.list = list
  assert.equal(await context.repair(), true)
})

test("a compaction that begins while the first list is pending stops the repair before any put", async () => {
  const { ctx, context, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  assert.equal(held.entered, true)
  context.observe(event("session.compaction.started", { reason: "auto" }))
  held.settle.resolve() // the list answers: no binding
  assert.equal(await read, false) // nothing failed: the check was overtaken
  assert.equal(ctx.calls.put.length, calls.puts) // no put
  assert.equal(ctx.calls.list, calls.lists + 1) // and no second list
  assert.equal(context.owed(), true)
  context.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding") // the repair runs after the signal
  assert.equal(context.owed(), false)
})

test("a compaction that begins while the repair put is pending stops the read-back before the confirming list", async () => {
  const { ctx, context, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "put")
  const read = context.repair()
  await flush()
  assert.equal(held.entered, true)
  context.observe(event("session.compaction.started", { reason: "auto" }))
  held.settle.resolve()
  assert.equal(await read, false)
  assert.equal(ctx.calls.list, calls.lists + 1) // only the first list: the confirming one was not made
  assert.equal(context.owed(), true)
  context.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(await context.repair(), true)
  assert.equal(ctx.calls.list, calls.lists + 2) // the read-back runs again after the signal
  assert.equal(context.owed(), false)
})

test("a compaction that begins while the repair's confirming list is pending proves nothing, and the obligation stays owed", async () => {
  const { ctx, context } = await gapped()
  const entry = ctx.session.instructions.entry
  const list = entry.list
  let calls = 0
  let release = null
  entry.list = async (...args) => {
    calls += 1
    if (calls === 2) await new Promise(resolve => { release = resolve }) // the confirming list, after the repair put
    return list(...args)
  }
  const read = context.repair()
  await flush()
  assert.equal(typeof release, "function") // the put is made and its confirming list is pending
  context.observe(event("session.compaction.started", { reason: "auto" }))
  context.observe(event("session.compaction.ended", { reason: "auto" }))
  release() // the entry is there, but the check began before that compaction
  assert.equal(await read, false)
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(context.owed(), false)
})

test("a read that fails while a compaction began during it is ignored, and the check stays owed", async () => {
  const { ctx, context } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  context.observe(event("session.compaction.started", { reason: "auto" }))
  held.settle.reject(new Error("unavailable"))
  assert.equal(await read, false) // not a context failure: the check overlapped a compaction
  assert.equal(context.owed(), true)
  context.observe(event("session.compaction.ended", { reason: "auto" }))
  assert.equal(await context.repair(), true)
  assert.equal(context.owed(), false)
})

test("a read that overlapped a compaction that began and failed inside one host call is ignored too", async () => {
  const { ctx, context } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  context.observe(event("session.compaction.started", { reason: "auto" }))
  context.observe(event("session.compaction.failed", { reason: "auto" })) // the compaction is over when the call fails
  held.settle.reject(new Error("unavailable"))
  assert.equal(await read, false) // not a context failure: the compaction overlapped the call
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(context.owed(), false)
})

test("a read that succeeds across a compaction that began and failed does not clear the obligation", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  gap(context)
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  context.observe(event("session.compaction.started", { reason: "auto" }))
  context.observe(event("session.compaction.failed", { reason: "auto" }))
  held.settle.resolve() // the entry is there, but the read overlapped a compaction
  assert.equal(await read, false)
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(context.owed(), false)
})

test("a read that fails with no compaction and no newer gap leaves the obligation owed and starts nothing else", async () => {
  const { ctx, context } = await gapped()
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.equal(await context.repair(), false)
  assert.equal(context.owed(), true)
  ctx.session.instructions.entry.list = list
  assert.equal(await context.repair(), true) // the host answers again: the next ask proves
  assert.equal(context.owed(), false)
})

test("a read-back queued behind an earlier operation does no I/O after a newer gap, and its failure is ignored", async () => {
  const { ctx, context } = make()
  const entry = ctx.session.instructions.entry
  const base = entry.list
  let attempts = 0
  entry.list = async (...args) => { attempts += 1; if (attempts > 1) throw new Error("unavailable"); return base(...args) }
  const held = holdFirst(entry, "list")
  const earlier = context.context("binding") // its own check is held, so later context operations queue behind it
  await flush()
  assert.equal(held.entered, true)
  gap(context)
  const stale = context.repair() // queued behind the earlier operation
  context.reset() // a newer gap supersedes it
  held.settle.resolve()
  await earlier
  assert.equal(await stale, false) // a superseded check neither reads nor proves
  assert.equal(attempts, 1) // only the earlier operation's own list
  assert.equal(context.owed(), true) // the newest gap still owes its own check
  entry.list = base
  resumed(context) // the first event after the newest gap
  assert.equal(await context.repair(), true)
  assert.equal(context.owed(), false)
})

// One currency rule: a read-back asks, after every host call it awaits and before it proves, whether it is still the
// check this obligation and this binding call for. It never rejects: it resolves true only when it proved the binding,
// and false for every other end, which leaves the obligation owed.
test("a read-back whose check holds proves the binding, and one that fails stays owed and is asked for again", async () => {
  const { ctx, context } = await gapped()
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  gap(context)
  const list = ctx.session.instructions.entry.list
  ctx.session.instructions.entry.list = async () => { throw new Error("unavailable") }
  assert.equal(await context.repair(), false)
  assert.equal(context.owed(), true)
  ctx.session.instructions.entry.list = list
  assert.equal(await context.repair(), true)
})

test("a withdrawn binding is not put back: the binding is cleared while the first list is pending", async () => {
  const { ctx, context, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  assert.equal(held.entered, true)
  const cleared = context.context(null) // a heartbeat answered STALE_INSTANCE: the binding is withdrawn, the entry removed
  held.settle.resolve() // the list answers: no entry
  assert.equal(await read, false)
  await cleared
  assert.equal(ctx.calls.put.length, calls.puts) // the withdrawn text was never put
  assert.equal(ctx.calls.list, calls.lists + 1) // and nothing was read after it
  assert.equal(ctx.entries.has(BINDING_KEY), false)
  // The overtaken check changed nothing: the obligation is still owed until a binding is proved.
  assert.equal(context.owed(), true)
  // The rejoin publishes its new binding. Its confirmed put is a read-back no gap or compaction overlapped, so it
  // discharges the obligation, and the next ask has nothing to do.
  await context.context("binding two")
  assert.equal(ctx.entries.get(BINDING_KEY), "binding two")
  assert.equal(context.owed(), false)
})

test("a failed list changes nothing once the binding it was for is withdrawn", async () => {
  const { ctx, context } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  void context.context(null)
  held.settle.reject(new Error("unavailable"))
  assert.equal(await read, false)
  assert.equal(context.owed(), true) // nothing was proved, and nothing turned chat off
  await context.context("binding two")
  assert.equal(context.owed(), false) // the rejoin's confirmed publish discharged the obligation
})

test("a replaced binding with the same text is still a different binding", async () => {
  const { ctx, context, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  const replaced = context.context("binding") // the same text, published again by a rejoin: the old check is not for this binding
  held.settle.resolve()
  assert.equal(await read, false)
  await replaced
  assert.equal(ctx.calls.put.length, calls.puts + 1) // only the new call's own put
  assert.equal(context.owed(), false) // discharged by that put's own confirmation, not by the overtaken check
})

test("a withdrawn binding's removal lands behind a repair put that is already issued", async () => {
  const { ctx, context, calls } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "put") // the entry is gone, so the check's repair put is issued and pending
  const read = context.repair()
  await flush()
  assert.equal(held.entered, true)
  const cleared = context.context(null) // the binding is withdrawn: its removal queues behind the check on the context queue
  held.settle.resolve()
  assert.equal(await read, false) // it stops before the confirming list: the binding is gone
  await cleared
  assert.equal(ctx.calls.put.length, calls.puts + 1) // the put was issued, so the test is not vacuous
  assert.equal(ctx.calls.remove.length, 1) // and the removal ran
  assert.equal(ctx.entries.has(BINDING_KEY), false) // after it, so the late put does not outlive the withdrawal
})

test("a confirming list that answers after the binding was withdrawn proves nothing", async () => {
  const { ctx, context } = make()
  await context.context("binding")
  gap(context) // a gap: the entry is still there
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  void context.context(null)
  held.settle.resolve() // the entry is there, but the binding it names is withdrawn
  assert.equal(await read, false)
  assert.equal(context.owed(), true) // the obligation is still owed
})

test("a read-back that is closed or disabled while a host call is pending proves nothing and repairs nothing", async () => {
  for (const end of ["disable", "dispose"]) {
    const { ctx, context, calls } = await gapped()
    const held = holdFirst(ctx.session.instructions.entry, "list")
    const read = context.repair()
    await flush()
    context[end]()
    held.settle.resolve() // the list answers: no entry, so a repair put would follow if the check were still current
    assert.equal(await read, false, end)
    assert.equal(ctx.calls.put.length, calls.puts, end)
    assert.equal(context.owed(), false, end)
  }
})

// Nothing published is not a proof. The obligation stays owed, and a confirmed `context()` publish discharges it when no
// gap or compaction came since that publish began.
test("with no binding published the obligation stays owed, and a confirmed publish discharges it", async () => {
  const { ctx, context } = gappedWithNoBinding()
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), false) // nothing to read, and nothing proved
  assert.equal(ctx.calls.list, 0)
  assert.equal(context.owed(), true) // still owed, and asking costs no host call
  await context.context("binding") // the join's publish, confirmed
  assert.equal(context.owed(), false)
})

test("a confirmed publish that a gap overlapped does not discharge the obligation", async () => {
  const { ctx, context } = gappedWithNoBinding()
  const held = holdFirst(ctx.session.instructions.entry, "list") // the publish's confirming list
  const publish = context.context("binding")
  await flush()
  assert.equal(held.entered, true)
  gap(context) // a newer gap while the confirming list is pending
  held.settle.resolve()
  await publish
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true) // the next ask discharges it
  assert.equal(context.owed(), false)
})

test("a confirmed publish that a compaction overlapped does not discharge the obligation", async () => {
  const { ctx, context } = gappedWithNoBinding()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const publish = context.context("binding")
  await flush()
  context.observe(event("session.compaction.started", { reason: "auto" }))
  context.observe(event("session.compaction.failed", { reason: "auto" })) // the compaction is over when the list answers
  held.settle.resolve()
  await publish
  assert.equal(context.owed(), true)
})

test("a publish that a newer binding replaced does not discharge the obligation", async () => {
  const { ctx, context } = gappedWithNoBinding()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const first = context.context("binding one")
  await flush()
  const withdrawn = context.context(null) // the binding is withdrawn while its first publish is confirming
  held.settle.resolve()
  await first
  await withdrawn
  assert.equal(context.owed(), true) // that publish was for a binding that is gone
  await context.context("binding two")
  assert.equal(context.owed(), false) // the new binding's own confirmed publish discharges it
})

test("a confirmed publish in a gap discharges the obligation", async () => {
  const { context } = make()
  await context.context("binding")
  context.reset()
  assert.equal(context.owed(), true)
  await context.context("binding two")
  assert.equal(context.owed(), false)
})

// A read-back is a repair that is owed until it succeeds. A failure leaves the obligation owed, so the next ask repeats
// it, and nothing about it turns chat off.
const TRANSIENT = {
  "the list rejects"(ctx) {
    const entry = ctx.session.instructions.entry
    const list = entry.list
    entry.list = async () => { throw new Error("unavailable") }
    return () => { entry.list = list }
  },
  "the repair put rejects"(ctx) {
    const entry = ctx.session.instructions.entry
    const put = entry.put
    entry.put = async () => { throw new Error("unavailable") }
    return () => { entry.put = put }
  },
  "the put leaves no entry to confirm"(ctx) {
    const entry = ctx.session.instructions.entry
    const put = entry.put
    entry.put = async input => { ctx.calls.put.push(input) }
    return () => { entry.put = put }
  },
}

for (const [failure, break_] of Object.entries(TRANSIENT)) {
  test(`a transient failure (${failure}) leaves the obligation owed, and the next check proves it`, async () => {
    const { ctx, context } = await gapped()
    const mend = break_(ctx)
    assert.equal(await context.repair(), false)
    assert.equal(context.owed(), true) // owed, and nothing turned chat off
    assert.equal(await context.repair(), false) // a second failed check changes nothing either
    assert.equal(context.owed(), true)
    mend() // the host answers again
    assert.equal(await context.repair(), true)
    assert.equal(ctx.entries.get(BINDING_KEY), "binding") // the entry a compaction dropped is back
    assert.equal(context.owed(), false)
  })
}

test("a check queued behind a publish that discharged the obligation makes no host call", async () => {
  const { ctx, context } = make()
  gap(context) // the stream has resumed, so a publish may discharge the gap
  assert.equal(context.owed(), true)
  const held = holdFirst(ctx.session.instructions.entry, "put")
  const publish = context.context("binding") // the join's publish: its put is pending
  await flush()
  assert.equal(held.entered, true)
  const read = context.repair() // asked for while the obligation was owed, and queued behind the publish
  held.settle.resolve()
  await publish // confirmed, and nothing overlapped it: the obligation is discharged
  assert.equal(await read, false)
  assert.equal(ctx.calls.list, 1) // only the publish's own confirming list
  assert.equal(ctx.calls.put.length, 1)
  assert.equal(context.owed(), false)
})

// A host call that never answers must not block the serial queue for ever. Each call has a time limit, and a call that
// runs out of it counts as a failed call: a check proves nothing and stays owed, a publish rejects, a removal is not an
// error. The timers are injected, so no test waits for the clock.
const NEVER = () => new Promise(() => {})
// The call timers still armed: a call that answered in time has cleared its own.
const armed = clock => clock.all.filter(timer => !timer.cleared && timer.ms === CALL_TIMEOUT_MS)

test("a call that answers in time clears its own timer", async () => {
  const { clock, context } = make()
  await context.context("binding")
  compacted(context)
  assert.equal(await context.repair(), true)
  await context.context(null)
  assert.equal(clock.all.length, 4) // put, confirming list, read-back list, removal
  assert.equal(armed(clock).length, 0)
})

test("a read-back whose list never answers ends at its time limit and stays owed, and the queue goes on", async () => {
  const { ctx, clock, context } = await gapped()
  const entry = ctx.session.instructions.entry
  const list = entry.list
  entry.list = NEVER
  const read = context.repair()
  await flush()
  assert.equal(armed(clock).length, 1) // the hung call's timer
  armed(clock)[0].fn() // the time limit passes
  assert.equal(await read, false)
  assert.equal(context.owed(), true) // a timed-out check is a failed check: the obligation is still owed
  entry.list = list // the host answers again
  assert.equal(await context.repair(), true) // the queue was not blocked, and the next ask repeats the check
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  assert.equal(context.owed(), false)
})

for (const name of ["put", "list"]) {
  test(`a publish whose ${name} never answers rejects at its time limit, and the next publish is not blocked`, async () => {
    const { ctx, clock, context } = make()
    const entry = ctx.session.instructions.entry
    const original = entry[name]
    entry[name] = NEVER
    const first = context.context("binding one")
    await flush()
    assert.equal(armed(clock).length, 1)
    armed(clock)[0].fn()
    await assert.rejects(first, { code: "CHAT_CONTEXT_UNAVAILABLE" })
    entry[name] = original
    await context.context("binding two") // not queued behind the call that never ended
    assert.equal(ctx.entries.get(BINDING_KEY), "binding two")
  })
}

test("a removal that never answers ends at its time limit without an error, and the queue goes on", async () => {
  const { ctx, clock, context } = make()
  await context.context("binding")
  const entry = ctx.session.instructions.entry
  const remove = entry.remove
  entry.remove = NEVER
  const cleared = context.context(null)
  await flush()
  assert.equal(armed(clock).length, 1)
  armed(clock)[0].fn()
  await cleared
  entry.remove = remove
  await context.context("binding two")
  assert.equal(ctx.entries.get(BINDING_KEY), "binding two")
})

// A call that ran out of time is not cancelled, so it may still land. A put that lands late can overwrite a newer binding,
// and a removal that lands late can delete one. Landing late owes the read-back again. A read changes nothing.
test("a put that lands after its time limit owes the read-back again, so a newer binding is not left overwritten", async () => {
  const { ctx, clock, context } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "put") // the repair's put waits
  const read = context.repair()
  await flush()
  assert.equal(held.entered, true)
  assert.equal(armed(clock).length, 1)
  armed(clock)[0].fn() // it runs out of time
  assert.equal(await read, false)
  await context.context("binding two") // a rejoin publishes a newer binding, and it is confirmed
  assert.equal(context.owed(), false)
  held.settle.resolve() // the late put lands: it writes the old text over the new one
  await flush()
  assert.equal(ctx.entries.get(BINDING_KEY), "binding")
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding two")
})

test("a removal that lands after its time limit owes the read-back again, so a newer binding is not left deleted", async () => {
  const { ctx, clock, context } = make()
  await context.context("binding")
  const held = holdFirst(ctx.session.instructions.entry, "remove") // a rejoin withdraws the binding, and the removal waits
  const cleared = context.context(null)
  await flush()
  assert.equal(held.entered, true)
  assert.equal(armed(clock).length, 1)
  armed(clock)[0].fn()
  await cleared
  await context.context("binding two") // the newer binding is confirmed
  assert.equal(context.owed(), false)
  held.settle.resolve() // the late removal lands: it deletes the new entry
  await flush()
  assert.equal(ctx.entries.has(BINDING_KEY), false)
  assert.equal(context.owed(), true)
  assert.equal(await context.repair(), true)
  assert.equal(ctx.entries.get(BINDING_KEY), "binding two")
})

for (const end of ["disable", "dispose"]) {
  test(`a binding put that lands after its time limit, once the context is ${end}d, is removed again`, async () => {
    const { ctx, clock, context } = make()
    const held = holdFirst(ctx.session.instructions.entry, "put") // a join's put waits
    const publish = context.context("binding")
    await flush()
    assert.equal(held.entered, true)
    armed(clock)[0].fn() // it runs out of time: the join fails
    await assert.rejects(publish, { code: "CHAT_CONTEXT_UNAVAILABLE" })
    context[end]() // chat is off for this session
    const removals = ctx.calls.remove.length
    held.settle.resolve() // the late put lands
    await flush()
    await flush()
    assert.equal(ctx.calls.remove.length, removals + 1)
    assert.equal(ctx.entries.has(BINDING_KEY), false)
  })
}

test("a list that answers after its time limit owes nothing, because a read changes nothing", async () => {
  const { ctx, clock, context } = await gapped()
  const held = holdFirst(ctx.session.instructions.entry, "list")
  const read = context.repair()
  await flush()
  assert.equal(armed(clock).length, 1)
  armed(clock)[0].fn()
  assert.equal(await read, false)
  assert.equal(await context.repair(), true) // a second check proves it
  held.settle.resolve() // the first check's list answers late
  await flush()
  assert.equal(context.owed(), false)
})
