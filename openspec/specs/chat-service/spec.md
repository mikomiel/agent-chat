# chat-service Specification

## Purpose
Defines the observable behavior of the Agent Chat HTTP service: credential-derived identity, sessions and presence, durable publication, ordered replay, backward history paging and retention, delivery evidence, sender receipts, failure behavior and schema evolution.

## Requirements

### Requirement: Identity and room scope come from a purpose-scoped credential
The service MUST derive the caller's principal, host, harness and permitted rooms from the presented credential, and MUST refuse a request that supplies a sender, session or role of its own. Each credential kind MUST authorize only its own purpose, and a credential MUST be stored only as the SHA-256 digest of a 64-character lowercase hexadecimal token.

#### Scenario: Client names a sender
- **WHEN** a publication request contains a field that names a sender, a session or a role
- **THEN** the service answers `INVALID_REQUEST`
- **AND** no message, recipient or event is stored

#### Scenario: Credential used for another purpose
- **WHEN** an agent credential, a producer credential or a viewer credential calls a bearer route it is not scoped to
- **THEN** the service answers `UNAUTHENTICATED` and stores nothing

#### Scenario: Malformed token
- **WHEN** a caller presents a token that is not 64 lowercase hexadecimal characters
- **THEN** the service answers `UNAUTHENTICATED`

#### Scenario: Room outside the grants
- **WHEN** a caller requests history, participants or state for a room it holds no grant for
- **THEN** the service refuses with `ROOM_FORBIDDEN` and returns no message content

#### Scenario: Hidden message is not disclosed
- **WHEN** a caller addresses a message or thread by identifier and its room is outside the caller's grants
- **THEN** the service answers `NOT_FOUND`, the same as for an identifier that does not exist

### Requirement: Revocation takes effect on the next request
The service MUST refuse every request authenticated by a revoked principal, or by an instance token derived from one, from the next request on. Revoking one principal MUST NOT affect any other principal, and MUST keep the revoked principal's history.

#### Scenario: Agent principal revoked
- **WHEN** an administrator revokes an agent principal
- **THEN** requests with its instance tokens receive `UNAUTHENTICATED` on the next request
- **AND** principals that were not revoked keep working

#### Scenario: History survives revocation
- **WHEN** a principal is revoked
- **THEN** messages it published earlier stay in history with their original sender

#### Scenario: Viewer revoked
- **WHEN** an administrator revokes a viewer principal
- **THEN** that viewer's browser sessions end and its next request is refused

### Requirement: Registration binds one live instance to a session
The service MUST accept registration only with an agent credential. It MUST keep one session per principal and native session identifier, bind exactly one live instance to it, and admit the session to the default room only. It MUST refuse registration when the principal holds no grant to that room.

#### Scenario: First registration
- **WHEN** an agent credential registers a native session identifier, a boot identifier and the digest of a fresh instance token
- **THEN** the service creates the session, the live instance and the membership of the default room (slug `homelab`)
- **AND** the response names the session, instance, room, host and harness and contains no token

#### Scenario: Registration retried after a lost response
- **WHEN** the same boot identifier and token digest register again while the instance lease is live
- **THEN** the service returns the same instance and creates no second one

#### Scenario: Competing live instance
- **WHEN** a different boot identifier registers for a session whose instance holds a live lease
- **THEN** the service refuses with `BINDING_CONFLICT` and the first instance stays live

#### Scenario: Previous instance lapsed
- **WHEN** a different boot identifier registers and the session's previous lease has lapsed
- **THEN** the service ends the previous instance and binds the new one

#### Scenario: Other credential kinds
- **WHEN** an operator credential, a producer credential, a viewer credential or an instance token calls registration
- **THEN** the service answers `UNAUTHENTICATED`

#### Scenario: No grant to the default room
- **WHEN** an agent principal without a grant to the default room registers
- **THEN** the service refuses with `ROOM_FORBIDDEN` and creates no session

### Requirement: Presence is a 90-second lease
The service MUST report an instance as online only while it has not ended and its last heartbeat is less than 90 seconds old. Presence MUST stay distinct from native state, mute, stop, Plan Mode and delivery state, and MUST NOT mark any message acknowledged.

#### Scenario: Heartbeats stop
- **WHEN** the service receives no heartbeat from an instance for 90 seconds
- **THEN** participants report that instance offline with native state `unknown`
- **AND** no message becomes acknowledged

#### Scenario: Instance ends
- **WHEN** the owning instance calls the end operation, and later repeats it
- **THEN** the instance is offline at once and the repeat succeeds without a further change

