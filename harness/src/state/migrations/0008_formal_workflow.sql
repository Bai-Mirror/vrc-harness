-- A formal Workflow runs the definition, capability manifest, thresholds and input manifest frozen when it was
-- created; a later knowledge-layer edit cannot change a Workflow already under way.
CREATE TABLE workflow_definition (
  workflow_id TEXT PRIMARY KEY REFERENCES workflow(id),
  profile TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json) = 'object'),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'),
  thresholds_json TEXT NOT NULL CHECK (json_valid(thresholds_json) AND json_type(thresholds_json) = 'object'),
  manifest_json TEXT CHECK (manifest_json IS NULL OR (json_valid(manifest_json) AND json_type(manifest_json) = 'object')),
  -- sha256 of every tool-root file the Workflow's stages and observers run; a changed tool stops the Workflow.
  tools_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tools_json) AND json_type(tools_json) = 'object'),
  frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TRIGGER workflow_definition_no_update BEFORE UPDATE ON workflow_definition
BEGIN SELECT RAISE(ABORT, 'workflow_definition is append-only'); END;
CREATE TRIGGER workflow_definition_no_delete BEFORE DELETE ON workflow_definition
BEGIN SELECT RAISE(ABORT, 'workflow_definition is append-only'); END;

-- Every distinct plan document the Runtime observed. Approval binds a hash (gate_decision); this keeps the
-- content that hash stood for, so what was approved stays readable after the plan changes.
CREATE TABLE plan_revision (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  hash TEXT NOT NULL,
  content_json TEXT CHECK (content_json IS NULL OR (json_valid(content_json) AND json_type(content_json) = 'object')),
  error TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((content_json IS NULL) <> (error IS NULL))
);
CREATE INDEX plan_revision_lookup ON plan_revision(workflow_id, seq);
CREATE TRIGGER plan_revision_no_update BEFORE UPDATE ON plan_revision
BEGIN SELECT RAISE(ABORT, 'plan_revision is append-only'); END;
CREATE TRIGGER plan_revision_no_delete BEFORE DELETE ON plan_revision
BEGIN SELECT RAISE(ABORT, 'plan_revision is append-only'); END;

-- Temporary Task Workflows were created 'active' and never updated. Their state is their latest Task's.
UPDATE workflow SET status = lower((SELECT t.status FROM task t WHERE t.workflow_id = workflow.id ORDER BY t.rowid DESC LIMIT 1))
  WHERE process_hash = 'avh-task/0.1'
    AND (SELECT t.status FROM task t WHERE t.workflow_id = workflow.id ORDER BY t.rowid DESC LIMIT 1) IN ('PASSED', 'FAILED', 'CANCELLED');
