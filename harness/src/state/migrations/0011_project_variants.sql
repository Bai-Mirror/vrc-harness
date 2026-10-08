CREATE TABLE project_brief (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  intake_mode TEXT NOT NULL CHECK (intake_mode IN ('conversation', 'selection', 'import')),
  customer_request TEXT NOT NULL DEFAULT '',
  face_concept TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'direction_pending', 'direction_approved', 'archived')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One customer-facing look/outfit plan. All variants in the commission share its face concept.
-- A variant is not a Unity root: one look can have source, working, FT-derived and delivery roots.
CREATE TABLE project_variant (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'working', 'delivery', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(project_id, name)
);
CREATE INDEX project_variant_project ON project_variant(project_id, status, created_at);

-- Roots have lineage. An FT/plugin installer clones a whole root; that clone is a derivative,
-- not another outfit variant. Baseline roots may have no variant.
CREATE TABLE avatar_root (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  variant_id TEXT REFERENCES project_variant(id),
  derived_from TEXT REFERENCES avatar_root(id),
  scene_path TEXT NOT NULL DEFAULT '',
  object_path TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('baseline', 'working', 'plugin_derivative', 'delivery')),
  plugin_profile TEXT NOT NULL DEFAULT '',
  active_state TEXT NOT NULL DEFAULT 'unknown' CHECK (active_state IN ('active', 'inactive', 'unknown')),
  blueprint_id TEXT NOT NULL DEFAULT '',
  observed_at TEXT,
  UNIQUE(project_id, scene_path, object_path)
);
CREATE INDEX avatar_root_project ON avatar_root(project_id, variant_id, role);

CREATE TABLE project_variant_asset (
  variant_id TEXT NOT NULL REFERENCES project_variant(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  role TEXT NOT NULL DEFAULT 'candidate' CHECK (role IN ('candidate', 'source', 'used', 'rejected')),
  attached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (variant_id, asset_id)
);
CREATE INDEX project_variant_asset_asset ON project_variant_asset(asset_id, variant_id);
