CREATE TABLE project_asset (
  project_id TEXT NOT NULL REFERENCES project(id),
  asset_id TEXT NOT NULL REFERENCES asset(id),
  role TEXT NOT NULL DEFAULT 'candidate' CHECK (role IN ('candidate', 'source', 'used', 'rejected')),
  attached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, asset_id)
);
CREATE INDEX project_asset_asset ON project_asset(asset_id, project_id);
