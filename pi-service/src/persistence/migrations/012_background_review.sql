-- Migration 012: background_review table
-- Tracks review cycle state per profile session.

CREATE TABLE IF NOT EXISTS review_counters (
    profile_id          TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    turns_since_memory  INTEGER NOT NULL DEFAULT 0,
    iters_since_skill   INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (profile_id, session_id)
);
