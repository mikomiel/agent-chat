-- Sender receipts: a non-waking ledger that tells the sending session its message was handed to or acknowledged
-- by a recipient (receipts.record, receipts.eligible owns the policy). A `replied` receipt is the reply message
-- itself and has no row here. Nothing here wakes a model, charges a wake budget or writes a replay event.
-- The sender opts in per message; the policy ignores the flag for kinds that never carry receipts.
ALTER TABLE agent_chat.messages ADD COLUMN receipts_requested boolean NOT NULL DEFAULT false;
-- At most one row per message, recipient and state: an addressed message can have several recipients.
-- Retention collects a message row and its receipts together (ON DELETE CASCADE).
CREATE TABLE agent_chat.sender_receipts (
    id uuid PRIMARY KEY,
    message_id uuid NOT NULL REFERENCES agent_chat.messages(id) ON DELETE CASCADE,
    sender_session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    state text NOT NULL CHECK (state IN ('handed', 'acked')),
    recipient_session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz,
    UNIQUE (message_id, recipient_session_id, state)
);
-- The sender feed reads its own undelivered rows oldest first.
CREATE INDEX sender_receipts_undelivered ON agent_chat.sender_receipts(sender_session_id, created_at, id)
    WHERE delivered_at IS NULL;
