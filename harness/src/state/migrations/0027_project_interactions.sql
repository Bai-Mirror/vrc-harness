CREATE TABLE project_session (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE TABLE project_interaction (
  id TEXT PRIMARY KEY REFERENCES project_message(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  revision INTEGER NOT NULL,
  reply_to TEXT REFERENCES project_interaction(id),
  task_id TEXT UNIQUE REFERENCES task(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_user','answered','completed','failed','superseded','cancelled')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error TEXT,
  UNIQUE(project_id,command_id),
  UNIQUE(project_id,revision)
);
CREATE INDEX project_interaction_pending ON project_interaction(status,project_id);
