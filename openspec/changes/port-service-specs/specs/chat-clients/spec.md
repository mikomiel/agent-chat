# Spec Delta

## Purpose

Defines how the shipped command-line client and the per-process adapter core behave toward a harness session: the exact binding context, binding-file safety, message and recipient handling, role selectors, one-step replies, and the adapter's join, heartbeat and bounded rejoin lifecycle.

## ADDED Requirements

### Requirement: The adapter exposes an exact binding context after joining
After a successful join the adapter MUST expose `python`, `instance_file`, `room_id`, `session_id`, `instance_id`, `native_session_id`, `host` and `harness` to its session as metadata, MUST NOT include a token, and MUST state that this binding supersedes every earlier one. When the adapter stops, fails or replaces its instance, it MUST withdraw the metadata.

#### Scenario: Joined session learns its binding
- **WHEN** an adapter has joined and the harness asks it for the session context
- **THEN** the context carries the eight binding fields and names the interpreter form and the environment variable the CLI needs
- **AND** it carries no token and no other session's binding

#### Scenario: Instance replaced
- **WHEN** the adapter rejoins with a new instance
- **THEN** the context names the new instance file and says it supersedes every earlier binding

#### Scenario: Adapter stops or fails
- **WHEN** the adapter stops, or fails terminally
- **THEN** it withdraws the context and reports no binding

### Requirement: The CLI reads exactly one binding file
For every command except `produce`, the CLI MUST take its identity only from the file named by `AGENT_CHAT_INSTANCE_FILE`. It MUST NOT scan a directory, choose the latest file, register by itself, or fall back to an agent credential. The file MUST be named `<boot_id>.json`, hold exactly the keys `native_session_id`, `boot_id`, `token` and `server_origin`, and be a regular single-link file of at most 4096 bytes with mode 0600 in a real directory with mode 0700 owned by the effective user.

#### Scenario: Variable unset
- **WHEN** a command other than `produce` runs without `AGENT_CHAT_INSTANCE_FILE`
- **THEN** it fails with `BINDING_REQUIRED` and reads no other file

#### Scenario: Unsafe file or directory
- **WHEN** the file is a symlink, has more than one link, has the wrong mode or owner, or sits in a directory with the wrong mode or owner
- **THEN** the CLI fails with `BINDING_FILE_UNSAFE` and sends no request

#### Scenario: Missing or malformed file
- **WHEN** the file or its directory is missing, or the file name is not a boot identifier with `.json`, or the keys are not exactly the four listed
- **THEN** the CLI fails with `BINDING_FILE_MISSING` or `BINDING_FILE_INVALID` and sends no request

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

#### Scenario: Limit out of range
- **WHEN** a session runs `who`, `history` or `state` with a limit outside 1 to 100
- **THEN** the CLI fails with `INVALID_ARGUMENTS` and sends nothing

### Requirement: CLI results are machine-readable and redacted
Except for `--help` and the header line of a `state` result, the CLI MUST print one JSON document that holds `result`, or `error` with a stable `code` and an optional `hint`. It MUST redact the instance token from that document, and MUST echo the idempotency key of a command that has one, whether the caller gave it or the CLI derived it.

#### Scenario: Refusal printed
- **WHEN** a command fails with a stable code
- **THEN** the CLI prints one document that holds `error.code`, and a `hint` when the refusal has one
- **AND** a hint names flags, commands or rules and never a value the caller supplied

#### Scenario: Token never printed
- **WHEN** a response or error text would contain the instance token
- **THEN** the printed document shows `[REDACTED]` in its place

#### Scenario: Key echoed
- **WHEN** a session runs `send`, or `reply` with or without `--key`
- **THEN** the printed document carries `idempotency_key` with the key that the request used
- **AND** a command that has no key, such as `ack` or `who`, prints no `idempotency_key`

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
When a POST may have been sent and ends without a definitive answer, the CLI MUST print `REQUEST_UNCERTAIN` and exit with 4. This covers a dropped connection, a redirect, a 5xx without a known error, a malformed, truncated or oversized response and an unmapped status. A connection that cannot be made MUST fail with `TRANSPORT_UNAVAILABLE`, and a GET that ends without an answer with `TRANSPORT_UNAVAILABLE`, `REDIRECT_REFUSED`, `SERVICE_UNAVAILABLE` or `HTTP_REFUSED`.

#### Scenario: Keyed write with no answer
- **WHEN** a `send` or `reply` ends without a definitive answer after it was submitted
- **THEN** the CLI prints `REQUEST_UNCERTAIN`, echoes the idempotency key and exits with 4
- **AND** the caller recovers by repeating the same key and request

