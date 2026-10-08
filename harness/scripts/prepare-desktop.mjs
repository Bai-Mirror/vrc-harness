import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedPackFiles } from './build-lib.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))), target=join(root,'desktop-resources');
rmSync(target,{recursive:true,force:true});mkdirSync(target,{recursive:true});
for(const name of ['bin','dist'])cpSync(join(root,name),join(target,name),{recursive:true});
for(const path of shippedPackFiles(root)){
  const destination=join(target,path);mkdirSync(dirname(destination),{recursive:true});
  copyFileSync(join(root,path),destination);chmodSync(destination,statSync(join(root,path)).mode&0o777);
}
for(const name of ['package.json','package-lock.json','README.md','LICENSE','LICENSE-docs.md','NOTICE.md'])copyFileSync(join(root,name),join(target,name));
cpSync(join(root,'docs'),join(target,'docs'),{recursive:true});
// The desktop bundle carries only production JS dependencies plus the exact Node runtime that passed the release check.
const pkg=JSON.parse(readFileSync(join(target,'package.json'),'utf8'));delete pkg.scripts;pkg.private=true;
writeFileSync(join(target,'package.json'),JSON.stringify(pkg,null,2)+'\n');
execFileSync(process.platform==='win32'?'npm.cmd':'npm',['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],
  {cwd:target,stdio:'inherit',shell:process.platform==='win32'});
// src-tauri/src/main.rs starts runtime/node, which is runtime\node.exe on Windows.
const node=join(target,'runtime',process.platform==='win32'?'node.exe':'node');
mkdirSync(join(target,'runtime'));copyFileSync(process.execPath,node);chmodSync(node,0o755);
console.error(`prepared Tauri resources with ${process.version}`);
