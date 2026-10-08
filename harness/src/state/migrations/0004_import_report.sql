CREATE TABLE import_report (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  report_json TEXT NOT NULL CHECK (json_valid(report_json) AND json_type(report_json) = 'object'),
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX import_report_project ON import_report(project_id, created_at);
CREATE TRIGGER import_report_no_update BEFORE UPDATE ON import_report
BEGIN SELECT RAISE(ABORT, 'import_report is append-only'); END;
CREATE TRIGGER import_report_no_delete BEFORE DELETE ON import_report
BEGIN SELECT RAISE(ABORT, 'import_report is append-only'); END;
