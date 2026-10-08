import type {DatabaseSync} from 'node:sqlite';
import type {WorkflowSnapshot} from './runtime.ts';
import {workflowSnapshot} from './runtime.ts';
import {selectedStageContract} from './stage-contract.ts';
import {toolReferences} from './capabilities.ts';
import {canonicalJson} from '../pack-hash.ts';
import {inputSha256} from './inputs.ts';
import type {Verdict,GateDecision,WarningAcceptance} from '../process/types.ts';

/** The contract that actually validates an unchanged approved preparation artifact. */
export function preparationEvidenceContract(snapshot:WorkflowSnapshot,stageId:string) {
  const stage=snapshot.definition.stages.find(s=>s.id===stageId);
  if(!stage)return null;
  const checks=snapshot.definition.checks.filter(c=>stage.requires.includes(c.id));
  const observers=Object.fromEntries(checks.map(c=>[c.observe,snapshot.capabilities.observers[c.observe]]));
  const references=[...new Set(Object.values(observers).flatMap(o=>o?.kind==='command'?toolReferences(o.command):[]))];
  const thresholds=[...new Set(checks.flatMap(c=>[...c.rule.matchAll(/\bt\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m=>m[1]!)))];
  return {stage,checks,gates:snapshot.definition.gates.filter(g=>stage.gates.includes(g.id)),observers,
    artifacts:Object.fromEntries([...new Set([...stage.produces,...stage.invalidated_by])].map(k=>[k,snapshot.capabilities.artifacts[k]])),
    tools:Object.fromEntries(references.map(p=>[p,snapshot.tools[p]])),thresholds:Object.fromEntries(thresholds.map(k=>[k,snapshot.thresholds[k]]))};
}
export function workflowPreparationContract(db:DatabaseSync,workflowId:string,stageId:string,runId?:string) {
  return preparationEvidenceContract(selectedStageContract(db,workflowSnapshot(db,workflowId),stageId,runId).snapshot,stageId);
}
export interface ArchivedPreparationProof {
  schema:'production-preparation-evidence/1';stageId:string;sourceWorkflowId:string;sourceCompletionSeq:number;
  sourceRunId:string;contract:unknown;artifactHashes:Record<string,string>;outputHashes:Record<string,string>;
  verdicts:Verdict[];gates:GateDecision[];warningAcceptances:WarningAcceptance[];
}
export function validArchivedPreparation(db:DatabaseSync,workflowId:string,proof:ArchivedPreparationProof,sha:string,hashes:Record<string,string>):boolean {
  if(!['intake','plan','environment','setup'].includes(proof.stageId)||!proof.sourceRunId||inputSha256(canonicalJson(proof))!==sha)return false;
  if(canonicalJson(workflowPreparationContract(db,workflowId,proof.stageId))!==canonicalJson(proof.contract))return false;
  const stage=workflowSnapshot(db,workflowId).definition.stages.find(s=>s.id===proof.stageId)!;
  return stage.invalidated_by.every(k=>Boolean(hashes[k])&&hashes[k]===proof.artifactHashes[k])
    &&stage.produces.every(k=>Boolean(hashes[k])&&hashes[k]===proof.outputHashes[k]);
}
