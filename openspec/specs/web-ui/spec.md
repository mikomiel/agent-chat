# web-ui Specification

## Purpose
Defines the browser surface of the Agent Chat service: the sign-in and session boundary, the read-only viewer, inert rendering, opt-in live events, the operator's writes and how the page treats an uncertain one, and the room, sessions and state views.

## Requirements

### Requirement: The browser surface exists only with a public origin and serves a fixed asset set
The service MUST register the page, the sign-in routes and the UI assets only when a public origin is configured, and MUST serve exactly four package assets by fixed name: the page script, the translation script, the stylesheet and one font. Every response, errors included, MUST carry `Cache-Control: no-store`, a content security policy that allows only same-origin resources and no framing, `nosniff`, no referrer and `X-Frame-Options: DENY`.

#### Scenario: No public origin
- **WHEN** the service runs without a public origin and a request carries no `Origin` and no `Cookie` header
- **THEN** a request for the page or for any UI asset answers HTTP 404
- **AND** the sign-in, browser-session and sign-out routes are not registered, so a request for one of them answers HTTP 404, except a state-changing request to the sign-in path, which the origin rules refuse

#### Scenario: Asset outside the set
- **WHEN** a caller requests a name outside the four assets
- **THEN** the service answers HTTP 404 with `NOT_FOUND`
- **AND** the refusal carries the same security headers

#### Scenario: Query on an asset
- **WHEN** a caller adds a non-empty query string to an asset request
- **THEN** the service refuses with `INVALID_REQUEST` and HTTP status 422
- **AND** the refusal carries the same security headers

#### Scenario: Inline script blocked
- **WHEN** script text is added to the page at run time
- **THEN** the browser's policy stops it from running

### Requirement: Browser sign-in is a separate credential purpose with a bounded session
The service MUST give a browser session only for a non-revoked operator or viewer credential that is not an instance token, after a double-submit challenge: a login cookie that the service sets with a 10-minute lifetime and a CSRF value derived from the cookie value. The service MUST compare the two, and it stores no challenge and does not check its age. A session MUST last 8 hours for an operator and 10 minutes for a viewer and MUST NOT be extended by use.

#### Scenario: Operator signs in
- **WHEN** an operator credential is presented with the login cookie and its CSRF value
- **THEN** the service sets a session cookie that has the `__Host-` prefix, `Secure`, `HttpOnly` and `SameSite=Strict` and lasts 28800 seconds
- **AND** the response names `access` operator and a CSRF value for the session and contains no credential
- **AND** the login cookie is removed

#### Scenario: Viewer signs in
- **WHEN** a viewer credential signs in
- **THEN** the session lasts 600 seconds and the response names `access` viewer
- **AND** later requests do not extend it

#### Scenario: Credential of another purpose
- **WHEN** an agent, instance, producer, revoked or unknown credential is presented
- **THEN** the service answers `UNAUTHENTICATED` and creates no session
- **AND** it counts one failed sign-in

#### Scenario: Malformed credential
- **WHEN** the presented value is not 64 lowercase hexadecimal characters
- **THEN** the service answers `INVALID_REQUEST` and creates no session
- **AND** it counts no failed sign-in, and the refusal comes before the challenge is compared

#### Scenario: Challenge missing or wrong
- **WHEN** a sign-in has no exact public origin, or its CSRF value is missing, is not 64 lowercase hexadecimal characters or does not match a present login cookie
- **THEN** the service answers HTTP 403 and creates no session
- **AND** it counts no failed sign-in

#### Scenario: Login cookie missing or malformed
- **WHEN** a sign-in carries a well-formed CSRF value but the login cookie is missing or is not 64 lowercase hexadecimal characters
- **THEN** the service answers HTTP 401 `UNAUTHENTICATED` and creates no session
- **AND** it counts no failed sign-in

#### Scenario: Challenge is compared, not remembered
- **WHEN** a sign-in presents a login cookie value together with the CSRF value derived from that value
- **THEN** the service accepts the challenge, although it stored none
- **AND** the 10 minutes are the lifetime that the service gives the cookie, and the service does not check how old the value is

#### Scenario: Earlier session at a later sign-in
- **WHEN** a client that presents a session cookie signs in successfully
- **THEN** the presented session ends
- **AND** a failed sign-in leaves it valid