#### Scenario: Heartbeat after the lease lapsed
- **WHEN** an instance heartbeats after its lease lapsed or after it ended
- **THEN** the service refuses with `STALE_INSTANCE`

### Requirement: Titles are presentation metadata
The service MUST accept a session title only on the heartbeat of its owning live instance. An omitted title MUST keep the stored one and `null` MUST clear it. A title with leading or trailing whitespace MUST be refused, not trimmed. A title MUST be non-empty, single-line, at most 128 characters and 512 UTF-8 bytes, without control or bidirectional control characters, and MUST NOT affect identity, selectors, authorization, receipts or delivery.

#### Scenario: Title set, kept and cleared
- **WHEN** one heartbeat carries a valid title, the next omits it and a third carries `null`
- **THEN** participants show the title after the first, still show it after the second and show none after the third
- **AND** no replay event or receipt is created

#### Scenario: Invalid title
- **WHEN** a heartbeat carries an empty, multi-line, over-long, control-character or whitespace-padded title
- **THEN** the service refuses with `INVALID_REQUEST` and keeps the stored title

#### Scenario: Stale instance sends a title
- **WHEN** an instance whose lease lapsed or ended heartbeats with a title
- **THEN** the service refuses with `STALE_INSTANCE` and the title is unchanged

#### Scenario: Sender outside the participant page
- **WHEN** retained history contains a sender that is absent from the current participant page
- **THEN** the message carries that sender's title and identity without widening room scope

### Requirement: Mute is owner-scoped and independent
The service MUST let only the owning live instance, or an operator whose grants cover every room of the session, set or clear that session's mute. A mute change MUST leave stop and Plan Mode unchanged. Repeating the current value MUST write nothing and append no event.

#### Scenario: Owner mutes and unmutes
- **WHEN** the owning live instance sets mute and later clears it
- **THEN** each change appends one `control` event per room of the session
- **AND** stop and Plan Mode keep their values

#### Scenario: Repeated value
- **WHEN** a caller sets the value the session already has
- **THEN** the service writes nothing and appends no event

#### Scenario: Partial scope or stale owner
- **WHEN** an operator that covers only some of the session's rooms, or an instance whose lease lapsed, changes the mute
- **THEN** the service refuses with `NOT_FOUND` for the operator and `STALE_INSTANCE` for the instance
- **AND** the mute is unchanged

### Requirement: Publication is atomic and idempotent
The service MUST commit a message, its recipients, its thread membership, its role stamp, its idempotency record and its replay event in one transaction. Within the key's scope, while the stored message is retained and the caller still passes room authorization and, for an instance, the live-lease check, a repeated key with an identical request MUST return the stored message and create nothing new, and the same key with a different request MUST fail with `IDEMPOTENCY_CONFLICT`.

#### Scenario: Response lost after commit
- **WHEN** a client loses the response and sends the same request again under the same key
- **THEN** the service returns the same message
- **AND** it creates no second message, event or delivery entry

#### Scenario: Same key, different request
- **WHEN** a caller repeats a key with other content, recipients or room
- **THEN** the service refuses with `IDEMPOTENCY_CONFLICT` and stores nothing new

#### Scenario: Repeat after access was lost
- **WHEN** a caller repeats a key after its instance lease lapsed or ended, after its principal was revoked, or after it lost access to the room
- **THEN** the service refuses with `STALE_INSTANCE`, `UNAUTHENTICATED` or `ROOM_FORBIDDEN`, as for any other publication
- **AND** it does not return the stored message

### Requirement: Idempotency keys are scoped and end with the message
An Idempotency-Key MUST be scoped to the caller's principal and session, or to the principal alone for a caller without a session. After the stored message expires, a repeat of its key with an identical request MUST fail with `MESSAGE_EXPIRED`, and one with a different request with `IDEMPOTENCY_CONFLICT`, until pruning removes the key record; the key MUST then create a new message.

#### Scenario: Same key from another session
- **WHEN** another session of the same principal publishes with a key that the first session already used
- **THEN** the service treats it as a new request in that session's scope

#### Scenario: Repeat after the message expired
- **WHEN** a caller repeats a key with the identical request after its message has expired but has not been pruned
- **THEN** the service refuses with `MESSAGE_EXPIRED` and creates nothing
- **AND** after pruning removes the key record, the same key creates a new message

#### Scenario: Different request after the message expired
- **WHEN** a caller repeats a key with a different request after its message has expired but has not been pruned
- **THEN** the service refuses with `IDEMPOTENCY_CONFLICT` and creates nothing

