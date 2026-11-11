-- Display metadata only. UUIDs and the existing selector label remain unchanged.
ALTER TABLE agent_chat.sessions ADD COLUMN title text
    CHECK (title IS NULL OR (char_length(title) BETWEEN 1 AND 128 AND octet_length(title) <= 512));
