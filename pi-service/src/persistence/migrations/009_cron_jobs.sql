CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schedule TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('script_only', 'data_collection', 'llm_driven')),
  prompt TEXT,
  script TEXT,
  cwd TEXT,
  delivery_channel_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cron_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job_id, started_at DESC);
