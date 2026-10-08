-- AI may author a project-scoped candidate, but it can only enter immutable candidate storage after its Task passes.
-- Registration is not evaluation, promotion, activation, contribution, or release.
CREATE TABLE managed_pack_authoring (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  base_pack_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE,
  source_root TEXT NOT NULL UNIQUE,
  task_id TEXT UNIQUE REFERENCES task(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','running','registered','failed','cancelled')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX managed_pack_authoring_project ON managed_pack_authoring(project_id,created_at);