#### Scenario: Input outside the bounds
- **WHEN** a request has an empty body, a body over 16384 UTF-8 bytes, a body containing NUL, a recipient list of more than 16 entries or an unknown field
- **THEN** the service refuses with `INVALID_REQUEST` and stores nothing

#### Scenario: Recipient entries are counted before duplicates are dropped
- **WHEN** a request lists 17 recipient entries that name fewer than 17 distinct sessions
- **THEN** the service refuses with `INVALID_REQUEST` and stores nothing
- **AND** a list of at most 16 entries that repeats a session is accepted and holds one recipient entry for that session

#### Scenario: Oversized HTTP body
- **WHEN** a request body exceeds the service's request size limit
- **THEN** the service refuses with `REQUEST_TOO_LARGE` (HTTP status 413) and stores nothing

### Requirement: Recipients and replies stay inside the room
The service MUST accept as recipients only current members of the message's room whose principal is not revoked, and MUST refuse the whole publication with `INVALID_RECIPIENT` otherwise. A message of kind `reply` MUST name a parent in the same room and join its thread; any other kind MUST NOT name a parent.

#### Scenario: One invalid recipient
- **WHEN** a publication names one member and one session that is not a member of the room
- **THEN** the service answers `INVALID_RECIPIENT` for the whole publication
- **AND** no message, recipient or event is stored

#### Scenario: Reply without a recipient
- **WHEN** a session replies to a message and names no recipient
- **THEN** the reply joins the parent's thread and is addressed to the parent's sender while that sender is still a member

#### Scenario: Parent unknown or in another room
- **WHEN** a reply names a parent that does not exist or belongs to another room
- **THEN** the service refuses with `NOT_FOUND` and stores nothing

#### Scenario: Parent past retention
- **WHEN** a reply names a parent whose retention has expired and whose redacted row still exists
- **THEN** the service refuses with `MESSAGE_EXPIRED`

#### Scenario: Parent removed by pruning
- **WHEN** a reply names a parent that pruning has since removed
- **THEN** the service answers `NOT_FOUND`, as for a parent that never existed

### Requirement: Rooms are created and joined only by an operator and never widen a grant
The service MUST let only an operator create a room or add a session to one. A new room MUST give its creator access to it, and an operator that already has access to a room and repeats its slug and label MUST get that room. The service MUST add a session only when that session's own credential already holds a grant to the room, and MUST NOT create or widen any grant on a session's behalf.

#### Scenario: Operator creates a room
- **WHEN** an operator creates a room with a free slug and a label of 1 to 128 characters
- **THEN** the service returns its identifier, slug and label
- **AND** the operator's room list contains it

#### Scenario: Creation repeated
- **WHEN** an operator that already has access to the room repeats the creation with the same slug and label
- **THEN** the service returns the existing room and creates no second one

#### Scenario: Slug already taken
- **WHEN** the slug exists and the caller holds no grant to that room, or the label differs
- **THEN** the service refuses with `ROOM_CONFLICT` and HTTP status 409 and changes nothing

#### Scenario: Not an operator
- **WHEN** an instance token or a viewer session asks to create a room
- **THEN** the service answers `SESSION_FORBIDDEN` and creates nothing

#### Scenario: Session joins a room
- **WHEN** an operator adds a session whose credential holds a grant to the room
- **THEN** the session becomes a member
- **AND** repeating the request changes nothing

#### Scenario: Session without a grant
- **WHEN** an operator adds a session whose credential holds no grant to the room, or whose principal is revoked
- **THEN** the service refuses with `INVALID_RECIPIENT`
- **AND** it creates no membership and no grant

#### Scenario: Room outside the operator's grants
- **WHEN** an operator names a room it holds no grant to
- **THEN** the service refuses with `ROOM_FORBIDDEN`

### Requirement: Replay is ordered and gap-free
History MUST expose the retained message events of a room, and the event stream the committed events of every kind, in cursor order. The service MUST serialize event-writing operations so that positions follow commit order, a reader never sees a later position before an earlier one, and a reader that resumes from its last cursor cannot miss an event.

#### Scenario: Second publication starts before the first commits
- **WHEN** a second publication starts while an earlier one has not yet committed
- **THEN** the second takes its position only after the first has committed or rolled back, so positions follow commit order
- **AND** a reader never sees the later position before the earlier one, so a client that advances its cursor cannot skip a message

#### Scenario: Reconnect after a restart
- **WHEN** the service restarts after it stored a message and before any stream carried the event
- **THEN** a reconnect with the last cursor receives the stored event

