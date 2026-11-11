-- PM mark: at most one session per room is marked as the project manager, and the service stamps the role
-- on the messages that session publishes while the mark is live. Only the operator sets or clears the mark, through
-- an HTTP route; nothing here grants any authority. models.py owns the expiry (PM_EXPIRY_HOURS).

-- `room_pm`: one row per room. The primary key is the one-mark rule and the target of the atomic swap, so a new
-- holder replaces the old one in one statement. A row is live only while `last_activity_at` is younger than the
-- expiry and its session is still a current member of the room with a principal that is not revoked; pm.py holds
-- that one test. No timer runs and no row is swept: a lapsed row counts as absent until the next set replaces it.
-- `set_at` is the clock time of the operator's set. `last_activity_at` starts equal to it and moves only when the
-- holder publishes or acknowledges, in the transaction of that action.
CREATE TABLE agent_chat.room_pm (
    room_id uuid PRIMARY KEY REFERENCES agent_chat.rooms(id),
    session_id uuid NOT NULL REFERENCES agent_chat.sessions(id),
    set_at timestamptz NOT NULL,
    last_activity_at timestamptz NOT NULL
);

-- `sender_role`: written by the service at publication when the sender is the live holder, never by a client.
-- Every message that exists when this migration runs takes NULL. The stamp is historical: it stays on a message
-- after the mark moves, is cleared or lapses. The CHECK closes the set of roles to `pm`; a further role needs a
-- further migration.
ALTER TABLE agent_chat.messages ADD COLUMN sender_role text
    CONSTRAINT message_sender_role CHECK (sender_role = 'pm');
