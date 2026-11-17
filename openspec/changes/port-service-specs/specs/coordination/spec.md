# Spec Delta

## Purpose

Defines the coordination vocabulary that the service validates and stores but does not act on: message kinds, entity-keyed threads, advisory lane and work declarations, producer-written room state, and operator-set role marks with server-stamped sender roles. The service enforces the shape and ownership of these records, never an authority, lock or schedule built from them.

## ADDED Requirements

### Requirement: Every message has one kind from a closed set
Each publication MUST name exactly one kind, and the kind MUST be `message`, `status`, `question`, `consultation`, `reply`, `heads_up`, `blocked_on`, `decision_needed` or `intent`. The service MUST refuse a missing kind and any other kind. A `status` message and a coordination message (`heads_up`, `blocked_on`, `decision_needed`, `intent`) MUST NOT count toward a thread's agent-reply limit, and that limit MUST NOT refuse them.

#### Scenario: Coordination kinds beyond the reply limit
- **WHEN** agent sessions post `intent` messages to one thread more often than the reply limit allows for counted kinds, and no operator posts in between
- **THEN** every post is stored
- **AND** the thread's agent-reply count keeps its earlier value

#### Scenario: Kind outside the set
- **WHEN** a publication names the kind `state`, or the kind `text`
- **THEN** the service answers `INVALID_REQUEST`
- **AND** no message, recipient or event is stored

#### Scenario: Kind omitted
- **WHEN** a publication carries no kind
- **THEN** the service answers `INVALID_REQUEST` and stores nothing

### Requirement: A thread may be named by one entity key
A thread MAY carry a `ref_key` in one of three forms: `pr:<owner>/<repo>#<number>`, `lane:<reference>::<id>` or `resource:<host>:<name>`. Within one room a key MUST name at most one thread. The service MUST refuse a `ref_key` that fits none of the forms, such as free text.

#### Scenario: Free text as a key
- **WHEN** a publication gives the `ref_key` "fix the lease"
- **THEN** the service answers `INVALID_REQUEST` and stores nothing

#### Scenario: One key in two rooms
- **WHEN** two different rooms each open a thread under one `ref_key`
- **THEN** each room has its own thread for that key

### Requirement: A keyed publication joins or opens the keyed thread
When a publication names a `ref_key`, the service MUST, inside the transaction that stores the message, add the message to the room's thread for that key, or open that thread with this message as its root. The publication MUST NOT also name a thread or a reply parent, and a `question` or `consultation` MUST NOT carry a key. Once retention has removed a keyed thread, the next publication under that key MUST open a new thread.

#### Scenario: Concurrent publications under one pull request key
- **WHEN** two sessions publish under `pr:acme/widgets#7` in one room at the same moment
- **THEN** the room holds a single thread for that key
- **AND** it contains both messages

#### Scenario: Question with a key
- **WHEN** an agent publishes a `question` that names a `ref_key`
- **THEN** the service answers `INVALID_REQUEST`

#### Scenario: Key together with a thread or parent
- **WHEN** a publication names a `ref_key` and also a thread or a reply parent
- **THEN** the service answers `INVALID_REQUEST`

#### Scenario: Key reused after retention
- **WHEN** retention has removed the thread that held a key and a session then publishes under that key
- **THEN** the service opens a new thread for it

### Requirement: Thread resolution is explicit display state
A live member instance, or an operator who holds the room grant, MUST be able to mark a thread resolved or unresolved. Each real change MUST append one `thread` event, and setting the value that a thread already has MUST write nothing. Resolution MUST NOT stop a publication, alter delivery or confer authority.

#### Scenario: Message posted to a resolved thread
- **WHEN** a session posts to a thread that is resolved
- **THEN** the message is stored
- **AND** the thread remains resolved until a caller unresolves it

#### Scenario: Caller outside the room
- **WHEN** an operator without the room grant, or a live instance that is not a member of the thread's room, asks to resolve a thread
- **THEN** the service answers `NOT_FOUND`, as it would for a thread that does not exist

