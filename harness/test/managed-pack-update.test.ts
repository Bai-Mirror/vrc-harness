import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packTreeHash } from '../src/managed-pack-candidate.ts';
import { installSignedPackRelease, isVerifiedRelease, releasePayload, type SignedPackRelease, verifyPackRelease } from '../src/managed-pack-update.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/state/db.ts';
import { posixPath, removeTemp } from './fixtures/platform.ts';

function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'avh-update-'));t.after(()=>removeTemp(root));
  const home=join(root,'home'),staging=join(root,'staging');cpSync(new URL('../builtin/',import.meta.url),staging,{recursive:true});
  const pack=JSON.parse(readFileSync(join(staging,'pack.json'),'utf8')) as Record<string,unknown>;
  Object.assign(pack,{id:'stable-2026.09.1',version:'1.2.0',channel:'stable'});writeFileSync(join(staging,'pack.json'),JSON.stringify(pack));
  const db=openDatabase(join(root,'state.db'));t.after(()=>db.close());
  const keys=generateKeyPairSync('ed25519');const publicPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
  const unsigned:SignedPackRelease={schema:'harness-pack-release/0.1',releaseId:'release-2026.09.1',packId:'stable-2026.09.1',version:'1.2.0',
    contentHash:packTreeHash(staging).hash,issuedAt:'2026-09-27T20:00:00Z',minimumStateSchema:SCHEMA_VERSION,
    previousPackIds:['builtin-linux-rc5'],keyId:'official-1',signature:''};
  const manifest={...unsigned,signature:sign(null,releasePayload(unsigned),keys.privateKey).toString('base64')};
  return{root,home,staging,db,manifest,publicPem};
}

test('only a trusted Ed25519 server release can enter selectable managed packs',t=>{
  const f=fixture(t);verifyPackRelease(f.manifest,{'official-1':f.publicPem},SCHEMA_VERSION);
  assert.throws(()=>verifyPackRelease({...f.manifest,version:'1.2.1'},{'official-1':f.publicPem},SCHEMA_VERSION),/signature verification failed/);
  assert.throws(()=>verifyPackRelease(f.manifest,{},SCHEMA_VERSION),/untrusted release signing key/);
  const installed=installSignedPackRelease(f.db,f.home,f.staging,f.manifest,{'official-1':f.publicPem},SCHEMA_VERSION);
  assert.match(posixPath(installed.root), /managed\/packs\/stable-2026\.09\.1$/);
  assert.equal(isVerifiedRelease(f.db,installed.id,installed.root),true);
  const row=f.db.prepare('SELECT status,signer_key_id FROM managed_pack_release WHERE pack_id=?').get(installed.id) as {status:string;signer_key_id:string};
  assert.deepEqual({...row},{status:'installed',signer_key_id:'official-1'});
});

test('signed metadata cannot bless different pack bytes or an unsupported runtime schema',t=>{
  const f=fixture(t);writeFileSync(join(f.staging,'extra.txt'),'changed after signing');
  assert.throws(()=>installSignedPackRelease(f.db,f.home,f.staging,f.manifest,{'official-1':f.publicPem},SCHEMA_VERSION),/content hash mismatch/);
  const tooNew={...f.manifest,minimumStateSchema:SCHEMA_VERSION+1,signature:''};
  assert.throws(()=>verifyPackRelease(tooNew,{'official-1':f.publicPem},SCHEMA_VERSION),/unsupported state schema/);
});
