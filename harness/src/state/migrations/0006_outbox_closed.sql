DROP TRIGGER dispatch_outbox_order;
CREATE TABLE dispatch_outbox_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id),
  status TEXT NOT NULL DEFAULT 'intended' CHECK (status IN ('intended', 'launched', 'acked', 'closed')),
  intended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  launched_at TEXT,
  acked_at TEXT
);
INSERT INTO dispatch_outbox_new SELECT * FROM dispatch_outbox;
DROP TABLE dispatch_outbox;
ALTER TABLE dispatch_outbox_new RENAME TO dispatch_outbox;
CREATE TRIGGER dispatch_outbox_initial BEFORE INSERT ON dispatch_outbox
WHEN NEW.status <> 'intended'
BEGIN SELECT RAISE(ABORT, 'dispatch_outbox must start intended'); END;
CREATE TRIGGER dispatch_outbox_order BEFORE UPDATE OF status ON dispatch_outbox
WHEN NOT (OLD.status = 'intended' AND NEW.status IN ('launched', 'closed')
       OR OLD.status = 'launched' AND NEW.status IN ('acked', 'closed')
       OR OLD.status = 'acked' AND NEW.status = 'closed')
BEGIN SELECT RAISE(ABORT, 'invalid dispatch_outbox transition'); END;
