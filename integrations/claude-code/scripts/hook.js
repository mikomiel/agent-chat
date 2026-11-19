// Entry point for every hook in hooks/hooks.json: `node hook.js <command>`.
import { nodeIo, runHook } from "../lib/hook.js"

const code = await runHook(process.argv[2], nodeIo()).catch(() => 0)
process.exit(code)
