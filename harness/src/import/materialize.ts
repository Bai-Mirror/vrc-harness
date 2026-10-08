import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { hostPlatform } from '../host-platform.ts';
import { ordinal } from '../pack-hash.ts';

const MAX_FILES=100_000,MAX_BYTES=8*1024*1024*1024,MAX_UNITYPACKAGE=512*1024*1024;
export interface MaterializedImport {source:string;sourceKind:'folder'|'archive'|'unitypackage';sourceHash:string;projectPath:string;created:boolean;warnings:string[];candidateRoots:string[]}
// Folder sourceHash identifies editable input, excluding Unity caches; it is not the original full tree or copied target tree.
const UNITY_CACHES=new Set(['Library','Temp','Logs','obj']);
function unityRoot(root:string):boolean{
  const assets=join(root,'Assets'),settings=join(root,'ProjectSettings'),version=join(settings,'ProjectVersion.txt');
  if(!existsSync(assets)||!existsSync(settings)||!existsSync(version))return false;
  const a=lstatSync(assets),s=lstatSync(settings),v=lstatSync(version);
  return a.isDirectory()&&!a.isSymbolicLink()&&s.isDirectory()&&!s.isSymbolicLink()&&v.isFile()&&!v.isSymbolicLink()&&v.size<4096&&/^m_EditorVersion: \d+\.\d+\.\d+[a-z]\d+\s*$/m.test(readFileSync(version,'utf8'));
}
function unityCache(path:string,root:string):boolean{
  if(path===root||!UNITY_CACHES.has(basename(path))||!unityRoot(dirname(path)))return false;
  // A nested Assets/Packages/ProjectSettings tree remains user source, even if it resembles another project.
  for(let ancestor=dirname(dirname(path));ancestor.length>=root.length;ancestor=dirname(ancestor)){
    const segment=relative(ancestor,dirname(path)).split(sep)[0]!;
    const persistent=process.platform==='win32'?['assets','packages','projectsettings'].includes(segment.toLowerCase()):['Assets','Packages','ProjectSettings'].includes(segment);
    if(unityRoot(ancestor)&&persistent)return false;
    if(ancestor===root||dirname(ancestor)===ancestor)break;
  }
  const info=lstatSync(path);return info.isDirectory()||info.isSymbolicLink();
}
function copyEditableTree(source:string,target:string):void{cpSync(source,target,{recursive:true,errorOnExist:true,force:false,filter:path=>!unityCache(path,source)});}
function safeName(value:string):string{return value.replace(/\.(?:unitypackage|zip|7z|rar|tar|gz)$/i,'').replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^[-.]+|[-.]+$/g,'').slice(0,80)||'imported-project';}
function targetPath(workspace:string,name:string):string{let path=join(workspace,safeName(name)),index=1;while(existsSync(path))path=join(workspace,`${safeName(name)}-${index++}`);return path;}
function safeRelative(name:string):string{
  const normalized=name.replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'');
  if(!normalized||normalized.startsWith('/')||/^[A-Za-z]:\//.test(normalized)||normalized.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error(`unsafe archive path: ${name}`);
  return normalized;
}
function validateTree(root:string,editableUnity=false):string[]{let files=0,bytes=0;const caches:string[]=[];const visit=(dir:string):void=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);
  // This precise non-source entry is never read, followed, hashed, or copied, including cache junctions.
  if(editableUnity&&unityCache(path,root)){caches.push(relative(root,path));continue;}
  const info=lstatSync(path);if(info.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))throw new Error(`unsupported extracted entry: ${relative(root,path)}`);
  if(entry.isDirectory())visit(path);else{files++;bytes+=info.size;if(files>MAX_FILES||bytes>MAX_BYTES)throw new Error('import exceeds file or byte limit');}
}};visit(root);return caches;}
function roots(root:string):string[]{const found:string[]=[];const visit=(dir:string,depth:number):void=>{if(depth>5)return;
  if(existsSync(join(dir,'Assets'))&&existsSync(join(dir,'ProjectSettings')))found.push(dir);
  for(const entry of readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory()&&!['Library','Temp','Logs','obj','.git'].includes(entry.name))visit(join(dir,entry.name),depth+1);
};visit(root,0);return found;}
function treeHash(root:string):string{const hash=createHash('sha256');const visit=(dir:string):void=>{for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>ordinal(a.name,b.name))){
  const path=join(dir,entry.name),name=relative(root,path).split(sep).join('/');if(unityCache(path,root))continue;if(entry.isDirectory()){hash.update(`d\0${name}\0`);visit(path);}else{hash.update(`f\0${name}\0`);hash.update(readFileSync(path));}}
};visit(root);return hash.digest('hex');}
function archivePaths(source:string):string[]{const output=execFileSync(hostPlatform.toolCommand('7z'),['l','-slt',source],{encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});
  const marker=/^----------$/m.exec(output);const body=marker?output.slice(marker.index+marker[0].length):output;
  return [...body.matchAll(/^Path = (.+)$/gm)].map(match=>match[1]!).filter(name=>name!==source);
}
function extractArchive(source:string,target:string):void{for(const name of archivePaths(source))safeRelative(name);
  mkdirSync(target,{recursive:true});execFileSync(hostPlatform.toolCommand('7z'),['x','-y',`-o${target}`,source],{stdio:'pipe',timeout:600000,maxBuffer:16*1024*1024});validateTree(target);}