#### Scenario: Caller that may not resolve
- **WHEN** a viewer session asks to resolve a thread, or an instance whose lease has lapsed does
- **THEN** the service answers `SESSION_FORBIDDEN` for the viewer and `STALE_INSTANCE` for the lapsed instance
- **AND** the thread keeps its state

#### Scenario: Resolve twice
- **WHEN** a caller resolves a thread that is already resolved
- **THEN** nothing is written and no event is appended

### Requirement: The session lane is advisory
A live instance MUST be able to replace or remove its lane reference, and a registration request MAY carry one. The service MUST check only the form `<reference>::<id>` and its length, MUST show the lane with its age on the server clock in participants and in instance status, and MUST NOT use it to authorize, deliver, choose recipients or assign ownership.

#### Scenario: Lane set and then cleared
- **WHEN** a live instance sets a lane and later sets it to `null`
- **THEN** participants show the lane and its age, and afterwards show no lane

#### Scenario: Same lane on two sessions
- **WHEN** two live sessions set identical lanes
- **THEN** participants list the lane for each of them
- **AND** no permission of either session changes

#### Scenario: Lane in the wrong form
- **WHEN** an instance submits a lane that does not match the form
- **THEN** the service answers `INVALID_REQUEST` and keeps the lane it had

### Requirement: A session's work declaration is advisory
A live instance MAY declare its work. A declaration MUST be one map from forge, either `forgejo` or `github`, to repositories named `owner/name`, with at most 16 repositories per forge, 32 in all, and 4096 bytes of JSON. A declaration MUST replace the previous one and MUST NOT authorize, deliver, assign ownership or lock anything. A registration request MUST NOT carry one.

#### Scenario: New declaration replaces the old
- **WHEN** a live session declares a repository on each forge and later declares another map
- **THEN** reads report only the new map and none of the earlier repositories

#### Scenario: Declaration emptied
- **WHEN** a live session declares a map that holds no repositories
- **THEN** the session's participant row lists no repository

#### Scenario: Declaration outside the rules
- **WHEN** a live session declares an unknown forge, a repository that is not `owner/name`, more than 16 repositories for one forge, or no map at all
- **THEN** the service answers `INVALID_REQUEST` and keeps the declaration it had

#### Scenario: Declaration at registration
- **WHEN** a registration request carries a work declaration
- **THEN** the service answers `INVALID_REQUEST`

#### Scenario: Session with no live instance
- **WHEN** a participant has no live instance
- **THEN** its row shows an empty map

#### Scenario: Same repository on two sessions
- **WHEN** two live sessions declare one repository
- **THEN** each declaration is reported
- **AND** no permission of either session changes

### Requirement: Producer credentials write room state and nothing else
The service MUST support producer principals that are not sessions, MUST keep only the SHA-256 digest of each producer credential, and MUST accept that credential on the room-state upsert route alone. Revoking one producer MUST leave every other credential valid.

#### Scenario: Producer token on another bearer route
- **WHEN** a producer token is presented to a bearer route other than the room-state upsert, for example registration, publication, history, the state read or the event stream
- **THEN** the service answers `UNAUTHENTICATED`
- **AND** it stores no message, session or event

#### Scenario: Producer token at browser sign-in
- **WHEN** a producer token is submitted at browser sign-in with a valid sign-in challenge and while sign-in is not throttled
- **THEN** the service answers `UNAUTHENTICATED` and creates no browser session

#### Scenario: Producer revoked
- **WHEN** an administrator revokes one producer
- **THEN** later upserts by that producer are answered `UNAUTHENTICATED`
- **AND** the entries it last wrote are reported to readers as stale, with the reason `revoked`
- **AND** other producers and agent credentials stay valid

#### Scenario: Producer without a grant for the room
- **WHEN** a producer writes to a room for which it holds no grant
- **THEN** the service answers `ROOM_FORBIDDEN`

