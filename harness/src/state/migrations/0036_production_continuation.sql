CREATE TABLE production_head (
  logical_project_id TEXT PRIMARY KEY REFERENCES project(id),
  workflow_id TEXT NOT NULL REFERENCES workflow(id)
);
CREATE TABLE production_baseline (
  workflow_id TEXT PRIMARY KEY REFERENCES workflow(id),
  source_workflow_id TEXT NOT NULL REFERENCES workflow(id),
  path TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  state TEXT NOT NULL CHECK(state IN ('copying','ready','failed')),
  error TEXT
);
CREATE TABLE production_continuation (
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL UNIQUE,
  logical_project_id TEXT NOT NULL REFERENCES project(id),
  predecessor_workflow_id TEXT NOT NULL REFERENCES workflow(id),
  predecessor_project_id TEXT NOT NULL REFERENCES project(id),
  target_revision_id TEXT REFERENCES workflow_input_revision(id),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  successor_project_id TEXT REFERENCES project(id),
  successor_workflow_id TEXT UNIQUE REFERENCES workflow(id),
  preparation_json TEXT CHECK(preparation_json IS NULL OR json_valid(preparation_json)),
  state TEXT NOT NULL CHECK(state IN ('requested','waiting','preparing','applied','failed','cancelled','superseded')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE face_manual_binding (
  project_id TEXT NOT NULL REFERENCES project(id),
  session_id TEXT NOT NULL REFERENCES face_manual_session(id),
  continuation_id TEXT NOT NULL REFERENCES production_continuation(id),
  PRIMARY KEY(project_id,session_id)
);
-- Copy cancellation checks must not load a potentially multi-megabyte preparation manifest for every file.
CREATE INDEX production_continuation_state ON production_continuation(id,state);
CREATE TABLE production_evidence_reuse (
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  stage_id TEXT NOT NULL,
  source_workflow_id TEXT NOT NULL REFERENCES workflow(id),
  source_completion_seq INTEGER NOT NULL REFERENCES stage_completion(seq),
  PRIMARY KEY(workflow_id,stage_id)
);
CREATE TABLE production_archive_reference (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json))
);
CREATE TABLE production_delivery (
  workflow_id TEXT PRIMARY KEY REFERENCES workflow(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  face_input_hash TEXT,
  package_hash TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER production_delivery_no_update BEFORE UPDATE ON production_delivery BEGIN
  SELECT RAISE(ABORT,'production delivery evidence is immutable');
END;
CREATE TRIGGER production_delivery_no_delete BEFORE DELETE ON production_delivery BEGIN
  SELECT RAISE(ABORT,'production delivery evidence is immutable');
END;
CREATE TRIGGER production_evidence_reuse_no_update BEFORE UPDATE ON production_evidence_reuse BEGIN
  SELECT RAISE(ABORT,'preparation evidence references are immutable');
END;
CREATE TRIGGER production_evidence_reuse_no_delete BEFORE DELETE ON production_evidence_reuse BEGIN
  SELECT RAISE(ABORT,'preparation evidence references are immutable');
END;