function ensureGit(root:string):void{if(existsSync(join(root,'.git')))return;execFileSync(hostPlatform.toolCommand('git'),['init','--quiet',root],{stdio:'pipe',timeout:120000});}
function tarEntries(buffer:Buffer):Map<string,Buffer>{const result=new Map<string,Buffer>();let offset=0,files=0,total=0;
  while(offset+512<=buffer.length){const header=buffer.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
    const text=(start:number,length:number)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
    const rawName=`${text(345,155)}${text(345,155)?'/':''}${text(0,100)}`.replace(/\/+$/,'');if(!rawName||rawName==='.') {offset+=512;continue;}
    const name=safeRelative(rawName),size=parseInt(text(124,12).trim()||'0',8),type=text(156,1)||'0';
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>buffer.length)throw new Error('invalid unitypackage tar entry');
    if(type==='0'||type==='') {files++;total+=size;if(files>MAX_FILES||total>MAX_UNITYPACKAGE)throw new Error('unitypackage exceeds safe limits');result.set(name,Buffer.from(buffer.subarray(offset+512,offset+512+size)));}
    else if(type!=='5')throw new Error(`unsupported unitypackage tar entry type ${type}`);
    offset+=512+Math.ceil(size/512)*512;
  }return result;}
function restoreUnityPackage(source:string,target:string):string[]{const compressed=readFileSync(source);if(compressed.length>MAX_UNITYPACKAGE)throw new Error('unitypackage exceeds safe compressed size');
  const entries=tarEntries(gunzipSync(compressed,{maxOutputLength:MAX_UNITYPACKAGE}));const groups=new Map<string,Map<string,Buffer>>();
  for(const [name,bytes] of entries){const [guid,file,...rest]=name.split('/');if(!guid||!file||rest.length)continue;
    let group=groups.get(guid);if(!group){group=new Map();groups.set(guid,group);}group.set(file,bytes);}
  mkdirSync(join(target,'Assets'),{recursive:true});const warnings:string[]=[];let restored=0;
  for(const [guid,files] of groups){const pathname=files.get('pathname')?.toString('utf8').replace(/\0/g,'').trim();if(!pathname){warnings.push(`${guid}: missing pathname`);continue;}
    const local=safeRelative(pathname);if(!local.startsWith('Assets/')){warnings.push(`${guid}: skipped non-Assets path ${local}`);continue;}
    const asset=files.get('asset');if(asset){const path=join(target,local);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,asset);restored++;}
    const meta=files.get('asset.meta');if(meta){const path=join(target,`${local}.meta`);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,meta);}
  }
  if(!restored)throw new Error('unitypackage contains no restorable Assets');
  mkdirSync(join(target,'Packages'),{recursive:true});mkdirSync(join(target,'ProjectSettings'),{recursive:true});
  writeFileSync(join(target,'Packages','manifest.json'),JSON.stringify({dependencies:{}},null,2)+'\n');
  writeFileSync(join(target,'Packages','vpm-manifest.json'),JSON.stringify({dependencies:{}},null,2)+'\n');
  writeFileSync(join(target,'ProjectSettings','ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\nm_EditorVersionWithRevision: 2022.3.22f1\n');
  warnings.push('UnityPackage 不含完整工程依赖；已建立恢复骨架，必须由 AI 分析后再用 VPM 补包');validateTree(target);return warnings;
}
export function materializeImportSource(sourcePath:string,workspacePath:string,name?:string):MaterializedImport{
  const source=realpathSync(sourcePath),workspace=realpathSync(workspacePath);if(!statSync(workspace).isDirectory())throw new Error('workspace is not a directory');
  if(statSync(source).isDirectory()){
    const caches=validateTree(source,true),warnings:string[]=caches.length?['已保留可编辑源工程；Unity 缓存将在首次打开时重新生成，原目录未修改']:[];
    const direct=roots(source);if(direct.length===1&&hostPlatform.within(workspace,direct[0]!)&&!name)return{source,sourceKind:'folder',sourceHash:treeHash(source),projectPath:direct[0]!,created:false,warnings,candidateRoots:[direct[0]!]};
    const target=targetPath(workspace,name??basename(source));
    let candidates:string[];if(direct.length===1){copyEditableTree(direct[0]!,target);candidates=[target];}
    else {mkdirSync(target,{recursive:true});const payload=join(target,'_Harness','Incoming');mkdirSync(dirname(payload),{recursive:true});copyEditableTree(source,payload);candidates=roots(payload);
      mkdirSync(join(target,'Assets'),{recursive:true});mkdirSync(join(target,'Packages'),{recursive:true});mkdirSync(join(target,'ProjectSettings'),{recursive:true});
      writeFileSync(join(target,'Packages','manifest.json'),'{"dependencies":{}}\n');writeFileSync(join(target,'ProjectSettings','ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
      warnings.push(`输入识别到 ${candidates.length} 个 Unity 工程根；已隔离保存原结构，交由 AI 判断恢复方式`);}
    validateTree(target,true);ensureGit(target);return{source,sourceKind:'folder',sourceHash:treeHash(source),projectPath:target,created:true,warnings,candidateRoots:candidates};
  }
  const target=targetPath(workspace,name??basename(source)),temporary=`${target}.next-${process.pid}`,extension=extname(source).toLowerCase();let warnings:string[]=[];let candidates:string[]=[];
  try{if(extension==='.unitypackage'){warnings=restoreUnityPackage(source,temporary);candidates=[temporary];}else if(['.zip','.7z','.rar','.tar','.gz'].includes(extension)){extractArchive(source,temporary);
    candidates=roots(temporary);if(candidates.length===1&&candidates[0]===temporary){/* already an ordinary project */}
    else {const extracted=join(temporary,'_Harness','Incoming');mkdirSync(dirname(extracted),{recursive:true});for(const entry of readdirSync(temporary))if(entry!=='_Harness')renameSync(join(temporary,entry),join(extracted,entry));
      mkdirSync(join(temporary,'Assets'),{recursive:true});mkdirSync(join(temporary,'Packages'),{recursive:true});mkdirSync(join(temporary,'ProjectSettings'),{recursive:true});
      writeFileSync(join(temporary,'Packages','manifest.json'),'{"dependencies":{}}\n');writeFileSync(join(temporary,'ProjectSettings','ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
      warnings.push(`压缩输入识别到 ${candidates.length} 个 Unity 工程根；已隔离保存原结构，交由 AI 判断恢复方式`);candidates=roots(temporary);}
  }else throw new Error('supported imports: Unity project folder, .zip/.7z/.rar/.tar/.gz, or .unitypackage');
    renameSync(temporary,target);ensureGit(target);
  }catch(error){rmSync(temporary,{recursive:true,force:true});throw error;}
  return{source,sourceKind:extension==='.unitypackage'?'unitypackage':'archive',sourceHash:createHash('sha256').update(readFileSync(source)).digest('hex'),projectPath:target,created:true,warnings,candidateRoots:candidates.map(path=>path.replace(temporary,target))};
}
