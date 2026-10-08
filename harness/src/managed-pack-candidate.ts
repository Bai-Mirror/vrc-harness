import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { knowledgeCheck } from './knowledge-cli.ts';
import type { ManagedPackInfo } from './managed-pack.ts';
import type { LocalConfig } from './config.ts';
import { parseDocument } from 'yaml';
import { loadProcess, sameProcessGates } from './process/load.ts';
import { loadCapabilities, manifestToolReferences } from './workflow/capabilities.ts';
import { copyTreeExact, packTreeHash } from './pack-hash.ts';

const ID = /^[a-zA-Z0-9._-]+$/;
/** A base pack may be a changed bundle installed beside its predecessor: `<id>+<content hash>`. */
const BASE_ID = /^[a-zA-Z0-9._-]+(\+[0-9a-f]{12})?$/;

export type CandidateSource = 'ai' | 'distill' | 'human' | 'import';
export interface CandidateDeclaration {
  basePackId: string;
  sourceKind: CandidateSource;
  sourceRef?: string;
  reason: string;
  impact: Record<string, unknown>;
  permissions: Record<string, unknown>;
}
export interface CandidateRow {
  id: string; basePackId: string; version: string; root: string; contentHash: string; sourceKind: CandidateSource;
  sourceRef: string | null; reason: string; impact: Record<string, unknown>; permissions: Record<string, unknown>;
  status: string; createdAt: string; updatedAt: string;
}
export interface CandidateAuthorityAudit { profiles:string[];commands:number;tools:string[];executables:string[];network:false;
  writeScope:'project-and-run';unknownPermissionKeys:string[] }
export const LOCAL_TRIAL_RESTRICTIONS = Object.freeze({ network: false, globalDefault: false, propagation: false,
  midRunInjection: false, mayChangeAcceptance: false, mayChangePermissions: false, writeScope: 'project-and-run' });
