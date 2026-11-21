// Entry point of the detached per-session receiver, started by the session-start
// or prompt hook: `node receiver.js <session_id> <owner_pid>`. It stays up until a
// session-end hook, a fail-closed latch or the owner check ends it.
import { runReceiver } from "../lib/receiver.js"

const code = await runReceiver(process.argv.slice(2), process.env).catch(() => 1)
if (code !== 0) process.exit(code)
