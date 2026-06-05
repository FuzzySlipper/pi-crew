-- Migration 001: Initial pi-crew runtime persistence schema.
-- Forward-only, idempotent for CREATE TABLE IF NOT EXISTS.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Sessions table: durable session records for both conversational
-- and worker sessions.  Worker sessions carry a worker_binding JSON
-- column with Den assignment/run/task correlation.
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('conversational','worker')),
    profile_id          TEXT NOT NULL,
    channel_bindings_json TEXT NOT NULL DEFAULT '[]',
    worker_binding_json TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','archived')),
    created_at          TEXT NOT NULL,
    last_activity       TEXT NOT NULL,
    expires_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_kind  ON sessions(kind);

-- Messages table: persisted per-session message history.
-- Content is stored as JSON-serialized text.
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
    content         TEXT NOT NULL,
    tool_name       TEXT,
    token_count     INTEGER,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

-- Audit log table: full-fidelity event history with Den correlation
-- IDs.  event_data is redacted at the storage boundary.
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT,
    assignment_id   TEXT,
    run_id          TEXT,
    event_type      TEXT NOT NULL,
    event_data      TEXT NOT NULL,
    flushed         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_session    ON audit_log(session_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_assignment ON audit_log(assignment_id);
CREATE INDEX IF NOT EXISTS idx_audit_type       ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_flushed    ON audit_log(flushed);

-- Runtime KV table: small operational state (last Den sync, etc.).
CREATE TABLE IF NOT EXISTS runtime_kv (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
