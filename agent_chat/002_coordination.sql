-- Coordination state: more message kinds, entity-keyed threads with resolution, an advisory lane on the live
-- instance, a producer principal and room state. Everything here is untrusted, advisory material: no delivery,
-- admission or authorization query reads it. 001 created the CHECKs below unnamed, so PostgreSQL generated their
-- names; DROP has no IF EXISTS, so a wrong name aborts the single migrate transaction.

-- Coordination kinds. They are never selected for delivery (deliveries.pending lists its kinds explicitly).
ALTER TABLE agent_chat.messages DROP CONSTRAINT messages_kind_check,
    ADD CONSTRAINT message_kind CHECK (kind IN ('message', 'status', 'question', 'consultation', 'reply',
        'heads_up', 'blocked_on', 'decision_needed', 'intent'));

-- Entity-keyed threads and their resolution. The database checks the coarse shape only;
-- models.REF_KEY_PATTERN is the one exact grammar.
ALTER TABLE agent_chat.threads
    ADD COLUMN ref_key text CONSTRAINT thread_ref_key_shape
        CHECK (ref_key ~ '^(pr|lane|resource):[A-Za-z0-9_./:#-]{1,180}$'),
    ADD COLUMN resolved_at timestamptz,
    ADD COLUMN resolved_by_principal_id uuid REFERENCES agent_chat.principals(id),
    ADD CONSTRAINT thread_resolution CHECK ((resolved_at IS NULL) = (resolved_by_principal_id IS NULL));
CREATE UNIQUE INDEX thread_ref_key ON agent_chat.threads(room_id, ref_key) WHERE ref_key IS NOT NULL;

-- Advisory lane on the live instance. The database bounds the text only.
ALTER TABLE agent_chat.instances
    ADD COLUMN lane text CONSTRAINT instance_lane_shape CHECK (lane ~ '^[A-Za-z0-9_./:-]{1,120}$'),
    ADD COLUMN lane_since timestamptz,
    ADD CONSTRAINT instance_lane_since CHECK ((lane IS NULL) = (lane_since IS NULL));

-- Producer principal: an authenticated machine writer of room state, with no harness, session or membership.
ALTER TABLE agent_chat.principals DROP CONSTRAINT principals_kind_check, DROP CONSTRAINT principals_check,
    ADD COLUMN producer text,
    ADD CONSTRAINT principal_kind CHECK (kind IN ('operator', 'agent', 'producer')),
    ADD CONSTRAINT principal_shape CHECK (
        (kind = 'operator' AND host IS NULL AND harness IS NULL AND producer IS NULL)
     OR (kind = 'agent' AND host IS NOT NULL AND harness IS NOT NULL AND harness IN ('claude', 'pi', 'codex')
         AND producer IS NULL)
     OR (kind = 'producer' AND harness IS NULL AND host IS NOT NULL AND producer IS NOT NULL
         AND host ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND producer ~ '^[a-z0-9][a-z0-9-]{0,62}$'));

-- Room state: the latest value per key. This table is the only owner of the value; events only invalidate.
CREATE TABLE agent_chat.room_state (
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    state_key text NOT NULL
        CHECK (state_key ~ '^[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9.-]{0,62}$'),
    ref_key text CHECK (ref_key ~ '^resource:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$'),
    value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 4096),
    producer_principal_id uuid NOT NULL REFERENCES agent_chat.principals(id),
    -- Server clock at the last change of value or ref_key.
    changed_at timestamptz NOT NULL,
    -- Server clock at the last accepted upsert.
    observed_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (room_id, state_key),
    CHECK (changed_at <= observed_at AND expires_at > observed_at
           AND expires_at <= observed_at + interval '3600 seconds')
);
CREATE INDEX room_state_producer ON agent_chat.room_state(producer_principal_id);
CREATE INDEX room_state_expiry ON agent_chat.room_state(expires_at);

-- Replay events. There is no FK to room_state, because state rows are pruned independently of events.
ALTER TABLE agent_chat.events DROP CONSTRAINT events_kind_check,
    ADD COLUMN state_key text,
    ADD CONSTRAINT event_kind CHECK (kind IN ('message', 'receipt', 'control', 'state', 'thread')),
    ADD CONSTRAINT event_state_key CHECK ((kind = 'state') = (state_key IS NOT NULL)),
    ADD CONSTRAINT event_thread_root CHECK (kind <> 'thread' OR message_id IS NOT NULL);
