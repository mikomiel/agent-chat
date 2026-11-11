-- Direct 1:1 threads: higher reply and wake limits for a thread between exactly two sessions, with a loop detector.
-- The thread row holds the state: publication writes it under the event clock and the thread lock, so no verdict
-- depends on message history, which retention prunes while the thread lives. The functions below are the one
-- definition of each term; publication, pending and claim all call them. models.py owns the numbers.

-- The direct reply limit (models.DIRECT_REPLY_LIMIT) exceeds the CHECK of 001, which PostgreSQL named.
ALTER TABLE agent_chat.threads DROP CONSTRAINT threads_agent_replies_check,
    ADD CONSTRAINT thread_agent_replies CHECK (agent_replies BETWEEN 0 AND 20);

-- Each admission is charged to one per-session allowance. Admissions before this migration count as 'other'.
ALTER TABLE agent_chat.delivery_attempts ADD COLUMN allowance text NOT NULL DEFAULT 'other'
    CONSTRAINT delivery_allowance CHECK (allowance IN ('direct', 'other'));

-- `participants`: every session that sent or received any message in the thread since this migration, kept after
-- those messages expire. An operator has no session, so an operator sender adds none; the sessions an operator
-- message addresses join.
-- `participants_complete`: whether `participants` names every session that ever took part. A thread that exists
-- when this migration runs is incomplete for good: retention may already have removed the messages and recipient
-- rows that named some of its sessions, and nothing stored shows whether it has, so no history is read back. Such a
-- thread is never direct and keeps the limits it had before. The ADD COLUMN default `false` is what the existing
-- rows take; the default is then changed to `true`, which every thread created from now on takes.
-- `loop_stamps`: the clock time of each counted reply since the last operator reset, in publication order. The
-- reset clears them with the reply count, so a stamp never outlives its reply. Replies counted before this
-- migration carry no stamp, so the detector sees only replies published after it.
ALTER TABLE agent_chat.threads
    ADD COLUMN participants uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN participants_complete boolean NOT NULL DEFAULT false,
    ADD COLUMN loop_stamps timestamptz[] NOT NULL DEFAULT '{}',
    ADD CONSTRAINT thread_loop_stamps CHECK (cardinality(loop_stamps) <= agent_replies);
ALTER TABLE agent_chat.threads ALTER COLUMN participants_complete SET DEFAULT true;

-- Direct: complete participants that are exactly two sessions, counting the sessions a message being published
-- would add (`joining`). A thread whose participants are not complete is never direct.
CREATE FUNCTION agent_chat.thread_direct(complete boolean, participants uuid[], joining uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT complete AND (SELECT count(DISTINCT member) = 2 FROM unnest(participants || joining) AS member)
$$;

-- Loop detector: some `replies` consecutive stamps span at most `window_seconds`. The stamps are wall-clock readings,
-- so a clock stepped back can shorten a span and trip the detector early, which fails closed. An operator message
-- of a counted kind clears the stamps.
CREATE FUNCTION agent_chat.thread_loop_tripped(stamps timestamptz[], replies integer, window_seconds integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM generate_subscripts(stamps, 1) AS earliest
        WHERE stamps[earliest + replies - 1] - stamps[earliest] <= make_interval(secs => window_seconds)
    )
$$;
