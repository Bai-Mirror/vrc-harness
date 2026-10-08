CREATE TABLE project_recovery (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('folder','archive','unitypackage')),
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('observe','shallow','deep')),
  distill INTEGER NOT NULL DEFAULT 0 CHECK(distill IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('analysis_pending','ready','apply_pending','failed')),
  analysis_task_id TEXT REFERENCES task(id),
  apply_task_id TEXT REFERENCES task(id),
  candidate_roots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(candidate_roots_json)),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX project_recovery_project ON project_recovery(project_id,created_at);

CREATE TABLE project_package_action (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  action TEXT NOT NULL,
  package_id TEXT,
  requested_version TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed','failed')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
