-- User-owned local selection is separate from candidate-declared privileges and official releases.
CREATE TABLE local_pack_adoption (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','local')),
  project_id TEXT REFERENCES project(id),
  candidate_id TEXT REFERENCES managed_pack_candidate(id),
  content_hash TEXT,
  base_pack_id TEXT,
  base_hash TEXT,
  evaluation_id TEXT REFERENCES managed_pack_evaluation(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','disabled')),
  command_id TEXT NOT NULL UNIQUE,
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((scope='project' AND project_id IS NOT NULL) OR (scope='local' AND project_id IS NULL)),
  CHECK ((candidate_id IS NULL AND content_hash IS NULL) OR (candidate_id IS NOT NULL AND length(content_hash)=64))
);
CREATE UNIQUE INDEX local_pack_adoption_project ON local_pack_adoption(project_id) WHERE scope='project' AND status='active';
CREATE UNIQUE INDEX local_pack_adoption_default ON local_pack_adoption(scope) WHERE scope='local' AND status='active';
