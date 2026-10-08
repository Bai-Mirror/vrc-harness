CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK (kind IN ('client', 'private', 'history', 'sample')),
  path TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json) AND json_type(identity_json) = 'object'),
  lifecycle TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  knowledge_version TEXT NOT NULL,
  UNIQUE (workspace_id, path)
);

CREATE TABLE program (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL
);

CREATE TABLE program_project (
  program_id TEXT NOT NULL REFERENCES program(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  PRIMARY KEY (program_id, project_id)
);

CREATE TABLE workflow (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  process_id TEXT NOT NULL,
  process_hash TEXT NOT NULL,
  knowledge_version TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object')
);

CREATE TABLE artifact_version (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX artifact_version_lookup ON artifact_version(workflow_id, kind, seq);

CREATE TABLE verdict (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  check_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('edit', 'build', 'play', 'client')),
  artifact_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass', 'violation', 'no_data', 'undecidable', 'error', 'not_applicable')),
  basis TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workflow_id, id)
);
CREATE INDEX verdict_lookup ON verdict(workflow_id, check_id, seq);

CREATE TABLE gate_decision (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  gate_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('approved', 'chosen', 'done')),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX gate_decision_lookup ON gate_decision(workflow_id, gate_id, seq);

CREATE TABLE warning_acceptance (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  verdict_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workflow_id, verdict_id) REFERENCES verdict(workflow_id, id)
);

CREATE TABLE stage_completion (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  stage_id TEXT NOT NULL,
  artifact_hashes_json TEXT NOT NULL CHECK (json_valid(artifact_hashes_json) AND json_type(artifact_hashes_json) = 'object'),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE out_of_bounds_change (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  stage_id TEXT NOT NULL,
  artifact TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow(id),
  stage_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(inputs_json)),
  capability TEXT NOT NULL,
  expected_outputs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(expected_outputs_json)),
  retry_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(retry_policy_json)),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'RUNNING', 'VERIFYING', 'PASSED', 'WAITING_HUMAN', 'BLOCKED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'))
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL,
  provider TEXT,
  process_ref TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  UNIQUE (task_id, attempt)
);

CREATE TABLE dispatch_outbox (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id),
  status TEXT NOT NULL DEFAULT 'intended' CHECK (status IN ('intended', 'launched', 'acked')),
  intended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  launched_at TEXT,
  acked_at TEXT
);

CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT REFERENCES workflow(id),
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE lock (
  resource TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  fencing INTEGER NOT NULL CHECK (fencing > 0),
  lease_until TEXT NOT NULL
);

CREATE TRIGGER verdict_no_update BEFORE UPDATE ON verdict
BEGIN SELECT RAISE(ABORT, 'verdict is append-only'); END;
CREATE TRIGGER verdict_no_delete BEFORE DELETE ON verdict
BEGIN SELECT RAISE(ABORT, 'verdict is append-only'); END;
CREATE TRIGGER gate_decision_no_update BEFORE UPDATE ON gate_decision
BEGIN SELECT RAISE(ABORT, 'gate_decision is append-only'); END;
CREATE TRIGGER gate_decision_no_delete BEFORE DELETE ON gate_decision
BEGIN SELECT RAISE(ABORT, 'gate_decision is append-only'); END;
CREATE TRIGGER artifact_version_no_update BEFORE UPDATE ON artifact_version
BEGIN SELECT RAISE(ABORT, 'artifact_version is append-only'); END;
CREATE TRIGGER artifact_version_no_delete BEFORE DELETE ON artifact_version
BEGIN SELECT RAISE(ABORT, 'artifact_version is append-only'); END;
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE TRIGGER dispatch_outbox_initial BEFORE INSERT ON dispatch_outbox
WHEN NEW.status <> 'intended'
BEGIN SELECT RAISE(ABORT, 'dispatch_outbox must start intended'); END;
CREATE TRIGGER dispatch_outbox_order BEFORE UPDATE OF status ON dispatch_outbox
WHEN NOT (OLD.status = 'intended' AND NEW.status = 'launched'
       OR OLD.status = 'launched' AND NEW.status = 'acked')
BEGIN SELECT RAISE(ABORT, 'invalid dispatch_outbox transition'); END;
CREATE TRIGGER lock_fencing_increases BEFORE UPDATE ON lock
WHEN NEW.fencing <= OLD.fencing
BEGIN SELECT RAISE(ABORT, 'lock fencing must increase'); END;
