# chat-clients Specification

## Purpose
Defines how the shipped command-line client and the per-process adapter core behave toward a harness session: the exact binding context, binding-file safety, message and recipient handling, role selectors, one-step replies, the history and roster options of the CLI with the matching arguments of the MCP `history` and `who` tools, the adapter's join, heartbeat and bounded rejoin lifecycle, the notice contract that puts a peer message body into a harness session, and how the OpenCode plugin delivers from the host's idle hook.

## Requirements

### Requirement: The adapter exposes an exact binding context after joining
After a successful join the adapter MUST expose `python`, `instance_file`, `room_id`, `session_id`, `instance_id`, `native_session_id`, `host` and `harness` to its session as metadata, MUST NOT include a token, and MUST state that this binding supersedes every earlier one. When the adapter stops, fails or replaces its instance, it MUST withdraw the metadata.

#### Scenario: Joined session learns its binding
- **WHEN** an adapter has joined and the harness asks it for the session context
- **THEN** the context carries the eight binding fields and the route lines of the configured tool route
- **AND** on the `cli` route, and in the fallback lines of the `mcp-with-cli-fallback` route, it names the interpreter form and the environment variable the CLI needs
- **AND** on the `mcp` and `mcp-with-cli-fallback` routes it tells the model to call the agent-chat MCP `bind` tool, when the server exposes one, with exactly the `instance_file` shown, and again whenever a later binding shows a different one
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
Only a `settle` try that gets no complete answer, because the connection fails or ends early, or that gets a 5xx reply, MUST be sent again by the instance worker, with the same attempt and result, until 1 second before its 20-second request deadline, when the last failure MUST end the worker. A try the deadline cuts MUST report `REQUEST_UNCERTAIN`. A definite delivery refusal MUST be answered as refused. Any other failure MUST end the worker at once.

#### Scenario: The service answers after a brief outage
- **WHEN** a `settle` gets no complete answer or a 5xx reply, and a later try before the deadline is answered
- **THEN** the worker answers its parent with that answer
- **AND** each try carries the same attempt and the same result

#### Scenario: A definite refusal
- **WHEN** the service refuses a `settle` with a definite code such as `DELIVERY_CLOSED`
- **THEN** the worker sends no further try and answers its parent as refused

#### Scenario: A reply that ends early
- **WHEN** a `settle` reply stops inside its status line, short of its declared length, inside chunked framing, or before a reply that declares no length can be accepted
- **THEN** the try counts as one that got no complete answer
- **AND** a chunk size that is not hex counts the same, because the client cannot tell it from framing that stops
- **AND** a redirect is an answer once its status line and headers arrive, because the client refuses it without reading its body

#### Scenario: A complete reply that cannot be accepted
- **WHEN** a `settle` gets a complete reply below 500 that the client cannot accept, such as a redirect, a body that is not the service's, a code the client does not know, a 200 that names another attempt, or a complete status line or headers that the HTTP parser rejects
- **THEN** the worker sends no further try and ends at once

#### Scenario: The deadline is spent
- **WHEN** every try gets no complete answer or a 5xx reply until 1 second before the request deadline
- **THEN** the worker sends no further try, answers its parent with the code of the last failure and ends

#### Scenario: The deadline cuts a try
- **WHEN** the request deadline cuts a try short
- **THEN** the worker answers its parent with `REQUEST_UNCERTAIN` and ends
- **AND** a pause between tries that ends after the deadline starts no try, and the worker answers with the code of the last failure

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
A package MUST settle a batch for which the renderer returns nothing as `deferred` with reason `offline`, and MUST NOT send a partial or metadata notice in its place.

#### Scenario: The renderer returns nothing
- **WHEN** a claimed batch has a message that fails its pattern, or a batch that does not fit at cap 0
- **THEN** the package settles the batch as `deferred` with reason `offline`
- **AND** it sends no text to the session

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