export interface CandidateTrialRow { id:string;candidateId:string;projectId:string;workflowId:string|null;contentHash:string;
  mode:'shadow'|'project';status:'approved'|'active'|'disabled'|'completed';restrictions:typeof LOCAL_TRIAL_RESTRICTIONS;
  approvedBy:string;createdAt:string;activatedAt:string|null;disabledAt:string|null }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function safeId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name} is invalid`);
  return value;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Static least-authority audit before untrusted AI output may enter candidate storage. */
export function auditCandidateAuthority(root:string,permissions:Record<string,unknown>):CandidateAuthorityAudit{
  const known=new Set(['network','writes','globalDefault','propagation','midRunInjection','mayChangeAcceptance','mayChangePermissions']);
  const unknownPermissionKeys=Object.keys(permissions).filter(key=>!known.has(key)).sort();
  if(unknownPermissionKeys.length)throw new Error(`candidate declares unknown permissions: ${unknownPermissionKeys.join(', ')}`);
  if(permissions.network!==undefined&&permissions.network!==false)throw new Error('candidate permission audit rejects network access');
  for(const key of ['globalDefault','propagation','midRunInjection','mayChangeAcceptance','mayChangePermissions'])
    if(permissions[key]!==undefined&&permissions[key]!==false)throw new Error(`candidate permission audit rejects ${key}`);
  const writes=permissions.writes??[];
  if(!Array.isArray(writes)||writes.some(value=>!['project','run'].includes(String(value))))
    throw new Error('candidate permission audit restricts writes to project and run');
  const processRoot=join(root,'knowledge/process'),toolRoot=join(root,'tools');
  const thresholdDoc=parseDocument(readFileSync(join(processRoot,'thresholds.yaml'),'utf8'),{uniqueKeys:true});
  if(thresholdDoc.errors.length)throw new Error(`candidate thresholds invalid: ${thresholdDoc.errors.map(error=>error.message).join('; ')}`);
  const thresholds=object(thresholdDoc.toJS(),'candidate thresholds'),profiles:string[]=[],commands:string[][]=[],tools=new Set<string>();
  const capabilityFiles=readdirSync(processRoot).filter(name=>name.endsWith('.capabilities.yaml')).sort();
  if(!capabilityFiles.length)throw new Error('candidate permission audit found no capability manifests');
  for(const name of capabilityFiles){
    const profile=name.slice(0,-'.capabilities.yaml'.length),processPath=join(processRoot,`${profile}.process.yaml`);
    if(!existsSync(processPath))throw new Error(`candidate capability ${profile} has no matching process`);
    const definition=loadProcess(readFileSync(processPath,'utf8'),thresholds),capabilities=loadCapabilities(readFileSync(join(processRoot,name),'utf8'),definition);
    profiles.push(profile);
    for(const stage of Object.values(capabilities.stages))commands.push(stage.command??[],stage.prepareCommand??[],...Object.values(stage.agentTools??{}));
    for(const observer of Object.values(capabilities.observers))if(observer.kind==='command')commands.push(observer.command);
    for(const path of manifestToolReferences(capabilities)){
      if(path.split(/[\\/]/).includes('..')||isAbsolute(path)||!inside(toolRoot,join(toolRoot,path)))throw new Error(`candidate tool path escapes tools: ${path}`);
      if(!existsSync(join(toolRoot,path))||!statSync(join(toolRoot,path)).isFile())throw new Error(`candidate tool is missing: ${path}`);tools.add(path);
    }
  }
  const active=commands.filter(command=>command.length),allowedExecutables=new Set(['python3','node']),executables=[...new Set(active.map(command=>command[0]!))].sort();
  for(const executable of executables)if(!allowedExecutables.has(executable))throw new Error(`candidate command executable is not allowed: ${executable}`);
  for(const command of active)if(!command.some(argument=>argument.startsWith('{toolRoot}/')))
    throw new Error(`candidate command is not rooted in its tool pack: ${command.join(' ')}`);
  return{profiles,commands:active.length,tools:[...tools].sort(),executables,network:false,writeScope:'project-and-run',unknownPermissionKeys};
}

/** Deterministic identity over names, modes and bytes; symlinks and special files are refused. */
export { copyTreeExact, packTreeHash } from './pack-hash.ts';

function manifest(root: string): ManagedPackInfo {
  const raw = object(JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')), 'pack.json');
  if (raw.schema !== 'harness-managed-pack/0.1') throw new Error('unsupported candidate pack schema');
  const info = { schema: raw.schema, id: safeId(raw.id, 'pack id'), version: nonempty(raw.version, 'pack version'),
    channel: nonempty(raw.channel, 'pack channel'), description: nonempty(raw.description, 'pack description') } as ManagedPackInfo;
  if (info.channel !== 'candidate') throw new Error('candidate pack channel must be candidate');
  return info;
}

/** Ingests an agent-produced directory into immutable candidate storage after structural and knowledge validation. */
export function registerPackCandidate(db: DatabaseSync, home: string, sourceRoot: string, declaration: CandidateDeclaration): CandidateRow {
  const source = realpathSync(sourceRoot);
  if (!statSync(source).isDirectory()) throw new Error('candidate source is not a directory');
  if (typeof declaration.basePackId !== 'string' || !BASE_ID.test(declaration.basePackId)) throw new Error('base pack id is invalid');
  nonempty(declaration.reason, 'reason');
  const info = manifest(source);
  if (info.id === declaration.basePackId) throw new Error('candidate id must not overwrite its base pack');
  if (!existsSync(join(source, 'knowledge/process')) || !existsSync(join(source, 'tools')))
    throw new Error('candidate pack requires knowledge/process and tools directories');
  const knowledgeReport=knowledgeCheck(join(source, 'knowledge/process'));
  if(!/^违规 0 条$/m.test(knowledgeReport))throw new Error(`candidate knowledge is not qualified:\n${knowledgeReport}`);
  const authorityAudit=auditCandidateAuthority(source,declaration.permissions??{});
  const identity = packTreeHash(source);
  const parent = join(home, 'managed', 'candidates'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = join(parent, info.id);
  if (!inside(parent, target)) throw new Error('candidate path escapes managed storage');
  const existing = db.prepare('SELECT content_hash FROM managed_pack_candidate WHERE id = ?').get(info.id) as {content_hash:string}|undefined;
  if (existing) {
    if (existing.content_hash !== identity.hash) throw new Error(`candidate id ${info.id} already names different content`);
    return packCandidate(db, info.id)!;
  }
  if (existsSync(target)) throw new Error(`untracked candidate directory already exists: ${basename(target)}`);
  copyTreeExact(source, target);
  const copied = packTreeHash(target);
  if (copied.hash !== identity.hash) { rmSync(target, { recursive: true, force: true }); throw new Error('candidate changed while being ingested'); }
  db.prepare(`INSERT INTO managed_pack_candidate
    (id,base_pack_id,version,root,content_hash,source_kind,source_ref,reason,impact_json,permissions_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(info.id, declaration.basePackId, info.version, target, identity.hash,
      declaration.sourceKind, declaration.sourceRef ?? null, declaration.reason,
      JSON.stringify({...declaration.impact,authorityAudit}), JSON.stringify(declaration.permissions ?? {}));
  return packCandidate(db, info.id)!;
}