#### Scenario: Sign-out
- **WHEN** a signed-in browser signs out
- **THEN** the service deletes the session
- **AND** the next request with that cookie answers `UNAUTHENTICATED`

### Requirement: Failed sign-ins are limited service-wide
The service MUST count a sign-in as failed only when a well-formed credential is refused as `UNAUTHENTICATED`, service-wide and in its database; an origin, body or challenge refusal is not counted. While 10 or more failures are younger than 60 seconds it MUST answer every sign-in that passes those checks with `LOGIN_RATE_LIMITED`, even when the credential is valid, and it MUST evaluate sign-ins normally again as soon as fewer than 10 remain.

#### Scenario: Failures reach the limit
- **WHEN** 10 failed sign-ins fall within 60 seconds
- **THEN** the next sign-in, even with a valid credential, is refused with `LOGIN_RATE_LIMITED` and HTTP status 429
- **AND** the count is service-wide and kept in the database, so a restart does not reset it
- **AND** the window slides: sign-in works again as soon as fewer than 10 failures are younger than 60 seconds

#### Scenario: Refusals that are not counted
- **WHEN** 10 failures fall within 60 seconds and a sign-in then arrives with a wrong challenge, with a missing login cookie or with a malformed credential
- **THEN** the service answers 403, 401 `UNAUTHENTICATED` or 422 `INVALID_REQUEST` respectively, not `LOGIN_RATE_LIMITED`
- **AND** none of these refusals is counted as a failed sign-in

### Requirement: Cookie requests need the exact origin and a CSRF value
The service MUST refuse a request whose `Origin` differs from the configured public origin, and a state-changing request that carries any `Cookie` header, or that signs in, unless its `Origin` equals that origin exactly. Without a public origin it MUST refuse every request with an `Origin` or a `Cookie` header. A cookie-authenticated state change MUST carry the CSRF value derived from the session cookie. A request with both a `Cookie` header and an `Authorization` header MUST be refused.

#### Scenario: Foreign origin
- **WHEN** a state-changing request has a valid session cookie and CSRF value but its `Origin` is another site, is `null` or is absent
- **THEN** the service answers HTTP 403 `SESSION_FORBIDDEN` and changes nothing
- **AND** the session stays valid

#### Scenario: CSRF value missing or wrong
- **WHEN** an otherwise valid cookie-authenticated state change carries no CSRF value or a wrong one
- **THEN** the service answers HTTP 403 `CSRF_FORBIDDEN` and stores nothing

#### Scenario: Malformed request without a CSRF value
- **WHEN** a cookie-authenticated state change has no CSRF value and an invalid body, a missing required header or a malformed path parameter
- **THEN** the service answers HTTP 422 `INVALID_REQUEST`
- **AND** the CSRF value is compared only for a request that passes validation

#### Scenario: Foreign origin on a preflight
- **WHEN** a request with the method OPTIONS carries a foreign `Origin`
- **THEN** the service answers HTTP 403

#### Scenario: Browser headers without a public origin
- **WHEN** the service runs without a public origin and a request carries an `Origin` or a `Cookie` header, or is a state-changing request to the sign-in path
- **THEN** the service answers HTTP 403 `SESSION_FORBIDDEN` before routing

#### Scenario: Cookie and bearer together
- **WHEN** a request that passes the origin checks carries a `Cookie` header, with a session cookie or not, and an `Authorization` header
- **THEN** the service answers `UNAUTHENTICATED` and changes nothing

#### Scenario: Unrelated cookie on a bearer write
- **WHEN** a state-changing request with an `Authorization` header also carries a `Cookie` header that holds no session cookie
- **THEN** the service answers HTTP 403 `SESSION_FORBIDDEN` unless its `Origin` equals the public origin exactly
- **AND** with the exact `Origin` it answers `UNAUTHENTICATED`, because of the `Authorization` header

#### Scenario: Credentials are not interchangeable
- **WHEN** a caller presents a session cookie value as a bearer token, or an operator credential as a bearer token to the browser-session route
- **THEN** the service answers `UNAUTHENTICATED`

