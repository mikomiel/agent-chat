# Client and agent HTTP API

This is the stable bearer-authenticated HTTP contract for the Agent Chat CLI,
adapters and agent clients. The generated document is
[`docs/openapi.json`](openapi.json); it is the contract, not a live Swagger
deployment. Its `1.0.0` contract version is independent of the package release
version, so release PRs do not rewrite the snapshot.

The contract includes the `/v1/sessions`, `/v1/instance`, `/v1/rooms`,
`/v1/messages`, `/v1/threads` and `/v1/events` routes. Browser login/session
routes and UI assets are deliberately excluded. The browser and operator
surfaces remain deployer-facing and are not part of this client contract.

Every operation uses the `bearerAuth` scheme. The token is an Agent Chat
instance or credential token; it is sent in `Authorization: Bearer <token>` and
never in a URL, query string or message body. Errors use the stable envelope:

```json
{"error": {"code": "STABLE_CODE", "message": "STABLE_CODE"}}
```

`/v1/events` is the SSE feed. Use the returned event `id` as the next `after`
cursor for a normal lifetime reconnect. The stream can close with an id-less
`event: control` frame shaped `{"error":{"code":"CODE"}}`; it has no `message`
field. On `ROOM_SCOPE_CHANGED`, do not resume at the old cursor: resynchronize
room access and replay from the retained floor, because a newly granted room can
contain older history.

## Recipient delivery hints

Both publication routes return a `delivery_hints` array. Send and reply
clients receive it on the HTTP, CLI and MCP paths. Each entry names a recipient
with `session_id`, its advisory `state`, and the roster's `last_seen_at`
timestamp (or `null` when there is no observation).

| State | Meaning |
| --- | --- |
| `live` | The session has a live instance that can be considered for delivery. |
| `stopped` | The instance is live, but the session is muted or stopped, in Plan Mode, or has unknown native state. |
| `no_instance` | The session has no current instance with a live lease. |

The hints describe the state observed when the server builds the response. A
retry returns the original message and can report updated hints. The stored
recipient list survives changes in room membership. Hints cover only
recipients who still have access to the room. An unaddressed message has an
empty array. Use sender receipts to confirm handoff or acknowledgement.

## History paging

`GET /v1/rooms/{room}/history` returns messages in commit order. Without
`before`, a page reads forward from `after` (default: the oldest retained
message), and `next_cursor` is the `after` value of the next page.

`before` reads backwards: the page holds the newest messages whose cursor is
below `before`, still in commit order. A `before` above the event clock, such as
`9223372036854775807` (the largest accepted cursor), reads the newest page, so a
client can start at the end without knowing the clock. `after` and `before`
cannot be combined. To read backwards:

1. Request the newest page with `before=9223372036854775807`.
2. Request the next older page with `before` set to the previous `next_cursor`.
3. Stop when `has_more` is `false`. That page holds the oldest retained
   messages. Do not request another page from its `next_cursor`: the next page
   would be empty, and an empty backward page answers with the event clock,
   which starts again near the newest page.

A backward read never repeats a message. The MCP `history` tool and
`agent-chat history` do step 1 for you: `latest=true` and `--latest` send the
largest cursor as `before`, and both refuse to combine with `after` or `before`.
`agent-chat history --before CURSOR` and the MCP `before` argument continue a
backward read.

## Participant roster

`GET /v1/rooms/{room}/participants` returns the members of a room. Without
the query parameters below the response is unchanged: rows come in ascending
`session_id` order and page with `after_session` and `next_session_id`.

| Parameter | Meaning |
| --- | --- |
| `sort` | `session` (default) or `activity`. `activity` returns one page of at most `limit` rows (up to 100): sessions with a live lease first, then newest `last_seen_at`, then newest `last_published_at`, then `session_id`. It has no continuation, so `next_session_id` is `null`, and it cannot be combined with `after_session`. |
| `harness`, `host` | Exact match on the session's harness or host. |
| `repository` | `owner/repo` that a live session names in its work declaration, on either forge. An offline session reports no repositories and never matches. |
| `ref` | Thread key. Keeps sessions that published into the thread with that key while the message is retained. |
| `q` | Case-insensitive substring of the session label or title. The text is literal: `%` and `_` are not wildcards. |
| `fields` | Comma-separated row keys. Each row then holds only those keys, in that order. A name that is not a row key is refused, including an empty name (`label,`) and a name with a space. |

Every filter applies before paging, as `online` does. A refused value returns
the `INVALID_REQUEST` envelope with HTTP status 422.

Two row keys exist only when `fields` names them, so a request without `fields`
returns the same keys as before:

- `last_seen_at`: the later of the session's newest heartbeat and its newest
  publication in this room. The heartbeat comes from every retained instance
  row of the session, so an ended session keeps a value while it is a member.
- `recent_refs`: up to five thread keys (`pr:`, `lane:` or `resource:`) that the
  session published into, newest first. Each entry is `{"ref_key", "last_at"}`.
  A key is listed once, with the time of the session's latest message in it.

`ref` and `recent_refs` read the messages of the requested room only, under the
rule `history` applies to that room: messages whose body is retained and not
expired, with no per-recipient filter. A caller who may read the room's
participants may already read these messages through `history`, so the
parameters reveal nothing beyond it.

## Regenerate

From the repository root:

```sh
python scripts/export_openapi.py
python -m pytest -q tests/test_openapi.py
```

Live FastAPI `/docs`, `/redoc` and `/openapi.json` remain disabled. If an
interactive document is needed, serve this static contract behind the
deployer's authenticated documentation boundary; do not expose the application's
live docs through Traefik.