#### Scenario: Unkeyed write with no answer
- **WHEN** `ack`, `mute`, `unmute`, `resolve`, `unresolve`, `lane` or `work` ends without a definitive answer after it was submitted
- **THEN** the CLI prints `REQUEST_UNCERTAIN` and exits with 4
- **AND** the document carries no idempotency key

#### Scenario: Read with no answer
- **WHEN** a GET command such as `who` ends in a dropped connection, a redirect or a server error without a known code
- **THEN** the CLI fails with `TRANSPORT_UNAVAILABLE`, `REDIRECT_REFUSED` or `SERVICE_UNAVAILABLE` and exits with 1

#### Scenario: Connection not made
- **WHEN** the CLI cannot connect to the service
- **THEN** it fails with `TRANSPORT_UNAVAILABLE` and exits with 1, whatever the command

### Requirement: A 20-second alarm bounds every command
The CLI MUST arm a 20-second alarm for the whole command. When it fires outside an HTTP request, such as while the CLI waits for standard input, the CLI MUST print `CLI_INTERRUPTED` and exit with 1. When it fires after the connection is made, the request MUST end as `REQUEST_UNCERTAIN` for a POST and as `TRANSPORT_UNAVAILABLE` for any other method; when it fires before, as `TRANSPORT_UNAVAILABLE` for every method.

#### Scenario: Standard input stalls
- **WHEN** standard input stays open and silent until the alarm fires
- **THEN** the CLI prints `CLI_INTERRUPTED` and exits with 1
- **AND** it has sent no request

#### Scenario: Alarm during a request
- **WHEN** the alarm fires after the connection is made, while the request is still in progress
- **THEN** the request ends as `REQUEST_UNCERTAIN` for a POST and as `TRANSPORT_UNAVAILABLE` for any other method
- **AND** the CLI does not print `CLI_INTERRUPTED` for it

#### Scenario: Alarm before the connection is made
- **WHEN** host name resolution stalls until the alarm fires
- **THEN** the CLI fails with `TRANSPORT_UNAVAILABLE` and exits with 1, for a POST too

### Requirement: Socket steps time out after 3 seconds
The CLI MUST time out each socket connect, send and receive step of a request after 3 seconds. The bound does not cover host name resolution; only the 20-second alarm limits it.

#### Scenario: Peer stops answering
- **WHEN** the service accepts a connection and then sends nothing for 3 seconds
- **THEN** the step times out, and the CLI reports `REQUEST_UNCERTAIN` for a POST or `TRANSPORT_UNAVAILABLE` for any other method

### Requirement: Recipients resolve to concrete sessions
The CLI MUST resolve each `--to` selector, a session UUID, a label, `harness@host` or `harness@host/native-id`, to a concrete session UUID. It MUST refuse a selector that matches several sessions, online or offline, with `AMBIGUOUS_RECIPIENT` and the candidates, and MUST NOT choose one. It MUST refuse more than 16 selectors.

#### Scenario: Two sessions match the alias
- **WHEN** two sessions of one harness and host exist and the sender enters `harness@host`
- **THEN** the CLI exits with 3, lists both candidates and publishes nothing

#### Scenario: UUID needs no roster read
- **WHEN** a selector is a session UUID
- **THEN** the CLI uses it without reading the roster

#### Scenario: Unknown selector
- **WHEN** no session matches a selector
- **THEN** the CLI fails with `INVALID_RECIPIENT` and publishes nothing

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
The adapter MUST join only when `enabled` is true and the harness is `pi`, `codex`, `claude`, `deepseek` or `opencode`, MUST persist the binding secret first and then register with the agent credential and only the digest of that secret, and MUST heartbeat every 30 seconds by default. It MUST treat a join response that does not name exactly the session, instance, room, host and harness as `REQUEST_UNCERTAIN`. On stop it MUST end the instance and discard the binding file.

#### Scenario: Join and heartbeat
- **WHEN** an enabled adapter starts for a native session
- **THEN** it persists the binding file, registers with the token digest and heartbeats every 30 seconds
- **AND** the registration request carries the digest and not the token

#### Scenario: Disabled or unknown harness
- **WHEN** the adapter is asked to join while `enabled` is not true, or with another harness
- **THEN** it refuses with `INTEGRATION_DISABLED` or `INVALID_REQUEST` and sends no request

#### Scenario: Stop with the end call failing
- **WHEN** the adapter stops and the end call fails
- **THEN** it keeps the binding file, and the server's 90-second lease ends the instance

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
