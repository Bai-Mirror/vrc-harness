import type {DatabaseSync} from 'node:sqlite';

/** Runtime-owned portable receipt bytes, reconstructed from the persisted restore report. */
export function restoreRecordContent(restoreId:string, fixed:Record<string,unknown>):string {
  const record={schema:'harness-restore-record/1',restoreId,shareId:fixed.shareId,archive:fixed.archive,name:fixed.name,
    createdAt:fixed.createdAt,producer:fixed.producer,level:fixed.level,levelReasons:fixed.levelReasons,selection:fixed.selection,
    decision:fixed.decision,counts:fixed.counts,missing:fixed.missing,packs:fixed.packs,projectPacks:fixed.projectPacks};
  return `${JSON.stringify(record,null,2)}\n`;
}

export function restoreRecordFiles(db:DatabaseSync,projectId:string):Array<{path:string;content:string}> {
  return db.prepare('SELECT id,report_json FROM project_restore WHERE project_id=?').all(projectId).map(row=>({
    path:`_harness/share/restore-${String(row.id).slice(0,8)}.json`,
    content:restoreRecordContent(String(row.id),JSON.parse(String(row.report_json))),
  }));
}
