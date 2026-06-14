-- Migration 006: Rename durable non-pooled session kind from conversational to full.
-- Keep legacy rows readable at the SQL layer so the repository can fail loudly with
-- an explicit migration/discard message instead of a CHECK-constraint error.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS sessions_v6 (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('full','worker','delegated','conversational')),
    profile_id          TEXT NOT NULL,
    instance_id         TEXT,
    channel_bindings_json TEXT NOT NULL DEFAULT '[]',
    worker_binding_json TEXT,
    delegation_json     TEXT,
    delegation_spawn_request_json TEXT,
    delegation_constraints_json TEXT,
    effective_runtime_json TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','archived')),
    created_at          TEXT NOT NULL,
    last_activity       TEXT NOT NULL,
    expires_at          TEXT
);

INSERT OR IGNORE INTO sessions_v6 (
    id, kind, profile_id, instance_id, channel_bindings_json,
    worker_binding_json, delegation_json, delegation_spawn_request_json,
    delegation_constraints_json, effective_runtime_json,
    status, created_at, last_activity, expires_at
)
SELECT
    id, kind, profile_id, instance_id, channel_bindings_json,
    worker_binding_json, delegation_json, delegation_spawn_request_json,
    delegation_constraints_json, effective_runtime_json,
    status, created_at, last_activity, expires_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_v6 RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind);

PRAGMA foreign_keys = ON;
