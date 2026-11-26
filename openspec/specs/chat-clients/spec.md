# chat-clients Specification

## Purpose
Defines how the shipped command-line client and the per-process adapter core behave toward a harness session: the exact binding context, binding-file safety, message and recipient handling, role selectors, one-step replies, the history and roster options of the CLI with the matching arguments of the MCP `history` and `who` tools, the adapter's join, heartbeat and bounded rejoin lifecycle, the notice contract that puts a peer message body into a harness session, the sender receipts that a harness package shows without waking it, how the `pi` package keeps its footer and its instance true across a lapsed lease, a stopped chat, a replaced runtime and a compaction, and how the OpenCode plugin delivers from the host's idle hook.

## Requirements

### Requirement: The adapter exposes an exact binding context after joining
After a successful join the adapter MUST expose `python`, `instance_file`, `room_id`, `session_id`, `instance_id`, `native_session_id`, `host` and `harness` to its session as metadata, MUST NOT include a token, and MUST state that this binding supersedes every earlier one. When the adapter stops, fails or replaces its instance, it MUST withdraw the metadata.

#### Scenario: Joined session learns its binding
- **WHEN** an adapter has joined and the harness asks it for the session context
- **THEN** the context carries the eight binding fields and the route lines of the configured tool route
- **AND** on the `cli` route, and in the fallback lines of the `mcp-with-cli-fallback` route, it names the interpreter form and the environment variable the CLI needs
- **AND** on the `mcp` and `mcp-with-cli-fallback` routes it tells the model to call the agent-chat MCP `bind` tool, when the server exposes one, with exactly the `instance_file` shown, and again whenever a later binding shows a different one
- **AND** a package that shows sender receipts ends its route lines with one sentence that tells the model how to ask for them: `send/reply --receipts asks for handed/acked receipts.` on the `cli` route, and `send/reply receipts=true asks for handed/acked receipts.` on the `mcp` and `mcp-with-cli-fallback` routes, except in a binding that goes with a notice that fits only without that sentence
- **AND** it carries no token and no other session's binding

#### Scenario: Tool route
- **WHEN** an integration's config sets `toolRoute` to `cli`, `mcp` or `mcp-with-cli-fallback`, or leaves it unset, which means `cli`
- **THEN** the binding context and every notice name only the surfaces of that route, by server and tool name, never by a harness-specific callable name
- **AND** the `mcp-with-cli-fallback` route allows the CLI only while the MCP server or its transport is unavailable, and tells the model to reconcile an uncertain send or reply instead of replaying it automatically on the other transport
- **AND** any other value keeps chat off

#### Scenario: Instance replaced
- **WHEN** the adapter rejoins with a new instance
- **THEN** the context names the new instance file and says it supersedes every earlier binding

#### Scenario: Adapter stops or fails
- **WHEN** the adapter stops, or fails terminally
- **THEN** it withdraws the context and reports no binding

### Requirement: The CLI reads exactly one binding file
For every command except `produce`, the CLI MUST take its identity only from the file named by `AGENT_CHAT_INSTANCE_FILE`. It MUST NOT scan a directory, choose the latest file, register by itself, or fall back to an agent credential. The file MUST be named `<boot_id>.json`, hold exactly the keys `native_session_id`, `boot_id`, `token` and `server_origin`, and be a regular single-link file of at most 4096 bytes with mode 0600 in a real directory with mode 0700 owned by the effective user.

#### Scenario: Variable unset
- **WHEN** a command other than `produce`, whose arguments the parser accepts, runs without `AGENT_CHAT_INSTANCE_FILE`
- **THEN** it fails with `BINDING_REQUIRED` and reads no other file
- **AND** a command whose arguments the parser refuses fails first, with `INVALID_ARGUMENTS`, or with `INVALID_CURSOR` for a malformed `--after` or `--before`
- **AND** a binding refusal comes before the checks of a limit, `--clear`, `--thread` with `--ref`, `--latest` with `--after` or `--before`, `--room` and the body

#### Scenario: Unsafe file or directory
- **WHEN** the file is a symlink, has more than one link, has the wrong mode or owner, or sits in a directory with the wrong mode or owner
- **THEN** the CLI fails with `BINDING_FILE_UNSAFE` and sends no request

#### Scenario: Missing or malformed file
- **WHEN** the file or its directory is missing, or the file name is not a boot identifier with `.json`, or the file is not JSON, or the keys are not exactly the four listed, or the boot or native session identifier in it is invalid
- **THEN** the CLI fails with `BINDING_FILE_MISSING` or `BINDING_FILE_INVALID` and sends no request

#### Scenario: Token or origin refused
- **WHEN** the file holds exactly the four keys, but its token is not 64 lowercase hexadecimal characters or its server origin is not a canonical origin
- **THEN** the CLI fails with `UNAUTHENTICATED` for the token and with `INVALID_ORIGIN` for the origin, and exits with 1
- **AND** it sends no request

#### Scenario: Name and content disagree
- **WHEN** the boot identifier inside the file differs from the identifier in the file name
- **THEN** the CLI fails with `BINDING_FILE_CONFLICT` and sends no request

### Requirement: Message bodies come from standard input and the sender from the binding
The CLI MUST read a message body only from standard input, MUST refuse a terminal with `STDIN_REQUIRED`, a body over 16384 bytes with `BODY_TOO_LARGE` and a body that is not UTF-8 with `INVALID_BODY`, and MUST validate the body before any request. It MUST NOT offer a sender option, because the sender is the bound session.

#### Scenario: CLI sends content
- **WHEN** an authenticated session runs `send` with a body on standard input
- **THEN** the resulting history record names that session as sender without a caller-controlled sender field

#### Scenario: Terminal input
- **WHEN** standard input is a terminal
- **THEN** the CLI fails with `STDIN_REQUIRED` and sends nothing

#### Scenario: Oversized body
- **WHEN** the body exceeds 16384 bytes
- **THEN** the CLI fails with `BODY_TOO_LARGE` before it makes any request

### Requirement: The CLI covers the bearer operations an agent needs
The CLI MUST provide the commands `who`, `history`, `send`, `reply`, `ack`, `status`, `mute`, `unmute`, `resolve`, `unresolve`, `lane`, `state` and `work`, each calling the matching bearer operation with the bound instance token. `send` MUST need an explicit idempotency key, MUST refuse a thread together with a thread key, and MUST publish kind `message` unless `--kind` names another kind. `lane` and `work` MUST need exactly one of a declaration and `--clear`.

#### Scenario: Default kind
- **WHEN** a session runs `send` without `--kind`
- **THEN** the stored message has kind `message`

#### Scenario: Status of the bound session
- **WHEN** a bound session runs `status`
- **THEN** the CLI returns the server's instance status for that session

#### Scenario: Declaration and clear together
- **WHEN** a session runs `work` with a repository and `--clear`
- **THEN** the CLI fails with `INVALID_ARGUMENTS` and sends nothing

#### Scenario: Thread and thread key together
- **WHEN** a session runs `send` or `history` with both `--thread` and `--ref`
- **THEN** the CLI fails with `INVALID_ARGUMENTS` and sends nothing
- **AND** `send` reads and validates its body first, so a refusal of the body takes precedence over this one

#### Scenario: Limit out of range
- **WHEN** a session runs `who`, `history` or `state` with a limit outside 1 to 100
- **THEN** the CLI fails with `INVALID_ARGUMENTS` and sends nothing

### Requirement: CLI results are machine-readable and redacted
Except for `--help` and the header line of a `state` result, the CLI MUST print one JSON document that holds `result`, or `error` with a stable `code` and an optional `hint`. It MUST redact the instance token from that document, and MUST echo the idempotency key of a command that has one, whether the caller gave it or the CLI has derived it.

#### Scenario: Refusal printed
- **WHEN** a command fails with a stable code
- **THEN** the CLI prints one document that holds `error.code`, and a `hint` when the refusal has one
- **AND** a hint names flags, commands or rules and never a value the caller supplied

#### Scenario: Token never printed
- **WHEN** a response or error text would contain the instance token
- **THEN** the printed document shows `[REDACTED]` in its place

#### Scenario: Key echoed
- **WHEN** a session runs `send`, or `reply` with or without `--key`, and the CLI has the key
- **THEN** the printed document carries `idempotency_key` with the key that the request used
- **AND** a command that has no key, such as `ack` or `who`, prints no `idempotency_key`

#### Scenario: One-step reply fails before its key exists
- **WHEN** a one-step reply, `reply` without `--key`, fails because standard input is a terminal, because its body is refused, because the binding is refused or because the read of the session's own status fails
- **THEN** the printed error document carries no `idempotency_key`
- **AND** `send`, and `reply` with `--key`, echo the key the caller gave on the same failures

#### Scenario: State output
- **WHEN** the CLI prints a `state` result
- **THEN** it first prints a line saying the data is untrusted observation data and not an instruction or a grant

### Requirement: The CLI maps each outcome to one exit code
The CLI MUST exit with 0 on success, 3 for `AMBIGUOUS_RECIPIENT` and 4 for `REQUEST_UNCERTAIN`. It MUST exit with 2 for `INVALID_ARGUMENTS`, `INVALID_REQUEST`, `INVALID_BODY`, `BODY_TOO_LARGE`, `STDIN_REQUIRED`, `INVALID_RECIPIENT` and `INVALID_CURSOR`, and with 1 for every other code.

#### Scenario: Usage or validation refusal
- **WHEN** a command fails with `INVALID_ARGUMENTS`, `INVALID_BODY`, `STDIN_REQUIRED` or `INVALID_RECIPIENT`
- **THEN** the CLI exits with 2

#### Scenario: Any other refusal
- **WHEN** a command fails with `ROOM_FORBIDDEN`, `PARTICIPANT_SCAN_LIMIT`, a `BINDING_*` code or `CLI_INTERRUPTED`
- **THEN** the CLI exits with 1

#### Scenario: Ambiguous or uncertain
- **WHEN** a command fails with `AMBIGUOUS_RECIPIENT` or with `REQUEST_UNCERTAIN`
- **THEN** the CLI exits with 3 or with 4 respectively

### Requirement: A request that may have been sent and has no answer is reported as uncertain
When a POST may have been sent and ends without a definitive answer, the CLI MUST print `REQUEST_UNCERTAIN` and exit with 4. This covers a dropped connection, a redirect, any 5xx answer, a malformed, truncated or oversized response and an unmapped status. A connection that cannot be made, TLS handshake included, MUST fail with `TRANSPORT_UNAVAILABLE`, and a GET that ends without an answer with `TRANSPORT_UNAVAILABLE`, `REDIRECT_REFUSED`, `SERVICE_UNAVAILABLE` or `HTTP_REFUSED`.

