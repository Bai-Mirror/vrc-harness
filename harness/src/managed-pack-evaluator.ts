import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hostPlatform } from './host-platform.ts';
import { packCandidate, packTreeHash, recordPackEvaluation, type CaseResult } from './managed-pack-candidate.ts';
import { runCheckCommand } from './exec/check-runner.ts';
import { bundledPackRoot } from './managed-pack.ts';

interface EvaluationCase { id:string;modelFamily:string;attempts:number;command:string[];timeoutMs:number }
interface EvaluationSuite { schema:'harness-pack-evaluation/0.1';id:string;version:string;cases:EvaluationCase[] }
const ID=/^[A-Za-z0-9._-]+$/;
function inside(root:string,path:string):boolean {const item=relative(resolve(root),resolve(path));return item===''||(!item.startsWith(`..${sep}`)&&item!=='..'&&!isAbsolute(item));}
function suite(root:string):EvaluationSuite {
  const path=join(root,'suite.json'),raw=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
  if(raw.schema!=='harness-pack-evaluation/0.1'||typeof raw.id!=='string'||!ID.test(raw.id)||typeof raw.version!=='string'||!raw.version)
    throw new Error('invalid evaluation suite identity');
  if(!Array.isArray(raw.cases)||!raw.cases.length)throw new Error('evaluation suite requires cases');
  const ids=new Set<string>();
  const cases=raw.cases.map((value,index)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`cases[${index}] must be an object`);
    const item=value as Record<string,unknown>,id=String(item.id??''),modelFamily=String(item.modelFamily??'');
    if(!ID.test(id)||ids.has(id))throw new Error(`cases[${index}].id is invalid or duplicated`);ids.add(id);
    if(!modelFamily.trim())throw new Error(`cases[${index}].modelFamily is required`);
    const attempts=item.attempts??2,timeoutMs=item.timeoutMs??60_000;
    if(!Number.isInteger(attempts)||Number(attempts)<1||Number(attempts)>5)throw new Error(`cases[${index}].attempts must be 1..5`);
    if(!Number.isInteger(timeoutMs)||Number(timeoutMs)<100||Number(timeoutMs)>3_600_000)throw new Error(`cases[${index}].timeoutMs is invalid`);
    if(!Array.isArray(item.command)||!item.command.length||item.command.some(part=>typeof part!=='string'||!part))
      throw new Error(`cases[${index}].command must be nonempty strings`);
    return{id,modelFamily,attempts:Number(attempts),timeoutMs:Number(timeoutMs),command:item.command as string[]};
  });
  return{schema:raw.schema,id:raw.id,version:raw.version,cases};
}
function baselineRoot(db:DatabaseSync,home:string,id:string):string {
  if(!ID.test(id))throw new Error('invalid base pack id');
  const root=join(home,'managed','packs',id);
  if(!inside(join(home,'managed','packs'),root)||!existsSync(join(root,'pack.json')))throw new Error(`base pack is not installed: ${id}`);
  const manifest=JSON.parse(readFileSync(join(root,'pack.json'),'utf8')) as {id?:string;channel?:string};
  if(manifest.id!==id)throw new Error('base pack manifest does not match its directory');
  if(manifest.channel!=='builtin'){
    const release=db.prepare(`SELECT content_hash FROM managed_pack_release WHERE pack_id=? AND status IN ('installed','active','rolled_back')`).get(id) as {content_hash:string}|undefined;
    if(!release||packTreeHash(root).hash!==release.content_hash)throw new Error('base pack is not a verified signed release');
  }
  return root;
}
function resultFrom(stdout:string,status:number|null,timedOut:boolean):CaseResult['result'] {
  if(timedOut||status===null)return'error';
  try {const lines=stdout.trim().split('\n');const value=JSON.parse(lines.at(-1)??'') as {result?:unknown};
    if(['pass','fail','error','undecidable'].includes(String(value.result)))return String(value.result) as CaseResult['result'];
  } catch { /* command exit remains authoritative fallback */ }
  return status===0?'pass':'fail';
}

/** Runs a trusted suite against baseline and candidate with no network and read-only packs, then records owned evidence. */
export async function evaluatePackCandidate(db:DatabaseSync,home:string,candidateId:string,suiteRoot:string,
  options:{allowProcessFallback?:boolean}={}):Promise<ReturnType<typeof recordPackEvaluation>> {
  const candidate=packCandidate(db,candidateId);if(!candidate)throw new Error(`unknown candidate ${candidateId}`);
  const definition=suite(suiteRoot),baseline=baselineRoot(db,home,candidate.basePackId);
  const claimed=db.prepare("UPDATE managed_pack_candidate SET status='evaluating',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status<>'evaluating'").run(candidateId);
  if(!claimed.changes)throw new Error('candidate evaluation is already running');
  const runId=randomUUID(),runDirectory=join(home,'evaluations',runId);hostPlatform.mkdirPrivate(runDirectory);
  const usedIsolation=new Set<'bwrap'|'lowil'|'none'>();
  const execute=async(subject:'baseline'|'candidate',packRoot:string):Promise<CaseResult[]>=>{
    const results:CaseResult[]=[];
    for(const test of definition.cases)for(let attempt=1;attempt<=test.attempts;attempt++){
      const argv=test.command.map(part=>part.replaceAll('{pack}',packRoot).replaceAll('{suite}',suiteRoot)
        .replaceAll('{subject}',subject).replaceAll('{attempt}',String(attempt)));
      const checkId=`${subject}-${test.id}-${attempt}`;
      const run=await runCheckCommand(argv,{project:suiteRoot,runDirectory,checkId,timeoutMs:test.timeoutMs,
        readonly:[suiteRoot,baseline,candidate.root],isolation:options.allowProcessFallback?'auto':'bwrap',harnessHome:home});
      usedIsolation.add(run.isolation);
      const result=resultFrom(run.stdout,run.status,run.timedOut),evidenceFile=join(runDirectory,`${checkId}.json`);
      writeFileSync(evidenceFile,JSON.stringify({schema:'harness-pack-evidence/0.1',suiteId:definition.id,suiteVersion:definition.version,
        candidateId,subject,caseId:test.id,modelFamily:test.modelFamily,attempt,result,durationMs:run.durationMs,
        isolation:run.isolation,status:run.status,timedOut:run.timedOut,stdout:run.stdout,stderr:run.stderr},null,2),{mode:0o600});
      results.push({caseId:test.id,modelFamily:test.modelFamily,attempt,result,durationMs:run.durationMs,
        evidenceRef:relative(home,evidenceFile).split(sep).join('/')});
      if(result==='pass')break;
    }
    return results;
  };
  try{
    const baselineResults=await execute('baseline',baseline),results=await execute('candidate',candidate.root);
    // The column knows bwrap, container and process; the Windows Low integrity sandbox is recorded as process isolation,
    // and each evidence file keeps the exact kind.
    const isolation=usedIsolation.has('none')||usedIsolation.has('lowil')?'process':'bwrap';
    return recordPackEvaluation(db,candidateId,{suiteId:definition.id,suiteVersion:definition.version,isolation,baselineResults,results});
  }catch(error){
    db.prepare("UPDATE managed_pack_candidate SET status='failed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='evaluating'").run(candidateId);
    throw error;
  }
}

export function defaultEvaluationSuiteRoot():string {
  const root=bundledPackRoot();if(!root)throw new Error('installed Harness has no bundled evaluation suite');
  const suiteRoot=join(root,'evaluation','smoke');
  if(!existsSync(join(suiteRoot,'suite.json')))throw new Error('installed Harness has no bundled evaluation suite');
  return suiteRoot;
}
