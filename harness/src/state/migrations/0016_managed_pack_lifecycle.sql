-- Candidate knowledge/tool packs never become active merely because an agent produced them.
-- This ledger separates local generation/evaluation from contribution telemetry.
-- Formal adoption is possible only through the independently signed server-release update protocol.
CREATE TABLE managed_pack_candidate (
  id TEXT PRIMARY KEY,
  base_pack_id TEXT NOT NULL,
  version TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ai', 'distill', 'human', 'import')),
  source_ref TEXT,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  impact_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(impact_json) AND json_type(impact_json) = 'object'),
  permissions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions_json) AND json_type(permissions_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN
    ('generated', 'evaluating', 'evaluated', 'rejected', 'failed', 'queued', 'submitted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE managed_pack_evaluation (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES managed_pack_candidate(id),
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  isolation TEXT NOT NULL CHECK (isolation IN ('bwrap', 'container', 'process')),
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'cancelled')),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object'),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX managed_pack_evaluation_candidate ON managed_pack_evaluation(candidate_id, started_at);

CREATE TABLE managed_pack_case_result (
  evaluation_id TEXT NOT NULL REFERENCES managed_pack_evaluation(id),
  subject TEXT NOT NULL CHECK (subject IN ('baseline', 'candidate')),
  case_id TEXT NOT NULL,
  model_family TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'error', 'undecidable')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (evaluation_id, subject, case_id, model_family, attempt)
);

-- Local qualification never installs a candidate. Only a separately verified,
-- signed server release may enter managed/packs through the update protocol.
CREATE TABLE managed_pack_release (
  release_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  signer_key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'active', 'rolled_back', 'revoked')),
  previous_pack_id TEXT,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  activated_at TEXT
);
