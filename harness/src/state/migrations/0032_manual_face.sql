CREATE TABLE face_preference (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  mode TEXT NOT NULL CHECK(mode IN ('preserve','ai','manual')),
  revision INTEGER NOT NULL DEFAULT 1,
  accepted_session_id TEXT,
  current_session_id TEXT
);
CREATE TABLE face_manual_session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_session_id TEXT REFERENCES face_manual_session(id),
  project_path TEXT NOT NULL UNIQUE,
  workflow_id TEXT REFERENCES workflow(id),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('editing','processing','accepted','cancelled','stopping')),
  input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json)),
  accepted_json TEXT CHECK(accepted_json IS NULL OR json_valid(accepted_json)),
  version INTEGER,
  gui_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project_id,version)
);
CREATE TRIGGER face_manual_accepted_no_update BEFORE UPDATE ON face_manual_session
WHEN OLD.state = 'accepted'
BEGIN SELECT RAISE(ABORT,'accepted manual face is immutable'); END;
CREATE TRIGGER face_manual_no_delete BEFORE DELETE ON face_manual_session
BEGIN SELECT RAISE(ABORT,'manual face evidence is retained'); END;
