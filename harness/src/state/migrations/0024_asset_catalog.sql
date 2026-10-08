-- The asset catalog BOOTH products and local assets share: one category vocabulary, one avatar dictionary, one review
-- queue (docs/zh/参考站对照清单.md §2, §3, §5, §6). No table here holds a foreign key into booth_item or booth_file:
-- those belong to the BOOTH index. Every row below is either a decision a person made (kept for good) or derived from
-- the index and re-derived when its inputs or the dictionary change.

-- The category vocabulary in effect (the latest version), in tree order.
CREATE TABLE asset_category (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);
-- Every vocabulary version ever in effect; a new one is made only by applying a proposal.
CREATE TABLE asset_taxonomy_version (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  categories_json TEXT NOT NULL CHECK (json_valid(categories_json) AND json_type(categories_json) = 'array'),
  proposal_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE asset_taxonomy_proposal (
  id TEXT PRIMARY KEY,
  base_version INTEGER NOT NULL,
  operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
  impact_json TEXT NOT NULL CHECK (json_valid(impact_json)),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('ai', 'human', 'system')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT
);
-- Version 1: the reference archive's vocabulary. 未分类 is the absence of a category, not a row.
INSERT INTO asset_category (id, path, position) VALUES
  ('body', '素体', 0), ('outfit', '服装', 1), ('hair', '发型', 2), ('accessory', '配饰', 3),
  ('texture', '贴图', 4), ('toy', '玩具', 5), ('plugin', '功能插件', 6);
INSERT INTO asset_taxonomy_version (version, categories_json) VALUES (1, '[{"id":"body","path":"素体","hidden":false},{"id":"outfit","path":"服装","hidden":false},{"id":"hair","path":"发型","hidden":false},{"id":"accessory","path":"配饰","hidden":false},{"id":"texture","path":"贴图","hidden":false},{"id":"toy","path":"玩具","hidden":false},{"id":"plugin","path":"功能插件","hidden":false}]');

-- One row per catalog item ('booth:<item id>' or 'local:<asset id>'). category_id NULL is 未分类. source says who set
-- it: auto (a confident BOOTH rule, only ever applied to an item without a category), manual (a person's final
-- choice), legacy (mapped from the old asset.kind, kept in legacy_kind) or none.
CREATE TABLE asset_classification (
  subject TEXT PRIMARY KEY CHECK (subject LIKE 'booth:%' OR subject LIKE 'local:%'),
  category_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('none', 'auto', 'manual', 'legacy')),
  suggestion_id TEXT,
  suggestion_reason TEXT NOT NULL DEFAULT '',
  dismissed_suggestion_id TEXT,
  basis_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(basis_json)),
  legacy_kind TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX asset_classification_category ON asset_classification (category_id);
CREATE INDEX asset_classification_suggestion ON asset_classification (suggestion_id);

-- The old asset.kind becomes a category; the kind itself stays in asset and in legacy_kind.
-- package and other have no category: they are 未分类.
INSERT OR IGNORE INTO asset_classification (subject, category_id, source, legacy_kind)
  SELECT 'local:' || id, CASE kind WHEN 'avatar' THEN 'body' WHEN 'outfit' THEN 'outfit' WHEN 'texture' THEN 'texture'
    WHEN 'animation' THEN 'toy' END, 'legacy', kind FROM asset;

-- What was derived for an item, from which inputs and with which dictionary and vocabulary versions.
CREATE TABLE asset_derivation (
  subject TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('booth', 'local')),
  ref TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  files_stamp TEXT NOT NULL DEFAULT '',
  dictionary_version TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  -- Only BOOTH 3D categories (and local assets) carry avatar tags.
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  -- Why an item without confirmed avatars counts as universal ('' when it only was not recognised).
  universal_basis TEXT NOT NULL DEFAULT '',
  search_strong TEXT NOT NULL DEFAULT '',
  search_weak TEXT NOT NULL DEFAULT '',
  listing_key INTEGER,
  acquired_at TEXT,
  derived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, ref)
);

