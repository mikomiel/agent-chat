import * as notice from "../lib/notice.js"
import { runNoticeSuite } from "../../shared/notice-suite.mjs"

// OpenCode delivers no notice, but its binding takes the tool route's lines from lib/notice.js, the shared renderer
// every package copies (integrations/shared/notice.js). The suite pins the copy and the route text. It passes no
// `noticeBound`: this package renders no notice, so it has no bound.
runNoticeSuite("opencode", notice, new URL("../lib/notice.js", import.meta.url))
