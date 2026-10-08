import type { DatabaseSync } from 'node:sqlite';
import { diagnoseContext, readContextSamples, type ContextDiagnostic } from './context-diagnostics.ts';

export interface TrialSafetyAction {trialId:string;candidateId:string;workflowId:string;diagnostics:ContextDiagnostic[]}

/** Critical telemetry stops future local adoption or the affected trial; official releases remain separately signed. */
export function enforceCandidateTrialSafety(db:DatabaseSync):TrialSafetyAction[]{
  // Stop future adoption only; neither rollback nor a healthy base pack repairs an existing project.
  const adopted=db.prepare(`SELECT a.id,w.id AS workflowId FROM local_pack_adoption a JOIN event e
    ON e.entity_type='workflow' AND e.action='created' AND json_extract(e.payload_json,'$.localAdoption.adoptionId')=a.id
    JOIN workflow w ON w.id=e.workflow_id WHERE a.status='active' AND a.candidate_id IS NOT NULL`).all() as Array<{id:string;workflowId:string}>;
  for(const row of adopted){
    const critical=diagnoseContext(readContextSamples(db,row.workflowId)).filter(item=>item.severity==='critical');
    if(!critical.length)continue;
    db.exec('BEGIN IMMEDIATE');try{
      const changed=db.prepare("UPDATE local_pack_adoption SET status='disabled',reason='观察到严重可靠性退化，停止后继采用；现有工程仍需恢复' WHERE id=? AND status='active'").run(row.id);
      if(changed.changes)db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
        VALUES(?,'runtime','local_pack_adoption',?,'auto_disabled','local reliability regression; existing project still needs recovery',?)`)
        .run(row.workflowId,row.id,JSON.stringify({diagnostics:critical}));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  const trials=db.prepare(`SELECT id,candidate_id AS candidateId,workflow_id AS workflowId FROM managed_pack_trial
    WHERE status='active' AND workflow_id IS NOT NULL ORDER BY created_at`).all() as Array<{id:string;candidateId:string;workflowId:string}>;
  const actions:TrialSafetyAction[]=[];
  for(const trial of trials){
    const critical=diagnoseContext(readContextSamples(db,trial.workflowId)).filter(item=>item.severity==='critical');
    if(!critical.length)continue;
    db.exec('BEGIN IMMEDIATE');try{
      const changed=db.prepare(`UPDATE managed_pack_trial SET status='disabled',disabled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='active'`).run(trial.id);
      if(changed.changes)db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
        VALUES(?,'runtime','managed_pack_trial',?,'auto_disabled','critical context reliability regression',?)`)
        .run(trial.workflowId,trial.id,JSON.stringify({schema:'candidate-safety/0.1',candidateId:trial.candidateId,diagnostics:critical}));
      db.exec('COMMIT');if(changed.changes)actions.push({trialId:trial.id,candidateId:trial.candidateId,workflowId:trial.workflowId,diagnostics:critical});
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return actions;
}
