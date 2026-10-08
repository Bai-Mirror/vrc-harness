CREATE TABLE booth_item (
  item_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shop_name TEXT NOT NULL DEFAULT '',
  item_url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  owned INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed','available','login_required','unavailable')),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json)='array'),
  images_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(images_json) AND json_type(images_json)='array'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json)='object'),
  remote_updated_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX booth_item_owned_status ON booth_item(owned,status,updated_at);

CREATE TABLE booth_file (
  downloadable_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES booth_item(item_id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  remote_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed','available','login_required','unavailable')),
  probed_at TEXT,
  UNIQUE(item_id,filename,remote_version)
);
CREATE INDEX booth_file_item ON booth_file(item_id,status);

CREATE TABLE asset_selection_plan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  variant_id TEXT REFERENCES project_variant(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflow(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','materializing','ready','failed','released')),
  rationale TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_by TEXT NOT NULL DEFAULT 'provider' CHECK (created_by IN ('provider','human')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX asset_selection_plan_project ON asset_selection_plan(project_id,status,created_at);

CREATE TABLE asset_selection_file (
  plan_id TEXT NOT NULL REFERENCES asset_selection_plan(id) ON DELETE CASCADE,
  downloadable_id TEXT NOT NULL REFERENCES booth_file(downloadable_id),
  purpose TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0,1)),
  PRIMARY KEY(plan_id,downloadable_id)
);

CREATE TABLE materialized_file (
  downloadable_id TEXT PRIMARY KEY REFERENCES booth_file(downloadable_id),
  path TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64),
  remote_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ready','corrupt','missing')),
  materialized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE materialized_ref (
  plan_id TEXT NOT NULL REFERENCES asset_selection_plan(id) ON DELETE CASCADE,
  downloadable_id TEXT NOT NULL REFERENCES materialized_file(downloadable_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(plan_id,downloadable_id)
);
CREATE INDEX materialized_ref_file ON materialized_ref(downloadable_id,plan_id);