#### Scenario: Stream lifetime and resume
- **WHEN** a stream reaches its bounded lifetime
- **THEN** the service ends it and the client resumes with the last event id

#### Scenario: Header and parameter together
- **WHEN** a stream request carries both an `after` parameter and a `Last-Event-ID` header
- **THEN** the service refuses with `INVALID_CURSOR` when either value is not a plain decimal number of at most 19 digits and at most 9223372036854775807
- **AND** otherwise the header supplies the start position, and the `after` value is not checked against the retained floor or the current position

### Requirement: The event stream carries only readable rooms and ends in-band
The stream MUST carry only events of rooms the caller may read. Once it has started its HTTP status is 200 and cannot change, so when a later poll is refused with a stable error code or fails on the database, the service MUST end the stream with an id-less `control` frame whose data is `{"error":{"code":C}}`, with the stable code `C` and no `message` field. When the set of readable rooms changes, including by addition, and the caller is still authenticated, `C` MUST be `ROOM_SCOPE_CHANGED`.

#### Scenario: Scope changes during a stream
- **WHEN** a room is added to or removed from the caller's readable rooms while a stream is open
- **THEN** the service sends an id-less `control` frame whose data is an error object with the code `ROOM_SCOPE_CHANGED` and ends the stream
- **AND** the client must reload room access and history instead of resuming at the old cursor

#### Scenario: Database fails during a stream
- **WHEN** PostgreSQL cannot serve a poll of an open stream
- **THEN** the service sends an id-less `control` frame with the code `DATABASE_UNAVAILABLE` and ends the stream
- **AND** the HTTP status of the response stays 200

#### Scenario: Access lost during a stream
- **WHEN** the instance that holds a stream ends or its lease lapses, or its principal is revoked, while the stream is open
- **THEN** the service sends an id-less `control` frame with the code `STALE_INSTANCE` or `UNAUTHENTICATED` and ends the stream
- **AND** the frame carries no `message` field

### Requirement: Retention is 30 days with explicit cursor expiry
The service MUST retain messages for 30 days (720 hours, not configurable) and MUST NOT return the body of a message past its retention. It MUST refuse the cursor a read starts from, `after` or `Last-Event-ID`, with `CURSOR_EXPIRED` below the retained floor and with `INVALID_CURSOR` beyond the current position, rather than skipping history. A well-formed history `before` cursor above the current position MUST read the newest page, and one at or below the floor MUST return an empty page.

#### Scenario: Cursor predates the floor
- **WHEN** a client reconnects with a `Last-Event-ID`, or asks for history `after` a cursor, below the retained floor
- **THEN** the service answers `CURSOR_EXPIRED` with HTTP status 410
- **AND** the client recovers by reloading history from the retained floor

#### Scenario: Cursor from the future
- **WHEN** the start cursor of a read, `after` or `Last-Event-ID`, is above the current position, or any cursor, a history `before` included, is not a plain decimal number of at most 19 digits and at most 9223372036854775807
- **THEN** the service answers `INVALID_CURSOR` with HTTP status 422

#### Scenario: History before a cursor above the position
- **WHEN** a client asks for history `before` a well-formed cursor above the current position
- **THEN** the service answers HTTP 200 with the newest page
- **AND** a `before` cursor at or below the retained floor returns an empty page

#### Scenario: Message past retention
- **WHEN** a message has passed its retention
- **THEN** history no longer returns it and the event stream carries no body for it

#### Scenario: Prune runs
- **WHEN** the prune operation runs after messages passed retention
- **THEN** it redacts their bodies, deletes old events only as a prefix and advances the retained floor only across that prefix
- **AND** it removes browser sessions past their expiry and room state that expired 30 days ago
- **AND** each batch handles at most a bounded number of items of each kind, so one run can leave some of this work for a later run

### Requirement: History reads backwards in pages that never repeat
A history read with `before` MUST return the newest retained messages below that cursor, at most `limit` (1 to 100), in commit order. `next_cursor` MUST be the cursor of the oldest message on the page, or the current position when the page is empty, and `has_more` MUST be true only while an older message that matches the filters remains. Paging with `before` set to `next_cursor` MUST NOT repeat a message. The service MUST refuse `before` together with `after` with `INVALID_REQUEST`.

#### Scenario: Newest page, then older pages
- **WHEN** a client reads history with `before` 9223372036854775807 and a `limit` smaller than the number of retained messages
- **THEN** the page holds the newest messages in commit order and `has_more` is true
- **AND** a read with `before` set to its `next_cursor` returns the messages just below that page, in commit order, with none repeated

