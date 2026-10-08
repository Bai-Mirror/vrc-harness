ALTER TABLE project_interaction ADD COLUMN input_context_json TEXT CHECK(input_context_json IS NULL OR json_valid(input_context_json));
CREATE TABLE production_proposal (
  id TEXT PRIMARY KEY REFERENCES project_interaction(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  revision INTEGER NOT NULL,
  profile TEXT NOT NULL,
  request TEXT NOT NULL,
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  status TEXT NOT NULL CHECK(status IN ('proposed','working','ready','completed','cancelled')),
  workflow_id TEXT UNIQUE REFERENCES workflow(id),
  approval_command TEXT,
  UNIQUE(project_id,approval_command)
);
