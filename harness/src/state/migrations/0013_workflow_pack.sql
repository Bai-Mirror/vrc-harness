-- Keep the executable side of the selected managed pack pinned too. Hashes detect mutation; this path selects
-- the immutable version, so activating or rolling back another pack cannot redirect an in-flight Workflow.
ALTER TABLE workflow_definition ADD COLUMN tool_root TEXT NOT NULL DEFAULT '';