#### Scenario: Keyed write with no answer
- **WHEN** a `send` or `reply` ends without a definitive answer after it was submitted
- **THEN** the CLI prints `REQUEST_UNCERTAIN`, echoes the idempotency key and exits with 4
- **AND** the caller recovers by repeating the same key and request

#### Scenario: Unkeyed write with no answer
- **WHEN** `ack`, `mute`, `unmute`, `resolve`, `unresolve`, `lane` or `work` ends without a definitive answer after it was submitted
- **THEN** the CLI prints `REQUEST_UNCERTAIN` and exits with 4
- **AND** the document carries no idempotency key

#### Scenario: Read with no answer
- **WHEN** a GET command such as `who` ends in a dropped connection, a redirect or a server error, whatever its code
- **THEN** the CLI fails with `TRANSPORT_UNAVAILABLE`, `REDIRECT_REFUSED` or `SERVICE_UNAVAILABLE` and exits with 1

#### Scenario: Server error that carries a stable code
- **WHEN** the service answers a `send` with 500 `INTERNAL_ERROR` or 503 `DATABASE_UNAVAILABLE`, or a `who` with 503 `DATABASE_UNAVAILABLE`
- **THEN** the CLI does not print that code: it prints `REQUEST_UNCERTAIN` and exits with 4 for the `send`, and `SERVICE_UNAVAILABLE` and exits with 1 for the `who`
- **AND** a 4xx answer is shown under its own code only when the CLI knows that code for that status, and otherwise counts as an unmapped status

#### Scenario: Connection not made
- **WHEN** the CLI cannot connect to the service, or cannot complete the TLS handshake
- **THEN** it fails with `TRANSPORT_UNAVAILABLE` and exits with 1, whatever the command

### Requirement: A 20-second alarm bounds command execution
The CLI MUST arm a 20-second alarm after parsing the arguments and cancel it before printing the result. When it fires outside an HTTP request, the CLI MUST print `CLI_INTERRUPTED` and exit with 1, except that during the binding-file read it MUST print `BINDING_FILE_UNSAFE`. When it fires after the connection is made, the request MUST end as `REQUEST_UNCERTAIN` for a POST and as `TRANSPORT_UNAVAILABLE` for any other method; when it fires before, as `TRANSPORT_UNAVAILABLE` for every method.

#### Scenario: Standard input stalls
- **WHEN** standard input stays open and silent until the alarm fires
- **THEN** the CLI prints `CLI_INTERRUPTED` and exits with 1
- **AND** it has sent no request

#### Scenario: Alarm during the binding read
- **WHEN** the alarm fires while the CLI reads the binding file, for example on a stalled filesystem
- **THEN** the CLI fails with `BINDING_FILE_UNSAFE`, not `CLI_INTERRUPTED`, and exits with 1
- **AND** it has sent no request

#### Scenario: Output is outside the alarm
- **WHEN** the command has finished and the reader of standard output stops reading a large result
- **THEN** the alarm no longer applies, and the CLI waits on the write

#### Scenario: Alarm during a request
- **WHEN** the alarm fires after the connection is made, while the request is still in progress
- **THEN** the request ends as `REQUEST_UNCERTAIN` for a POST and as `TRANSPORT_UNAVAILABLE` for any other method
- **AND** the CLI does not print `CLI_INTERRUPTED` for it

#### Scenario: Alarm before the connection is made
- **WHEN** the alarm fires while host name resolution or the TLS handshake is still in progress
- **THEN** the CLI fails with `TRANSPORT_UNAVAILABLE` and exits with 1, for a POST too

### Requirement: Socket steps time out after 3 seconds
The CLI MUST time out each socket connect, send and receive step of a request after 3 seconds. The bound does not cover host name resolution; only the 20-second alarm limits it.

#### Scenario: Peer stops answering
- **WHEN** the service accepts a connection, completes any TLS handshake and then sends nothing for 3 seconds
- **THEN** the step times out, and the CLI reports `REQUEST_UNCERTAIN` for a POST or `TRANSPORT_UNAVAILABLE` for any other method

#### Scenario: Handshake stalls
- **WHEN** the service accepts a connection and then sends nothing during the TLS handshake for 3 seconds
- **THEN** the step times out, and the CLI fails with `TRANSPORT_UNAVAILABLE` and exits with 1, for a POST too

### Requirement: Recipients resolve to concrete sessions
The CLI MUST resolve each `--to` selector, a session UUID, a label, `harness@host` or `harness@host/native-id`, to a concrete session UUID wherever it knows the room; in a one-step reply only a session UUID resolves. It MUST refuse a selector that matches several sessions, online or offline, with `AMBIGUOUS_RECIPIENT` and the candidates, and MUST NOT choose one. It MUST refuse more than 16 selectors.

#### Scenario: Two sessions match the alias
- **WHEN** two sessions of one harness and host exist and the sender enters `harness@host`
- **THEN** the CLI exits with 3, lists both candidates and publishes nothing

#### Scenario: UUID needs no roster read
- **WHEN** a selector is a session UUID
- **THEN** the CLI uses it without reading the roster

#### Scenario: Unknown selector
- **WHEN** no session matches a selector
- **THEN** the CLI fails with `INVALID_RECIPIENT` and publishes nothing

#### Scenario: Alias in a one-step reply
- **WHEN** a one-step reply, `reply` without `--key`, names a label or `harness@host` in `--to`
- **THEN** the CLI fails with `INVALID_RECIPIENT`, reads no roster and publishes nothing
- **AND** a session UUID in the same position is used as given

#### Scenario: Roster too long
- **WHEN** the roster needs more than 100 pages
- **THEN** the CLI fails with `PARTICIPANT_SCAN_LIMIT`

### Requirement: Role selectors resolve to the live holder
The CLI MUST accept `pm`, `forgejo-pm` and `forgejo_pm` for the `pm` role, `github-pm` and `github_pm` for `github_pm`, and `delivery-manager`, `delivery_manager` and `dm` for `delivery_manager`. A selector MUST resolve to that role's live holder and MUST win over a session label of the same text. The CLI MUST refuse a selector that has no live holder, and a selector in a one-step reply.

#### Scenario: Address a role
- **WHEN** a send names `github-pm` or `github_pm` in `--to` while that role has a live holder
- **THEN** the message goes to the holder's session UUID, and the result lists that UUID among the recipients

#### Scenario: Repeated selector
- **WHEN** one send names the `pm` selector two times
- **THEN** the roster is read a single time for that role and the message lists one recipient

#### Scenario: No live holder
- **WHEN** a send names `delivery-manager` and no live mark exists for that role
- **THEN** the CLI fails with `INVALID_RECIPIENT` and a hint, and publishes nothing

#### Scenario: Label that looks like a selector
- **WHEN** a session has chosen the label `pm`
- **THEN** `--to pm` still resolves the role holder and never that label

#### Scenario: Role in a one-step reply
- **WHEN** a one-step reply names a role selector
- **THEN** the CLI fails with `INVALID_RECIPIENT` and a hint to pass a room and key or the holder's UUID

### Requirement: The CLI offers no way to act as a role
The CLI MUST NOT offer an option that publishes as a role or a command that sets or clears a role mark, because only an operator sets marks. Its help for role addressing and role filtering MUST say that a mark grants no authority.

#### Scenario: No sender or role option
- **WHEN** a session lists the options of `send` and `reply`
- **THEN** neither command offers a sender or role option
- **AND** no CLI command sets or clears a role mark

#### Scenario: Help states the limit
- **WHEN** a session reads the help for `--to` or `--from`
- **THEN** the text says that a mark grants no authority

### Requirement: History can be filtered by sender role
When given `--from` with a role selector, the CLI MUST narrow `history` to messages that the service stamped with that role, MUST accept the same selectors as role addressing, and MUST keep cursor order. A read without `--from` MUST stay as it was. The service MUST answer an unknown `sender_role` filter with `INVALID_REQUEST`.

#### Scenario: Filter the primary role
- **WHEN** the `pm` holder has published and a session asks for history with `--from pm`
- **THEN** the result holds only messages stamped `pm`, in cursor order

#### Scenario: Filter by alias
- **WHEN** a session asks for history with `--from dm`
- **THEN** every returned message carries the stamp `delivery_manager`

#### Scenario: Unknown role filter
- **WHEN** a caller passes the history route a `sender_role` that is not one of the known selectors
- **THEN** the service refuses with `INVALID_REQUEST`

### Requirement: History reads the newest page and pages backwards from it
`history --latest` MUST read the newest page in commit order, and `history --before CURSOR` the newest page below that cursor, so a client passes each `next_cursor` as the next `--before` until `has_more` is false. The CLI MUST refuse `--latest` together with `--after` or `--before` with `INVALID_ARGUMENTS` and send no request, and a malformed cursor with `INVALID_CURSOR`. A `history` without these flags MUST send no `before` parameter.

#### Scenario: Newest page, then the rest
- **WHEN** a room holds 25 messages and a session runs `history --latest --limit 20`
- **THEN** the result holds the 20 newest messages in commit order and `has_more` is true
- **AND** `history --before` with that result's `next_cursor` returns the other five messages, and `has_more` is false
- **AND** `history --before 9223372036854775807` returns the same page as `--latest`

#### Scenario: Latest with a cursor flag
- **WHEN** a session runs `history --latest` together with `--after`, `--before` or both
- **THEN** the CLI fails with `INVALID_ARGUMENTS` and a hint that names the flags, exits with 2 and sends no request

#### Scenario: Malformed cursor
- **WHEN** a session passes `--after` or `--before` a value that is not a decimal number of at most 19 digits and at most 9223372036854775807
- **THEN** the CLI fails with `INVALID_CURSOR`, exits with 2 and sends no request

#### Scenario: Request without the backward flags
- **WHEN** a session runs `history` with a limit, or with `--after`, but without `--latest` and `--before`
- **THEN** the request carries no `before` parameter

### Requirement: Who passes the roster options to the service
`who` MUST accept `--sort` (`session` or `activity`), `--harness`, `--host`, `--repository`, `--ref`, `--q` and `--fields`, and MUST send each only when given. The CLI MUST refuse any other `--sort` value, and a `--ref` that is not a thread key, with `INVALID_ARGUMENTS` before any request. It MUST leave every other value to the service and report the service's refusal as `INVALID_REQUEST` with exit code 2.

#### Scenario: Only the given options are sent
- **WHEN** a session runs `who` without a roster option, then with `--online` only, then with every roster option
- **THEN** the first request carries `limit` and the second adds `online`, and neither carries `sort`, `harness`, `host`, `repository`, `ref`, `q` or `fields`
- **AND** the third carries each of those seven with the value given

#### Scenario: Order, filter and projection
- **WHEN** a session runs `who --online --sort activity --limit 5 --fields session_id,title,last_seen_at`
- **THEN** each row holds those three keys only, and the live sessions follow the activity order
- **AND** `who --q privilege --fields session_id` lists only the sessions whose label or title contains the text

