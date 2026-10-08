-- BOOTH files become versions in one global, content-addressed pool (docs/zh/dev0.1升级规划方案.md §5, P3).
--
-- Migration 0015 kept one materialized_file row per downloadable id and stored the bytes at
-- <downloadable id>-<file name>, so fetching a file again overwrote the bytes a project had been made with. Now:
--   pool_blob            the bytes, once per sha256 and never modified. `source` says where they came from and
--                        `retention` whether they can be fetched again (BOOTH: cache) or are the only copy (a local
--                        import, still to come: keep); the strictest retention any origin asks for wins;
--   booth_file_version   which downloadable served which bytes, under which name, size and remote version clue;
--   asset_selection_pin  the version (sha256) a plan uses. A plan keeps it when BOOTH serves something else later.
-- The two 0015 tables become views over these, so readers written against 0015 keep working. Files already fetched
-- are recorded where they are and not moved: a frozen Workflow manifest may name their path.

-- What the last resolve and size probe of a downloadable saw, as step:outcome codes, e.g. `head:http-403 range:ok` or
-- `resolve:http-404`. Never the signed file URL: it carries a signature.
ALTER TABLE booth_file ADD COLUMN probe_outcome TEXT NOT NULL DEFAULT '';
-- Digest of the item's entry in the library listing (name, gift, downloadable ids) when its JSON was last read: a
-- quick sync reads the JSON again only when the entry changed.
ALTER TABLE booth_item ADD COLUMN listing_digest TEXT NOT NULL DEFAULT '';

CREATE TABLE pool_blob (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  path TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('booth', 'local')),
  retention TEXT NOT NULL CHECK (retention IN ('cache', 'keep')),
  -- Kept on the person's request, whatever references it.
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  -- removed: the bytes were deleted on an explicit request; the row and the versions stay as history.
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'corrupt', 'missing', 'removed')),
  stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  removed_at TEXT,
  CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

-- remote_version is the clue BOOTH gave for these bytes, as canonical JSON {name, size, etag?, lastModified?}; seen_at is
-- when BOOTH was last seen serving them. filename and fetched_at describe the first fetch and do not change.
CREATE TABLE booth_file_version (
  downloadable_id TEXT NOT NULL REFERENCES booth_file(downloadable_id),
  sha256 TEXT NOT NULL REFERENCES pool_blob(sha256),
  filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  remote_version TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (downloadable_id, sha256)
);
CREATE INDEX booth_file_version_blob ON booth_file_version(sha256);
CREATE TRIGGER booth_file_version_identity BEFORE UPDATE OF downloadable_id, sha256, filename, byte_size, fetched_at ON booth_file_version
BEGIN SELECT RAISE(ABORT, 'a BOOTH file version keeps its identity'); END;

-- materialized_at: when a materialization of the plan last found the pinned bytes present (NULL: pinned, not fetched yet).
CREATE TABLE asset_selection_pin (
  plan_id TEXT NOT NULL,
  downloadable_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  pinned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  materialized_at TEXT,
  PRIMARY KEY (plan_id, downloadable_id),
  FOREIGN KEY (plan_id, downloadable_id) REFERENCES asset_selection_file(plan_id, downloadable_id) ON DELETE CASCADE,
  FOREIGN KEY (downloadable_id, sha256) REFERENCES booth_file_version(downloadable_id, sha256)
);
CREATE INDEX asset_selection_pin_blob ON asset_selection_pin(sha256);
CREATE TRIGGER asset_selection_pin_fixed BEFORE UPDATE OF plan_id, downloadable_id, sha256 ON asset_selection_pin
BEGIN SELECT RAISE(ABORT, 'a plan keeps the version it pinned'); END;

-- Files fetched before this migration: their bytes, where they are. Two downloadables that served the same bytes share
-- one blob (the earlier fetch's path).
INSERT OR IGNORE INTO pool_blob (sha256, byte_size, path, source, retention, status, stored_at, verified_at)
  SELECT sha256, byte_size, path, 'booth', 'cache', status, materialized_at, verified_at
  FROM materialized_file ORDER BY materialized_at, downloadable_id;
-- The name each file was fetched under is in its path (<root>/assets/<id>-<name>); the index may since have lost it.
INSERT INTO booth_file_version (downloadable_id, sha256, filename, byte_size, remote_version, fetched_at, seen_at)
  SELECT m.downloadable_id, m.sha256,
    CASE
      WHEN instr(m.path, 'assets/' || m.downloadable_id || '-') > 0
        THEN substr(m.path, instr(m.path, 'assets/' || m.downloadable_id || '-') + length(m.downloadable_id) + 8)
      WHEN instr(m.path, 'assets\' || m.downloadable_id || '-') > 0
        THEN substr(m.path, instr(m.path, 'assets\' || m.downloadable_id || '-') + length(m.downloadable_id) + 8)
      ELSE f.filename
    END,
    m.byte_size, m.remote_version, m.materialized_at, m.verified_at
  FROM materialized_file m JOIN booth_file f ON f.downloadable_id = m.downloadable_id;
-- Every plan that had a file keeps the bytes it had.
INSERT INTO asset_selection_pin (plan_id, downloadable_id, sha256, pinned_at, materialized_at)
  SELECT r.plan_id, r.downloadable_id, m.sha256, r.created_at, r.created_at
  FROM materialized_ref r JOIN materialized_file m ON m.downloadable_id = r.downloadable_id
  JOIN asset_selection_file s ON s.plan_id = r.plan_id AND s.downloadable_id = r.downloadable_id;
-- A 404 used to rename a file to <id>.bin; give it back the name it was fetched under where no sibling holds that name.
UPDATE booth_file SET filename = (SELECT v.filename FROM booth_file_version v WHERE v.downloadable_id = booth_file.downloadable_id)
  WHERE filename = downloadable_id || '.bin'
    AND EXISTS (SELECT 1 FROM booth_file_version v WHERE v.downloadable_id = booth_file.downloadable_id AND v.filename <> booth_file.filename)
    AND NOT EXISTS (SELECT 1 FROM booth_file_version v JOIN booth_file o ON o.item_id = booth_file.item_id AND o.filename = v.filename
      WHERE v.downloadable_id = booth_file.downloadable_id AND o.downloadable_id <> booth_file.downloadable_id);

DROP INDEX materialized_ref_file;
DROP TABLE materialized_ref;
DROP TABLE materialized_file;
-- Readers written against 0015: the newest version of each downloadable, and whether its bytes are here.
CREATE VIEW materialized_file AS
  SELECT v.downloadable_id, b.path, v.byte_size, v.sha256, v.remote_version,
    CASE WHEN b.status = 'removed' THEN 'missing' ELSE b.status END AS status,
    v.fetched_at AS materialized_at, b.verified_at
  FROM booth_file_version v JOIN pool_blob b ON b.sha256 = v.sha256
  WHERE NOT EXISTS (SELECT 1 FROM booth_file_version n WHERE n.downloadable_id = v.downloadable_id
    AND (n.fetched_at > v.fetched_at OR (n.fetched_at = v.fetched_at AND n.sha256 > v.sha256)));
-- A plan file counts as materialized once its pinned version was found present for the plan.
CREATE VIEW materialized_ref AS
  SELECT plan_id, downloadable_id, materialized_at AS created_at FROM asset_selection_pin WHERE materialized_at IS NOT NULL;
