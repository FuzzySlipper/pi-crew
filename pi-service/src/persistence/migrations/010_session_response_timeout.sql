-- Migration 010: persist full-agent response timeout envelopes per session.

ALTER TABLE sessions ADD COLUMN response_timeout_ms INTEGER;
