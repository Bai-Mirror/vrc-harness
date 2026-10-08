-- Contribution sharing (回传共享, src/sharing/). Sharing is on unless the person turned it off, but nothing is uploaded
-- until they have seen the current notice. Their choices and the notices they saw are kept here, append-only; the
-- installation token itself is a credential (config/secrets), never a row.
CREATE TABLE sharing_consent (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (action IN ('notice_shown', 'enabled', 'disabled', 'registered', 'revoke_requested', 'revoked')),
  notice_version INTEGER CHECK (notice_version IS NULL OR notice_version > 0),
  surface TEXT NOT NULL CHECK (surface IN ('gui-setup', 'gui', 'tui-setup', 'tui', 'cli', 'runtime')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TRIGGER sharing_consent_no_update BEFORE UPDATE ON sharing_consent
BEGIN SELECT RAISE(ABORT, 'sharing_consent is append-only'); END;
CREATE TRIGGER sharing_consent_no_delete BEFORE DELETE ON sharing_consent
BEGIN SELECT RAISE(ABORT, 'sharing_consent is append-only'); END;

-- The bounded local queue of harness-records/0.1 records (shared/sharing.ts validates each one before it is written).
-- A batch id is given to records once, when they are first sent, and kept until the server stores them, so a retry
-- after a lost answer is the same batch. Sent records stay listed for the person until the server would have deleted them.
CREATE TABLE sharing_record (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  category TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND json_type(record_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'rejected')),
  batch_id TEXT CHECK (batch_id IS NULL OR length(batch_id) = 32),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT
);
CREATE INDEX sharing_record_status ON sharing_record(status, created_at);

-- What a producer already turned into a record (a finished Run, say), so it is never queued twice. Local only.
CREATE TABLE sharing_source (
  ref TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