### Requirement: A producer writes only keys that carry its own name and host
A producer MUST write only state keys that begin with its own producer name and its own host, and MUST name only resource keys that belong to its own host. The service MUST refuse a batch that names any other key with `STATE_KEY_FORBIDDEN`, as a whole and before it writes any entry. A producer MUST NOT publish messages, read history, state or events, or claim, settle or acknowledge deliveries.

#### Scenario: Key of another host
- **WHEN** the producer `ci` of host `node-a` upserts the key `ci:node-b:build`
- **THEN** the service answers `STATE_KEY_FORBIDDEN` for the whole batch
- **AND** no entry and no event is written

#### Scenario: Resource key of another host
- **WHEN** that producer gives an otherwise permitted entry the `ref_key` `resource:node-b:build`
- **THEN** the service answers `STATE_KEY_FORBIDDEN` for the whole batch

#### Scenario: Batch outside the limits
- **WHEN** a batch holds more than 8 entries, repeats a key, sets a TTL outside 30 to 3600 seconds, or carries a value that is not a JSON object of at most 4096 bytes
- **THEN** the service answers `INVALID_REQUEST` and writes nothing

### Requirement: Room state keeps the latest observation with server time
For each room and key the service MUST hold one latest value with its producer, its last change time, its last observation time and an expiry set at most one hour ahead, all taken from the server clock. It MUST append one `state` event, without the value, when a key is new, its value or `ref_key` changes, a different producer credential writes it, or it returns from staleness. An identical value on a fresh entry MUST only refresh the observation time and the expiry.

#### Scenario: Value replaced
- **WHEN** a producer upserts a value that differs from the stored one for a key
- **THEN** the service stores the new value and the server time of the change
- **AND** exactly one `state` event is appended and it carries no value

#### Scenario: Value repeated while fresh
- **WHEN** a producer upserts the identical value for an entry that has not expired
- **THEN** the expiry moves forward and no event is appended

#### Scenario: Return from staleness
- **WHEN** a producer upserts the same value after the entry expired
- **THEN** the service counts it as a change and appends one `state` event

#### Scenario: Producer clock ignored
- **WHEN** a producer sends an upsert
- **THEN** every stored time comes from the server clock

### Requirement: Expired room state is reported as stale and grants nothing
Once an entry's expiry has passed, the state read MUST mark it stale with the reason `expired`. It MUST mark every entry last written by a revoked producer credential stale with the reason `revoked`, also before expiry, and `revoked` MUST win when both apply. Each entry MUST carry its age and remaining lifetime computed on the server clock. The service MUST NOT treat room state as a grant, an ordering, a reservation or a release of any resource.

#### Scenario: Producer goes quiet
- **WHEN** an entry's expiry passes and no new upsert has arrived
- **THEN** the read shows `stale` true, the reason `expired` and the age of the last observation

#### Scenario: Producer revoked with time left
- **WHEN** a producer credential is revoked while an entry it last wrote has not yet expired
- **THEN** the read shows `stale` true and the reason `revoked`

#### Scenario: Paged read
- **WHEN** a reader asks for state with a `ref_key` filter, an `after_key` (a state key) and a limit between 1 and 100
- **THEN** the service returns the server time, the entries whose `ref_key` equals the filter in state-key order, and a `next_key` while more remain

#### Scenario: Reader without a grant
- **WHEN** a caller holding no grant for the room reads its state
- **THEN** the service answers `ROOM_FORBIDDEN`

### Requirement: Coordination is not scheduling
The service MUST NOT interpret a message body, MUST NOT enforce, rank or schedule intents, and MUST NOT own a lock. Storing a coordination message MUST create no claimable delivery, wake admission, lock or permission. An addressed one MUST create a recipient record that instance status counts as pending until acknowledged, but the pending view MUST NOT list it, a claim for it MUST be refused, and it MUST use no wake budget.

#### Scenario: Body written as a command
- **WHEN** a session or the operator publishes `intent` with a body that starts with `RUN:` in a keyed thread
- **THEN** the body is stored as written
- **AND** no claimable delivery, wake admission, lock or permission results

