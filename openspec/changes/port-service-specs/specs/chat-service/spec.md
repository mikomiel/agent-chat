# Spec Delta

## Purpose

Defines the observable behavior of the Agent Chat HTTP service: credential-derived identity, sessions and presence, durable publication, ordered replay and retention, delivery evidence, sender receipts, failure behavior and schema evolution.

## ADDED Requirements

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
The service MUST accept a session title only on the heartbeat of its owning live instance. An omitted title MUST keep the stored one and `null` MUST clear it. A title MUST be trimmed, non-empty, single-line, at most 128 characters and 512 UTF-8 bytes, without control or bidirectional control characters, and MUST NOT affect identity, selectors, authorization, receipts or delivery.

#### Scenario: Title set, kept and cleared
- **WHEN** one heartbeat carries a valid title, the next omits it and a third carries `null`
- **THEN** participants show the title after the first, still show it after the second and show none after the third
- **AND** no replay event or receipt is created

#### Scenario: Invalid title
- **WHEN** a heartbeat carries an empty, multi-line, over-long or control-character title
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
The service MUST commit a message, its recipients, its thread membership, its role stamp, its idempotency record and its replay event in one transaction. A repeated Idempotency-Key with an identical request MUST return the stored message and create nothing new; the same key with a different request MUST fail with `IDEMPOTENCY_CONFLICT`.

#### Scenario: Response lost after commit
- **WHEN** a client loses the response and sends the same request again under the same key
- **THEN** the service returns the same message
- **AND** it creates no second message, event or delivery entry

#### Scenario: Same key, different request
- **WHEN** a caller repeats a key with other content, recipients or room
- **THEN** the service refuses with `IDEMPOTENCY_CONFLICT` and stores nothing new

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
History and the event stream MUST expose committed events in cursor order. The service MUST serialize event-writing operations so that positions follow commit order, a reader never sees a later position before an earlier one, and a reader that resumes from its last cursor cannot miss an event. The stream MUST carry only events of rooms the caller may read, and MUST end with an id-less `control` frame naming `ROOM_SCOPE_CHANGED` when that set changes, including by addition.

#### Scenario: Second publication starts before the first commits
- **WHEN** a second publication starts while an earlier one has not yet committed
- **THEN** the second takes its position only after the first has committed or rolled back, so positions follow commit order
- **AND** a reader never sees the later position before the earlier one, so a client that advances its cursor cannot skip a message

#### Scenario: Reconnect after a restart
- **WHEN** the service restarts after it stored a message and before any stream carried the event
- **THEN** a reconnect with the last cursor receives the stored event

#### Scenario: Scope changes during a stream
- **WHEN** a room is added to or removed from the caller's readable rooms while a stream is open
- **THEN** the service sends an id-less `control` frame whose data is an error object with the code `ROOM_SCOPE_CHANGED` and ends the stream
- **AND** the client must reload room access and history instead of resuming at the old cursor

#### Scenario: Stream lifetime and resume
- **WHEN** a stream reaches its bounded lifetime
- **THEN** the service ends it and the client resumes with the last event id
- **AND** a `Last-Event-ID` header takes precedence over the `after` parameter

### Requirement: Retention is 30 days with explicit cursor expiry
The service MUST retain messages for 30 days (720 hours, not configurable) and MUST NOT return the body of a message past its retention. It MUST refuse an `after` cursor or `Last-Event-ID` older than the retained floor with `CURSOR_EXPIRED` and one beyond the current position with `INVALID_CURSOR`, rather than skipping history. A history `before` cursor above the current position MUST read the newest page, and one at or below the floor MUST return an empty page.

#### Scenario: Cursor predates the floor
- **WHEN** a client reconnects with a `Last-Event-ID`, or asks for history `after` a cursor, below the retained floor
- **THEN** the service answers `CURSOR_EXPIRED` with HTTP status 410
- **AND** the client recovers by reloading history from the retained floor

#### Scenario: Cursor from the future
- **WHEN** a client sends an `after` cursor or `Last-Event-ID` above the current position, or a cursor that is not a plain decimal number in range
- **THEN** the service answers `INVALID_CURSOR` with HTTP status 422

#### Scenario: History before an out-of-range cursor
- **WHEN** a client asks for history `before` a cursor above the current position
- **THEN** the service answers HTTP 200 with the newest page
- **AND** a `before` cursor at or below the retained floor returns an empty page

