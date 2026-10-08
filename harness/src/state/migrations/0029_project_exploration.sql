CREATE TABLE exploration_resource (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  UNIQUE(project_id,path)
);
CREATE TABLE interaction_exploration (
  interaction_id TEXT NOT NULL REFERENCES project_interaction(id),
  ordinal INTEGER NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES task(id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(interaction_id,ordinal)
);
