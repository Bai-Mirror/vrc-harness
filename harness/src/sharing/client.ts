import type { DatabaseSync } from 'node:sqlite';
import { clearSecret, readSecret, writeSecret } from '../providers/secrets.ts';
import { MAX_BATCH_RECORDS, RECORD_RECEIPT_SCHEMA, RECORD_SCHEMA, SHARING_PATHS, type RecordReceipt } from '../shared/sharing.ts';
import { claimSharingBatch, forgetSharingRecords, pruneSharingQueue, recordConsent, settleSharingBatch, sharingState } from './state.ts';
import { cancelPendingContributions } from './contribution-cleanup.ts';

const TOKEN_SECRET = 'sharing.installation-token';

function pathAt(server: string, path: string): string {
  const base = new URL(server);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    throw new Error('贡献服务器需要 HTTPS，或本机 HTTP');
  return new URL(path, base).toString();
}

async function answer(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`贡献服务器返回 HTTP ${response.status}: ${String(body.error ?? '请求失败')}`);
  return body;
}

/** The token is a private file, never part of SQLite, configuration, logs, or an exported project. */
export async function sharingToken(db: DatabaseSync, home: string, server: string, fetcher: typeof fetch = fetch): Promise<string> {
  const state = sharingState(db);
  if (!state.active) throw new Error(state.needsNotice ? '先查看回传共享说明' : '回传共享已关闭或正在撤回');
  if (state.installation && state.installation.server !== server) throw new Error('共享服务器已变化；请先撤回旧服务器的数据');
  const existing = readSecret(home, TOKEN_SECRET);
  if (state.installation) {
    if (!existing) throw new Error('本机安装令牌已丢失，无法恢复原安装；请联系维护者处理撤回');
    return existing;
  }
  const body = await answer(await fetcher(pathAt(server, SHARING_PATHS.installations), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' }));
  if (body.schema !== 'harness-installation/0.1' || typeof body.installId !== 'string' || !/^[0-9a-f]{32}$/.test(body.installId)
    || typeof body.token !== 'string' || !/^hst_[A-Za-z0-9_-]{43}$/.test(body.token)) throw new Error('贡献服务器返回无效安装凭据');
  writeSecret(home, TOKEN_SECRET, body.token);
  recordConsent(db, 'registered', 'runtime', { installId: body.installId, server });
  return body.token;
}

/** Retries use the same batch id; a failed network request leaves the batch in the local queue. */
export async function flushSharing(db: DatabaseSync, home: string, server: string, fetcher: typeof fetch = fetch): Promise<{ sent: number; pending: number }> {
  pruneSharingQueue(db);
  if (!sharingState(db).active) return { sent: 0, pending: sharingState(db).counts.queued };
  const batch = claimSharingBatch(db, MAX_BATCH_RECORDS);
  if (!batch) return { sent: 0, pending: 0 };
  const token = await sharingToken(db, home, server, fetcher);
  if (!sharingState(db).active) return { sent: 0, pending: sharingState(db).counts.queued };
  const response = await fetcher(pathAt(server, SHARING_PATHS.records), { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({
    schema: RECORD_SCHEMA, batchId: batch.batchId, notice: sharingState(db).noticeVersion, records: batch.records,
  }) });
  const receipt = await answer(response) as unknown as RecordReceipt;
  if (receipt.schema !== RECORD_RECEIPT_SCHEMA || receipt.batchId !== batch.batchId || receipt.status !== 'stored'
    || receipt.accepted !== batch.records.length) throw new Error('贡献服务器回执与本地批次不匹配');
  const sent = settleSharingBatch(db, batch.batchId, { sent: true });
  return { sent, pending: sharingState(db).counts.queued };
}

export async function remoteSharingStatus(db: DatabaseSync, home: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const state = sharingState(db), token = readSecret(home, TOKEN_SECRET);
  if (!state.installation || !token) return null;
  return answer(await fetcher(pathAt(state.installation.server, SHARING_PATHS.status), {
    headers: { authorization: `Bearer ${token}` },
  }));
}

/** If offline, the revocation stays pending locally and may be retried without re-enabling uploads. */
export async function revokeSharing(db: DatabaseSync, home: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const state = sharingState(db), installation = state.revokePending ?? state.installation;
  if (state.choice !== 'off') {
    recordConsent(db, 'disabled', 'runtime');
  }
  db.prepare("DELETE FROM sharing_record WHERE status = 'queued'").run();
  cancelPendingContributions(db,home);
  if (!installation) return { revoked: false, reason: 'no-installation', localStopped: true };
  if (!state.revokePending) recordConsent(db, 'revoke_requested', 'runtime', {
    installId: installation.installId, server: installation.server,
  });
  const token = readSecret(home, TOKEN_SECRET);
  if (!token) throw new Error('本机安装令牌已丢失，无法向服务器提交撤回；请联系维护者');
  const result = await answer(await fetcher(pathAt(installation.server, SHARING_PATHS.revoke), { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }));
  if (result.schema !== 'harness-revocation/0.1' || result.installId !== installation.installId || result.revoked !== true)
    throw new Error('贡献服务器未确认撤回');
  recordConsent(db, 'revoked', 'runtime', result);
  forgetSharingRecords(db);
  clearSecret(home, TOKEN_SECRET);
  return result;
}
