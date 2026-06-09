-- Migration 002: delegation lineage columns and delegated session kind.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS sessions_next (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('conversational','worker','delegated')),
    profile_id          TEXT NOT NULL,
    channel_bindings_json TEXT NOT NULL DEFAULT '[]',
    worker_binding_json TEXT,
    delegation_json    TEXT,
    delegation_spawn_request_json TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','archived')),
    created_at          TEXT NOT NULL,
    last_activity       TEXT NOT NULL,
    expires_at          TEXT
);

INSERT OR IGNORE INTO sessions_next (
    id, kind, profile_id, channel_bindings_json, worker_binding_json,
    delegation_json, delegation_spawn_request_json,
    status, created_at, last_activity, expires_at
)
SELECT
    id, kind, profile_id, channel_bindings_json, worker_binding_json,
    NULL, NULL, status, created_at, last_activity, expires_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind);

PRAGMA foreign_keys = ON;
