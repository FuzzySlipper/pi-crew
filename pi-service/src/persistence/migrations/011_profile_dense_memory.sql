-- Migration 011: profile_dense_memory table
-- Dense per-profile personal notes (Hermes MEMORY.md / USER.md compat).

CREATE TABLE IF NOT EXISTS profile_dense_memory (
    profile_id  TEXT NOT NULL,
    target      TEXT NOT NULL CHECK(target IN ('memory', 'user')),
    -- Full content as newline-separated entries.
    content     TEXT NOT NULL DEFAULT '',
    -- Byte cap for this target (from profile config or default).
    cap_bytes   INTEGER NOT NULL DEFAULT 2200,
    -- Monotonic write token for drift detection.
    write_token INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, target)
);

-- Index for profile-level lookups (already covered by PK, but explicit).
CREATE INDEX IF NOT EXISTS idx_profile_dense_memory_profile
    ON profile_dense_memory (profile_id);
