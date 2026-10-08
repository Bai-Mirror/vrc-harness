CREATE TABLE production_archived_evidence (
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  stage_id TEXT NOT NULL,
  source_workflow_id TEXT NOT NULL,
  source_completion_seq INTEGER NOT NULL,
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
  proof_sha256 TEXT NOT NULL,
  PRIMARY KEY(workflow_id,stage_id)
);
CREATE TRIGGER production_archived_evidence_no_update BEFORE UPDATE ON production_archived_evidence BEGIN
  SELECT RAISE(ABORT,'archived preparation evidence is immutable');
END;
CREATE TRIGGER production_archived_evidence_no_delete BEFORE DELETE ON production_archived_evidence BEGIN
  SELECT RAISE(ABORT,'archived preparation evidence is immutable');
END;
