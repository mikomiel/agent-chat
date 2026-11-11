-- Viewers have only explicit principal_rooms grants and browser authentication, never a native identity.
ALTER TABLE agent_chat.principals DROP CONSTRAINT principal_kind, DROP CONSTRAINT principal_shape,
    ADD CONSTRAINT principal_kind CHECK (kind IN ('operator', 'agent', 'producer', 'viewer')),
    ADD CONSTRAINT principal_shape CHECK (
        (kind IN ('operator', 'viewer') AND host IS NULL AND harness IS NULL AND producer IS NULL)
     OR (kind = 'agent' AND host IS NOT NULL AND harness IS NOT NULL
         AND harness IN ('claude', 'pi', 'codex', 'deepseek', 'opencode') AND producer IS NULL)
     OR (kind = 'producer' AND harness IS NULL AND host IS NOT NULL AND producer IS NOT NULL
         AND host ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND producer ~ '^[a-z0-9][a-z0-9-]{0,62}$'));