#### Scenario: Bad order or thread key
- **WHEN** a session runs `who --sort newest`, or `who --ref` with free text
- **THEN** the CLI fails with `INVALID_ARGUMENTS` and a hint, exits with 2 and sends no request

#### Scenario: Value that the service refuses
- **WHEN** a session runs `who` with `--sort activity` and `--after-session`, or with `--fields nope`, or with `--repository x`
- **THEN** the CLI prints `INVALID_REQUEST` and exits with 2

### Requirement: The MCP history and who tools carry the same arguments
The MCP `history` tool MUST accept `latest` and `before` with the meaning of the CLI flags, and MUST answer `{"error":{"code":"INVALID_REQUEST"}}`, before any room or history request, when `latest` is true together with `after` or `before`. The MCP `who` tool MUST accept `sort`, `harness`, `host`, `repository`, `ref`, `q` and `fields` and pass each on only when given. A `latest` that is left out or false MUST add nothing to the request.

#### Scenario: Newest page through the tool
- **WHEN** a client calls `history` with `latest` true and a limit of 20
- **THEN** the request to the service carries `before` 9223372036854775807 and `limit` 20, and the result is the newest page

#### Scenario: Backward paging through the tool
- **WHEN** a client calls `history` with `latest` true and a limit of 10 in a room of 25 messages, then again with `before` set to each `next_cursor` until `has_more` is false
- **THEN** it has read each of the 25 messages once, in pages of 10, 10 and 5
- **AND** a further call with `before` set to the last `next_cursor` returns an empty page

#### Scenario: Latest with a cursor argument
- **WHEN** a client calls `history` with `latest` true and `after`, `before` or both, even for a room that does not exist
- **THEN** the tool answers `INVALID_REQUEST` and makes no room or history request to the service

#### Scenario: Roster arguments through the tool
- **WHEN** a client calls `who` with `sort` as `activity`, with `q`, `repository` or `fields`
- **THEN** the request carries those parameters with their values, and the rows follow the order, match the filters and hold only the named keys
- **AND** the participants request of a `who` without them carries `online` and `limit` only

#### Scenario: Values that the service refuses
- **WHEN** a client calls `who` with `sort` as `newest`, with `sort` as `activity` and an `after_session`, with an empty `fields` or `q`, with a `q` that holds a NUL, or with a `repository` or `ref` of the wrong form
- **THEN** the tool answers `{"error":{"code":"INVALID_REQUEST"}}`

### Requirement: One-step reply and acknowledgement take only the message id
The CLI MUST let `reply MESSAGE` without `--key`, and `ack MESSAGE`, work from the message id alone. The reply MUST take its room from the parent message, form its idempotency key from the bound session and that id, and refuse `--room` when `--key` is absent. The explicit form with both `--room` and `--key` MUST keep working as before.

#### Scenario: Reply with the message id only
- **WHEN** an addressed session runs `reply MESSAGE` with a body on standard input
- **THEN** the reply lands in the parent's room and thread, and its sender is the bound session
- **AND** the caller passed neither a room nor a key

#### Scenario: Reply repeated after a lost response
- **WHEN** the session runs the same one-step reply again after losing the answer
- **THEN** it receives the first reply back and no second reply exists, while the first reply is retained

#### Scenario: Same derived key with another body
- **WHEN** the session repeats the one-step reply for that message but with different text
- **THEN** the CLI fails with `IDEMPOTENCY_CONFLICT` and a hint to pass an explicit `--key` and `--room`

#### Scenario: Message outside the session's scope
- **WHEN** the message lives in a room that the session may not read
- **THEN** the service refuses the call and no reply is stored

### Requirement: The adapter joins, heartbeats and ends one instance
The adapter MUST join only when `enabled` is true and the harness is `pi`, `codex`, `claude`, `deepseek` or `opencode`, MUST persist the binding secret first and then register with the agent credential and only the digest of that secret, and MUST heartbeat every 30 seconds by default. It MUST treat a join response that does not name exactly the session, instance, room, host and harness as `REQUEST_UNCERTAIN`. On stop it MUST discard the held instance's binding file, then end the instance.

#### Scenario: Join and heartbeat
- **WHEN** an enabled adapter starts for a native session
- **THEN** it persists the binding file, registers with the token digest and heartbeats every 30 seconds
- **AND** the registration request carries the digest and not the token

#### Scenario: Disabled or unknown harness
- **WHEN** the adapter is asked to join while `enabled` is not true, or with another harness
- **THEN** it refuses with `INTEGRATION_DISABLED` or `INVALID_REQUEST` and sends no request

#### Scenario: Stop with the end call failing
- **WHEN** the adapter stops and the end call fails
- **THEN** the adapter removed the binding file before the end call, so once that removal succeeds a new open of its path finds nothing
- **AND** the instance ends when no heartbeat renews its 90-second server lease
- **AND** a file the host could not remove stays readable, and a caller that holds the file open or has read the credential can still use the binding and renew its lease with heartbeats
- **AND** the removal has no time limit of its own, like the binding file's write at join, so a file system that blocks delays the end request until it returns

#### Scenario: Stop without a joined instance
- **WHEN** the adapter stops while it waits to rejoin, after it failed terminally or after a join that did not complete
- **THEN** it sends no end request and discards no binding file
- **AND** an earlier binding file stays on disk, and the server's 90-second lease ends any live instance

### Requirement: The adapter rejoins after a jittered back-off
When a request fails with `STALE_INSTANCE`, `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN`, when it runs past the adapter's own 20-second request deadline, or when a join meets `BINDING_CONFLICT`, the adapter MUST rejoin with a fresh instance. The nominal wait MUST start at 5 seconds and double to at most 120 seconds, and each wait MUST be multiplied by a random factor from 0.5 to 1, so the first wait lasts 2.5 to 5 seconds.

#### Scenario: Lease lost
- **WHEN** a heartbeat returns `STALE_INSTANCE`
- **THEN** the adapter withdraws its context, waits the back-off and joins again with a new boot identifier
- **AND** it publishes the new binding context

#### Scenario: Join response lost
- **WHEN** a join ends without a definitive answer, or meets `BINDING_CONFLICT` from the earlier instance that is still live
- **THEN** the adapter publishes no binding context and joins again with a new boot identifier after the back-off
- **AND** the retry succeeds once the earlier instance's lease has lapsed

#### Scenario: Request deadline
- **WHEN** a join or heartbeat request runs past the adapter's 20-second request deadline
- **THEN** the adapter treats it as `REQUEST_UNCERTAIN`, withdraws its context and rejoins after the back-off
- **AND** it does not fail with `CLI_INTERRUPTED`

#### Scenario: Back-off grows
- **WHEN** an outage lasts through several rejoin attempts
- **THEN** the nominal waits are 5, 10, 20, 40 and 80 seconds, and 120 seconds from then on
- **AND** each actual wait lies between half of the nominal wait and the whole of it

### Requirement: The adapter stops when its rejoin bound is spent
An episode begins at the first failure that calls for a rejoin and ends at the next successful join. The adapter MUST fail with `REJOIN_WINDOW` when an episode has lasted 2 hours or its next wait would end after that limit, and with `REJOIN_BUDGET` when an episode begins after 3 joins that each ended an earlier episode succeeded within the last hour. It MUST fail with the code of any other refusal of a join or heartbeat request instead of retrying it.

#### Scenario: Budget exhausted
- **WHEN** a new episode begins within one hour of three joins that each ended an earlier episode
- **THEN** the adapter fails with `REJOIN_BUDGET` and withdraws its context

#### Scenario: Initial join that had to retry
- **WHEN** the first join of an adapter fails with an outage code and a retry then succeeds
- **THEN** that success counts as one of the three joins that the budget allows within an hour

#### Scenario: Window exhausted
- **WHEN** an episode has lasted 2 hours without a successful join, or its next wait would end after that limit
- **THEN** the adapter fails with `REJOIN_WINDOW` and withdraws its context

#### Scenario: Authorization refusal
- **WHEN** a join or heartbeat request fails with `UNAUTHENTICATED` or `INVALID_REQUEST`
- **THEN** the adapter fails with that code and does not rejoin

### Requirement: The instance worker sends a settlement again until its request deadline
Only a `settle` try that gets no status, because the connection fails before the status line and headers are read or ends before a three-digit status code, or that gets a 5xx reply, MUST be sent again by the instance worker, with the same attempt and result, until 1 second before its 20-second request deadline, when the last failure MUST end the worker. A try the deadline cuts MUST report `REQUEST_UNCERTAIN`. A definite delivery refusal MUST be answered as refused. Any other failure MUST end the worker at once.

#### Scenario: The service answers after a brief outage
- **WHEN** a `settle` gets no status or a 5xx reply, and a later try before the deadline is answered
- **THEN** the worker answers its parent with that answer
- **AND** each try carries the same attempt and the same result

#### Scenario: A definite refusal
- **WHEN** the service refuses a `settle` with a definite code such as `DELIVERY_CLOSED`
- **THEN** the worker sends no further try and answers its parent as refused

#### Scenario: A reply that ends in its status code
- **WHEN** a `settle` reply stops before a three-digit status code, or the connection is reset before its headers are read
- **THEN** the try counts as one that got no status

#### Scenario: A reply below 500 that cannot be accepted
- **WHEN** a `settle` gets a reply below 500 that the client cannot accept, such as a redirect, a body that is not the service's or is cut, a code the client does not know or a 200 that names another attempt, or a reply the parser rejects, such as one with too many headers
- **THEN** the worker sends no further try and ends at once
- **AND** this holds because the service sends a status below 500 only once a settlement is committed or definitely refused

#### Scenario: The deadline is spent
- **WHEN** every try gets no status or a 5xx reply until 1 second before the request deadline
- **THEN** the worker sends no further try, answers its parent with the code of the last failure and ends

#### Scenario: The deadline cuts a try
- **WHEN** the request deadline cuts a try short
- **THEN** the worker answers its parent with `REQUEST_UNCERTAIN` and ends
- **AND** a pause between tries that ends after the deadline starts no try, and the worker answers with the code of the last failure

### Requirement: The `pi` footer reads `no live instance` when the instance lease lapses
The `pi` package MUST show `Agent Chat: no live instance` once 90 seconds have passed on the monotonic clock or on the wall clock since it sent the last join or heartbeat request that the worker answered without `refused`, and the state text again only at the next such answer, even if the wall clock is set back. This text MUST come before every state text. The lapse itself MUST change the footer only: it MUST NOT begin a rejoin episode, withdraw the binding context or raise a fault.