### Requirement: The viewer is read-only
A viewer session MUST read the rooms, participants, history, room state and event stream that its grants allow and MUST NOT change anything. The service MUST refuse a viewer's write, and a viewer credential MUST NOT work as a bearer. The page MUST show a read-only indicator for a viewer and MUST NOT offer the composer, room administration, recipient selection, mute, PM mark, role mark or thread resolution controls. The live-events switch, refresh and filters stay available to a viewer.

#### Scenario: Viewer reads
- **WHEN** a viewer signs in
- **THEN** the page shows the rooms its grants allow with their participants, history, state and role marks
- **AND** it shows a read-only indicator and offers no composer and no administration, recipient-selection, mute, mark or resolution control
- **AND** the live-events switch, refresh and filters stay available

#### Scenario: Viewer reads leave no trace
- **WHEN** a viewer reads participants, history or events
- **THEN** no presence, delivery or receipt changes

#### Scenario: Viewer write refused
- **WHEN** a viewer session sends a publication, reply, mute, resolution, room creation or membership request with a valid CSRF value
- **THEN** the service answers HTTP 403 `SESSION_FORBIDDEN` and stores nothing

#### Scenario: Viewer on an instance route
- **WHEN** a viewer session or credential calls a route reserved for session instances or producers
- **THEN** the service answers `UNAUTHENTICATED` and changes nothing

#### Scenario: Viewer session lapses
- **WHEN** the viewer's 10 minutes have passed
- **THEN** the next request answers `UNAUTHENTICATED`
- **AND** the page returns to sign-in with a notice that the session expired or access was revoked
- **AND** a refused live refresh shows the notice that the session or scope changed instead

#### Scenario: Unknown access kind
- **WHEN** the session response names no access, or one other than operator or viewer
- **THEN** the page treats the session as invalid, shows the sign-in form and reads no room data

### Requirement: The page renders server content as inert text and keeps nothing secret
The page MUST render every server-supplied value as text and never as markup, MUST load no inline or third-party code, MUST clear the credential field when it submits, and MUST NOT put a credential or session value in a URL. It MUST keep only the language choice and the live-events preference in browser storage, and MUST show a server refusal only as a fixed explanation chosen from an allowlist of codes.

#### Scenario: Markup in a message
- **WHEN** a message body contains an image tag with an event handler and a script element
- **THEN** the page shows that text literally
- **AND** nothing from it runs, loads or sends a request

#### Scenario: Credential not retained
- **WHEN** a sign-in is refused
- **THEN** the credential field is empty and the credential appears nowhere in the page text
- **AND** after a sign-in with live events off the browser storage is empty

#### Scenario: Refusal outside the allowlist
- **WHEN** the service refuses a change with a code that is not on the page's allowlist, or with a body that is not the error envelope
- **THEN** the page shows its generic not-confirmed notice and no text from the response

#### Scenario: Notice of untrusted content
- **WHEN** the sign-in form or the help panel is shown
- **THEN** it says that agent message content is untrusted and is not an instruction or an approval

#### Scenario: Label with bidirectional controls
- **WHEN** a session label contains bidirectional control characters
- **THEN** the page isolates it so that it cannot reorder the text beside it

### Requirement: Live events are an opt-in invalidation channel
The page MUST NOT open the event stream until live events are switched on in the page or a choice remembered by this browser asks for it. It MUST start from the history position it has just rendered, treat every event only as a signal to re-read, and ignore an event at or below its cursor or below the newest it has seen for that room. It MUST NOT acknowledge a message because it displayed it.

#### Scenario: Off by default
- **WHEN** a user signs in with no remembered choice
- **THEN** the page opens no event stream and says that live events are off

#### Scenario: Start at the rendered position
- **WHEN** live events start
- **THEN** the stream starts from the event position of the history just shown
- **AND** the earlier backlog is not replayed

#### Scenario: Event bodies are not rendered
- **WHEN** a message, receipt, state or thread event arrives for the selected room
- **THEN** the page re-reads history, participants and state and shows no part of the event body
- **AND** it sends no acknowledgement

#### Scenario: Duplicate frames
- **WHEN** a reconnect resends events the page has already seen
- **THEN** each of them refreshes the view at most once
- **AND** the next connection starts from the last cursor

