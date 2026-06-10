-- Migration 004: preserve live instance binding for persisted sessions.

ALTER TABLE sessions ADD COLUMN instance_id TEXT;
