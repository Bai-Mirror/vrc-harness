-- Machine-specific execution inputs are resolved from validated configuration once and frozen. Capability packs
-- contain placeholders only, never a developer's personal paths.
ALTER TABLE workflow_definition ADD COLUMN variables_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(variables_json) AND json_type(variables_json) = 'object');
