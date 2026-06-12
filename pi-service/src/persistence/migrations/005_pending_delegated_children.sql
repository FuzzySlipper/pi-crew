CREATE TABLE IF NOT EXISTS pending_delegated_children (
  child_session_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  status TEXT NOT NULL,
  spawned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  timeout_ms INTEGER,
  policy_id TEXT NOT NULL,
  effective_runtime_json TEXT NOT NULL,
  latest_event_id TEXT,
  latest_checkpoint_id TEXT,
  outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_delegated_children_status
  ON pending_delegated_children(status);
CREATE INDEX IF NOT EXISTS idx_pending_delegated_children_updated_at
  ON pending_delegated_children(updated_at);
