-- The complete schema. Delivery admissions hold IDs and outcomes only; native execution stays outside PostgreSQL.
CREATE TABLE agent_chat.principals (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('operator', 'agent')),
    credential_hash text NOT NULL UNIQUE CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    revoked boolean NOT NULL DEFAULT false,
    host text,
    harness text,
    CHECK ((kind = 'operator' AND host IS NULL AND harness IS NULL)
        OR (kind = 'agent' AND host IS NOT NULL AND harness IS NOT NULL AND harness IN ('claude', 'pi', 'codex')))
);
CREATE TABLE agent_chat.rooms (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    label text NOT NULL
);
INSERT INTO agent_chat.rooms VALUES
    ('00000000-0000-4000-8000-000000000001', 'homelab', 'Homelab');
CREATE TABLE agent_chat.principal_rooms (
    principal_id uuid NOT NULL REFERENCES agent_chat.principals(id),
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    PRIMARY KEY (principal_id, room_id)
);
CREATE TABLE agent_chat.sessions (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES agent_chat.principals(id),
    native_session_id text NOT NULL,
    label text NOT NULL,
    muted boolean NOT NULL DEFAULT false,
    UNIQUE (principal_id, native_session_id)
);
CREATE TABLE agent_chat.memberships (
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    PRIMARY KEY (room_id, session_id)
);
CREATE TABLE agent_chat.instances (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    boot_id uuid NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    native_state text NOT NULL DEFAULT 'unknown' CHECK (native_state IN ('idle', 'busy', 'unknown')),
    stopped boolean NOT NULL DEFAULT true,
    plan_mode boolean NOT NULL DEFAULT true,
    UNIQUE (session_id, boot_id)
);
CREATE UNIQUE INDEX one_current_instance ON agent_chat.instances(session_id) WHERE ended_at IS NULL;
CREATE TABLE agent_chat.threads (
    id uuid PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    root_message_id uuid NOT NULL,
    agent_replies integer NOT NULL DEFAULT 0 CHECK (agent_replies BETWEEN 0 AND 6),
    UNIQUE (id, room_id)
);
CREATE TABLE agent_chat.messages (
    id uuid PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    thread_id uuid NOT NULL,
    reply_to uuid,
    sender_principal_id uuid NOT NULL REFERENCES agent_chat.principals(id),
    sender_session_id uuid REFERENCES agent_chat.sessions(id),
    kind text NOT NULL CHECK (kind IN ('message', 'status', 'question', 'consultation', 'reply')),
    -- NULL is a redacted parent tombstone; publication always supplies nonempty text.
    body text CHECK (octet_length(body) BETWEEN 1 AND 16384),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '720 hours'),
    UNIQUE (id, room_id, thread_id),
    FOREIGN KEY (thread_id, room_id) REFERENCES agent_chat.threads(id, room_id),
    FOREIGN KEY (reply_to, room_id, thread_id) REFERENCES agent_chat.messages(id, room_id, thread_id),
    CHECK ((kind = 'reply') = (reply_to IS NOT NULL))
);
-- Foreign-key delete checks and retention pruning look messages up by the message or thread they point at.
CREATE INDEX messages_reply_to ON agent_chat.messages(reply_to);
CREATE INDEX messages_thread ON agent_chat.messages(thread_id);
ALTER TABLE agent_chat.threads ADD CONSTRAINT root_in_thread
    FOREIGN KEY (root_message_id, room_id, id)
    REFERENCES agent_chat.messages(id, room_id, thread_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE agent_chat.delivery_batches (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    message_ids uuid[] NOT NULL CHECK (cardinality(message_ids) BETWEEN 1 AND 16),
    UNIQUE (id, session_id)
);
CREATE TABLE agent_chat.recipients (
    message_id uuid NOT NULL REFERENCES agent_chat.messages(id),
    session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    handed_at timestamptz,
    acknowledged_at timestamptz,
    replying_message_id uuid REFERENCES agent_chat.messages(id),
    uncertainty_reason text,
    delivery_batch_id uuid,
    PRIMARY KEY (message_id, session_id),
    CONSTRAINT delivery_for_recipient_session
        FOREIGN KEY (delivery_batch_id, session_id) REFERENCES agent_chat.delivery_batches(id, session_id)
);
CREATE INDEX recipients_session_message ON agent_chat.recipients(session_id, message_id);
CREATE INDEX recipients_delivery_batch ON agent_chat.recipients(delivery_batch_id)
    WHERE delivery_batch_id IS NOT NULL;
-- Foreign-key delete checks and retention pruning look recipients up by the reply that answered them.
CREATE INDEX recipients_replying_message ON agent_chat.recipients(replying_message_id);
-- The singleton row serializes allocation through commit, unlike a sequence.
CREATE TABLE agent_chat.event_clock (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
    retained_floor bigint NOT NULL DEFAULT 0 CHECK (retained_floor BETWEEN 0 AND position)
);
INSERT INTO agent_chat.event_clock DEFAULT VALUES;
CREATE TABLE agent_chat.events (
    position bigint PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    kind text NOT NULL CHECK (kind IN ('message', 'receipt', 'control')),
    message_id uuid REFERENCES agent_chat.messages(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- Events invalidate a room's view; receipt and session tables remain the state owners.
    session_id uuid REFERENCES agent_chat.sessions(id)
);
CREATE INDEX events_room_position ON agent_chat.events(room_id, position);
CREATE INDEX events_message ON agent_chat.events(message_id);
CREATE INDEX messages_expiry ON agent_chat.messages(expires_at);
CREATE TABLE agent_chat.requests (
    principal_id uuid NOT NULL REFERENCES agent_chat.principals(id),
    scope_id uuid NOT NULL,
    key uuid NOT NULL,
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    message_id uuid NOT NULL REFERENCES agent_chat.messages(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, scope_id, key)
);
CREATE INDEX requests_message ON agent_chat.requests(message_id);

CREATE TABLE agent_chat.browser_sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    principal_id uuid NOT NULL REFERENCES agent_chat.principals(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '8 hours')
);
CREATE INDEX ON agent_chat.browser_sessions(expires_at);

-- A service-wide failure budget avoids trusting proxy/client address headers.
CREATE TABLE agent_chat.login_guard (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    failures timestamptz[] NOT NULL DEFAULT '{}' CHECK (cardinality(failures) <= 10)
);
INSERT INTO agent_chat.login_guard(singleton) VALUES (true);

-- Delivery admissions and attempts. Reservations contain IDs and outcomes only.
CREATE TABLE agent_chat.delivery_attempts (
    id uuid PRIMARY KEY,
    batch_id uuid NOT NULL,
    session_id uuid NOT NULL,
    instance_id uuid NOT NULL REFERENCES agent_chat.instances(id),
    request_key uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
    admitted_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    outcome text CHECK (outcome IN ('handed', 'failed', 'deferred', 'uncertain')),
    reason text CHECK (reason IN ('busy', 'muted', 'stopped', 'plan', 'unknown',
        'offline', 'stale_binding', 'native_unavailable', 'transport_ambiguous', 'claim_expired')),
    completed_at timestamptz,
    FOREIGN KEY (batch_id, session_id) REFERENCES agent_chat.delivery_batches(id, session_id) ON DELETE CASCADE,
    UNIQUE (session_id, request_key),
    UNIQUE (batch_id, ordinal),
    CHECK (expires_at > admitted_at),
    CHECK ((outcome IS NULL) = (completed_at IS NULL)),
    CHECK ((outcome IS NULL OR outcome = 'handed') = (reason IS NULL))
);
CREATE UNIQUE INDEX one_inflight_delivery ON agent_chat.delivery_attempts(session_id) WHERE outcome IS NULL;
CREATE INDEX delivery_wake_window ON agent_chat.delivery_attempts(session_id, admitted_at);
CREATE INDEX delivery_expiry ON agent_chat.delivery_attempts(expires_at) WHERE outcome IS NULL;
