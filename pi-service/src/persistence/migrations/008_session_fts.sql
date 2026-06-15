-- Migration 008: FTS5 index for profile-bounded session_search.
-- The runtime DB remains the session registry/source; profile isolation is enforced by joining
-- messages -> sessions.profile_id in every query instead of exposing a global search surface.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    session_id UNINDEXED,
    role UNINDEXED,
    content='messages',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, session_id, role)
    VALUES (new.id, new.content, new.session_id, new.role);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
    VALUES ('delete', old.id, old.content, old.session_id, old.role);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
    VALUES ('delete', old.id, old.content, old.session_id, old.role);
    INSERT INTO messages_fts(rowid, content, session_id, role)
    VALUES (new.id, new.content, new.session_id, new.role);
END;

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
