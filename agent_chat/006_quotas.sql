-- Volume quotas count registrations and agent publications in a rolling hour (sessions.register, publication.publish).
-- Existing instances take the migration time, so they count once toward their principal's first hour.
ALTER TABLE agent_chat.instances ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX instances_created ON agent_chat.instances(created_at);
CREATE INDEX messages_sender_window ON agent_chat.messages(sender_session_id, created_at)
    WHERE sender_session_id IS NOT NULL;
