ALTER TABLE production_continuation ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE production_continuation_contract (
  event_seq INTEGER PRIMARY KEY REFERENCES event(seq),
  continuation_id TEXT NOT NULL REFERENCES production_continuation(id),
  source_hash TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  pack_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  token TEXT NOT NULL
);
CREATE TRIGGER production_continuation_contract_no_update BEFORE UPDATE ON production_continuation_contract BEGIN
  SELECT RAISE(ABORT,'continuation contract adoption is immutable');
END;
CREATE TRIGGER production_continuation_contract_no_delete BEFORE DELETE ON production_continuation_contract BEGIN
  SELECT RAISE(ABORT,'continuation contract adoption is immutable');
END;
