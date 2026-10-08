-- The exact stage knowledge selected by Harness is frozen with the Workflow. Agents never discover SOP files
-- on their own, and a later managed-pack update cannot silently change an in-flight task's instructions.
ALTER TABLE workflow_definition ADD COLUMN contexts_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(contexts_json) AND json_type(contexts_json) = 'object');