#### Scenario: A brief outage
- **WHEN** the worker answers a heartbeat or a pending read `refused` with `SERVICE_UNAVAILABLE`, `TRANSPORT_UNAVAILABLE` or `REQUEST_UNCERTAIN`, and the lease has not lapsed
- **THEN** the adapter keeps its worker and its binding context, begins no rejoin episode and spends none of its rejoin budget
- **AND** the next heartbeat or poll tick is the retry

#### Scenario: The lease lapses during an outage
- **WHEN** 90 seconds pass after the send of the last request that was answered without `refused`
- **THEN** the footer reads `Agent Chat: no live instance` at that deadline, not at the next 30-second heartbeat
- **AND** the lapse itself begins no rejoin episode, withdraws no binding context and raises no fault
- **AND** the next heartbeat answered without `refused` shows the state text again

#### Scenario: The lease runs from the send
- **WHEN** a heartbeat is sent at second 0 and answered without `refused` at second 40
- **THEN** the lease runs to second 90, not to second 130

#### Scenario: A host suspend
- **WHEN** the host is suspended for more than 90 seconds after the send of the last request that was answered without `refused`, so that the monotonic clock and its timer stand still and the wall clock runs on
- **THEN** the footer reads `Agent Chat: no live instance` at the first poll tick after the resume, whatever request is in flight then
- **AND** the lapse itself begins no rejoin episode, withdraws no binding context and raises no fault
- **AND** the next heartbeat answered without `refused` shows the state text again

#### Scenario: A wall clock set back after a lapse
- **WHEN** 90 seconds have passed on either clock since the send of the last request that was answered without `refused`, and the wall clock is then set back to a time before its own deadline, while the monotonic clock may not yet have counted 90 seconds
- **THEN** the footer keeps reading `Agent Chat: no live instance` at every poll tick and after every heartbeat that the worker answers `refused`
- **AND** the next heartbeat answered without `refused` shows the state text again

#### Scenario: The lapse comes first
- **WHEN** the lease lapses while the session is busy, stopped, paused or in Plan Mode
- **THEN** the footer reads `Agent Chat: no live instance` until a heartbeat is answered without `refused`, and then reads the text of that state

#### Scenario: A rejoin episode
- **WHEN** the adapter waits to rejoin after a failure that calls for it
- **THEN** the footer reads `Agent Chat: reconnecting`, never `Agent Chat: no live instance`
- **AND** the next successful join starts a new lease

#### Scenario: A reply from an ended instance
- **WHEN** an instance has ended or been replaced and the reply to a request that it sent arrives
- **THEN** that reply renews no lease

### Requirement: The `pi` footer is never blank after chat stops
After chat fails closed, after `/agent-chat-off` and in a replacing runtime whose off latch holds, the `pi` footer MUST read `Agent Chat: no live instance`. Only `session_shutdown` MAY clear the footer. A Pi process with no valid chat configuration MUST register nothing and never touch the footer.

#### Scenario: Chat fails closed
- **WHEN** chat fails closed, for example with `REJOIN_BUDGET`, or the worker exits under a joined session
- **THEN** the footer reads `Agent Chat: no live instance`

#### Scenario: The operator turns chat off
- **WHEN** the operator runs `/agent-chat-off`
- **THEN** the worker ends and the footer reads `Agent Chat: no live instance`

#### Scenario: Shutdown
- **WHEN** Pi emits `session_shutdown`
- **THEN** the footer is cleared and the lease timer is cleared
- **AND** nothing renders afterwards

#### Scenario: No valid chat configuration
- **WHEN** Pi starts with no configuration, or with one that the config loader refuses, such as a record with chat disabled
- **THEN** the extension registers no handler and no command, and the footer is never touched

### Requirement: `pi` sends a changed state at the next poll
At every 2-second poll the `pi` package MUST compare the state that it would heartbeat with the last state that the worker confirmed, and send one heartbeat at once when they differ, not at the next 30-second tick. A changed state that the worker answered `refused` MUST stay unconfirmed and be sent again at the next poll. It MUST send nothing extra while the state holds, and no second heartbeat while one is in flight.

#### Scenario: Idle to busy, and back
- **WHEN** the session turns busy between two heartbeats, or turns idle again
- **THEN** the next poll sends one heartbeat that carries the new state
- **AND** nothing more is sent while the state holds

#### Scenario: The worker refuses the change
- **WHEN** the worker answers a changed heartbeat `refused`
- **THEN** the next poll sends the state again, and once the worker confirms it, no more

#### Scenario: A heartbeat is in flight
- **WHEN** a poll finds a heartbeat in flight
- **THEN** it sends no second heartbeat

### Requirement: `pi` compares the state again when a slow request is done
A state change that a poll or event sees during a request other than a receipts request MUST NOT start a second one. When that request is done, `pi` MUST compare the state with the confirmed one once and send a heartbeat if it differs, before a waiting request, not at a later poll, unless that request was a heartbeat sent since the last delivery poll pass: a waiting poll goes first. A refused heartbeat MUST NOT repeat in a loop: at most once for each poll or event that found a request in flight.

#### Scenario: A change during a slow request
- **WHEN** the session turns busy or enters Plan Mode while a pending read, a claim, a settlement or a heartbeat is in flight, and a poll finds that request in flight
- **THEN** one heartbeat that carries the new state is sent when that request is done, not at a later poll, unless that request is a heartbeat and a delivery poll waits behind it
- **AND** nothing is sent if the state has changed back by then

#### Scenario: A poll that waits behind a heartbeat
- **WHEN** a poll finds a heartbeat in flight and leaves a delivery poll due, and the state changes while that heartbeat is out
- **THEN** the delivery poll is sent when the first heartbeat is done, before the heartbeat of the new state
- **AND** the heartbeat of the new state follows the delivery poll

#### Scenario: A refusal is not repeated in a loop
- **WHEN** the worker answers `refused` to a heartbeat that was sent when a slow request was done, or that was in flight when a poll found it
- **THEN** that heartbeat is sent again at most once for each such poll or event, and never in a loop
- **AND** a state that stays unconfirmed is sent again by the next poll that finds no request in flight

### Requirement: `pi` takes turns between a heartbeat and a delivery poll
In one instance, a heartbeat and a delivery poll MUST take turns, whether the worker confirms or refuses: at most one heartbeat goes between a poll tick and the next delivery poll, and at most one delivery poll pass goes between a heartbeat falling due, by a keep-alive or a changed state, and the next heartbeat. A further pass goes only when the state is the confirmed one as that pass is chosen and no keep-alive asked. A `REQUEST_UNCERTAIN` refusal of a changed state leaves no confirmed state.

#### Scenario: A refusal that outlasts every tick
- **WHEN** each heartbeat is answered `refused`, and a poll tick comes while each one is out, so that the tick asks for a compare and leaves a delivery poll due
- **THEN** the delivery poll is sent after each refusal, and the retry that the tick asked for follows it
- **AND** two heartbeats never follow each other while a poll waits

#### Scenario: Heartbeats that are confirmed take their turn too
- **WHEN** the title changes during each of several slow heartbeats, a poll tick comes with each change, and the worker confirms every heartbeat
- **THEN** a delivery poll is sent after each heartbeat, and not after the last one only
- **AND** at most one heartbeat goes between a poll tick and the next delivery poll

#### Scenario: A delivery poll that is held
- **WHEN** a heartbeat is refused after a poll tick asked for a compare, so that its retry waits for a delivery poll, and another poll tick comes while that poll is held
- **THEN** the retry is sent when that poll is done, before the second poll

#### Scenario: A keep-alive and a poll tick come while a delivery is held in its hand-off
- **WHEN** a heartbeat has gone in the run, a delivery's hand-off is held, and a keep-alive tick and a poll tick come meanwhile
- **THEN** the held pass settles first, the heartbeat that the keep-alive asked for goes second, and the delivery poll that waited goes third

#### Scenario: The keep-alive asks again
- **WHEN** a heartbeat is refused while a delivery poll waits, and the 30-second tick came while it was out
- **THEN** the delivery poll is sent first, and the heartbeat that the tick asked for follows it: heartbeat, delivery poll, heartbeat
- **AND** an event that asks for a compare of a state that the worker has not confirmed is treated the same way

#### Scenario: A further change
- **WHEN** a heartbeat is refused or confirmed while a delivery poll waits, and an event or a poll tick finds the state changed again while it was out
- **THEN** the delivery poll is sent first, and the heartbeat of the new state follows it

#### Scenario: A delivery poll and a receipts request both wait
- **WHEN** a poll tick finds a change and its heartbeat is refused, and an event came while that heartbeat was out and asked for a compare, so that a delivery poll, a retry and a receipts request all wait
- **THEN** the delivery poll is sent first, the retry that the event asked for second and the receipts request third

#### Scenario: Nothing waits
- **WHEN** a heartbeat that an event found in flight is refused and no delivery poll is due
- **THEN** that state is sent again once, at once, before a receipts request that waits

#### Scenario: A state that has reverted to the confirmed one while a delivery poll is out
- **WHEN** a poll tick finds a change, its heartbeat is refused as a brief outage that sent nothing, an event that came while it was out asked for a compare, and the state is the confirmed one again while the delivery poll that the tick queued is out
- **THEN** no heartbeat follows that poll

#### Scenario: A state that has reverted to the confirmed one while a receipts request is out
- **WHEN** a heartbeat is refused as a brief outage that sent nothing, no entry asks for it again, and only a receipts request is due, so that it goes out, and the state is the confirmed one again while it is out
- **THEN** an event that finds the state confirmed ends nothing, and no heartbeat follows the request

#### Scenario: A change of the stop state while a receipts request is out
- **WHEN** a receipts request is out and a stop, an abort of the turn or the user's input that ends a stop changes the state
- **THEN** that request ends at once when the new state is not the confirmed one, and that state report is the next request unless a delivery poll has the turn
- **AND** a change that returns the state to the confirmed one ends nothing, and no heartbeat follows the request

#### Scenario: A refusal that may have been applied
- **WHEN** a heartbeat of a changed state is refused as `REQUEST_UNCERTAIN`, and the state later returns to the one that was confirmed before it
- **THEN** the next compare sends that state, because the worker may hold the refused one
- **AND** a refusal that sent nothing, `SERVICE_UNAVAILABLE` or `TRANSPORT_UNAVAILABLE`, leaves the confirmed state as it was and sends nothing for a state that returns to it

#### Scenario: A refusal that may have been applied, of the confirmed state
- **WHEN** a heartbeat of the state that the worker already confirmed, a keep-alive for example, is refused as `REQUEST_UNCERTAIN`
- **THEN** that state stays confirmed, because the worker holds it whether or not the request was applied
- **AND** the next poll tick sends its delivery poll with no heartbeat before it

