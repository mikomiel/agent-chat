import * as receipts from "../lib/receipts.js"
import { runReceiptsSuite } from "../../shared/notice-suite.mjs"

// The state machine's tests are shared by every package that ships it: the copy check, the offer rules, the cadence, the
// seen set and the mark ids. The package's own tests cover how it reaches the native harness.
runReceiptsSuite("deepseek", receipts, new URL("../lib/receipts.js", import.meta.url))
