-- A candidate may be tried locally only for one named project. This is not promotion:
-- the global managed-pack selection remains unchanged and official adoption still
-- requires a signed server release.
CREATE TABLE managed_pack_trial (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES managed_pack_candidate(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  workflow_id TEXT REFERENCES workflow(id),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  mode TEXT NOT NULL DEFAULT 'project' CHECK (mode IN ('shadow', 'project')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'active', 'disabled', 'completed')),
  restrictions_json TEXT NOT NULL CHECK (json_valid(restrictions_json) AND json_type(restrictions_json) = 'object'),
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  activated_at TEXT,
  disabled_at TEXT
);
CREATE UNIQUE INDEX managed_pack_trial_open_project
  ON managed_pack_trial(project_id) WHERE status IN ('approved', 'active');
CREATE UNIQUE INDEX managed_pack_trial_workflow
  ON managed_pack_trial(workflow_id) WHERE workflow_id IS NOT NULL;
