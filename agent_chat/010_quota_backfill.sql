-- Migration 006 stamps every instance that existed at apply time with the migration
-- clock, so a database upgraded from 005 counts a principal's whole registration
-- history against its first rolling hour and refuses every new registration until
-- that hour passes. Move only the rows 006 stamped, bounded by the recorded
-- version-006 applied_at: a genuine registration made afterwards keeps its real
-- created_at and its share of the hourly quota.
UPDATE agent_chat.instances
SET created_at = clock_timestamp() - make_interval(secs => 3601)
WHERE created_at > clock_timestamp() - make_interval(secs => 3600)
  AND created_at <= (
      SELECT applied_at FROM agent_chat.schema_migrations WHERE version = 6
  );
