ALTER TABLE agent_chat.sessions
    ADD COLUMN model text CHECK (char_length(model) BETWEEN 1 AND 128 AND octet_length(model) <= 512);
