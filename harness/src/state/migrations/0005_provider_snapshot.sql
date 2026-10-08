CREATE TABLE provider_snapshot (
  workflow_id TEXT PRIMARY KEY REFERENCES workflow(id),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TRIGGER provider_snapshot_no_update BEFORE UPDATE ON provider_snapshot
BEGIN SELECT RAISE(ABORT, 'provider_snapshot is append-only'); END;
CREATE TRIGGER provider_snapshot_no_delete BEFORE DELETE ON provider_snapshot
BEGIN SELECT RAISE(ABORT, 'provider_snapshot is append-only'); END;
