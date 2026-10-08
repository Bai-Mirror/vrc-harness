import type { DatabaseSync } from 'node:sqlite';
import { remoteSharingStatus } from './sharing/client.ts';
import { recordEventOnce } from './state/tx.ts';

/**
 * DATA/D8 traceability: one contributed case, from the receipt the server returned through the candidate and the
 * evaluation it came from, to the signed release that accepted it and the version installed on this computer.
 *
 * The server holds the authority for acceptance (`accepted/contribution/<receiptId>.json`) and reports it in the
 * installation status; this module records what such a read reported (`recordContributionAcceptance`) and answers the
 * whole chain from local facts alone (`traceContribution`). It never promotes, activates or releases anything: a
 * receipt is not an adoption, and the missing release id stays null until the server says otherwise.
 */
export const TRACE_SCHEMA = 'harness-contribution-trace/0.1';
const HEX32 = /^[0-9a-f]{32}$/;

export interface ContributionTrace {
  schema: typeof TRACE_SCHEMA;
  /** The server's receipt for the upload, if one came back. */
  receiptId: string | null;
  candidateId: string;
  evaluationId: string;
  contributionStatus: string;
  submittedAt: string | null;
  /** The signed release the server accepted this case into; null until an installation-status read reports it. */
  release: { releaseId: string; packId: string; version: string; status: string; installedAt: string; activatedAt: string | null } | null;
  /** The version of that pack installed here, and whether it is the active one. */
  installed: { releaseId: string; packId: string; version: string; active: boolean } | null;
  /** Whether the local facts already name a release: false means the chain still ends at the evaluation. */
  complete: boolean;
}
interface ContributionRow {
  id: string; candidateId: string; evaluationId: string; status: string; submittedAt: string | null;
  receiptJson: string | null; releaseId: string | null;
}

const COLUMNS = `id, candidate_id AS candidateId, evaluation_id AS evaluationId, status, submitted_at AS submittedAt,
  receipt_json AS receiptJson, release_id AS releaseId`;

/**
 * Records that the server accepted this receipt into a release. Returns whether anything changed: an unknown receipt
 * (this computer never uploaded it, or its row was cancelled) is ignored rather than invented, and re-reading the same
 * acceptance writes nothing twice.
 */
export function recordContributionAcceptance(db: DatabaseSync, input: { receiptId: string; releaseId: string }): boolean {
  if (!HEX32.test(input.receiptId)) throw new Error('invalid receipt id');
  if (!input.releaseId.trim()) throw new Error('invalid release id');
  const row = db.prepare(`SELECT ${COLUMNS} FROM managed_pack_contribution WHERE json_extract(receipt_json,'$.receiptId') = ?`)
    .get(input.receiptId) as ContributionRow | undefined;
  if (!row) return false;
  if (row.releaseId === input.releaseId) return false;
  db.prepare(`UPDATE managed_pack_contribution SET release_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .run(input.releaseId, row.id);
  recordEventOnce(db, { actor: 'runtime', entityType: 'managed_pack_contribution', entityId: row.id,
    action: 'accepted_into_release', reason: 'the receiving server reported this contribution accepted into a signed release',
    payload: { receiptId: input.receiptId, releaseId: input.releaseId, candidateId: row.candidateId, evaluationId: row.evaluationId } });
  return true;
}

/**
 * Reads the installation status and records every acceptance it reports. Offline, without an installation, or with a
 * server that answers something unexpected it records nothing and reports why: a trace read must not fail because the
 * network is down. Returns the number of newly recorded edges.
 */
export async function refreshContributionAcceptance(db: DatabaseSync, home: string, fetcher?: typeof fetch):
  Promise<{ recorded: number; error?: string }> {
  let status: unknown;
  try { status = await remoteSharingStatus(db, home, fetcher); }
  catch (error) { return { recorded: 0, error: (error as Error).message }; }
  const contributions = (status as { contributions?: unknown } | null)?.contributions;
  if (!Array.isArray(contributions)) return { recorded: 0 };
  let recorded = 0;
  for (const item of contributions as Array<{ receiptId?: unknown; releaseId?: unknown }>) {
    if (typeof item.receiptId !== 'string' || typeof item.releaseId !== 'string') continue;
    recorded += recordContributionAcceptance(db, { receiptId: item.receiptId, releaseId: item.releaseId }) ? 1 : 0;
  }
  return { recorded };
}

/** The chain for one case, looked up by the server's receipt id or by the candidate it came from. */
export function traceContribution(db: DatabaseSync, input: { receiptId?: string; candidateId?: string }): ContributionTrace | undefined {
  let row: ContributionRow | undefined;
  if (input.receiptId !== undefined) {
    row = db.prepare(`SELECT ${COLUMNS} FROM managed_pack_contribution WHERE json_extract(receipt_json,'$.receiptId') = ?`)
      .get(input.receiptId) as ContributionRow | undefined;
  } else if (input.candidateId !== undefined) {
    row = db.prepare(`SELECT ${COLUMNS} FROM managed_pack_contribution WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(input.candidateId) as ContributionRow | undefined;
  }
  if (!row) return undefined;
  const receipt = row.receiptJson ? JSON.parse(row.receiptJson) as { receiptId?: unknown } : undefined;
  const receiptId = typeof receipt?.receiptId === 'string' ? receipt.receiptId : null;
  const release = row.releaseId ? db.prepare(`SELECT release_id AS releaseId, pack_id AS packId, version, status,
    installed_at AS installedAt, activated_at AS activatedAt FROM managed_pack_release WHERE release_id = ?`).get(row.releaseId) as
    ContributionTrace['release'] ?? null : null;
  // The version installed here for that pack, accepted or not: the chain should say what this computer runs.
  const installedRow = release ? db.prepare(`SELECT release_id AS releaseId, pack_id AS packId, version, status FROM managed_pack_release
    WHERE pack_id = ? ORDER BY installed_at DESC, rowid DESC LIMIT 1`).get(release.packId) as
    { releaseId: string; packId: string; version: string; status: string } | undefined : undefined;
  return { schema: TRACE_SCHEMA, receiptId, candidateId: row.candidateId, evaluationId: row.evaluationId,
    contributionStatus: row.status, submittedAt: row.submittedAt,
    release, installed: installedRow ? { releaseId: installedRow.releaseId, packId: installedRow.packId, version: installedRow.version,
      active: installedRow.status === 'active' } : null,
    complete: Boolean(release) };
}