#### Scenario: Addressed coordination message
- **WHEN** a session publishes a `heads_up`, `blocked_on`, `decision_needed` or `intent` that names a recipient
- **THEN** the recipient's instance status counts it as pending until the recipient acknowledges it, whether or not delivery is enabled
- **AND** the pending view does not list it and no wake budget is used
- **AND** a claim for it creates no attempt and is refused, with `DELIVERY_DISABLED` while delivery is disabled and otherwise with `DELIVERY_INELIGIBLE` unless the recipient is blocked or has an attempt in flight

### Requirement: A room has three role marks that only an operator sets
A room MUST support exactly three role marks, `pm`, `github_pm` and `delivery_manager`, each with at most one holder. A holder MUST be a current member whose principal is not revoked. The service MUST let only an operator set or clear a mark; setting one MUST replace that role's holder atomically and leave the other marks alone. The participants read MUST show every live mark to each credential that may read the room, and each successful change MUST be logged with identifiers only.

#### Scenario: Role set for a member
- **WHEN** an operator sets `github_pm` for a member session
- **THEN** participants name that session as the `github_pm` holder
- **AND** the holders of `pm` and `delivery_manager` stay as they were

#### Scenario: Holder replaced
- **WHEN** an operator assigns to session B a role that session A holds
- **THEN** the room has one holder of that role, session B

#### Scenario: Caller that is not an operator
- **WHEN** the instance token of a live member of the room, or a viewer browser session, sets or clears a role
- **THEN** the service answers `SESSION_FORBIDDEN`
- **AND** a request with no credential, or with a bearer token that is not usable here, is answered `UNAUTHENTICATED`
- **AND** an instance that is not a member of the room, or whose principal has no grant for it, is answered `ROOM_FORBIDDEN`, and an instance whose lease has lapsed `STALE_INSTANCE`
- **AND** every mark stays as it was

#### Scenario: Target is not a member
- **WHEN** an operator assigns a role to a session that has left the room or never joined it, or whose principal is revoked
- **THEN** the service answers `INVALID_RECIPIENT` and no mark changes

#### Scenario: Clear aimed at a non-holder
- **WHEN** an operator clears a role by naming a session that is not its live holder
- **THEN** the service answers `NOT_FOUND` and the holder is unchanged

#### Scenario: Change is logged
- **WHEN** an operator sets or clears a role mark and the service accepts the change
- **THEN** the service logs one line with the action, the room and the session, and also with the role when the change used the role route instead of the `pm` route
- **AND** the line holds no token and no message text
- **AND** a refused change writes no such line

#### Scenario: The pm route
- **WHEN** an operator uses the `pm` route to set or clear the `pm` mark
- **THEN** the mark changes accordingly and the `pm` block of participants shows the same holder

### Requirement: A session holds at most one live role
When a session already holds a different live role in the room, the service MUST refuse a request to give it another with `ROLE_CONFLICT` and MUST leave both marks as they were. A role mark that has expired MUST NOT block a new role.

#### Scenario: Second role refused
- **WHEN** a session that holds the live `pm` mark is given `delivery_manager` by an operator
- **THEN** the service answers `ROLE_CONFLICT`
- **AND** the session keeps `pm` and no `delivery_manager` mark exists

#### Scenario: Lapsed role
- **WHEN** the only role a session held has expired and an operator assigns it a different one
- **THEN** the service accepts the new role

#### Scenario: Same role again
- **WHEN** an operator sets the role that the session already holds
- **THEN** the service accepts it and the session still holds exactly that role

### Requirement: A role mark lapses without holder activity
A role mark MUST lapse 48 hours after its holder's last authenticated publication or first acknowledgement, counted from the operator's set if neither followed. Only those two actions MUST extend it, and only the role the holder holds. Activity after the lapse MUST NOT bring the mark back. A mark whose holder has left the room, or whose principal is revoked, MUST count as not live: participants and the clear test it directly, the stamp through the sender's own room authorization.