#### Scenario: Any order of ticks, events and answers
- **WHEN** poll ticks, keep-alive ticks and events that change busy or idle or the title come in any order, from a confirmed state and from a changed one, while each request is confirmed, refused as a brief outage, refused as `REQUEST_UNCERTAIN`, or held until a later tick
- **THEN** the loop ends and a later poll tick finds it free
- **AND** at most one heartbeat goes between a poll tick and the next delivery poll
- **AND** at most one delivery poll pass goes between a heartbeat falling due and the next heartbeat, and a further pass goes only when the state is the confirmed one as that pass is chosen and no keep-alive asked
- **AND** a heartbeat of the confirmed state is sent only after an entry that asks for one outright, such as a keep-alive tick, or when a `REQUEST_UNCERTAIN` refusal of a changed state left no confirmed state
- **AND** no request is sent twice for one due flag

### Requirement: `pi` asks for the end of its instance at `session_shutdown` and starts a replacing runtime stopped
`session_shutdown` MUST stop the `pi` worker, which requests the instance's end, and return a promise that Pi awaits before a replacing runtime starts. The promise MUST settle when every worker that the package stopped has closed, a rejoin's included, or after 6 seconds. Neither the request nor the close proves that the server accepted the end. No other event MAY end an instance. A replacing runtime MUST start stopped, join with its own native session id and start no worker once chat is off.

#### Scenario: A runtime is replaced
- **WHEN** Pi emits `session_shutdown` to the old runtime and then `session_start` to a new one, with the reason `reload`, `new`, `resume` or `fork`
- **THEN** the old worker is closed before the new runtime joins
- **AND** the new runtime joins with its own binding and starts stopped

#### Scenario: A reload during a rejoin
- **WHEN** a failure that calls for a rejoin has stopped the worker, that worker has not closed yet, and Pi emits `session_shutdown` for a reload, and that worker closes within 6 seconds
- **THEN** the promise that the handler returns settles only after that worker has closed
- **AND** the replacing runtime joins after it, which removes the usual cause of `BINDING_CONFLICT`: an old worker that is still ending its instance

#### Scenario: A worker that closed without ending its instance
- **WHEN** Pi emits `session_shutdown`, and the worker closes within 6 seconds, but its `end` request failed, so its instance stays until its lease expires
- **THEN** the promise that the handler returns settles, because a close shows that the process exited and not that the server accepted `end`
- **AND** a join of the replacing runtime that meets `BINDING_CONFLICT` is retried after a back-off like any other

#### Scenario: A worker that does not close at shutdown
- **WHEN** Pi emits `session_shutdown` and a worker that the package stopped has not closed 6 seconds later
- **THEN** the promise that the handler returns settles at that time, with that worker still not closed

#### Scenario: A delivery whose hand-off is held
- **WHEN** Pi has the message of a claimed delivery and has not reported it, and Pi emits `session_shutdown` or the worker exits
- **THEN** nothing is settled and no worker starts, whether Pi reports the message later or the hand-off times out

#### Scenario: An event that precedes a switch
- **WHEN** Pi emits `session_before_switch` or `session_before_fork`
- **THEN** the package stops no worker and ends no instance, because it listens to neither event

#### Scenario: Chat is off
- **WHEN** chat was turned off and Pi replaces the runtime
- **THEN** the new runtime starts no worker, and its footer reads `Agent Chat: no live instance`

### Requirement: A `pi` worker waits for every worker that the package stopped to close, for 6 seconds at most
`connect` MUST start no worker while another joins or serves, and none until every worker that the package stopped has closed, a rejoin's included. A wait MUST end after 6 seconds at the latest, and the worker then starts. After a wait it MUST check again that its runtime was not shut down and chat was not turned off. A call that comes while another waits MUST wait for that one, so waits that end at different times start one worker. A call that finds a worker joining or serving MUST stop none.

#### Scenario: A rejoin waits for the old worker
- **WHEN** the rejoin timer fires while the worker that the rejoin stopped has not closed yet, and it closes within 6 seconds
- **THEN** no worker starts until that one has closed, and then exactly one starts, however many calls waited
- **AND** none starts if Pi shut the runtime down or the operator turned chat off during the wait

#### Scenario: A worker that does not close before a rejoin
- **WHEN** a rejoin waits and the worker that it stopped has not closed 6 seconds later
- **THEN** the wait ends and the rejoin starts one worker
- **AND** a join that still meets the old instance is refused with `BINDING_CONFLICT`, which the rejoin retries after a back-off

#### Scenario: A worker that closed without ending its instance
- **WHEN** the worker that a rejoin stopped closes within 6 seconds, but its `end` request failed, so its instance stays until its lease expires
- **THEN** the rejoin starts one worker, because a close shows that the process exited and not that the server accepted `end`
- **AND** a join that meets `BINDING_CONFLICT` is retried after a back-off like any other

#### Scenario: Waits that end at different times
- **WHEN** a second call comes while the first one waits for a worker that has not closed, and the join of the worker that starts after the wait meets `BINDING_CONFLICT`
- **THEN** the second call starts no worker, and none starts before the back-off is over
- **AND** the next worker starts after the back-off and once the worker that the failed join stopped has closed, or after 6 seconds

#### Scenario: A second connect
- **WHEN** `connect` is called while a worker joins or serves
- **THEN** it starts no second worker and stops none

### Requirement: A `pi` disconnect ends the instance for good
`disconnect` MUST end the instance as `session_shutdown` and the off latch do: it MUST stop the live worker, and no `connect` after it MAY start a worker, nor MAY the `connect` call that is out, whether it waits for a close, joins or waits for the answer to its first heartbeat.

#### Scenario: A disconnect during a wait
- **WHEN** `connect` waits for a worker that has not closed, `disconnect` is called, and that worker then closes
- **THEN** the call that waited starts no worker

#### Scenario: A connect after a disconnect
- **WHEN** `disconnect` is called and `connect` follows, while the old worker is still closing or after it has closed
- **THEN** the call that waits for the close starts no worker, and nor does a call after it
- **AND** no binding is published

### Requirement: Compaction and tree navigation keep the `pi` binding
Tree navigation and compaction MUST keep the `pi` binding and MUST NOT join again. While Pi is not idle, in a compaction or a tree summary, the package MUST report `busy` and claim nothing. `session_tree`, `session_compact` and `session_compact_failed` MUST make it read the state at once, with the context that the event carries.

#### Scenario: A compaction runs
- **WHEN** a compaction or a tree summary runs while a message is pending
- **THEN** the heartbeat says `busy` and no claim is sent
- **AND** once Pi is idle again the claim is sent

#### Scenario: Compaction or navigation ends
- **WHEN** `session_tree`, `session_compact` or `session_compact_failed` arrives
- **THEN** the loop reads the state at once, with the context that the event carries
- **AND** the binding stays, nothing is joined again and the next turn carries the binding section

#### Scenario: A receipts request is in flight
- **WHEN** one of the three events arrives while a receipts request is in flight
- **THEN** the package ends that request only when the state differs from the last confirmed one, and sends that state report in the same pass
- **AND** an event that finds nothing due ends nothing

### Requirement: A peer message body is framed behind a per-notice nonce
When a harness package passes message bodies to its session, the notice MUST carry a nonce of at least 64 bits from a cryptographic generator, drawn after the claim and never derived from message data. Each message MUST be a header line, an opening marker `<<<AGENT-CHAT-BODY NONCE`, the body and a closing marker `AGENT-CHAT-BODY NONCE>>>`. Every body line MUST start with `> `, added after the cut.

#### Scenario: A body is rendered inside its frame
- **WHEN** a claimed question with the body `hello` is rendered
- **THEN** the notice has the message's header, the opening marker with the notice's nonce, the line `> hello` and the closing marker with the same nonce

#### Scenario: A body imitates the frame
- **WHEN** a body contains a closing marker, a header line, a binding line and an instruction line
- **THEN** each of those lines is written after `> ` inside the frame
- **AND** none of them ends the frame or reads as the adapter's own text

#### Scenario: Two notices
- **WHEN** the same batch is rendered twice
- **THEN** the two notices carry different nonces

### Requirement: The notice header names no peer-chosen text
The header line MUST carry the message id, the kind, the room of that message as `room <uuid>`, the sender as `session <uuid>` or `principal <uuid>`, the sent time, and the age in whole seconds from the server's `created_at` and `admitted_at`. No peer-chosen name, harness or host MAY appear outside the body. The renderer MUST check every header field against a strict pattern and MUST return nothing instead of interpolating text that does not match.

#### Scenario: A message from a session or from an operator
- **WHEN** a message has a sending session, or only a sending principal
- **THEN** the header names the sender as `session <uuid>`, or as `principal <uuid>`, and nothing else about the sender

#### Scenario: A message from another room
- **WHEN** a claimed message belongs to a room other than the room of the binding
- **THEN** its header names its own room as `room <uuid>`
- **AND** the pointer line of a cut body names that same room

#### Scenario: A header field fails its pattern
- **WHEN** a claimed message carries an id, kind, room, history cursor or time that does not match its strict pattern
- **THEN** the renderer returns nothing, and no text from that message reaches the session

### Requirement: The notice writes hidden and confusing code points as text
Before the cut, the renderer MUST write C0 controls other than LF and TAB, DEL, C1 controls, line and paragraph separators, bidirectional controls, zero-width and other default-ignorable format code points, variation selectors, tag characters and lone surrogates as `\uXXXX` text (`\u{X}` above U+FFFF), so that LF is the only line break a body carries. The ranges MUST be data in the vectors.

#### Scenario: A body carries hidden or confusing characters
- **WHEN** a body contains a bidirectional override, a NUL, a carriage return, U+0085 or a lone surrogate
- **THEN** each is written as `\uXXXX` text
- **AND** the body has no line break other than LF

### Requirement: The notice cuts a body on whole units and points at the rest
The renderer MUST cut a body on whole units (a code point or one escape) at a per-body cap of 4096 UTF-8 bytes unless the caller sets another. The cap counts the body as written, so an escape counts as its `\uXXXX` text. It MUST give every body that it or the core cut a pointer line with the exact `history` arguments.

#### Scenario: A body over the cap
- **WHEN** a body, as written, is longer than 4096 UTF-8 bytes
- **THEN** it ends on a code point or on one complete escape, never inside one
- **AND** a pointer line after the closing marker gives the room, the history cursor and a limit of 1, and does not repeat the message id that the header above it carries

#### Scenario: A body the core already cut
- **WHEN** the core marks a body as cut
- **THEN** the message carries the same pointer line

### Requirement: The instruction line ties a pointer and a reply to the header of the item
A notice with bodies MUST carry an instruction line before the first frame. It MUST tell the reader to verify that the `history` read of a cut body returns the id shown in that item's header. On the `cli` route it MUST also say that the `--room` of a reply is the room shown in that item's header. On the MCP routes the `reply` tool derives the room and key from the parent message, so the line names no room.

