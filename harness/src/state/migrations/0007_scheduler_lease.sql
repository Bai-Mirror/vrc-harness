CREATE TABLE scheduler_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  host TEXT,
  pid INTEGER,
  cycle INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT
);

INSERT INTO scheduler_lease (id) VALUES (1);