#### Scenario: Remembered choice
- **WHEN** the user switches live events on
- **THEN** this browser remembers the choice, and a later load or sign-in starts live events again once a room is shown
- **AND** sign-out, expiry, a room switch and a failing stream do not clear it, and only the switch does

#### Scenario: Another tab changes the choice
- **WHEN** another tab changes the remembered choice
- **THEN** this page keeps its own state and adopts the change at its next load

#### Scenario: Storage unusable
- **WHEN** browser storage is unusable
- **THEN** live events still work for this page
- **AND** the choice lasts only for this page load

#### Scenario: Malformed frame
- **WHEN** a frame is not valid JSON, or lacks a valid cursor and room
- **THEN** the page stops the stream and asks for a manual refresh
- **AND** it interprets nothing from the frame

### Requirement: Live refresh revalidates the binding and scope before it shows data
Before each live refresh the page MUST re-read the browser session and the room list, and MUST stop and lock if the principal, CSRF value or access changed, without adopting the new binding. On `ROOM_SCOPE_CHANGED` or `CURSOR_EXPIRED` it MUST reload retained history and resume from the retained floor.

#### Scenario: Binding replaced
- **WHEN** another sign-in for the same operator replaces the session cookie while live events run
- **THEN** the next refresh stops live events, locks the page and asks for a new sign-in
- **AND** the page does not adopt the new binding

#### Scenario: Access revoked
- **WHEN** the service refuses a live refresh with HTTP 401 or 403
- **THEN** the page hides history, stops reconnecting and shows the sign-in form
- **AND** it shows a notice that the session or scope changed

#### Scenario: Scope changed
- **WHEN** the stream sends a `control` frame with `ROOM_SCOPE_CHANGED`
- **THEN** the page re-reads the room list and the history of the new scope and resumes from the retained floor
- **AND** the control frame does not advance the cursor, even when the browser reuses an earlier event id

#### Scenario: Cursor expired
- **WHEN** the history check or the stream reports `CURSOR_EXPIRED` with HTTP status 410
- **THEN** the page reloads the retained history and resumes from the retained floor

#### Scenario: Invalid cursor
- **WHEN** the service answers HTTP 422 to the page's cursor
- **THEN** the page stops live events and asks for a manual refresh

#### Scenario: Typing during a refresh
- **WHEN** a live refresh runs while the operator types
- **THEN** the typed text is kept
- **AND** open evidence disclosures and a focused message action are restored

#### Scenario: Older messages evicted
- **WHEN** a refresh evicts older messages from the capped newest page above the reader
- **THEN** the page anchors on the first visible message, or the nearest surviving one, at the same offset

### Requirement: A failing live stream is retried by reading again
After an error of a stream that is not being re-established, the page MUST show live events as off, clear the snapshot and re-read after 1 second. After a stream that had opened ends and is being re-established, it MUST keep the snapshot, revalidate and reconnect from the last cursor after 1 second. After a failed re-read it MUST wait 1 second, double the wait to at most 10 seconds on each further failure, and reset it after a success.

#### Scenario: Stream refused or never opened
- **WHEN** the event stream errors before it has opened
- **THEN** the page shows live events as off, clears the snapshot and re-reads after 1 second
- **AND** a stream that errors again after each successful re-read is retried after 1 second each time

#### Scenario: Transient failure
- **WHEN** a refresh fails with an error that is not an access refusal
- **THEN** the page shows live events as off, clears the snapshot and retries after 1 second
- **AND** the delay doubles to at most 10 seconds and a success resets it

#### Scenario: Stream ended at its lifetime limit
- **WHEN** the service ends a stream after its bounded lifetime
- **THEN** the page reconnects from the last cursor after the usual revalidation
- **AND** it keeps showing the last snapshot and the draft meanwhile

### Requirement: Operator publication is one immutable attempt that is never retried automatically
The page MUST validate a draft before any request: a body of 1 to 16384 UTF-8 bytes without NUL, a chosen recipient for a question, a consultation or a reply to a session's message, and a thread key only on a new post that is neither a question nor a consultation. It MUST then freeze one attempt with its own idempotency key, resend only that attempt and only when the operator asks, and report the write saved only when the response matches the attempt.

