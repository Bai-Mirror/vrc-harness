import assert from 'node:assert/strict';
import test from 'node:test';
import { readSecret } from '../../harness/src/providers/secrets.ts';
import { flushSharing, remoteSharingStatus, revokeSharing, sharingToken } from '../../harness/src/sharing/client.ts';
import { chooseSharing, queueSharingRecord, sharingState } from '../../harness/src/sharing/state.ts';
import { SHARING_NOTICE_VERSION } from '../../harness/src/shared/sharing.ts';
import { openDatabase } from '../../harness/src/state/db.ts';
import { startServer, tempDir } from './helpers.ts';

test('notice gates registration, then an installation can send, inspect, and revoke its own records', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const home = tempDir(t), { url } = await startServer(t, { dataDir: tempDir(t) });
  await assert.rejects(sharingToken(db, home, url), /先查看/);
  assert.equal(sharingState(db).installation, null);
  assert.equal(queueSharingRecord(db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' }).queued, false);

  chooseSharing(db, { surface: 'cli', noticeShown: true, enabled: true });
  assert.equal(queueSharingRecord(db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' }).queued, true);
  const sent = await flushSharing(db, home, url);
  assert.deepEqual(sent, { sent: 1, pending: 0 });
  const install = sharingState(db).installation;
  assert.ok(install);
  assert.match(readSecret(home, 'sharing.installation-token') ?? '', /^hst_/);
  const status = await remoteSharingStatus(db, home) as { installation: { installId: string }; records: unknown[] };
  assert.equal(status.installation.installId, install.installId);
  assert.equal(status.records.length, 1);

  const revoked = await revokeSharing(db, home) as { revoked: boolean; removed: { records: number } };
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.removed.records, 1);
  assert.equal(sharingState(db).active, false);
  assert.equal(sharingState(db).installation, null);
  assert.equal(readSecret(home, 'sharing.installation-token'), undefined);
  assert.equal((await flushSharing(db, home, url)).sent, 0);
});


test('an old notice and on choice cannot register or flush under the revised advertised contract',async t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const home=tempDir(t),{url}=await startServer(t,{dataDir:tempDir(t)});
 db.prepare("INSERT INTO sharing_consent(action,notice_version,surface) VALUES('notice_shown',?,'gui')").run(SHARING_NOTICE_VERSION-1);
 db.exec("INSERT INTO sharing_consent(action,notice_version,surface) VALUES('enabled',NULL,'gui')");
 const caps=await (await fetch(url+'/v1/capabilities')).json();assert.equal(caps.dataPolicy.noticeVersion,SHARING_NOTICE_VERSION);
 let calls=0;await assert.rejects(()=>sharingToken(db,home,url,async()=>{calls++;return new Response();}),/先查看/);
 assert.deepEqual(await flushSharing(db,home,url,async()=>{calls++;return new Response();}),{sent:0,pending:0});assert.equal(calls,0);
 chooseSharing(db,{surface:'gui',noticeShown:true});assert.equal(sharingState(db).active,false);
 chooseSharing(db,{surface:'gui',enabled:true});assert.equal(sharingState(db).active,true);
});
