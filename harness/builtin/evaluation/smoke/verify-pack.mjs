import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root=process.argv[2];
const failures=[];
let manifest;
try{manifest=JSON.parse(readFileSync(join(root,'pack.json'),'utf8'));}catch{failures.push('pack.json unreadable');}
if(manifest?.schema!=='harness-managed-pack/0.1')failures.push('pack schema');
for(const path of ['knowledge/process/thresholds.yaml','tools'])if(!existsSync(join(root,path)))failures.push(path);
const processRoot=join(root,'knowledge/process');
if(!existsSync(processRoot)||!readdirSync(processRoot).some(name=>name.endsWith('.process.yaml')))failures.push('process definition');
if(!existsSync(processRoot)||!readdirSync(processRoot).some(name=>name.endsWith('.capabilities.yaml')))failures.push('capability manifest');
process.stdout.write(JSON.stringify({result:failures.length?'fail':'pass',failures})+'\n');
process.exitCode=failures.length?1:0;
