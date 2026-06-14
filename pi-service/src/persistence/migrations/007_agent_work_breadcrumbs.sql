CREATE TABLE IF NOT EXISTS agent_work_breadcrumbs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_family TEXT NOT NULL,
  state TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  grouping_key TEXT NOT NULL,
  session_id TEXT,
  child_session_id TEXT,
  tool_call_id TEXT,
  row_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_work_breadcrumbs_project_channel
  ON agent_work_breadcrumbs(project_id, channel_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_work_breadcrumbs_family
  ON agent_work_breadcrumbs(event_family, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_work_breadcrumbs_session
  ON agent_work_breadcrumbs(session_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_work_breadcrumbs_child
  ON agent_work_breadcrumbs(child_session_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_work_breadcrumbs_tool
  ON agent_work_breadcrumbs(tool_call_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_work_breadcrumbs_grouping
  ON agent_work_breadcrumbs(grouping_key, created_at, id);