export function packCandidate(db: DatabaseSync, id: string): CandidateRow | undefined {
  const row = db.prepare(`SELECT id,base_pack_id,version,root,content_hash,source_kind,source_ref,reason,impact_json,
    permissions_json,status,created_at,updated_at FROM managed_pack_candidate WHERE id=?`).get(id) as Record<string, unknown>|undefined;
  return row ? { id: String(row.id), basePackId: String(row.base_pack_id), version: String(row.version), root: String(row.root),
    contentHash: String(row.content_hash), sourceKind: row.source_kind as CandidateSource, sourceRef: row.source_ref as string|null,
    reason: String(row.reason), impact: JSON.parse(String(row.impact_json)) as Record<string,unknown>,
    permissions: JSON.parse(String(row.permissions_json)) as Record<string,unknown>, status: String(row.status),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : undefined;
}

export function packCandidates(db: DatabaseSync): CandidateRow[] {
  const ids = db.prepare('SELECT id FROM managed_pack_candidate ORDER BY created_at DESC,id').all() as Array<{id:string}>;
  return ids.map(row => packCandidate(db,row.id)!);
}

function trialRow(row:Record<string,unknown>):CandidateTrialRow {
  return {id:String(row.id),candidateId:String(row.candidate_id),projectId:String(row.project_id),workflowId:row.workflow_id as string|null,
    contentHash:String(row.content_hash),mode:row.mode as 'shadow'|'project',status:row.status as CandidateTrialRow['status'],
    restrictions:JSON.parse(String(row.restrictions_json)) as typeof LOCAL_TRIAL_RESTRICTIONS,approvedBy:String(row.approved_by),
    createdAt:String(row.created_at),activatedAt:row.activated_at as string|null,disabledAt:row.disabled_at as string|null};
}
export function candidateTrials(db:DatabaseSync,projectId?:string):CandidateTrialRow[] {
  const rows=(projectId?db.prepare('SELECT * FROM managed_pack_trial WHERE project_id=? ORDER BY created_at DESC').all(projectId):
    db.prepare('SELECT * FROM managed_pack_trial ORDER BY created_at DESC').all()) as Record<string,unknown>[];
  return rows.map(trialRow);
}
function requestedPrivilege(permissions:Record<string,unknown>):string|undefined {
  if(permissions.network===true)return 'network';
  for(const key of ['globalDefault','propagation','midRunInjection','mayChangeAcceptance','mayChangePermissions'])
    if(permissions[key]===true)return key;
  const writes=permissions.writes;
  if(Array.isArray(writes)&&writes.some(value=>!['project','run'].includes(String(value))))return 'writes';
  return undefined;
}
/** Shared admission check; a candidate cannot grant itself an adoption policy or stronger authority. */
export function validatedLocalCandidate(db:DatabaseSync,candidateId:string) {
  const candidate=packCandidate(db,candidateId);if(!candidate)throw new Error(`unknown candidate ${candidateId}`);
  if(candidate.status!=='evaluated')throw new Error('candidate must complete isolated evaluation before local adoption');
  const evaluation=db.prepare(`SELECT id,status,suite_id AS suiteId,suite_version AS suiteVersion,summary_json FROM managed_pack_evaluation
    WHERE candidate_id=? ORDER BY started_at DESC,id DESC LIMIT 1`).get(candidateId) as
    {id:string;status:string;suiteId:string;suiteVersion:string;summary_json:string}|undefined;
  if(evaluation?.status!=='passed'||JSON.parse(evaluation.summary_json).sameCoverage!==true||!persistedCaseCoverage(db,evaluation.id))
    throw new Error('latest isolated evaluation did not pass with the same coverage');
  const privilege=requestedPrivilege(candidate.permissions);if(privilege)throw new Error(`candidate requests forbidden local-trial privilege: ${privilege}`);
  if(packTreeHash(candidate.root).hash!==candidate.contentHash)throw new Error('candidate content no longer matches its registered hash');
  return {candidate,evaluation};
}
/** Human approval permits a hash-pinned project trial; it never changes the active/global pack. */
export function approveCandidateTrial(db:DatabaseSync,projectId:string,candidateId:string,approvedBy:string,
  mode:'shadow'|'project'='project'):CandidateTrialRow {
  const candidate=packCandidate(db,candidateId);if(!candidate)throw new Error(`unknown candidate ${candidateId}`);
  if(db.prepare("SELECT 1 FROM local_pack_adoption WHERE candidate_id=? AND status='disabled'").get(candidateId))
    throw new Error('candidate was automatically disabled for local reliability regression and cannot be retried unchanged');
  const safetyStop=db.prepare(`SELECT 1 FROM managed_pack_trial t JOIN event e ON e.entity_type='managed_pack_trial' AND e.entity_id=t.id
    AND e.action='auto_disabled' WHERE t.project_id=? AND t.candidate_id=? AND t.status='disabled' LIMIT 1`).get(projectId,candidateId);
  if(safetyStop)throw new Error('candidate was automatically disabled for reliability regression and cannot be retried unchanged');
  if(candidate.status!=='evaluated')throw new Error('candidate must complete isolated evaluation before local trial');
  const evaluation=db.prepare(`SELECT id,status,summary_json FROM managed_pack_evaluation WHERE candidate_id=? ORDER BY started_at DESC,id DESC LIMIT 1`)
    .get(candidateId) as {id:string;status:string;summary_json:string}|undefined;
  const summary=evaluation?JSON.parse(evaluation.summary_json) as {sameCoverage?:boolean}:undefined;
  if(evaluation?.status!=='passed'||summary?.sameCoverage!==true||!persistedCaseCoverage(db,evaluation.id))
    throw new Error('latest isolated evaluation did not pass with the same coverage');
  const privilege=requestedPrivilege(candidate.permissions);if(privilege)throw new Error(`candidate requests forbidden local-trial privilege: ${privilege}`);
  if(packTreeHash(candidate.root).hash!==candidate.contentHash)throw new Error('candidate content no longer matches its registered hash');
  const id=randomUUID();
  db.prepare(`INSERT INTO managed_pack_trial(id,candidate_id,project_id,content_hash,mode,restrictions_json,approved_by)
    VALUES(?,?,?,?,?,?,?)`).run(id,candidateId,projectId,candidate.contentHash,mode,JSON.stringify(LOCAL_TRIAL_RESTRICTIONS),nonempty(approvedBy,'approved by'));
  return candidateTrials(db,projectId).find(row=>row.id===id)!;
}
export function disableCandidateTrial(db:DatabaseSync,id:string):void {
  const result=db.prepare(`UPDATE managed_pack_trial SET status='disabled',disabled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status IN ('approved','active')`).run(id);
  if(!result.changes)throw new Error('open candidate trial not found');
}
export function approvedCandidateTrial(db:DatabaseSync,projectId:string,candidateId:string):CandidateTrialRow {
  if(db.prepare("SELECT 1 FROM local_pack_adoption WHERE candidate_id=? AND status='disabled'").get(candidateId))
    throw new Error('candidate was automatically disabled for local reliability regression and cannot be retried unchanged');
  const row=db.prepare(`SELECT * FROM managed_pack_trial WHERE project_id=? AND candidate_id=? AND status='approved' ORDER BY created_at DESC LIMIT 1`)
    .get(projectId,candidateId) as Record<string,unknown>|undefined;
  if(!row)throw new Error('candidate is not approved for a new workflow in this project');
  const trial=trialRow(row),candidate=packCandidate(db,candidateId);
  if(!candidate||candidate.contentHash!==trial.contentHash||packTreeHash(candidate.root).hash!==trial.contentHash)
    throw new Error('candidate trial hash no longer matches immutable content');
  // Historic summaries compared counts only; new Workflow adoption checks the retained evidence rows.
  const evaluation=db.prepare(`SELECT id,status,summary_json FROM managed_pack_evaluation WHERE candidate_id=? ORDER BY started_at DESC,id DESC LIMIT 1`)
    .get(candidateId) as {id:string;status:string;summary_json:string}|undefined;
  if(evaluation?.status!=='passed'||JSON.parse(evaluation.summary_json).sameCoverage!==true||!persistedCaseCoverage(db,evaluation.id))
    throw new Error('latest isolated evaluation did not pass with the same coverage');
  return trial;
}
export function activateCandidateTrial(db:DatabaseSync,trialId:string,workflowId:string):void {
  const result=db.prepare(`UPDATE managed_pack_trial SET status='active',workflow_id=?,activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='approved'`).run(workflowId,trialId);
  if(!result.changes)throw new Error('candidate trial is no longer approved');
}

function same(value:unknown):string{return JSON.stringify(value);}
function enforceTrialBoundary(base:LocalConfig,candidate:LocalConfig,profile:string):void {
  // A fixed rule string can still be weakened through its threshold table.
  for(const [name,value] of Object.entries(base.thresholdValues))
    if(same(candidate.thresholdValues[name])!==same(value))throw new Error(`candidate trial cannot change acceptance threshold ${name}`);
  const baseline=base.definitions[profile];if(!baseline)throw new Error(`baseline profile is unavailable: ${profile}`);
  const proposed=candidate.definitions[profile]!;
  if(same(proposed.stages.map(stage=>stage.id))!==same(baseline.stages.map(stage=>stage.id)))
    throw new Error('candidate trial cannot add, remove, or reorder workflow stages');
  const proposedChecks=new Map(proposed.checks.map(check=>[check.id,check]));
  for(const check of baseline.checks.filter(item=>item.severity==='blocking')){
    const next=proposedChecks.get(check.id);
    const fields=['observe','on','scope','rule','severity','maturity'] as const;
    if(!next||fields.some(field=>same(next[field])!==same(check[field])))throw new Error(`candidate trial cannot weaken blocking check ${check.id}`);
  }
  if(!sameProcessGates(proposed.gates, baseline.gates))throw new Error('candidate trial cannot change human gates');
  const baselineCapabilities=base.capabilities[profile];if(!baselineCapabilities)throw new Error(`baseline capabilities are unavailable: ${profile}`);
  const proposedCapabilities=candidate.capabilities[profile]!;
  for(const [stageId,stage] of Object.entries(baselineCapabilities.stages)){
    const next=proposedCapabilities.stages[stageId];if(!next||next.mode!==stage.mode)throw new Error(`candidate trial cannot change stage mode ${stageId}`);
    if(next.allowedWrites.some(path=>!stage.allowedWrites.includes(path)))throw new Error(`candidate trial cannot widen writes for ${stageId}`);
    if(next.resources.some(resource=>!stage.resources.includes(resource)))throw new Error(`candidate trial cannot widen resources for ${stageId}`);
    if(next.maxRetries>stage.maxRetries||next.maxCheckRetries>stage.maxCheckRetries)throw new Error(`candidate trial cannot increase retries for ${stageId}`);
  }
}

/** Build an ephemeral config for one Workflow. The caller must never persist it as the global config. */
export function frozenPackConfig(base:LocalConfig,candidate:Pick<CandidateRow,'root'>,profile:string):LocalConfig {
  const knowledgeRoot=join(candidate.root,'knowledge'),toolRoot=join(candidate.root,'tools'),processRoot=join(knowledgeRoot,'process');
  const thresholdsPath=join(processRoot,'thresholds.yaml'),definitionPath=join(processRoot,`${profile}.process.yaml`),
    capabilitiesPath=join(processRoot,`${profile}.capabilities.yaml`);
  const thresholdDoc=parseDocument(readFileSync(thresholdsPath,'utf8'),{uniqueKeys:true});
  if(thresholdDoc.errors.length)throw new Error(`candidate thresholds invalid: ${thresholdDoc.errors.map(error=>error.message).join('; ')}`);
  const thresholds=object(thresholdDoc.toJS(),'candidate thresholds');
  const definition=loadProcess(readFileSync(definitionPath,'utf8'),thresholds);
  const capabilities=loadCapabilities(readFileSync(capabilitiesPath,'utf8'),definition);
  const table=object(thresholds.t,'candidate thresholds.t');
  const thresholdValues=Object.fromEntries(Object.entries(table).map(([name,value])=>[name,object(value,`candidate thresholds.t.${name}`).value])) as LocalConfig['thresholdValues'];
  const result={...base,knowledgeRoot,toolRoot,definitions:{[profile]:definition},capabilities:{[profile]:capabilities},thresholdValues,
    thresholdsVersion:String(thresholds.version),provenanceFiles:{[profile]:{knowledge:[thresholdsPath,definitionPath,capabilitiesPath],interpretation:[]}}};
  return result;
}

/** Candidate trials retain their narrower authority; explicit official successors freeze a reviewed full contract. */
export function candidateTrialConfig(base:LocalConfig,candidate:Pick<CandidateRow,'root'>,profile:string):LocalConfig {
  const result=frozenPackConfig(base,candidate,profile);
  enforceTrialBoundary(base,result,profile);
  return result;
}

export interface CaseResult { caseId:string; modelFamily:string; attempt:number; result:'pass'|'fail'|'error'|'undecidable'; durationMs?:number; evidenceRef:string }
/** Retries and ordering do not change coverage; each family must see the exact same case identities. */
function sameCaseCoverage(baseline:Pick<CaseResult,'caseId'|'modelFamily'>[],candidate:Pick<CaseResult,'caseId'|'modelFamily'>[]):boolean {
  if(!baseline.length||!candidate.length)return false;
  const signature=(results:Pick<CaseResult,'caseId'|'modelFamily'>[])=>{
    const families=new Map<string,Set<string>>();
    for(const result of results){
      const cases=families.get(result.modelFamily)??new Set<string>();cases.add(result.caseId);families.set(result.modelFamily,cases);
    }
    return JSON.stringify([...families.keys()].sort().map(family=>[family,[...families.get(family)!].sort()]));
  };
  return signature(baseline)===signature(candidate);
}
/** Recheck old evaluations without rewriting their historic summary, status, or trial receipts. */
function persistedCaseCoverage(db:DatabaseSync,evaluationId:string):boolean {
  const rows=db.prepare(`SELECT DISTINCT subject,case_id AS caseId,model_family AS modelFamily
    FROM managed_pack_case_result WHERE evaluation_id=?`).all(evaluationId) as Array<{subject:string;caseId:string;modelFamily:string}>;
  return sameCaseCoverage(rows.filter(row=>row.subject==='baseline'),rows.filter(row=>row.subject==='candidate'));
}
interface RateSummary { cases:number;modelFamilies:number;attempts:number;passes:number;passRate:number;firstPassRate:number;secondPassRate:number;
  byFamily:Record<string,{cases:number;firstPassRate:number;secondPassRate:number}> }
function rateSummary(results:CaseResult[]):RateSummary {
  const families=[...new Set(results.map(result=>result.modelFamily))].sort();
  const pairs=[...new Set(results.map(result=>`${result.modelFamily}\0${result.caseId}`))];
  const passBy=(limit:number)=>pairs.filter(pair=>{const [family,caseId]=pair.split('\0');return results.some(result=>result.modelFamily===family&&result.caseId===caseId&&result.attempt<=limit&&result.result==='pass');}).length;
  const byFamily=Object.fromEntries(families.map(family=>{const selected=results.filter(result=>result.modelFamily===family);
    const familyPairs=[...new Set(selected.map(result=>result.caseId))];
    const rate=(limit:number)=>familyPairs.filter(caseId=>selected.some(result=>result.caseId===caseId&&result.attempt<=limit&&result.result==='pass')).length/familyPairs.length;
    return[family,{cases:familyPairs.length,firstPassRate:rate(1),secondPassRate:rate(2)}];}));
  const attempts=results.length,passes=results.filter(result=>result.result==='pass').length;
  return{cases:new Set(results.map(result=>result.caseId)).size,modelFamilies:families.length,attempts,passes,passRate:passes/attempts,
    firstPassRate:passBy(1)/pairs.length,secondPassRate:passBy(2)/pairs.length,byFamily};
}
/**
 * Records results from an isolated runner. Promotion policy consumes these rows; callers cannot claim pass without evidence refs.
 *
 * `status` says whether **this evaluation is usable evidence** -- every case produced a result and both sides cover the
 * same cases -- and not whether the candidate passed them. A candidate that failed every case still records `passed`
 * with `summary.candidate.passes: 0`: that run is exactly what a contribution has to be able to report, and DATA/D4
 * requires an unfixed failure to stay reportable. What decides adoption is the score (`firstPassRate`,
 * `secondPassRate`, `byFamily`) against the policy's thresholds, in `packContributionDecision` and the trial gates.
 * `failed` is reserved for a run that cannot be used at all: a case that errored or was undecidable, or two sides
 * whose case families differ.
 */
export function recordPackEvaluation(db: DatabaseSync, candidateId: string, input: {
  suiteId:string;suiteVersion:string;isolation:'bwrap'|'container'|'process';baselineResults:CaseResult[];results:CaseResult[]
}): {id:string;status:'passed'|'failed';summary:Record<string,unknown>} {
  const candidate=packCandidate(db,candidateId);if(!candidate)throw new Error(`unknown candidate ${candidateId}`);
  if (!input.results.length || !input.baselineResults.length) throw new Error('evaluation requires baseline and candidate case results');
  for (const result of [...input.baselineResults,...input.results]) {
    nonempty(result.caseId,'case id');nonempty(result.modelFamily,'model family');nonempty(result.evidenceRef,'evidence ref');
    if(!Number.isInteger(result.attempt)||result.attempt<1)throw new Error('attempt must be a positive integer');
  }
  const id=randomUUID();const candidateSummary=rateSummary(input.results),baselineSummary=rateSummary(input.baselineResults);
  const sameCoverage=sameCaseCoverage(input.baselineResults,input.results);
  // "passed" here means the run itself is usable, not that the candidate passed its cases: 0 passes is still `passed`.
  const status=input.results.every(result=>result.result!=='error'&&result.result!=='undecidable')&&sameCoverage?'passed':'failed';
  const summary={candidate:candidateSummary,baseline:baselineSummary,sameCoverage,
    delta:{firstPassRate:candidateSummary.firstPassRate-baselineSummary.firstPassRate,secondPassRate:candidateSummary.secondPassRate-baselineSummary.secondPassRate}};
  db.exec('BEGIN IMMEDIATE');try{
    db.prepare(`INSERT INTO managed_pack_evaluation(id,candidate_id,suite_id,suite_version,isolation,status,summary_json,finished_at)
      VALUES(?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id,candidateId,input.suiteId,input.suiteVersion,input.isolation,status,JSON.stringify(summary));
    const insert=db.prepare(`INSERT INTO managed_pack_case_result(evaluation_id,subject,case_id,model_family,attempt,result,duration_ms,evidence_ref)
      VALUES(?,?,?,?,?,?,?,?)`);
    for(const [subject,results] of [['baseline',input.baselineResults],['candidate',input.results]] as const)
      for(const result of results)insert.run(id,subject,result.caseId,result.modelFamily,result.attempt,result.result,result.durationMs??null,result.evidenceRef);
    db.prepare(`UPDATE managed_pack_candidate SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run('evaluated',candidateId);
    db.prepare(`INSERT INTO event(actor,entity_type,entity_id,action,reason,payload_json)
      VALUES('runtime','managed_pack_candidate',?,'evaluated','isolated candidate evaluation completed',?)`).run(candidateId,JSON.stringify({evaluationId:id,status,suiteId:input.suiteId,suiteVersion:input.suiteVersion,isolation:input.isolation,summary}));
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return{id,status,summary};
}

export interface ContributionPolicy { minimumModelFamilies:number;minimumFirstPassRate:number;minimumSecondPassRate:number;allowFamilyRegression:boolean }
/** Local telemetry qualification only. A true result permits contribution packaging, never local adoption. */
export function packContributionDecision(db:DatabaseSync,candidateId:string,policy:ContributionPolicy):{eligible:boolean;reasons:string[];evaluationId?:string;summary?:Record<string,unknown>} {
  const candidate=packCandidate(db,candidateId);if(!candidate)throw new Error(`unknown candidate ${candidateId}`);
  const row=db.prepare(`SELECT id,status,summary_json FROM managed_pack_evaluation WHERE candidate_id=? ORDER BY started_at DESC,id DESC LIMIT 1`).get(candidateId) as
    {id:string;status:string;summary_json:string}|undefined;
  if(!row)return{eligible:false,reasons:['没有隔离评测']};
  const recorded=JSON.parse(row.summary_json) as {candidate:RateSummary;baseline:RateSummary;sameCoverage:boolean};
  const summary={...recorded,sameCoverage:recorded.sameCoverage===true&&persistedCaseCoverage(db,row.id)};const reasons:string[]=[];
  if(row.status!=='passed')reasons.push('评测运行未有效完成');
  if(!summary.sameCoverage)reasons.push('基线与候选的案例或模型家族覆盖不同');
  if(summary.candidate.modelFamilies<policy.minimumModelFamilies)reasons.push(`模型家族不足 ${policy.minimumModelFamilies}`);
  if(summary.candidate.firstPassRate<policy.minimumFirstPassRate)reasons.push('一次通过率低于晋升阈值');
  if(summary.candidate.secondPassRate<policy.minimumSecondPassRate)reasons.push('二次内通过率低于晋升阈值');
  if(summary.candidate.firstPassRate<summary.baseline.firstPassRate)reasons.push('一次通过率相对基线劣化');
  if(summary.candidate.secondPassRate<summary.baseline.secondPassRate)reasons.push('二次内通过率相对基线劣化');
  if(!policy.allowFamilyRegression)for(const [family,result] of Object.entries(summary.candidate.byFamily)){
    const baseline=summary.baseline.byFamily[family];if(baseline&&(result.firstPassRate<baseline.firstPassRate||result.secondPassRate<baseline.secondPassRate))
      reasons.push(`模型家族 ${family} 相对基线劣化`);
  }
  return{eligible:reasons.length===0,reasons,evaluationId:row.id,summary:summary as unknown as Record<string,unknown>};
}