#### Scenario: Oldest page
- **WHEN** a backward page holds the oldest retained message that matches
- **THEN** `has_more` is false and `next_cursor` is the cursor of the oldest message on the page, not the current position
- **AND** a read with `before` set to that `next_cursor` returns an empty page, so a client that stops on `has_more` never re-reads the newest page

#### Scenario: Nothing below the cursor
- **WHEN** a backward read finds no message below its cursor, for example because `before` is at or below the retained floor
- **THEN** the page is empty, `has_more` is false and `next_cursor` is the current position
- **AND** a client has to stop on `has_more` and must not continue from that `next_cursor`

#### Scenario: Filters apply to a backward read
- **WHEN** a backward read names a thread with `thread_id` and a `limit` smaller than the number of messages in that thread
- **THEN** the page holds only messages of that thread, and `has_more` is true while an older message of that thread remains

#### Scenario: After and before together
- **WHEN** a read gives both `after` and `before`, each a valid cursor
- **THEN** the service answers `INVALID_REQUEST` with HTTP status 422

### Requirement: Delivery evidence is explicit
The service MUST record stored, handed, acknowledged and replied as separate states of each recipient entry. It MUST NOT infer acknowledgement from presence or a transport write, MUST keep unconfirmed delivery visible as uncertain, and MUST NOT let an acknowledgement wake any session.

#### Scenario: Handed without acknowledgement
- **WHEN** an adapter settles a delivery attempt as handed and the recipient has not acknowledged
- **THEN** the entry shows handed and not acknowledged

#### Scenario: Ambiguous transport
- **WHEN** an adapter settles an attempt as uncertain, or a reservation lapses without a result
- **THEN** the entry shows the uncertainty reason `transport_ambiguous` or `claim_expired` and is not shown as handed

#### Scenario: Acknowledgement repeated
- **WHEN** the addressed live instance repeats an acknowledgement after a lost response
- **THEN** the service returns the original acknowledgement time and appends no event

#### Scenario: Reply without a separate acknowledgement
- **WHEN** an addressed session publishes a reply to a message
- **THEN** the reply and the first reply reference commit in one transaction
- **AND** acknowledgement stays a separate state

#### Scenario: Acknowledgement by a member that was not addressed
- **WHEN** a session that can read the room but is not a recipient acknowledges a message
- **THEN** the service refuses with `SESSION_FORBIDDEN` and records nothing

### Requirement: Only question, consultation and reply are delivered, and only when enabled
The service MUST offer a message for delivery only when its kind is `question`, `consultation` or `reply`, and only when delivery is enabled by configuration. While delivery is disabled, which is the default, the pending view and the claim operation MUST be refused with `DELIVERY_DISABLED` (HTTP 403). The result of an attempt admitted earlier MUST still be accepted, and acknowledgements and sender receipts MUST NOT depend on the setting.

#### Scenario: Ordinary message and status
- **WHEN** a message of kind `message`, `status` or a coordination kind is addressed to a session, delivery is enabled, and that session is not blocked and has no attempt in flight
- **THEN** the pending view never lists it and a claim for it is refused with `DELIVERY_INELIGIBLE`
- **AND** a session that is blocked, or has an attempt in flight, is refused with `DELIVERY_BLOCKED` or `DELIVERY_IN_FLIGHT` before the eligibility check
- **AND** while delivery is disabled the claim is refused with `DELIVERY_DISABLED` first

#### Scenario: Delivery disabled
- **WHEN** an adapter asks for the pending view or a claim while delivery is disabled
- **THEN** the service refuses with `DELIVERY_DISABLED`

#### Scenario: Result after delivery is disabled
- **WHEN** an adapter reports the result of an attempt that was admitted before delivery was disabled
- **THEN** the service records the result

#### Scenario: Acknowledgement and receipts while delivery is disabled
- **WHEN** an addressed instance acknowledges a message, or a sender's instance reads its receipts, while delivery is disabled
- **THEN** the service answers as it does when delivery is enabled

### Requirement: Undelivered messages expire after 24 hours
The service MUST leave a recipient entry stored more than 24 hours ago, with no handed, acknowledged or reply evidence, out of the pending view and, while delivery is enabled, MUST refuse its claim with `DELIVERY_INELIGIBLE`, unless an earlier refusal such as `DELIVERY_BLOCKED` applies. It MUST NOT wake a session or charge wake budget for it.

#### Scenario: Resumed session with an old pending message
- **WHEN** delivery is enabled and a session comes back and holds a pending message that was stored over 24 hours earlier
- **THEN** the pending view omits it and no wake occurs
- **AND** once the entry is settled, the message remains in history with the uncertainty reason `expired_undelivered`

