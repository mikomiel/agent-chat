// The product core owns the rejoin policy; this module mirrors it for the one
// lifecycle that runs in a Node process. `test/policy.test.js` reads the
// constants back from `agent_chat/models.py`, so drift fails CI instead of
// changing behaviour silently.
export const REJOIN_CODES = new Set(["STALE_INSTANCE", "SERVICE_UNAVAILABLE", "TRANSPORT_UNAVAILABLE", "REQUEST_UNCERTAIN"])
export const REJOIN_BACKOFF_BASE_MS = 5_000
export const REJOIN_BACKOFF_CAP_MS = 120_000
export const REJOIN_JITTER_MIN = 0.5
export const REJOIN_EPISODE_MS = 7_200_000
export const REJOIN_PER_HOUR = 3
export const REJOIN_BUDGET_WINDOW_MS = 3_600_000

const refusal = code => Object.assign(new Error(code), { code })

export function createRejoinPolicy({ now = Date.now, random = Math.random } = {}) {
  let episodeStartedAt = null
  let attempt = 0
  const completed = []

  function next(code) {
    if (!REJOIN_CODES.has(code) && code !== "BINDING_CONFLICT") throw refusal("CHAT_LIFECYCLE_FAILED")
    const current = now()
    if (episodeStartedAt === null) episodeStartedAt = current
    while (completed.length && completed[0] < current - REJOIN_BUDGET_WINDOW_MS) completed.shift()
    if (completed.length >= REJOIN_PER_HOUR) throw refusal("REJOIN_BUDGET")
    if (current - episodeStartedAt >= REJOIN_EPISODE_MS) throw refusal("REJOIN_WINDOW")
    const delay = Math.min(REJOIN_BACKOFF_CAP_MS, REJOIN_BACKOFF_BASE_MS * 2 ** attempt) *
      (REJOIN_JITTER_MIN + (1 - REJOIN_JITTER_MIN) * random())
    if (current + delay >= episodeStartedAt + REJOIN_EPISODE_MS) throw refusal("REJOIN_WINDOW")
    attempt += 1
    return delay
  }

  // Called on entry to a scheduled retry as well as when it was scheduled: an
  // event-loop delay must not let a retry outlive the episode it belongs to.
  function check() {
    if (episodeStartedAt !== null && now() - episodeStartedAt >= REJOIN_EPISODE_MS) throw refusal("REJOIN_WINDOW")
  }

  function succeeded() {
    // Only a rejoin that followed an episode counts against the budget; the
    // initial join is not a rejoin.
    if (episodeStartedAt !== null) completed.push(now())
    while (completed.length && completed[0] < now() - REJOIN_BUDGET_WINDOW_MS) completed.shift()
    episodeStartedAt = null
    attempt = 0
  }

  return { next, check, succeeded }
}