#### Scenario: Draft refused locally
- **WHEN** the body is empty, over 16384 bytes or holds a NUL, or a question has no recipient, or a thread key is malformed or set on a reply, a question or a consultation
- **THEN** the page shows a fixed notice and sends no request

#### Scenario: Attempt frozen
- **WHEN** the operator sends a draft
- **THEN** the page freezes the room, key, body, kind, recipients, thread and reply target
- **AND** a later edit of the form does not change a retry

#### Scenario: Response lost or not matching
- **WHEN** the response is lost, malformed, or differs from the attempt in room, body, kind, recipients or reply target, or in thread or thread key when the attempt named one, or does not name the operator as sender
- **THEN** the page says the write is unconfirmed and keeps the attempt visible with its key
- **AND** it disables the draft, the room selector and refresh until the attempt is retried or discarded
- **AND** a retry sends the identical request, so the service stores one message

#### Scenario: Refusal of an attempt
- **WHEN** the service refuses an attempt for any reason, such as `INVALID_RECIPIENT`, a rate limit or a server error
- **THEN** the page says the write is unconfirmed, as for a lost response, and shows no text from the refusal
- **AND** it keeps the attempt visible with its key and disables the draft, the room selector and refresh until the attempt is retried or discarded

#### Scenario: Refusal after earlier uncertainty
- **WHEN** a retry is refused because access was lost
- **THEN** the page still says the outcome is unconfirmed, hides the room content and keeps the attempt
- **AND** once access returns the same retry succeeds with one stored message

#### Scenario: Session cookie replaced
- **WHEN** another sign-in replaces the session cookie while an attempt is uncertain
- **THEN** the retry keeps its original binding and is refused
- **AND** the page keeps the attempt and does not sign it again under the new binding

#### Scenario: Saved but read-back fails
- **WHEN** the response matches the attempt and the following read fails
- **THEN** the page reports the message as saved with its identifier and adds the read failure to that report
- **AND** unless the read was refused for lost access or a rate limit, it tells the operator not to send the message again
- **AND** after lost access it also locks the page and shows the sign-in form, and after a rate limit it adds the rate-limit notice instead

#### Scenario: Saved is not delivered
- **WHEN** a write is confirmed
- **THEN** the page says that a saved message is not a wake-up confirmation or an acknowledgement
- **AND** it clears the draft and the attempt

#### Scenario: Discarding an uncertain attempt
- **WHEN** the operator discards the local attempt
- **THEN** the page asks first and says that discarding does not undo a write already made on the server
- **AND** afterwards it revalidates the scope before another publication

### Requirement: Operator controls are confirmed by the server's answer and never retried automatically
The page MUST offer mute, role marks, thread resolution, room creation and room membership only to an operator, and MUST run one write at a time. It MUST show a change as saved only when the answer states the requested outcome, MUST NOT retry or toggle it automatically, and MUST re-read after a confirmed change. After a refusal other than `ROLE_CONFLICT` it MUST drop the loaded snapshot, and after an access refusal it MUST lock.

#### Scenario: Change confirmed
- **WHEN** the answer states the requested outcome
- **THEN** the page says the change is saved and re-reads participants, history and state
- **AND** when a PM mark or a role mark is assigned it says that the mark grants no authority

#### Scenario: Answer differs or is lost
- **WHEN** the answer does not state the requested outcome, or none arrives
- **THEN** the page says the change is not confirmed and asks for a fresh read before the next decision
- **AND** it neither retries nor toggles the change

#### Scenario: Confirmed but read-back fails
- **WHEN** the change is confirmed and the following read fails
- **THEN** the page says the change is confirmed and the read failed, and does not call the write lost

#### Scenario: Role conflict
- **WHEN** the service refuses a role mark with `ROLE_CONFLICT`
- **THEN** the page keeps the loaded view and shows a fixed explanation that the session already holds another role in the room

#### Scenario: Masked or conflicting scope
- **WHEN** the service refuses with `NOT_FOUND`, which can mask a room outside the scope, or with `ROOM_CONFLICT`
- **THEN** the page drops the loaded room snapshot and asks for a refresh before the next decision

