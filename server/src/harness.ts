/**
 * The client code the server reuses, in one place: both sides hash pack trees, canonicalize manifests and verify
 * signatures with the very same functions, so they cannot drift apart.
 * test/dockerfile.test.ts checks that server/Dockerfile copies exactly the client files these imports reach.
 */
export { canonicalJson, hashedModes, packTreeHash, writeModesSidecar } from '../../harness/src/pack-hash.ts';
// Contribution sharing: the record whitelist and the data policy are the client's own, checked by the same function.
export { dataPolicy, DEFAULT_RETENTION_DAYS, RECORD_RECEIPT_SCHEMA, RecordError, SHARING_PATHS, validateRecordBatch } from '../../harness/src/shared/sharing.ts';
export type { DataPolicy, RecordBatch, RecordReceipt } from '../../harness/src/shared/sharing.ts';
export { releasePayload, verifyPackRelease } from '../../harness/src/managed-pack-update.ts';
export type { SignedPackRelease } from '../../harness/src/managed-pack-update.ts';
export { compareVersions, verifyAppRelease } from '../../harness/src/app-release.ts';
export type { SignedAppRelease } from '../../harness/src/app-release.ts';
export type { ContributionReceipt } from '../../harness/src/contribution-queue.ts';
export { sha256File } from '../../harness/src/file-hash.ts';