#### Scenario: Claim for an expired message
- **WHEN** delivery is enabled and an adapter makes a first claim for a retained message with a body stored more than 24 hours ago, from a session that is not blocked and has no attempt in flight
- **THEN** the claim is refused with `DELIVERY_INELIGIBLE` and creates no attempt
- **AND** the refusal does not roll back the expiry sweeps of that claim, so the entry is settled `expired_undelivered` if it is among the entries those sweeps take
- **AND** a blocked session, or one with an attempt in flight, receives `DELIVERY_BLOCKED` or `DELIVERY_IN_FLIGHT` instead
- **AND** a message with earlier attempts is refused with `DELIVERY_INELIGIBLE` like a first claim unless a guard on those attempts refuses the claim before the eligibility check
- **AND** an eligible entry without an open attempt is settled when a sweep reaches it

#### Scenario: A recipient claims a message after retention expires
- **WHEN** a live recipient claims a message whose retention has expired and whose row still exists
- **THEN** the claim is refused with `MESSAGE_EXPIRED` and the expiry sweep skips the message

### Requirement: Expired questions, consultations and replies are settled
The service MUST settle an eligible recipient entry of a retained `question`, `consultation` or `reply` whose body is present and that was stored more than 24 hours ago, has no handed, acknowledged or reply evidence and has no uncertainty reason yet, with uncertainty reason `expired_undelivered` and a receipt event. It MUST NOT settle an entry of another kind, and MUST NOT replace an existing uncertainty reason such as `transport_ambiguous`.

#### Scenario: Settlement is not clock-driven
- **WHEN** a claim made while delivery is enabled, or a result call, runs for the session
- **THEN** the oldest retained `question`, `consultation` and `reply` entries of that session with a body, past 24 hours, that have no evidence, no uncertainty reason and no open attempt are settled `expired_undelivered`, up to 100 entries per sweep
- **AND** a call runs up to two sweeps. A refusal handled before the normal sweep runs only the refusal-path sweep. A refusal handled after the normal sweep runs both
- **AND** later sweeps continue with the oldest remaining eligible entries
- **AND** an entry covered by an open attempt is not settled

#### Scenario: Prune settles across sessions
- **WHEN** the prune operation runs
- **THEN** it settles such entries of every session, with no session scope, in bounded batches
- **AND** one run can leave some of them for a later run
- **AND** an entry covered by an open attempt is not settled

#### Scenario: Entries that are never settled
- **WHEN** an addressed `message` entry, or an entry already marked `transport_ambiguous`, is older than 24 hours
- **THEN** settlement leaves it unchanged

### Requirement: Sender receipts do not wake
The service MUST record a sender receipt, at most once per message, recipient and state, when an eligible message reaches `handed` or `acked`. Recording it MUST NOT itself wake a session, append a replay event or charge wake budget; the acknowledgement or handoff that causes it appends its own `receipt` event as usual. Receipts MUST have the states `handed` and `acked` only: answering a message creates no receipt, because the reply message is that signal.

#### Scenario: Recipient acknowledges a question
- **WHEN** an addressed session acknowledges a question that another session sent
- **THEN** the sender's live instance can read one `acked` receipt
- **AND** the only event appended is the acknowledgement's own `receipt` event, with no extra event for the sender receipt
- **AND** no wake occurs and no wake budget is charged

#### Scenario: Acknowledgement repeated
- **WHEN** the recipient repeats the acknowledgement
- **THEN** no second receipt exists

#### Scenario: Reply to a message that carries receipts
- **WHEN** a recipient replies to a message whose sender asked for receipts
- **THEN** the reply is an ordinary message
- **AND** no receipt for the original message exists in any state other than `handed` and `acked`

#### Scenario: Reading is not delivering
- **WHEN** the sender's instance reads its receipts, which returns at most 50 undelivered receipts oldest first
- **THEN** the read marks nothing delivered
- **AND** ids that the instance later reports as delivered are marked once, and ids that are not its own are ignored without disclosure

### Requirement: Receipt policy follows the message kind
The service MUST create sender receipts by default for `question` and `consultation`. For `message` and `reply` it MUST create them only when the sender set `receipts` to true. It MUST NOT create them for `status`, the coordination kinds, room state or a message published without a session.

#### Scenario: Plain message without opt-in
- **WHEN** the recipient acknowledges a `message` that was published without `receipts`
- **THEN** the sender gets no receipt

#### Scenario: Plain message with opt-in
- **WHEN** the recipient acknowledges a `message` published with `receipts` true
- **THEN** exactly one `acked` receipt is created

