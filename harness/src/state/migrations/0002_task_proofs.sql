-- Legacy completions remain readable by the aggregate, but cannot prove a new Task passed.
ALTER TABLE stage_completion ADD COLUMN run_id TEXT REFERENCES run(id);
CREATE INDEX stage_completion_run ON stage_completion(run_id);

-- A single event sequence orders human evidence against entry into WAITING_HUMAN.
CREATE TRIGGER gate_decision_human_event AFTER INSERT ON gate_decision
BEGIN
  INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
  VALUES (NEW.workflow_id, 'human', 'gate_decision', CAST(NEW.seq AS TEXT), 'recorded',
    'gate decision recorded', json_object('artifact_hash', NEW.artifact_hash));
END;
CREATE TRIGGER warning_acceptance_human_event AFTER INSERT ON warning_acceptance
BEGIN
  INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
  VALUES (NEW.workflow_id, 'human', 'warning_acceptance', CAST(NEW.seq AS TEXT), 'recorded',
    'warning accepted', json_object('verdict_id', NEW.verdict_id));
END;
CREATE TRIGGER out_of_bounds_acceptance_human_event AFTER UPDATE OF accepted ON out_of_bounds_change
WHEN OLD.accepted = 0 AND NEW.accepted = 1
BEGIN
  INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
  VALUES (NEW.workflow_id, 'human', 'out_of_bounds_change', CAST(NEW.seq AS TEXT), 'accepted',
    'out-of-bounds change accepted', json_object('artifact_hash',
      (SELECT hash FROM artifact_version WHERE workflow_id = NEW.workflow_id AND kind = NEW.artifact ORDER BY seq DESC LIMIT 1)));
END;
CREATE TRIGGER out_of_bounds_accepted_insert_human_event AFTER INSERT ON out_of_bounds_change
WHEN NEW.accepted = 1
BEGIN
  INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
  VALUES (NEW.workflow_id, 'human', 'out_of_bounds_change', CAST(NEW.seq AS TEXT), 'accepted',
    'out-of-bounds change accepted', json_object('artifact_hash',
      (SELECT hash FROM artifact_version WHERE workflow_id = NEW.workflow_id AND kind = NEW.artifact ORDER BY seq DESC LIMIT 1)));
END;
