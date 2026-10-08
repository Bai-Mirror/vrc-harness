ALTER TABLE face_manual_session ADD COLUMN preparation_json TEXT
CHECK(preparation_json IS NULL OR json_valid(preparation_json));
