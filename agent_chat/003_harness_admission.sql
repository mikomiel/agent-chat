-- Harness admission: deepseek and opencode join claude, pi and codex. Admission alone grants nothing;
-- a principal still needs an operator-created credential. Only the harness set changes; the shape is 002's.
ALTER TABLE agent_chat.principals DROP CONSTRAINT IF EXISTS principal_shape,
    ADD CONSTRAINT principal_shape CHECK (
        (kind = 'operator' AND host IS NULL AND harness IS NULL AND producer IS NULL)
     OR (kind = 'agent' AND host IS NOT NULL AND harness IS NOT NULL
         AND harness IN ('claude', 'pi', 'codex', 'deepseek', 'opencode')
         AND producer IS NULL)
     OR (kind = 'producer' AND harness IS NULL AND host IS NOT NULL AND producer IS NOT NULL
         AND host ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND producer ~ '^[a-z0-9][a-z0-9-]{0,62}$'));