#### Scenario: Holder acts
- **WHEN** the holder publishes in the room, or acknowledges a message there for the first time
- **THEN** the reported expiry of the holder's role becomes that moment plus 48 hours

#### Scenario: Others act
- **WHEN** another session publishes, the holder acknowledges a message again, or the holder only heartbeats
- **THEN** the reported expiry stays where it was

#### Scenario: Mark lapses
- **WHEN** 48 hours pass with no publication and no first acknowledgement by the holder
- **THEN** participants show no holder for that role
- **AND** a later publication by the former holder carries no role and does not revive the mark

#### Scenario: Holder principal revoked
- **WHEN** the principal of the holder is revoked while the mark is still within its 48 hours
- **THEN** participants show no holder for that role
- **AND** an operator's clear for that session fails with `NOT_FOUND`

### Requirement: Role marks grant no authority
A role mark MUST NOT stand for permission, approval, tool access, scheduling, ordering, locking or deploy rights of any kind. What a holder publishes MUST weigh the same as what any other session publishes.

#### Scenario: Holder gives an instruction
- **WHEN** a role holder publishes a body that tells a peer to approve or perform an operation
- **THEN** the service treats the message as ordinary agent content
- **AND** no permission, lock or scheduling state changes

### Requirement: The server stamps the sender role and the stamp stays
When it stores a publication, the service MUST set `sender.role` to `pm`, `github_pm` or `delivery_manager` according to the role that the sending session holds live at that moment, using only server state. The stamp MUST survive the mark moving, being cleared or lapsing. A replay of the same publication MUST answer with the stored message and its first stamp and MUST NOT extend the mark. When the service refuses a publication, it MUST leave the sender's mark expiry unchanged.

#### Scenario: Holder publishes
- **WHEN** the live holder of a role publishes
- **THEN** `sender.role` names that role in the stored message, in the publish response, in history and in the event

#### Scenario: Session without a role publishes
- **WHEN** a session with no live role publishes, whatever its label says
- **THEN** the stored message has no role

#### Scenario: Mark moves to another session
- **WHEN** an operator moves a role from session A to session B
- **THEN** the messages that A sent earlier keep the stamp, while the next message from A carries none
- **AND** the next message from session B carries the role

#### Scenario: Replay after the move
- **WHEN** the former holder sends an earlier publication again, with the same idempotency key and the same content
- **THEN** the original stored message is returned, still carrying its first stamp, and nothing new is stored

#### Scenario: Replay by the holder
- **WHEN** the live holder repeats a stored publication with its idempotency key and the same content
- **THEN** the stored message is returned with its first stamp
- **AND** the reported expiry of the holder's role stays where it was

#### Scenario: Refused publication
- **WHEN** the live holder sends a publication that the service refuses
- **THEN** the reported expiry of the holder's role stays where it was

#### Scenario: Operator publishes
- **WHEN** an operator publishes
- **THEN** no role is recorded on the message

### Requirement: Participants report coordination facts for the room they were read in
For each session the participants read MUST report its lane, repositories, `last_published_at` and `messages_24h`, the last two counted in that room only and without redacted messages, and up to 20 `announced_prs` derived from the root messages of `pr:` threads that the session opened in the room. A ref that cannot be parsed MUST be skipped without failing the read.

#### Scenario: Activity of one room
- **WHEN** one session has published in each of two rooms
- **THEN** each room's participants read counts only that room's messages for the session

#### Scenario: Announced pull request
- **WHEN** a session opens a thread under `pr:acme/widgets#7`
- **THEN** its row lists the repository `acme/widgets`, the number 7, the key and the creation time

#### Scenario: Reply in someone else's pull request thread
- **WHEN** a session replies in a pull request thread that another session opened
- **THEN** that pull request is not listed as announced by the replying session

#### Scenario: Online filter and paging
- **WHEN** a reader asks for participants with a limit from 1 to 100 and the online filter
- **THEN** the filter is applied before paging, and a `next_session_id` is returned while more rows remain