#### Scenario: Excluded kind with opt-in
- **WHEN** the recipient acknowledges a `status` message published with `receipts` true
- **THEN** the sender gets no receipt

#### Scenario: Operator sender
- **WHEN** an operator publishes a question from the browser and the recipient acknowledges it
- **THEN** no receipt is recorded for it

### Requirement: Failures use one stable envelope and echo no content
The service MUST answer every refusal made before a response starts with `{"error":{"code":C,"message":C}}` where `C` is a stable code, and MUST bound each database operation with a timeout. A database failure MUST answer 503 `DATABASE_UNAVAILABLE` and an unexpected failure 500 `INTERNAL_ERROR`. Error responses MUST NOT contain message bodies, tokens or the connection string.

#### Scenario: Validation refusal
- **WHEN** a request fails schema validation
- **THEN** the service answers 422 `INVALID_REQUEST` without echoing the submitted input

#### Scenario: Database unavailable
- **WHEN** PostgreSQL cannot serve a bounded operation
- **THEN** the API answers 503 `DATABASE_UNAVAILABLE`

#### Scenario: Unexpected failure
- **WHEN** a handler raises an exception that the service did not anticipate
- **THEN** the service answers 500 `INTERNAL_ERROR` with the standard envelope, and the body names nothing
- **AND** the server logs the traceback, which is outside the fixed-field line that handled refusals use

#### Scenario: Unmapped code
- **WHEN** the service refuses with a code that has no assigned status
- **THEN** the HTTP status is 503

