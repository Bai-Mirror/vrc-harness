CREATE TABLE asset (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('avatar', 'outfit', 'texture', 'animation', 'package', 'other')),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'ready', 'blocked', 'archived')),
  license TEXT NOT NULL DEFAULT 'unknown',
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX asset_kind_status ON asset(kind, status);

CREATE TABLE project_message (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'harness')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'note' CHECK (status IN ('note', 'proposed', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_message_project ON project_message(project_id, created_at);
