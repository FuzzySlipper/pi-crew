-- Migration 003: delegated session runtime and remaining delegation budget.

ALTER TABLE sessions ADD COLUMN delegation_constraints_json TEXT;
ALTER TABLE sessions ADD COLUMN effective_runtime_json TEXT;
