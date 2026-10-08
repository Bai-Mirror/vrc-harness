-- Concrete choices accompany the existing append-only, version-bound Gate decision.
ALTER TABLE gate_decision ADD COLUMN selection_json TEXT CHECK (selection_json IS NULL OR json_valid(selection_json));
