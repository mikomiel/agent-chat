-- Room role marks and the per-instance work declaration.
--
-- The single PM mark becomes the pm mark. Its wire stamp stays `pm`, so historical
-- messages, `--from pm` and the existing skills keep their meaning; github_pm and delivery_manager stamp their
-- own values. One live role per session is enforced by roles.assign under the event clock, not by a unique
-- index: liveness is clock-dependent and a partial index predicate must be immutable.
CREATE TABLE agent_chat.room_roles (
    room_id uuid NOT NULL REFERENCES agent_chat.rooms(id),
    role text NOT NULL CONSTRAINT room_role
        CHECK (role IN ('pm', 'github_pm', 'delivery_manager')),
    session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    set_at timestamptz NOT NULL,
    last_activity_at timestamptz NOT NULL,
    PRIMARY KEY (room_id, role)
);
CREATE INDEX room_roles_session ON agent_chat.room_roles(session_id);

INSERT INTO agent_chat.room_roles (room_id, role, session_id, set_at, last_activity_at)
SELECT room_id, 'pm', session_id, set_at, last_activity_at FROM agent_chat.room_pm;
DROP TABLE agent_chat.room_pm;

ALTER TABLE agent_chat.messages DROP CONSTRAINT message_sender_role;
ALTER TABLE agent_chat.messages ADD CONSTRAINT message_sender_role
    CHECK (sender_role IN ('pm', 'github_pm', 'delivery_manager'));

-- A JSON object from forge to repository names. models.WorkDeclaration owns the element grammar and the
-- count; this CHECK bounds the stored shape and text.
ALTER TABLE agent_chat.instances ADD COLUMN repositories jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT instance_repositories_shape CHECK (
        jsonb_typeof(repositories) = 'object' AND octet_length(repositories::text) <= 4096
    );