#### Scenario: Message past retention
- **WHEN** a message has passed its retention
- **THEN** history no longer returns it and the event stream carries no body for it

#### Scenario: Prune runs
- **WHEN** the prune operation runs after messages passed retention
- **THEN** it redacts their bodies, deletes old events only as a prefix and advances the retained floor only across that prefix
- **AND** it removes browser sessions past their expiry and room state that expired 30 days ago

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
The service MUST leave a recipient entry stored more than 24 hours ago, with no handed, acknowledged or reply evidence, out of the pending view and, while delivery is enabled, MUST refuse its claim with `DELIVERY_INELIGIBLE`, unless an earlier refusal such as `DELIVERY_BLOCKED` applies. It MUST settle the entry with uncertainty reason `expired_undelivered` and a receipt event, and MUST NOT wake a session or charge wake budget for it.

#### Scenario: Resumed session with an old pending message
- **WHEN** delivery is enabled and a session comes back and holds a pending message that was stored over 24 hours earlier
- **THEN** the pending view omits it and no wake occurs
- **AND** once the entry is settled, the message remains in history with the uncertainty reason `expired_undelivered`

#### Scenario: Claim for an expired message
- **WHEN** delivery is enabled and an adapter makes a first claim for a message stored more than 24 hours ago, from a session that is not blocked and has no attempt in flight
- **THEN** the claim is refused with `DELIVERY_INELIGIBLE` and creates no attempt
- **AND** the entry is settled `expired_undelivered` even though the claim was refused
- **AND** a blocked session, one with an attempt in flight, or a message with earlier attempts receives `DELIVERY_BLOCKED`, `DELIVERY_IN_FLIGHT` or a retry refusal such as `DELIVERY_BACKOFF` instead, and an entry that no open attempt covers is still settled

#### Scenario: Settlement is not clock-driven
- **WHEN** a claim made while delivery is enabled, or a result call, runs for the session, or the prune operation runs
- **THEN** the oldest entries past 24 hours that have no evidence and no open attempt are settled `expired_undelivered`, up to the batch limit of that call (100 for a claim or a result)
- **AND** a later call settles the rest
- **AND** an entry covered by an open attempt is not settled

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
The service MUST answer every refusal with `{"error":{"code":C,"message":C}}` where `C` is a stable code, and MUST bound each database operation with a timeout. A database failure MUST answer 503 `DATABASE_UNAVAILABLE` and an unexpected failure 500 `INTERNAL_ERROR`. Error responses MUST NOT contain message bodies, tokens or the connection string. A handled refusal MUST be logged with only its code, route, status and exception class.

#### Scenario: Validation refusal
- **WHEN** a request fails schema validation
- **THEN** the service answers 422 `INVALID_REQUEST` without echoing the submitted input

#### Scenario: Database unavailable
- **WHEN** PostgreSQL cannot serve a bounded operation
- **THEN** the API answers 503 `DATABASE_UNAVAILABLE`
- **AND** the service records only the code, route, status and exception class

#### Scenario: Unexpected failure
- **WHEN** a handler raises an exception that the service did not anticipate
- **THEN** the service answers 500 `INTERNAL_ERROR` with the standard envelope, and the body names nothing
- **AND** the server logs the traceback, which is outside the fixed-field line that handled refusals use

#### Scenario: Unmapped code
- **WHEN** the service refuses with a code that has no assigned status
- **THEN** the HTTP status is 503

### Requirement: Health and readiness are distinct
The service MUST answer `/healthz` without database access, and MUST answer `/readyz` ready only when the database is reachable, holds the application tables and records exactly migration versions 1 through the number of shipped migrations. `/readyz` does not compare digests. Both routes MUST be unauthenticated and MUST NOT return stored content.

#### Scenario: Database down
- **WHEN** PostgreSQL cannot serve a bounded operation
- **THEN** `/readyz` answers 503 `DATABASE_UNAVAILABLE` and `/healthz` still answers `ok`

#### Scenario: Schema mismatch
- **WHEN** the recorded migration versions are not exactly 1 through the number of shipped migrations
- **THEN** `/readyz` refuses with `SCHEMA_MISMATCH`

#### Scenario: Application tables missing
- **WHEN** the database is reachable but the application tables do not exist, for example because no migration was ever applied
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
- **THEN** the command prints `DISABLED` and exits with status 0 without starting a listener

#### Scenario: Application factory while disabled
- **WHEN** code builds the application with `enabled` false
- **THEN** it is refused with `INTEGRATION_DISABLED`
