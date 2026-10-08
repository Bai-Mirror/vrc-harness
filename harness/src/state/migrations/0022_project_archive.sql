-- The project archive (harness/docs/project-archive.md). Every table is append-only: a business conclusion, a file
-- registration, an input observation or a projection revision is never rewritten; a correction or a change of input is
-- a newer row, and what depended on the old one is derived as stale.

-- One record contract for business conclusions about a project (import findings, takeover candidates, scans, user
-- confirmations). Workflow results are derived from the Workflow tables in the same shape and are not copied here.
CREATE TABLE project_fact (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES project(id),
  object_id TEXT NOT NULL CHECK (length(object_id) > 0),
  attribute TEXT NOT NULL CHECK (length(attribute) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  source_type TEXT NOT NULL CHECK (source_type IN ('import_scan', 'harness_scan', 'takeover_analysis', 'user')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) > 0),
  -- Where in the project the conclusion was read from: {path?, line?, object?}; paths relative to the project root.
  locator_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  input_fingerprint TEXT,
  observer TEXT NOT NULL CHECK (length(observer) > 0),
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('observed', 'inferred', 'user_confirmed', 'verified', 'unknown', 'stale')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('none', 'inference', 'document', 'observation', 'attestation', 'verification')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  scope TEXT NOT NULL CHECK (length(scope) > 0),
  invalidation_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(invalidation_json) AND json_type(invalidation_json) = 'array'),
  share_layer TEXT NOT NULL CHECK (share_layer IN ('A', 'B', 'C', 'excluded')),
  supersedes TEXT REFERENCES project_fact(id),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_fact_object ON project_fact(project_id, object_id, attribute, seq);
CREATE TRIGGER project_fact_no_update BEFORE UPDATE ON project_fact
BEGIN SELECT RAISE(ABORT, 'project_fact is append-only'); END;
CREATE TRIGGER project_fact_no_delete BEFORE DELETE ON project_fact
BEGIN SELECT RAISE(ABORT, 'project_fact is append-only'); END;

-- What an input of a fact was when Harness last looked: a file's sha256, an artifact's fingerprint, a pack draft's tree
-- hash. NULL means absent. A fact bound to an input is stale while the latest observation differs from its binding.
CREATE TABLE project_input_observation (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  input TEXT NOT NULL CHECK (length(input) > 0),
  fingerprint TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_input_observation_lookup ON project_input_observation(project_id, input, seq);
CREATE TRIGGER project_input_observation_no_update BEFORE UPDATE ON project_input_observation
BEGIN SELECT RAISE(ABORT, 'project_input_observation is append-only'); END;
CREATE TRIGGER project_input_observation_no_delete BEFORE DELETE ON project_input_observation
BEGIN SELECT RAISE(ABORT, 'project_input_observation is append-only'); END;

-- The classification registry: who registered a project path, as what, in which share layer, with which rights.
-- Built-in rules live in code (versioned with the archive schema); these rows are registrations with a provenance.
CREATE TABLE project_file_entry (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  path TEXT NOT NULL CHECK (length(path) > 0),
  match TEXT NOT NULL CHECK (match IN ('file', 'tree')),
  category TEXT NOT NULL CHECK (length(category) > 0),
  share_layer TEXT NOT NULL CHECK (share_layer IN ('A', 'B', 'C', 'excluded')),
  rights TEXT NOT NULL CHECK (rights IN ('transferable', 'not_transferable', 'unknown')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive', 'secret')),
  source_type TEXT NOT NULL CHECK (source_type IN ('user', 'vpm', 'workflow', 'import_scan')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) > 0),
  sha256 TEXT,
  restore TEXT,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (match = 'file' OR substr(path, -1) = '/')
);
CREATE INDEX project_file_entry_path ON project_file_entry(project_id, path, seq);
CREATE TRIGGER project_file_entry_no_update BEFORE UPDATE ON project_file_entry
BEGIN SELECT RAISE(ABORT, 'project_file_entry is append-only'); END;
CREATE TRIGGER project_file_entry_no_delete BEFORE DELETE ON project_file_entry
BEGIN SELECT RAISE(ABORT, 'project_file_entry is append-only'); END;

-- A walk of the project tree: how many files, and the ones no registration covers (the 待分类 queue, capped).
CREATE TABLE project_scan (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  event_seq INTEGER NOT NULL,
  files INTEGER NOT NULL CHECK (files >= 0),
  unclassified INTEGER NOT NULL CHECK (unclassified >= 0),
  unclassified_json TEXT NOT NULL CHECK (json_valid(unclassified_json) AND json_type(unclassified_json) = 'array'),
  symlinks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(symlinks_json) AND json_type(symlinks_json) = 'array'),
  -- Files per share layer, layer-A files whose rights are not transferable, whether the walk hit its limit.
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object'),
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX project_scan_project ON project_scan(project_id, seq);
CREATE TRIGGER project_scan_no_update BEFORE UPDATE ON project_scan
BEGIN SELECT RAISE(ABORT, 'project_scan is append-only'); END;
CREATE TRIGGER project_scan_no_delete BEFORE DELETE ON project_scan
BEGIN SELECT RAISE(ABORT, 'project_scan is append-only'); END;

-- The project's portable identity: the database id of an imported project derives from its absolute path, so a moved
-- project needs an id that travels with its archive.
CREATE TABLE project_archive_identity (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  archive_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('created', 'adopted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TRIGGER project_archive_identity_no_update BEFORE UPDATE ON project_archive_identity
BEGIN SELECT RAISE(ABORT, 'project_archive_identity is append-only'); END;
CREATE TRIGGER project_archive_identity_no_delete BEFORE DELETE ON project_archive_identity
BEGIN SELECT RAISE(ABORT, 'project_archive_identity is append-only'); END;

-- A consistent project revision fixed in the database at a safe point: the digest of the projection it stands for.
CREATE TABLE project_revision (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  number INTEGER NOT NULL CHECK (number > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, number)
);
CREATE TRIGGER project_revision_no_update BEFORE UPDATE ON project_revision
BEGIN SELECT RAISE(ABORT, 'project_revision is append-only'); END;
CREATE TRIGGER project_revision_no_delete BEFORE DELETE ON project_revision
BEGIN SELECT RAISE(ABORT, 'project_revision is append-only'); END;

-- Every attempt to write a revision into the project and read it back. A failed one blocks a shareable export.
CREATE TABLE project_archive_write (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('verified', 'failed')),
  manifest_sha256 TEXT,
  error TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'verified') = (error IS NULL))
);
CREATE INDEX project_archive_write_project ON project_archive_write(project_id, seq);
CREATE TRIGGER project_archive_write_no_update BEFORE UPDATE ON project_archive_write
BEGIN SELECT RAISE(ABORT, 'project_archive_write is append-only'); END;
CREATE TRIGGER project_archive_write_no_delete BEFORE DELETE ON project_archive_write
BEGIN SELECT RAISE(ABORT, 'project_archive_write is append-only'); END;