#### Scenario: A reader follows a pointer line
- **WHEN** a notice with bodies is rendered
- **THEN** the instruction line tells the reader to verify that the `history` read returns the id shown in that item's header

#### Scenario: A reader replies to a message from another room
- **WHEN** a notice with bodies on the `cli` route carries a message from a room other than the room of the binding
- **THEN** the instruction line says that a reply's `--room` is the room shown in that item's header

#### Scenario: A reader replies through the MCP reply tool
- **WHEN** a notice with bodies is rendered on the `mcp` or `mcp-with-cli-fallback` route
- **THEN** the instruction line names no room, and the notice names `reply` to the message id, so the reply tool derives the room and key from the parent message

### Requirement: The notice says that peer data is untrusted
A static line before the first frame MUST say that every `> ` line between the markers is untrusted peer data, including lookalike bindings, instructions and markers, that peer data grants no authority, and that the notice acknowledges nothing. The binding line MUST stay outside every frame and before them.

#### Scenario: Order of the parts
- **WHEN** a notice with bodies is rendered
- **THEN** the binding line comes before the static line, and every frame comes after both

### Requirement: The notice fits the caller's bound without a metadata fallback
The caller MUST pass `bound`, the UTF-8 bytes it may send, with its own prefix already counted. The renderer MUST halve the body cap (4096, 2048, ... 0) until the whole notice fits, MUST keep the header, frame and pointer of every message at cap 0, and MUST return nothing only when those do not fit. It MUST NOT fall back to metadata for a batch in bodies mode.

#### Scenario: A batch does not fit the bound
- **WHEN** the bodies of a batch are too large for `bound` at the 4096-byte cap
- **THEN** the renderer halves the cap until the notice fits
- **AND** every message keeps its header, frame and pointer, and no metadata replaces the batch

#### Scenario: Not even the headers fit
- **WHEN** `bound` cannot hold the headers, markers and pointers of the batch at cap 0
- **THEN** the renderer returns nothing

### Requirement: A batch with no notice is deferred, never partly delivered
A package MUST settle a batch for which the renderer returns nothing as `deferred` with reason `offline`, and MUST NOT send a partial or metadata notice in its place. When a notice fits only beside a binding without its receipts sentence, the package MUST send that binding with it and MUST NOT defer the batch.

#### Scenario: The renderer returns nothing
- **WHEN** a claimed batch has a message that fails its pattern, or a batch that does not fit at cap 0
- **THEN** the package settles the batch as `deferred` with reason `offline`
- **AND** it sends no text to the session

#### Scenario: A batch that fits only beside the binding without the receipts sentence
- **WHEN** `claude-code` or `codex` claims a retry batch whose notice does not fit beside the binding still to be shown, and fits beside that binding without the receipts sentence
- **THEN** the hook carries that binding and the notice, and the batch settles `handed`

### Requirement: A package claims the longest prefix that one notice is estimated to carry
Before the claim, the package MUST take the longest prefix of the pending candidates, and at least one, whose estimated rendering fits `bound`. The estimate MUST budget the widest header, markers and pointer for each message and 3 rendered bytes for each stored body byte, up to the body cap. It MUST claim a retry batch, or a batch for which the server reported no sizes, whole. A missing or invalid size MUST count as a full body.

#### Scenario: More candidates than one notice is estimated to carry
- **WHEN** `pending` reports more candidates, with sizes, than the estimate says fit `bound`
- **THEN** the package claims only the longest prefix that the estimate admits, and at least the first candidate
- **AND** when the selected prefix fits the estimate and every claimed body renders within 3 bytes for each stored byte, the halving step cuts none of them

#### Scenario: A retry batch or a reply without sizes
- **WHEN** `pending` marks the batch as a retry, or reports no sizes
- **THEN** the package claims every candidate, because the server refuses any other set for a stored batch
- **AND** the renderer cuts bodies as far as `bound` needs

#### Scenario: A size that cannot be trusted
- **WHEN** a candidate's size is missing, negative or not a whole number
- **THEN** it counts as a full body of the per-body cap

### Requirement: A claimed body can still be cut when its escapes outgrow the estimate
The estimate assumes that a body renders to at most 3 bytes for each stored byte, as text with many line feeds does. A body whose escapes expand it further, such as carriage returns written as six bytes each, MAY make the renderer halve the body cap after the claim, and the halved cap applies to every body in the notice. Each body cut that way MUST carry its pointer line, and the notice MUST NOT exceed `bound`.

#### Scenario: Two bodies of carriage returns
- **WHEN** `pending` reports two bodies of 650 carriage returns each, with sizes, under a bound of 8137 bytes
- **THEN** the package claims both, because the estimate takes 3 bytes for each stored byte
- **AND** the renderer, which writes each carriage return as six bytes, halves the cap and cuts both bodies
- **AND** each cut body carries its pointer line, and the notice is at most 8137 bytes

### Requirement: Every renderer passes the same vectors
The Python reference (`agent_chat/notice.py`) and the shared JavaScript renderer (`integrations/shared/notice.js`) MUST both pass the vectors in `integrations/notice-vectors.json`. Each package that delivers notices MUST ship `lib/notice.js` as a byte-identical copy of the shared renderer, and its tests MUST fail when the copy differs. A package that never delivers a notice MAY ship that copy only for its binding text and tool-route names, and MUST NOT deliver a notice with it.

#### Scenario: Both implementations agree
- **WHEN** the vectors run under the Python tests and under each package's tests
- **THEN** every renderer returns the expected text for every notice vector and the expected ids for every pack vector

#### Scenario: A package copy drifts
- **WHEN** a delivering package's `lib/notice.js` differs by one byte from `integrations/shared/notice.js`
- **THEN** that package's tests fail

### Requirement: A package offers sender receipts only to a busy, unmuted session
A package that shows sender receipts MUST offer them only while the session is joined, its native state is busy and the worker's `receipts` answer carries `muted` as `false`; an absent or non-boolean `muted` MUST count as muted. It MUST ask for them at most every 5 seconds and only while a turn runs, MUST show at most 10 of the oldest rows in one notice, each row whole or not at all, and MUST NOT show an id again once its output was confirmed.

#### Scenario: A session that cannot show receipts
- **WHEN** the session is idle, stopped, in Plan Mode, in an unknown state or muted, or the worker's answer carries no boolean `muted`
- **THEN** the package shows no receipt and no notice is output
- **AND** the receipts stay pending on the server

### Requirement: A staged sender receipts notice is checked again when it is output
A package that stages a receipts notice and outputs it at a later boundary MUST check it again at that boundary and MUST NOT ask the worker or the server to do so. It MUST drop the notice unless the latest worker answer's `muted` flag is `false` (a `status` answer without a boolean one makes it unknown) and the request that asked for the notice was written at most 5 seconds before. A dropped notice MUST NOT be marked, and its rows MUST be offered again.

#### Scenario: A mute after the notice was staged
- **WHEN** a `status` answer says the session is muted, or more than 5 seconds pass after the request that staged a notice was written, and before its output
- **THEN** no notice is output, and `claude-code` and `codex` answer the hook as for a reply with nothing to carry
- **AND** the ids are not marked, and a later poll offers the rows again

#### Scenario: An answer read late
- **WHEN** a package reads a `receipts` answer more than 5 seconds after it wrote the request, for example after the host was suspended
- **THEN** the notice that answer staged is dropped at its output, because it is as old as its request
- **AND** the ids are not marked, and a later poll offers the rows again

### Requirement: `pi` checks a receipts notice right before it hands it to Pi
`pi` hands a receipts notice to Pi in the pass that got the answer, so it has no later boundary. It MUST make the check of a staged notice right before it hands the notice over, and MUST NOT hand over a notice that fails it. A notice it drops MUST NOT be marked, and its rows MUST be offered again.

#### Scenario: A `pi` answer read after a suspend
- **WHEN** `pi` reads a `receipts` answer more than 5 seconds after it wrote the request
- **THEN** `pi` hands no notice to Pi and marks no id
- **AND** a later poll offers the rows again

### Requirement: `deepseek` outputs a staged receipts notice only into a running turn
`deepseek` MUST also drop a staged receipts notice at output unless its native state, read without side effect, is a running turn outside Plan Mode. A notice it drops MUST NOT be marked, and its rows MUST be offered again.

#### Scenario: Plan Mode after the notice was staged
- **WHEN** `deepseek` finds its native state idle, stopped, unknown or in Plan Mode at the step that would carry a staged notice
- **THEN** no message is appended and the ids are not marked

### Requirement: `codex` outputs into a running turn only after a fresh read of the collaboration mode
While its app-server thread is bound, `codex` MUST read the thread's collaboration mode right before each claim of a prompt or tool hook and before it outputs a staged receipts notice. The read MUST start after that hook event arrived and answer within 3 seconds and at least 2.5 seconds before the hook's deadline. Only such a read that confirms a mode other than `plan` MAY let the output out. The `permission_mode` hint MAY only refuse it. A binding announcement carries no chat content: this read MUST NOT gate it.

#### Scenario: Plan Mode in the app-server while the hook says default
- **WHEN** the hook's `permission_mode` is `default` and the read finds the mode `plan`
- **THEN** nothing is claimed, no batch or notice is output and nothing is settled
- **AND** the hook is answered as for a reply with nothing to carry

#### Scenario: Plan Mode set while the hook's `pending` request is out
- **WHEN** the mode changes to `plan` after the hook event arrived and before the hook's read
- **THEN** no batch is claimed, no receipts notice is output and no receipt is marked
- **AND** a later poll offers the rows of the dropped notice again

#### Scenario: A binding still to be announced in Plan Mode
- **WHEN** a hook's read confirms `plan` and the binding announcement's write is not confirmed yet
- **THEN** nothing is claimed or settled, and the hook outputs the binding announcement alone

#### Scenario: A read that fails, times out or is malformed
- **WHEN** the read is refused, fails, gives an unknown mode, answers in another shape or does not end in its time
- **THEN** nothing is claimed or output and nothing is settled
- **AND** the hook is answered and chat stays on

#### Scenario: A read taken before the hook event
- **WHEN** only a read that started before the hook event confirmed a mode other than `plan`
- **THEN** that read authorizes no output of that hook

#### Scenario: A later-started read confirms Plan Mode
- **WHEN** a read that started after the hook's own read confirms `plan`, before or after the hook's read answers, and before the write
- **THEN** that hook claims nothing, or settles its claimed batch `deferred` with reason `plan`, and outputs nothing

#### Scenario: An answer after the read's time
- **WHEN** the read's answer comes at the end of its time or later
- **THEN** it counts as no answer: nothing is output, and the heartbeat does not record it

