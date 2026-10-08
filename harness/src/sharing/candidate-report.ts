import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { validateCandidateReport, type CandidateReport } from '../shared/candidate-report.ts';
import { packCandidate, packTreeHash } from '../managed-pack-candidate.ts';

/** Reception reports observations, including unsuccessful or single-family evaluations; it is never publication approval. */
export function candidateReportDecision(db:DatabaseSync,candidateId:string):{eligible:boolean;reasons:string[];evaluationId?:string}{
  const candidate=packCandidate(db,candidateId);if(!candidate)return{eligible:false,reasons:['找不到候选']};
  const evaluation=db.prepare('SELECT id,status FROM managed_pack_evaluation WHERE candidate_id=? ORDER BY started_at DESC,id DESC LIMIT 1').get(candidateId);
  if(!evaluation||!['passed','failed'].includes(String(evaluation.status)))return{eligible:false,reasons:['先完成一次隔离评测；失败和低分结果也可报告']};
  if(packTreeHash(candidate.root).hash!==candidate.contentHash)return{eligible:false,reasons:['候选内容已变化，请重新观察当前版本']};
  return{eligible:true,reasons:[],evaluationId:String(evaluation.id)};
}
type Summary={attempts:number;passes:number;failures:number;cases:number;modelFamilies:number;firstPassRate:number|null;secondPassRate:number|null};
/** Project words, paths, case IDs, model strings, original pack bytes and credentials never enter this projection. */
export function projectCandidateReport(db:DatabaseSync,candidateId:string,evaluationId:string):CandidateReport{
  const source=packCandidate(db,candidateId);if(!source)throw new Error('找不到候选');
  const evaluation=db.prepare('SELECT status FROM managed_pack_evaluation WHERE id=? AND candidate_id=?').get(evaluationId,candidateId);
  if(!evaluation||!['passed','failed'].includes(String(evaluation.status)))throw new Error('评测尚未结束');
  const rows=db.prepare('SELECT subject,case_id,model_family,attempt,result FROM managed_pack_case_result WHERE evaluation_id=?').all(evaluationId);
  const summarize=(subject:string):Summary=>{
    const selected=rows.filter(row=>row.subject===subject),pairs=new Set(selected.map(row=>JSON.stringify([row.case_id,row.model_family])));
    const pass=(limit:number)=>new Set(selected.filter(row=>row.result==='pass'&&Number(row.attempt)<=limit).map(row=>JSON.stringify([row.case_id,row.model_family]))).size;
    return{attempts:selected.length,passes:selected.filter(row=>row.result==='pass').length,failures:selected.filter(row=>row.result!=='pass').length,
      cases:new Set(selected.map(row=>row.case_id)).size,modelFamilies:new Set(selected.map(row=>row.model_family)).size,
      firstPassRate:pairs.size?pass(1)/pairs.size:null,secondPassRate:pairs.size?pass(2)/pairs.size:null};
  };
  return{schema:'harness-candidate-observation/0.1',category:'candidate-evaluation',purpose:'product-improvement',
    sourceKind:['ai','distill','human','import'].includes(source.sourceKind)?source.sourceKind:'unknown',
    evaluation:{status:evaluation.status as 'passed'|'failed',baseline:summarize('baseline'),candidate:summarize('candidate')}};
}
/** Revalidate the complete outgoing tree and every projected field, rather than trusting privacy:false or a hash. */
export function verifyCandidateReportTree(root:string):CandidateReport{
  if(lstatSync(root).isSymbolicLink()||readdirSync(root).sort().join(',')!=='candidate-report.json')throw new Error('贡献载荷包含报告之外的文件');
  const path=join(root,'candidate-report.json');if(!existsSync(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||lstatSync(path).size>64*1024)throw new Error('技术报告文件无效');
  return validateCandidateReport(JSON.parse(readFileSync(path,'utf8')));
}
