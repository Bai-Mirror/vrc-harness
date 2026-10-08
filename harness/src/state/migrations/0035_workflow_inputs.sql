CREATE TABLE workflow_input_revision (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  activation_id TEXT NOT NULL,
  source_event_seq INTEGER NOT NULL REFERENCES event(seq),
  base_plan_hash TEXT,
  face_identity_json TEXT NOT NULL CHECK(json_valid(face_identity_json)),
  face_input_hash TEXT NOT NULL,
  UNIQUE(workflow_id, revision),
  UNIQUE(workflow_id, activation_id)
);
CREATE TRIGGER workflow_input_revision_no_update BEFORE UPDATE ON workflow_input_revision
BEGIN SELECT RAISE(ABORT, 'workflow input revision is immutable'); END;
CREATE TRIGGER workflow_input_revision_no_delete BEFORE DELETE ON workflow_input_revision
BEGIN SELECT RAISE(ABORT, 'workflow input history is retained'); END;

CREATE TABLE run_input_snapshot (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  workflow_input_revision_id TEXT REFERENCES workflow_input_revision(id),
  baseline_artifact_hashes_json TEXT NOT NULL CHECK(json_valid(baseline_artifact_hashes_json)),
  effective_plan_json TEXT NOT NULL CHECK(json_valid(effective_plan_json)),
  effective_plan_sha256 TEXT NOT NULL,
  manual_values_json TEXT CHECK(manual_values_json IS NULL OR json_valid(manual_values_json)),
  manual_values_sha256 TEXT,
  manual_handoff_json TEXT CHECK(manual_handoff_json IS NULL OR json_valid(manual_handoff_json)),
  stage_tool_selection_json TEXT NOT NULL CHECK(json_valid(stage_tool_selection_json)),
  face_selection_json TEXT CHECK(face_selection_json IS NULL OR json_valid(face_selection_json))
);
CREATE TRIGGER run_input_snapshot_no_update BEFORE UPDATE ON run_input_snapshot
BEGIN SELECT RAISE(ABORT, 'run input snapshot is immutable'); END;
CREATE TRIGGER run_input_snapshot_no_delete BEFORE DELETE ON run_input_snapshot
BEGIN SELECT RAISE(ABORT, 'run input snapshot is retained'); END;

-- NULL means unknown historical binding. Never attribute old evidence to new inputs.
ALTER TABLE verdict ADD COLUMN input_hashes_json TEXT CHECK(input_hashes_json IS NULL OR json_valid(input_hashes_json));
ALTER TABLE gate_decision ADD COLUMN input_hashes_json TEXT CHECK(input_hashes_json IS NULL OR json_valid(input_hashes_json));