### Requirement: The `codex` heartbeat reports Plan Mode from the last-started read of the mode
`codex` MUST report `plan_mode` from the read that confirmed the collaboration mode and started last, and a hook event MUST NOT discard it. A read taken before a receipts notice counts here only when it confirms `plan`. Only a read that started later and confirms a mode other than `plan` MAY lift a Plan reading; a `permission_mode` hint, an unknown mode, a failed read and a late answer MUST NOT. A `plan` hint MUST report Plan Mode unless a read that started after its hook event confirmed another mode.

#### Scenario: A Plan reading during a running turn
- **WHEN** a hook's read finds the mode `plan` and later hooks say `default`
- **THEN** the heartbeat reports `plan_mode` true until a read that started later confirms another mode

#### Scenario: A later-started read that cannot tell the mode
- **WHEN** a read confirms `plan` after a read that started later could not tell the mode
- **THEN** the heartbeat reports `plan_mode` true

### Requirement: A receipts pass sends one request and reads the native state without side effect
A package's receipts pass MUST send at most one receipts request: the mark that waits or, when none waits, the feed poll. A mark that is not accepted MUST hold the feed poll until it lands. A pass that sends nothing MUST NOT delay the next one. `deepseek` MUST read its native state for receipts with a read that does not stop chat, log a warning or fence a delivery, and a state that read cannot classify MUST hold receipts for that pass and change nothing else.

#### Scenario: A mark waits
- **WHEN** a mark is waiting at a pass and the feed poll is due too
- **THEN** the pass sends only the mark, and the feed poll waits for the next cadence after the mark landed

#### Scenario: A pass that sends nothing
- **WHEN** a pass gives way to a request queued behind it, or finds the turn over, and sends no receipts request
- **THEN** the next pass of a running turn may poll at once

#### Scenario: An unreadable native state in a receipts pass
- **WHEN** `deepseek` cannot read its native state during a receipts pass
- **THEN** it sends no receipts request and chat stays on
- **AND** a later delivery is handed with no new Web prompt

### Requirement: `deepseek` counts only a running turn as busy for receipts
`deepseek`'s native-state read for receipts MUST count the agent as busy only while its status is `running`. An idle agent whose inbox holds a parked item is busy for a delivery, which MUST still start no turn, but runs no turn and MUST NOT be asked for receipts.

#### Scenario: A Web prompt parked while the agent is idle
- **WHEN** a `deepseek` agent is idle and a Web prompt waits in its inbox, as it does while a maintenance task runs
- **THEN** the receipts pass sends no `receipts` request and no notice is appended
- **AND** the delivery still counts the agent as busy and starts no turn

### Requirement: A receipts request gives way to every other request
A package MUST end a receipts request in flight with the worker's cancel when a heartbeat, a state report, a delivery poll or a claim falls due, MUST repeat the cancel every few milliseconds until that request answers, and MUST send no receipts request while one of them is due. A hook MUST NOT skip its claim because a receipts request is in flight. Client-side only: the first request after a cancel can wait up to 3 s for a server lock and then be refused.

#### Scenario: A request falls due while a receipts request is in flight
- **WHEN** a heartbeat, a state report, a delivery poll or a claim falls due while a receipts request is in flight and nothing releases that request
- **THEN** the package cancels the receipts request, and sends the due request when the worker has answered the cancel
- **AND** the package holds the `refused` answer like any refusal, changes no state for it, and keeps the ids of a mark that was ended
- **AND** chat stays on, and those ids are marked at a later pass

### Requirement: `receipts-cancel` gates receipts requests and ends only a receipts request
A package MUST send a receipts request only to a worker whose join reply lists `receipts-cancel` in `capabilities`, and MUST release a notice staged and not yet output when its worker is retired. A worker that lists `receipts-cancel` MUST let a cancel end only the receipts request it was sent for, and MUST still end on its alarm or on `SIGTERM` during a receipts request.

#### Scenario: A worker without the capability
- **WHEN** a worker's join reply has no `capabilities` list, or the list does not contain `receipts-cancel`
- **THEN** the package sends no `receipts` and no `receipts_delivered` request to it
- **AND** every delivery, heartbeat, claim and settle is what it is without receipts

#### Scenario: A rejoin onto another worker
- **WHEN** a rejoin starts a worker whose join reply differs in `capabilities` from the worker before it
- **THEN** the package follows the join reply of the worker that serves, and of no other
- **AND** a notice staged for the worker before it, and not yet output, is not shown, and its rows are offered again by a later feed

#### Scenario: A cancel arrives after the receipts request has its answer
- **WHEN** the worker receives the cancel signal after a receipts request has its answer and before it reads the next request
- **THEN** the worker drops the signal
- **AND** the next request, a retry of the same mark included, is sent to the server and answered

#### Scenario: A cancel lands before the worker reads the receipts request it was sent for
- **WHEN** a package writes a receipts request right after the answer to another one and cancels it, and the first signal lands before the worker has read that request
- **THEN** the worker drops that signal, as it does for any cancel in that window, and the package sends it again every few milliseconds until the request answers
- **AND** the first signal that lands after the worker read the request ends it, so a request queued behind it waits milliseconds, not the 2-second receipt deadline
- **AND** a repeat that lands after the answer is dropped, and the next request is sent to the server and answered

#### Scenario: The alarm fires during a receipts request
- **WHEN** the worker's alarm fires while a receipts request runs, also while the HTTP client waits for the answer
- **THEN** the worker ends with an error frame and does not answer `refused` for that receipts request

### Requirement: Sender receipts never wake and never change delivery
A package MUST output a receipts notice only at a native boundary of a turn that already runs, and MUST NOT start a turn, claim, settle, steer or wake for it. A pending receipt MUST NOT change the bytes of a claim, a handoff, a settle, a heartbeat, a binding announcement or a wake, and a receipts request MUST NOT sit between a claim and its settle. Only a native mode that `codex` reads before a notice MAY withhold an output and set `plan_mode`; it MUST NOT let one out or lift Plan Mode.

#### Scenario: Receipts pending
- **WHEN** receipts are pending
- **THEN** every delivery, binding announcement and wake that the package outputs, and every claim, settle and heartbeat request it makes, is byte-identical to that of a session with no receipts pending, except for what the `codex` mode read before a notice changes (next scenario)

#### Scenario: A `codex` mode read before a notice
- **WHEN** `codex` reads the collaboration mode before it outputs a staged notice, and the read confirms `plan`
- **THEN** the notice is not output, a claimed batch whose write follows settles `deferred` with reason `plan`, and the heartbeat reports `plan_mode` true
- **AND** a read that confirms another mode lets out that notice alone: it does not lift a Plan reading, change `plan_mode` or send a heartbeat

### Requirement: A package marks only the receipts its harness confirmed
A package MUST send `receipts_delivered` with exactly the ids a notice showed, and only after its harness confirmed the output. A `refused` or malformed answer MUST NOT end chat, and the ids of a mark that was refused or failed MUST be sent again at the next poll.

#### Scenario: A notice that reached the model
- **WHEN** the harness confirms that a receipts notice was output
- **THEN** the package sends `receipts_delivered` with exactly the ids in that notice, and never an empty list
- **AND** a notice that was not confirmed is not marked, and its rows are offered again

#### Scenario: A refusal or a failed mark
- **WHEN** either receipts operation answers `refused` or something malformed
- **THEN** chat stays on, heartbeat, claim and settle keep running, and the package asks again at its next poll
- **AND** the ids of a mark that was refused are kept, and after a rejoin they are marked through the new instance

#### Scenario: A transport failure on a receipts request
- **WHEN** a receipts request throws a transport error that carries a code, such as `REQUEST_UNCERTAIN`
- **THEN** the package handles it as it handles that error on any other request: a rejoin within the budget, or fail closed
- **AND** `CHAT_REQUEST_INVALID` and an error that carries no code are held, and chat stays on

### Requirement: Sender receipts use the shared state machine and renderer unchanged
A package that shows sender receipts MUST ship `lib/receipts.js` as a byte-identical copy of `integrations/shared/receipts.js`, and its tests MUST fail when the copy differs. Its receipt notice MUST come from `renderReceiptNotice` in its `lib/notice.js` copy, which passes the vectors in `integrations/receipt-vectors.json`.

#### Scenario: A receipts copy drifts
- **WHEN** a package's `lib/receipts.js` differs by one byte from `integrations/shared/receipts.js`
- **THEN** that package's tests fail

### Requirement: The OpenCode plugin delivers only when its config turns delivery on
The OpenCode plugin MUST read an optional boolean config key `delivery` that defaults to `false`. With the key absent or `false`, it MUST register no hook, MUST NOT subscribe to `session.inbox.delivered`, and MUST send nothing to a session except its binding entry. Any other value MUST keep chat off.

#### Scenario: Delivery is off
- **WHEN** the config file has no `delivery` key, or `delivery` is `false`
- **THEN** the plugin registers no hook and subscribes to the seven session events only
- **AND** it sends no `pending`, `claim` or `settle` request and makes no `synthetic` or `prompt` call

#### Scenario: A value that is not a boolean
- **WHEN** the config file sets `delivery` to a string, a number, `null`, an array or an object
- **THEN** the loader refuses the file and chat stays off

#### Scenario: Delivery is on
- **WHEN** `delivery` is `true` and the host has a `ctx.session.hook` function
- **THEN** the plugin registers one `experimental.idle` hook and subscribes to `session.inbox.delivered` in addition to the seven session events
- **AND** it disposes the hook when its instance ends, including a registration that the host answers after the instance ended

#### Scenario: A host with no hook
- **WHEN** `delivery` is `true` and the host has no `ctx.session.hook` function, or the registration fails
- **THEN** the plugin registers nothing, delivers nothing, and joins and keeps the binding as with `delivery` off

### Requirement: Only the idle hook claims, and no event does
With `delivery` set to `true`, the OpenCode plugin MUST claim a message and MUST send input to a session only inside the host's `experimental.idle` hook. It MUST NOT build any state of a session from events, and no event MAY cause a claim or an input.

#### Scenario: Events alone never deliver
- **WHEN** any sequence of events arrives and the hook is never called, including bad envelopes, replays, compaction events, execution starts and `session.inbox.delivered` events
- **THEN** the plugin sends no `pending`, `claim` or `settle` request and makes no `synthetic`, `prompt` or `wait` call
- **AND** a later hook call for a session that the events left joined and eligible makes exactly one claim

### Requirement: The idle hook never rejects and never holds the host
The hook callback MUST NOT reject or throw, whatever fails inside it. It MUST return within one budget of 1,500 milliseconds, and every wait inside it MUST end by that budget. When the budget ends, the hook MUST start no further step: it MUST NOT claim, admit or report again, and a grant it holds settles as the requirement on running out of time states.

#### Scenario: A step fails
- **WHEN** the worker, the host or the `session.get` call throws or rejects inside the hook
- **THEN** the callback resolves and the host's end of turn is not failed