#### Scenario: Write pending
- **WHEN** a write is pending
- **THEN** other writes, room selection, refresh, paging and the thread filter are blocked
- **AND** the view tabs and sign-out stay available, and sign-out asks for confirmation first
- **AND** a late answer cannot repopulate a page that has since been signed out

#### Scenario: Unknown mute state
- **WHEN** a session's mute state is unknown
- **THEN** the page offers neither mute nor unmute for it

#### Scenario: Room form refused locally
- **WHEN** the slug is not 1 to 63 lowercase letters, digits or hyphens starting with a letter or digit, or the name is empty, over 128 characters or holds a control character
- **THEN** the page shows a fixed notice and sends no request

#### Scenario: Membership outside the credential's scope
- **WHEN** the operator adds a session whose credential holds no grant to the room
- **THEN** the page reports the change as not confirmed
- **AND** no membership and no grant is created

### Requirement: Refresh, revocation and room changes never move work into another room
A refresh MUST revalidate the session and scope in place and keep the selected room and the draft. A room that has left the caller's scope MUST be reported and MUST NOT be replaced by another room. A response for an earlier room, filter or scope MUST NOT be rendered. Unloading the page, navigating away from it or putting it into the back-forward cache MUST lock it, and signing out MUST hide private data at once even if the network call fails.

#### Scenario: Refresh keeps room and draft
- **WHEN** the operator refreshes with a selected room and a draft
- **THEN** the page re-reads the room and keeps the room, the draft and the chosen recipients
- **AND** it asks for no confirmation

#### Scenario: Room left the scope
- **WHEN** a refresh finds that the selected room is no longer in the caller's scope
- **THEN** the page reports it, clears the room view and selects no other room
- **AND** it keeps the draft but cannot send it

#### Scenario: Another room with a draft
- **WHEN** the operator selects another room while a draft or an uncertain attempt exists
- **THEN** the page asks for confirmation first
- **AND** if the operator declines, the current room stays selected

#### Scenario: Late response
- **WHEN** a response for an earlier room, thread filter or sessions page arrives after the view moved on
- **THEN** the page discards it

#### Scenario: Read fails for a reason other than access
- **WHEN** a read fails with an error that is not an access refusal
- **THEN** the page drops the loaded room content and keeps the draft, the room list and the selected room
- **AND** it disables sending until a fresh read succeeds, and a refresh recovers in place without a confirmation

#### Scenario: Access lost
- **WHEN** a read other than a live refresh is refused with HTTP 401 or 403
- **THEN** the page locks, clears content and draft and shows the sign-in form with a notice that the session expired or access was revoked
- **AND** while an uncertain publication attempt or an administrative write is pending, such a refusal does not lock the page or clear the draft, and the attempt stays visible

#### Scenario: Page left
- **WHEN** the browser reports `pagehide` because the page is unloaded, navigated away from or put into the back-forward cache
- **THEN** it locks
- **AND** a restore from the back-forward cache starts like a first load: it selects the first room and holds no draft
- **AND** a page that is only in a background tab is not locked

#### Scenario: Sign-out unconfirmed
- **WHEN** the sign-out request ends without an answer
- **THEN** the page keeps private data hidden and says the sign-out is unconfirmed
- **AND** it offers the sign-out again

### Requirement: The roster and sessions views do not turn presence into readiness
The roster and sessions views MUST list online sessions before offline ones, name a session by its title or else by harness, host and short identifier, and keep the exact identifier one disclosure away. They MUST show the observed native state apart from liveness, never show an unknown state as idle, and flag stop, Plan Mode and mute only when on or unknown. When more pages exist they MUST say that the roster counts cover only the loaded page and the sessions filter only the loaded rows.

#### Scenario: Unknown native state
- **WHEN** a session is online and its native state is unknown
- **THEN** the views show it as online with an unknown state, not as idle or busy

#### Scenario: Flags that need attention
- **WHEN** stop, Plan Mode and mute are confirmed off for a session
- **THEN** no chip is shown for them
- **AND** a flag that is on, or unknown, is shown

#### Scenario: Partial roster
- **WHEN** the room has more participants than the loaded page
- **THEN** the roster counts are labelled as covering the loaded page, a tooltip says they do not describe the whole room, and a control loads the next page
- **AND** the sessions view says that its filter covers the loaded rows only

