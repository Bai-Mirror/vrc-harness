import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, copyTreeExact, packTreeHash } from './pack-hash.ts';

export interface SignedPackRelease {
  schema:'harness-pack-release/0.1';releaseId:string;packId:string;version:string;contentHash:string;
  issuedAt:string;minimumStateSchema:number;previousPackIds:string[];keyId:string;signature:string;
}
const SAFE=/^[a-zA-Z0-9._-]+$/;
export function releasePayload(manifest:SignedPackRelease):Buffer {
  const {signature:_,...payload}=manifest;return Buffer.from(canonicalJson(payload));
}
export function verifyPackRelease(manifest:SignedPackRelease,trustedKeys:Record<string,string>,supportedSchema:number):void {
  if(manifest.schema!=='harness-pack-release/0.1')throw new Error('unsupported pack release schema');
  for(const [name,value] of [['releaseId',manifest.releaseId],['packId',manifest.packId],['keyId',manifest.keyId]] as const)
    if(!SAFE.test(value))throw new Error(`invalid ${name}`);
  if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version))throw new Error('invalid release version');
  if(!/^[0-9a-f]{64}$/.test(manifest.contentHash))throw new Error('invalid release content hash');
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(manifest.issuedAt)||Number.isNaN(Date.parse(manifest.issuedAt)))throw new Error('invalid release issue time');
  if(!Number.isInteger(manifest.minimumStateSchema)||manifest.minimumStateSchema<1||manifest.minimumStateSchema>supportedSchema)
    throw new Error(`release requires unsupported state schema ${manifest.minimumStateSchema}`);
  if(!Array.isArray(manifest.previousPackIds)||manifest.previousPackIds.some(id=>!SAFE.test(id)))throw new Error('invalid previous pack list');
  const pem=trustedKeys[manifest.keyId];if(!pem)throw new Error(`untrusted release signing key ${manifest.keyId}`);
  let signature:Buffer;try{signature=Buffer.from(manifest.signature,'base64');}catch{throw new Error('invalid release signature encoding');}
  if(!signature.length||!verify(null,releasePayload(manifest),createPublicKey(pem),signature))throw new Error('release signature verification failed');
}
function packInfo(root:string):{id:string;version:string;channel:string}{
  const value=JSON.parse(readFileSync(join(root,'pack.json'),'utf8')) as Record<string,unknown>;
  return{id:String(value.id??''),version:String(value.version??''),channel:String(value.channel??'')};
}
/** Installs only a server-signed, byte-exact release. It does not activate it or disturb in-flight Workflows. */
export function installSignedPackRelease(db:DatabaseSync,home:string,stagingRoot:string,manifest:SignedPackRelease,
  trustedKeys:Record<string,string>,supportedSchema:number):{id:string;root:string} {
  verifyPackRelease(manifest,trustedKeys,supportedSchema);
  const identity=packTreeHash(stagingRoot);if(identity.hash!==manifest.contentHash)throw new Error('release content hash mismatch');
  const info=packInfo(stagingRoot);if(info.id!==manifest.packId||info.version!==manifest.version)throw new Error('release manifest and pack.json disagree');
  if(info.channel==='candidate'||info.channel==='builtin')throw new Error('server release must use a release channel');
  const parent=join(home,'managed','packs'),target=join(parent,manifest.packId);mkdirSync(parent,{recursive:true,mode:0o700});
  if(existsSync(target)){
    if(packTreeHash(target).hash!==manifest.contentHash)throw new Error('pack id already exists with different content');
  }else{
    copyTreeExact(stagingRoot,target);
    if(packTreeHash(target).hash!==manifest.contentHash){rmSync(target,{recursive:true,force:true});throw new Error('installed release does not hash as signed');}
  }
  db.prepare(`INSERT INTO managed_pack_release(release_id,pack_id,version,content_hash,signer_key_id,signature,manifest_json,previous_pack_id)
    VALUES(?,?,?,?,?,?,?,?)`).run(manifest.releaseId,manifest.packId,manifest.version,manifest.contentHash,manifest.keyId,manifest.signature,
      JSON.stringify(manifest),manifest.previousPackIds[0]??null);
  return{id:manifest.packId,root:target};
}

export function isVerifiedRelease(db:DatabaseSync,packId:string,root:string):boolean {
  const row=db.prepare(`SELECT content_hash FROM managed_pack_release WHERE pack_id=? AND status IN ('installed','active','rolled_back')`).get(packId) as {content_hash:string}|undefined;
  return Boolean(row&&existsSync(root)&&packTreeHash(root).hash===row.content_hash);
}