-- Avatar tags per item: the author's claims with their source and confidence, and whether they stand. `title` marks
-- a body product with the avatar it is (learned from its title); `manual` is a person's addition.
CREATE TABLE asset_avatar_tag (
  subject TEXT NOT NULL,
  avatar_key TEXT NOT NULL,
  avatar TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('variation', 'tag', 'description', 'title', 'manual')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'pending', 'rejected')),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('rule', 'human')),
  evidence TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  dictionary_version TEXT NOT NULL,
  PRIMARY KEY (subject, avatar_key)
);
CREATE INDEX asset_avatar_tag_avatar ON asset_avatar_tag (avatar_key, status);
-- A person's confirm or reject of one avatar on one item: re-derivation reapplies it, so a resync never undoes it.
CREATE TABLE asset_avatar_decision (
  subject TEXT NOT NULL,
  avatar_key TEXT NOT NULL,
  avatar TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('confirm', 'reject')),
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (subject, avatar_key)
);

-- This computer's additions to the shipped avatar dictionary: learned from owned bodies, chosen in the review queue,
-- or imported from the person's own dictionary. Personal data: it never leaves the state database.
CREATE TABLE avatar_dictionary_entry (
  canonical_key TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  shares_body_with_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(shares_body_with_json) AND json_type(shares_body_with_json) = 'array'),
  owned INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0, 1)),
  owned_by TEXT,
  body_item_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('learned', 'review', 'import', 'ai')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE avatar_dictionary_term (
  term_key TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Names discovery found that the dictionary does not know yet. Decided rows stay, so a rejected name is not asked again.
CREATE TABLE avatar_dictionary_candidate (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'alias', 'shares_body')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  related TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  items INTEGER NOT NULL DEFAULT 0,
  shops INTEGER NOT NULL DEFAULT 0,
  strength TEXT NOT NULL CHECK (strength IN ('strong', 'weak')),
  origin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT
);
CREATE INDEX avatar_dictionary_candidate_status ON avatar_dictionary_candidate (status, strength);

-- What each remote BOOTH file is (material / avatar / other) and which avatars its name names.
CREATE TABLE booth_file_kind (
  downloadable_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('material', 'avatar', 'other')),
  avatars_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(avatars_json) AND json_type(avatars_json) = 'array'),
  reason TEXT NOT NULL DEFAULT '',
  dictionary_version TEXT NOT NULL,
  derived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX booth_file_kind_item ON booth_file_kind (item_id, kind);

-- Local assets keep their catalog rows in step whichever path writes the asset table.
CREATE TRIGGER asset_catalog_insert AFTER INSERT ON asset BEGIN
  INSERT OR IGNORE INTO asset_classification (subject, category_id, source, legacy_kind)
  VALUES ('local:' || new.id, (SELECT id FROM asset_category WHERE id = CASE new.kind WHEN 'avatar' THEN 'body'
    WHEN 'outfit' THEN 'outfit' WHEN 'texture' THEN 'texture' WHEN 'animation' THEN 'toy' END), 'legacy', new.kind);
END;
CREATE TRIGGER asset_catalog_kind AFTER UPDATE OF kind ON asset BEGIN
  UPDATE asset_classification SET legacy_kind = new.kind,
    category_id = CASE WHEN source = 'legacy' THEN (SELECT id FROM asset_category WHERE id = CASE new.kind WHEN 'avatar' THEN 'body'
      WHEN 'outfit' THEN 'outfit' WHEN 'texture' THEN 'texture' WHEN 'animation' THEN 'toy' END) ELSE category_id END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE subject = 'local:' || new.id;
END;
CREATE TRIGGER asset_catalog_delete AFTER DELETE ON asset BEGIN
  DELETE FROM asset_classification WHERE subject = 'local:' || old.id;
  DELETE FROM asset_avatar_tag WHERE subject = 'local:' || old.id;
  DELETE FROM asset_avatar_decision WHERE subject = 'local:' || old.id;
  DELETE FROM asset_derivation WHERE subject = 'local:' || old.id;
END;