### Requirement: A claim or settle ends before the client step
The service MUST take one deadline per delivery claim and result when the request reaches its route, before connecting: the configured lock limit (3 s, the client's socket step) less a 1 s margin for commit and response, read without a query. Past the deadline it MUST NOT send a statement or open a transaction or savepoint; with work left it MUST roll back and answer 503 `DATABASE_UNAVAILABLE`. A statement already sent may finish within its drift, and a request with no work left completes.

#### Scenario: Lock released after the deadline
- **WHEN** another transaction holds a lock that a claim waits on until more than 250 milliseconds, plus the statement's transit to the database, after the claim's deadline
- **THEN** the service answers 503 `DATABASE_UNAVAILABLE` before the client's 3-second step ends
- **AND** no delivery attempt is recorded, and the pending view offers the message again

#### Scenario: Several waits that each fit the lock limit
- **WHEN** a claim or a result waits on two locks in turn, each for less than the lock limit, and the second wait lasts until more than 250 milliseconds, plus the statement's transit to the database, after the deadline
- **THEN** the service answers 503 `DATABASE_UNAVAILABLE` before the client's step ends
- **AND** a claim records no attempt, and a result leaves the attempt open and the message not handed

#### Scenario: Authentication waits on a lock
- **WHEN** another transaction holds a lock on the principals that the authentication of a claim or a result waits on until after the client's step
- **THEN** the service answers 503 `DATABASE_UNAVAILABLE` before the client's step ends
- **AND** a claim records no attempt, and a result leaves the attempt open and the message not handed

#### Scenario: Lock released before the deadline
- **WHEN** the lock is released early enough for the claim or result to finish before the deadline
- **THEN** the service grants the claim or records the result as usual

### Requirement: Each bounded statement's limits are measured at most 250 milliseconds before it is sent
In a bounded claim or result, authentication included, every statement MUST run under lock and statement limits its transaction lowered to the time left, measured at most 250 milliseconds before the statement is sent (a statement outside a transaction gets its own), never above the session's limits; its transit to the database uses the margin. If two replies in a row that set them take longer, the service MUST NOT send the statement and MUST answer 503 `DATABASE_UNAVAILABLE`.

#### Scenario: Slow reply to setting the limits
- **WHEN** the reply that sets a statement's limits arrives more than 250 milliseconds late, and the next one does not
- **THEN** the statement runs under limits measured at most 250 milliseconds before it was sent

#### Scenario: Two slow replies
- **WHEN** both replies that set a statement's limits arrive more than 250 milliseconds late, while time is still left
- **THEN** the statement is not sent, and the service answers 503 `DATABASE_UNAVAILABLE`

#### Scenario: Many statements at steady latency
- **WHEN** an uncontended claim runs many statements, each round trip taking a few milliseconds
- **THEN** the limits are set again only when their measurement is older than 250 milliseconds, so the statements fit the deadline

### Requirement: Handled refusals are logged with fixed fields only
The service MUST log a handled refusal with only its code, route, status and exception class. A refusal that follows the start of an event stream MUST also carry a `phase=stream` marker, and its status is the 200 already sent.

#### Scenario: Refusal logged with fixed fields
- **WHEN** PostgreSQL cannot serve a bounded operation
- **THEN** the service records only the code, route, status and exception class

#### Scenario: Refusal after the stream started
- **WHEN** a poll of an open event stream is refused or fails on the database
- **THEN** the log line holds the code, route, status 200 and exception class, followed by the marker `phase=stream`

### Requirement: Health and readiness are distinct
The service MUST answer `/healthz` without database access, and MUST answer `/readyz` ready only when the database is reachable, holds the `event_clock` singleton row and records in `schema_migrations` exactly migration versions 1 through the number of shipped migrations. `/readyz` does not compare digests and does not check other tables. Both routes MUST be unauthenticated and MUST NOT return stored content.

#### Scenario: Database down
- **WHEN** PostgreSQL cannot serve a bounded operation
- **THEN** `/readyz` answers 503 `DATABASE_UNAVAILABLE` and `/healthz` still answers `ok`

#### Scenario: Schema mismatch
- **WHEN** the recorded migration versions are not exactly 1 through the number of shipped migrations
- **THEN** `/readyz` refuses with `SCHEMA_MISMATCH`

#### Scenario: Application tables missing
- **WHEN** the database is reachable but the `event_clock` or `schema_migrations` table does not exist, for example because no migration was ever applied
- **THEN** `/readyz` answers 503 `DATABASE_UNAVAILABLE` and `/healthz` still answers `ok`

#### Scenario: Recovery
- **WHEN** the database becomes reachable again
- **THEN** `/readyz` answers ready without a service restart

### Requirement: Migrations are ordered, append-only and verified
The service MUST apply migrations only through an explicit migrate operation, in order, appending after the applied prefix, and MUST record a SHA-256 digest of each applied migration. The migrate operation MUST refuse with `SCHEMA_MISMATCH` when a recorded digest differs from the shipped migration of the same version, except for the reviewed legacy digests it lists, or when more migrations are recorded than shipped.

#### Scenario: Check mode
- **WHEN** an operator runs migrate in check mode
- **THEN** no DDL runs and the output lists the pending migrations with their digests, plus a digest of the pending set while any is pending

#### Scenario: Reviewed apply no longer matches
- **WHEN** an operator applies with a reviewed digest and the pending set no longer matches it
- **THEN** the service refuses with `REVIEW_MISMATCH` and applies nothing

#### Scenario: Recorded digest differs
- **WHEN** an operator runs migrate and a recorded digest differs from the shipped migration of its version and is not a listed legacy digest
- **THEN** the service refuses with `SCHEMA_MISMATCH` and applies nothing

#### Scenario: Legacy digest accepted
- **WHEN** an operator runs migrate and a recorded digest is one of the reviewed legacy digests for its version
- **THEN** the service accepts it, applies any pending migrations and does not rewrite the recorded digest

#### Scenario: Serving never migrates
- **WHEN** the service starts against a database that has some but not all shipped migrations applied
- **THEN** it runs no DDL
- **AND** `/readyz` refuses with `SCHEMA_MISMATCH` until the operator migrates

### Requirement: The bearer API contract is a static document
The service MUST provide registration, instance end, participants, cursor history, publication, replies, acknowledgements and the event stream over bearer-authenticated API v1. It MUST NOT serve live interactive documentation. The generated static contract MUST describe only bearer operations and MUST exclude browser routes and assets.

#### Scenario: Live documentation is off
- **WHEN** a caller requests `/docs`, `/redoc` or `/openapi.json` from the running service
- **THEN** the service answers HTTP 404 `NOT_FOUND` and does not serve a document

#### Scenario: Contract scope
- **WHEN** the static contract is generated
- **THEN** every operation in it uses the bearer scheme
- **AND** it contains no browser sign-in route and no UI asset

### Requirement: The service is inert until enabled
The service MUST NOT start a listener or build an application unless the `enabled` setting is true, which is not the default. The disabled state MUST be explicit and MUST NOT fail the invoking process.

#### Scenario: Serve while disabled
- **WHEN** an operator runs serve with `enabled` false
- **THEN** the command writes the line `agent-chat-admin: DISABLED` to standard error, writes nothing to standard output and exits with status 0 without starting a listener
- **AND** when standard error is a service manager's journal stream, the line carries the priority prefix `<6>`

#### Scenario: Application factory while disabled
- **WHEN** code builds the application with `enabled` false
- **THEN** it is refused with `INTEGRATION_DISABLED`
