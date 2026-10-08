-- Shares and restores of a project (harness/docs/project-share.md). Every table is append-only: an export, a restore or a
-- sync point is a fact about the project's life and is never rewritten.

-- A share package written from this database: the explicit list it was built from, the checks and the outcome. The
-- output path is a local record; it never enters an archive or a package.
CREATE TABLE project_share (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES project(id),
  archive_id TEXT NOT NULL CHECK (length(archive_id) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  level TEXT NOT NULL CHECK (level IN ('continuable', 'needs_dependencies', 'observe_only')),
  -- Layers, chosen optional items, the permitted-only mode, acknowledged findings, the recipient's label.
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json) AND json_type(selection_json) = 'object'),
  output TEXT NOT NULL CHECK (length(output) > 0),
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 64),
  package_bytes INTEGER NOT NULL CHECK (package_bytes > 0),
  files_sha256 TEXT NOT NULL CHECK (length(files_sha256) = 64),
  report_json TEXT NOT NULL CHECK (json_valid(report_json) AND json_type(report_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_share_project ON project_share(project_id, seq);
CREATE TRIGGER project_share_no_update BEFORE UPDATE ON project_share
BEGIN SELECT RAISE(ABORT, 'project_share is append-only'); END;
CREATE TRIGGER project_share_no_delete BEFORE DELETE ON project_share
BEGIN SELECT RAISE(ABORT, 'project_share is append-only'); END;

-- A share package restored into this database: which package, what was decided (a new project, an update of the same
-- project, a copy beside it) and the reconciliation's fixed part (what was restored, what is missing, what moved).
-- Workflows whose capability pack was not available are listed in pending_json; they are bound later.
CREATE TABLE project_restore (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES project(id),
  share_id TEXT NOT NULL CHECK (length(share_id) > 0),
  archive_id TEXT NOT NULL CHECK (length(archive_id) > 0),
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('new', 'update', 'copy')),
  pending_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_json) AND json_type(pending_json) = 'array'),
  report_json TEXT NOT NULL CHECK (json_valid(report_json) AND json_type(report_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_restore_project ON project_restore(project_id, seq);
CREATE TRIGGER project_restore_no_update BEFORE UPDATE ON project_restore
BEGIN SELECT RAISE(ABORT, 'project_restore is append-only'); END;
CREATE TRIGGER project_restore_no_delete BEFORE DELETE ON project_restore
BEGIN SELECT RAISE(ABORT, 'project_restore is append-only'); END;

-- Where a project's state met a share package: exported from here, or restored into here. The revision is this
-- database's revision at that point; lineage_json names every share this state descends from. A later package of the
-- same project is an update only when it descends from the last sync point and the project has not changed since.
CREATE TABLE project_sync (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  share_id TEXT NOT NULL CHECK (length(share_id) > 0),
  direction TEXT NOT NULL CHECK (direction IN ('export', 'restore')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  lineage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lineage_json) AND json_type(lineage_json) = 'array'),
  -- The project's files at that point (relative path -> sha256), without the archive Harness rewrites: a later update
  -- first proves the project still holds exactly these.
  content_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(content_json) AND json_type(content_json) = 'object'),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_sync_project ON project_sync(project_id, seq);
CREATE TRIGGER project_sync_no_update BEFORE UPDATE ON project_sync
BEGIN SELECT RAISE(ABORT, 'project_sync is append-only'); END;
CREATE TRIGGER project_sync_no_delete BEFORE DELETE ON project_sync
BEGIN SELECT RAISE(ABORT, 'project_sync is append-only'); END;
