-- DATA/D8 traceability: the edge between one contributed case and the signed release that accepted it.
-- The server is the authority (accepted/contribution/<receiptId>.json carries the release id) and reports it through
-- the installation status; the Runtime stores what that read reported, so one case can be traced from its receipt
-- through its candidate and evaluation to the release and the version installed here, without a network call at
-- query time. Null means no accepted release has been observed yet.
ALTER TABLE managed_pack_contribution ADD COLUMN release_id TEXT;