#### Scenario: A step hangs
- **WHEN** the worker, `session.get`, the entry read or `session.synthetic` never answers
- **THEN** the callback returns when the budget ends
- **AND** `busy` does not outlive the hook

### Requirement: The hook's budget is a deadline that the hook reads on the clock
The budget MUST be a deadline on the monotonic clock: the start of the hook plus 1,500 milliseconds. The timer that enforces it MUST run for what is left of the deadline. The hook MUST read the clock as the last step before `claim` and as the last step before `session.synthetic`, and MUST NOT rely on a timer alone.

#### Scenario: A pause delays the pending reply
- **WHEN** the event loop pauses, the clock passes the deadline before the timer runs, and then the reply to `pending` arrives
- **THEN** the plugin sends no `claim` and makes no `synthetic` call
- **AND** `busy` does not outlive the hook

#### Scenario: A pause between the claim and the admission
- **WHEN** the clock passes the deadline after the claim and before the admission, and no timer has run
- **THEN** the plugin makes no `synthetic` call
- **AND** it settles the grant `deferred` with reason `offline`

#### Scenario: A pause while the attempt is set up
- **WHEN** the clock passes the deadline after the plugin has opened its attempt and before it would call `session.synthetic`, and no timer has run
- **THEN** the plugin makes no `synthetic` call
- **AND** it closes the attempt and settles the grant `deferred` with reason `offline`

#### Scenario: Time passes before the timer is armed
- **WHEN** time passes between the hook taking its deadline and arming its timer, and `session.get` never answers
- **THEN** the callback returns at the deadline, and not a whole budget after it

### Requirement: A hook that runs out of time settles by what it has written
A grant that the hook holds when the budget ends, and has not written to the session, MUST settle `deferred` with reason `offline`, whatever is left of its reservation. An admission that `session.synthetic` has not answered when the budget ends MUST settle `uncertain`. An input that `session.synthetic` has accepted MUST NOT be ended by the budget.

#### Scenario: The claim answers after the budget
- **WHEN** the budget ends while the claim is in flight, and the grant arrives later
- **THEN** the plugin makes no `synthetic` call and settles the grant `deferred` with reason `offline`

#### Scenario: The admission is in flight
- **WHEN** the budget ends and `session.synthetic` has not answered
- **THEN** the plugin settles the attempt `uncertain`

#### Scenario: The admission is accepted and the final heartbeat stalls
- **WHEN** `session.synthetic` has answered, the final `unknown` heartbeat is still in flight when the budget ends, and the exact delivered event arrives before the reservation deadline
- **THEN** the plugin settles the attempt `handed`, once the heartbeat has returned

### Requirement: The idle hook returns at once when there is nothing to deliver
The hook MUST return before its first wait, and do nothing, for a session with no joined record, a member that does not own the joins, a child or fork session, a session whose chat is off or has not sent its first heartbeat, and a session that has used its continuation allowance.

#### Scenario: Nothing to do
- **WHEN** the hook is called for an unknown session, a session that is not a root session, a session whose chat is off, or a member that is not the owner
- **THEN** the callback returns without a wait, and no host or worker call is made

### Requirement: The idle hook claims only for a session it has just proved eligible
Inside the hook, the plugin MUST read the session with `session.get`. It MUST make no claim unless the read succeeds in time, the session is a root session and its `agent` is not `plan`. It MUST also require the session's binding entry to hold the published text.

#### Scenario: Plan agent
- **WHEN** the hook is called for a session whose `agent` is `plan`
- **THEN** the plugin sends no heartbeat, no `pending` and no `claim`, and makes no `synthetic` call

#### Scenario: An unreadable session
- **WHEN** `session.get` throws, rejects or runs out of time inside the hook
- **THEN** the plugin makes no claim and no `synthetic` call

#### Scenario: The binding entry is not there
- **WHEN** the entry list is missing, does not hold the published binding, or cannot be read
- **THEN** the plugin makes no claim and no `synthetic` call

### Requirement: The idle hook's requests to the worker keep one order and never overlap
The hook MUST send a heartbeat with `native_state` `busy`, then `pending`, then `claim`, then the admission, and, in a `finally`, the regular non-eligible heartbeat. The sequence MUST run inside the worker's one request at a time. A hook that finds the worker busy MUST return and claim nothing, and a settlement that finds it busy MUST wait for it.

#### Scenario: Order of the worker's requests
- **WHEN** the hook delivers a batch
- **THEN** the worker receives the `busy` heartbeat, then `pending`, then `claim`
- **AND** the `unknown` heartbeat follows the admission, and the `settle` request, when there is one, follows it
- **AND** no two requests overlap

#### Scenario: The worker is busy
- **WHEN** a heartbeat is in flight when the hook runs
- **THEN** the hook returns at once and sends nothing

### Requirement: The hook admits one steer input that does not resume the session
The plugin MUST admit a claimed batch with one `session.synthetic` call that carries `delivery` `steer`, `resume` `false`, an `id` of `msg_` followed by the attempt id without its dashes, and the metadata `{ "source": "agent-chat" }`. It MUST NOT call `prompt` or `wait`.

#### Scenario: Admission
- **WHEN** the hook has a grant
- **THEN** it makes exactly one `session.synthetic` call with the fields above

### Requirement: The admitted text is a metadata notice within 8 KiB
The text of the input MUST be a one-line delivery prefix and a notice in metadata mode, with identifiers and cursors and no body, and the two together MUST NOT exceed 8 KiB. The plugin MUST settle a batch whose notice the renderer cannot produce as `deferred` with reason `offline`, and MUST NOT admit anything for it.

#### Scenario: A notice on the configured route
- **WHEN** the hook admits a batch on the `cli`, `mcp` or `mcp-with-cli-fallback` tool route
- **THEN** the text is the delivery prefix and the shared renderer's notice for that route, and carries no message body

#### Scenario: A batch that does not fit
- **WHEN** the metadata notice for the claimed batch is larger than the bound that the delivery prefix leaves
- **THEN** the plugin settles the batch `deferred` with reason `offline`
- **AND** it makes no `synthetic` call

### Requirement: A hook delivery is handed only on the host's delivered event for the exact input
The plugin MUST settle an admitted batch `handed` only when `session.inbox.delivered` arrives for exactly the inbox id that it passed to `session.synthetic`, before the attempt's deadline: the start of the claim plus the grant's `reservation_ms`. A delivered event for another id MUST NOT settle the attempt. It MUST settle every other case `uncertain` with reason `transport_ambiguous`.

#### Scenario: The exact event arrives in time
- **WHEN** `session.inbox.delivered` arrives for the inbox id of the open attempt before its deadline
- **THEN** the plugin settles the attempt `handed`, in the background, after the hook has returned

#### Scenario: Another id or a replay
- **WHEN** a delivered event names another id, such as another plugin's input or the id of an earlier attempt
- **THEN** the plugin does not settle the open attempt
- **AND** the exact event, if it arrives before the deadline, still settles the attempt `handed`

#### Scenario: A late event
- **WHEN** the delivered event for the exact id arrives at or after the attempt's deadline
- **THEN** the plugin settles the attempt `uncertain`
- **AND** an exact event that arrives after the attempt has settled is ignored

#### Scenario: A rejected admission
- **WHEN** `session.synthetic` throws or rejects
- **THEN** the plugin settles the attempt `uncertain`, because the input may exist and cannot be withdrawn

#### Scenario: The event stream is lost
- **WHEN** the plugin's event stream ends or restarts while an attempt is open
- **THEN** the plugin settles the attempt `uncertain`

#### Scenario: The deadline passes
- **WHEN** the attempt's deadline passes with no delivered event, or the grant has 500 milliseconds or less of its reservation left and the hook is still within its budget when it would admit it
- **THEN** the plugin settles the attempt `uncertain`

### Requirement: An attempt is settled once, and an event opens none
The plugin MUST keep at most one open attempt for a session, and MUST settle each attempt once. A newer attempt for a session MUST settle the older one `uncertain`. A `session.inbox.delivered` event MUST NOT open an attempt, a record or any other state of a session.

#### Scenario: A duplicate event
- **WHEN** the exact delivered event arrives twice
- **THEN** the plugin sends one `handed` settlement

#### Scenario: An event for a session with no attempt
- **WHEN** a delivered event arrives for a session with no open attempt, or for a session the plugin has never seen
- **THEN** the plugin sends no request and makes no host call

### Requirement: The hook delivers at most three inputs for each execution
The plugin MUST admit at most 3 inputs for one execution of a session, and MUST count an input when it opens the attempt, whatever becomes of the input. `session.execution.started` for the session MUST clear the count. A start that the plugin never saw MUST leave the count where it was, so a missed start only reduces delivery.

#### Scenario: The fourth delivery
- **WHEN** the hook has admitted 3 inputs for a session and no execution has started since
- **THEN** a fourth hook call for that session returns at once and makes no request and no host call

#### Scenario: A new execution
- **WHEN** `session.execution.started` arrives for the session
- **THEN** the next hook call for that session may admit an input again

#### Scenario: Another session starts
- **WHEN** `session.execution.started` arrives for another session
- **THEN** the count of the first session does not change

### Requirement: The limits of idle delivery are stated and accepted
The README of the OpenCode package MUST state each limit named in the scenario below, and the plugin MUST NOT claim to remove it. Idle delivery MUST stay `NOT RUN` in the compatibility matrix until a live run against a real OpenCode release has shown each point in the scenario "A live run".

#### Scenario: Accepted limits
- **WHEN** a reader asks what idle delivery does not do
- **THEN** the README says that an idle session receives nothing until its next turn, because the hook runs only at the end of model work and the plugin never resumes a session
- **AND** that an input admitted just after an interrupt, while the callback is still running, stays parked, is promoted at the session's next turn, and settles `uncertain` if that comes too late
- **AND** that the agent can switch to Plan between the check and the admission, that a session with no `agent` counts as not in Plan, and that a custom agent with Plan's limits is not detected
- **AND** that `handed` means the input was promoted into the session's history, not that the model read it
- **AND** that the hook is experimental and the plugin is pinned to OpenCode `2.3.2`
- **AND** that an admitted input cannot be withdrawn
- **AND** that a session whose hook runs in an instance that does not own the joins gets no delivery
- **AND** that a repeated `session.execution.started` clears the count early

#### Scenario: A live run
- **WHEN** the compatibility matrix is to record idle delivery as run
- **THEN** a recorded run against one exact release shows that the hook fires, that the exact inbox id is delivered and settled `handed`, that an idle session gets no claim, that a session in Plan Mode gets no claim, that an Esc in the middle of a turn produces no hook call and no claim, that a forced error in the hook does not fail the turn, and the hook's measured latency
