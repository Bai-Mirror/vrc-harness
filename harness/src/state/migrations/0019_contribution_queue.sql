-- Contributions are opt-in, local outbox items. Creating one never uploads, promotes, activates, or releases a pack.
CREATE TABLE managed_pack_contribution (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES managed_pack_candidate(id),
  evaluation_id TEXT NOT NULL REFERENCES managed_pack_evaluation(id),
  payload_hash TEXT NOT NULL UNIQUE CHECK (length(payload_hash)=64),
  bundle_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized','exported','submitted','failed','cancelled')),
  authorized_by TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(candidate_id,evaluation_id)
);
