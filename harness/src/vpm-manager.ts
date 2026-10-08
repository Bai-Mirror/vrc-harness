import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { vpmEnvironment, vpmExecutable } from './environment.ts';

export type VpmAction='check'|'resolve'|'add'|'remove'|'migrate'|'migrate-unity2022';
export interface VpmStatus{available:boolean;packages:Record<string,string>;manifestPath:string;legacyManifest:boolean}
function executable():string{return vpmExecutable()??'vpm';}
/**
 * Usable means it runs: a VPM CLI whose .NET runtime is missing starts and exits at once. VPM runs in the temporary
 * directory: its crash reporter may write Sentry/<hash>/.installation into the working directory.
 */
function available():boolean{const result=spawnSync(executable(),['--version'],{stdio:'ignore',timeout:30000,cwd:tmpdir(),env:vpmEnvironment()});
  return result.error===undefined&&result.status===0;}
function json(path:string):Record<string,unknown>{try{return JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;}catch{return{};}}
export function vpmStatus(project:string):VpmStatus{
  const vpm=join(project,'Packages','vpm-manifest.json'),manifest=join(project,'Packages','manifest.json');
  const raw=json(vpm),dependencies=(raw.dependencies&&typeof raw.dependencies==='object'?raw.dependencies:json(manifest).dependencies)??{};
  return{available:available(),packages:Object.fromEntries(Object.entries(dependencies as Record<string,unknown>).filter(([,v])=>typeof v==='string')) as Record<string,string>,manifestPath:vpm,legacyManifest:!existsSync(vpm)};
}
export function runVpm(project:string,action:VpmAction,packageId?:string,version?:string):string{
  project=resolve(project);
  if(!existsSync(join(project,'Assets'))||!existsSync(join(project,'ProjectSettings')))throw new Error('目标不是可识别的 Unity 工程');
  if(!available())throw new Error('官方 VPM CLI 不可用：请在设置的「环境依赖」里安装，或运行 avh deps install');
  if((action==='add'||action==='remove')&&!packageId)throw new Error(`${action} 需要 packageId`);
  const files=['Packages/manifest.json','Packages/vpm-manifest.json'].map(path=>join(project,path));
  const backup=join(project,'Library','.avh-vpm-backup');rmSync(backup,{recursive:true,force:true});mkdirSync(backup,{recursive:true});
  for(const file of files)if(existsSync(file))copyFileSync(file,join(backup,file.endsWith('vpm-manifest.json')?'vpm-manifest.json':'manifest.json'));
  const args=action==='check'?['check','project',project]:action==='resolve'?['resolve','project',project]:
    action==='migrate'?['migrate','project',project]:action==='migrate-unity2022'?['migrate','unity2022',project]:
    [action,'package',packageId!,project,...(version?['--version',version]:[])];
  try{return execFileSync(executable(),args,{encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024,cwd:tmpdir(),env:vpmEnvironment()});}
  catch(error){mkdirSync(dirname(files[0]!),{recursive:true});for(const [i,file] of files.entries()){
      const saved=join(backup,i?'vpm-manifest.json':'manifest.json');if(existsSync(saved))copyFileSync(saved,file);else rmSync(file,{force:true});}
    throw new Error(`VPM ${action} 失败，清单已回退：${(error as Error).message}`);}
}