#### Scenario: Filter is local
- **WHEN** the user types into a roster or sessions filter
- **THEN** the rows narrow without a request
- **AND** no session becomes a recipient

#### Scenario: Recipient cap
- **WHEN** an operator selects a seventeenth recipient
- **THEN** the page refuses with a fixed notice
- **AND** offline sessions can be selected like online ones

#### Scenario: Sessions view for a viewer and an operator
- **WHEN** a viewer opens the sessions view
- **THEN** it shows each session's role marks, last publication time and message count for 24 hours, and no role control
- **AND** it shows the work declaration of an online session by forge, up to 8 repositories per forge with the rest as a count, and an offline session shows none
- **AND** it shows up to 3 announced pull requests per session, with the rest of the loaded list as a count
- **AND** an operator sees the same view with role controls

#### Scenario: Advisory lane
- **WHEN** a session has declared a lane
- **THEN** the roster row shows a lane chip, and the lane's age and the words that it is a declaration and not an entitlement are one tooltip or disclosure away
- **AND** the sessions view shows the lane with its age

#### Scenario: Late sessions page
- **WHEN** a sessions page for an earlier room or snapshot arrives late, or a later page fails
- **THEN** the page discards the late page and keeps the current snapshot

#### Scenario: Sessions read fails
- **WHEN** a sessions read fails
- **THEN** the page does not retry until the operator refreshes explicitly

#### Scenario: Reading position across tabs
- **WHEN** the user switches from the conversation to the sessions view and back
- **THEN** the conversation shows the same reading position

#### Scenario: Narrow window
- **WHEN** the window is 820 pixels wide or narrower
- **THEN** the roster and the state panel start collapsed
- **AND** they open again when the window widens

### Requirement: The state panel never shows a stale observation as current
The page MUST show room state observations as text with the producer, the change time and the observation time, and MUST show a stale observation as unknown with its age, or as unknown because the producer was revoked, never as free or known and without its value. It MUST ask the server again once after the soonest fresh observation expires, and a failure of the panel MUST NOT hide the rest of the view unless access was lost.

#### Scenario: Stale observation
- **WHEN** the service reports an observation as stale
- **THEN** the page shows it as unknown with the seconds since it was last seen
- **AND** it shows no value for it

#### Scenario: Revoked producer
- **WHEN** the stale reason is `revoked`
- **THEN** the page shows the observation as unknown because the producer was revoked

#### Scenario: Fresh observation
- **WHEN** an observation is fresh
- **THEN** the page shows its value as text, capped at 2000 characters for a generic value, under its thread key with a control that opens that thread

#### Scenario: Expiry asks the server again
- **WHEN** the soonest fresh observation expires
- **THEN** the page reads the state once more and shows the server's flags
- **AND** it does not decide staleness on its own

#### Scenario: More observations than shown
- **WHEN** the service reports more observations than the page asked for
- **THEN** the page says that the rest needs the CLI `state` command

#### Scenario: Panel failure
- **WHEN** the state read fails with an error that is not an access refusal
- **THEN** the panel says state is unavailable
- **AND** the rest of the room stays readable

### Requirement: The interface is Polish by default and English on request
The page MUST take its language from a `lang` value in the URL fragment, else from the stored language choice, else Polish. In English it MUST translate static text and each dynamic message that has an entry in its English table. A language change MUST store the choice, reload the page, and ask first when a draft or a write is pending.

#### Scenario: Default language
- **WHEN** no fragment value and no stored choice exist
- **THEN** the page is in Polish

#### Scenario: English selected
- **WHEN** the user selects English
- **THEN** static text and each dynamic message that has an English entry appear in English
- **AND** the choice is stored for later loads

#### Scenario: Message without an English entry
- **WHEN** English is selected and a dynamic message has no entry in the English table
- **THEN** that message appears in its Polish source text

#### Scenario: Storage blocked
- **WHEN** browser storage is blocked
- **THEN** the selection still applies to this page through the URL fragment

#### Scenario: Switch cancelled with a draft
- **WHEN** a draft exists and the user cancels the confirmation of a language change
- **THEN** the language and the draft stay unchanged
