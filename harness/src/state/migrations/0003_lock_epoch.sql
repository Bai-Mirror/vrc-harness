CREATE TABLE lock_epoch (
  resource TEXT PRIMARY KEY,
  fencing INTEGER NOT NULL CHECK (fencing > 0)
);
INSERT INTO lock_epoch (resource, fencing)
  SELECT resource, fencing FROM lock;
