import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Consent is revoked before filesystem cleanup: a failed cleanup can never leave an upload-authorized item. */
export function cancelPendingContributions(db: DatabaseSync, home?: string, selection?: { ids: string[]; reason: string }): void {
  if(selection&&!selection.ids.length)return;
  const selected=selection?` AND id IN (${selection.ids.map(()=>'?').join(',')})`:'';
  const rows=db.prepare(`SELECT id,bundle_path,status FROM managed_pack_contribution WHERE (status IN ('authorized','exported','failed') OR (status='cancelled' AND error IS NOT NULL))${selected}`).all(...(selection?.ids??[]));
  db.prepare(`UPDATE managed_pack_contribution SET status='cancelled',error='授权已撤销，待清理本地载荷',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('authorized','exported','failed')${selected}`).run(...(selection?.ids??[]));
  if(selection)for(const row of rows)if(row.status!=='cancelled')
    db.prepare("INSERT INTO event(actor,entity_type,entity_id,action,reason) VALUES('runtime','contribution',?,'contribution_queue_pruned',?)").run(row.id!,selection.reason);
  let incomplete=false;
  for(const row of rows){
    try{
      if(!home||!/^[-a-f0-9]{36}$/.test(String(row.id)))throw new Error('无法核对本地贡献目录');
      const base=resolve(home,'contributions'),target=resolve(String(row.bundle_path));
      if(target!==join(base,String(row.id)))throw new Error('载荷路径不属于当前安装');
      for(let current=target;;current=dirname(current)){
        if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('载荷路径包含链接');
        if(dirname(current)===current)break;
      }
      rmSync(target,{recursive:true,force:true});
      db.prepare("UPDATE managed_pack_contribution SET error=NULL WHERE id=? AND status='cancelled'").run(row.id!);
    }catch(error){incomplete=true;db.prepare("UPDATE managed_pack_contribution SET error=? WHERE id=? AND status='cancelled'").run(`回传已停止；本地载荷清理未完成：${(error as Error).message}`,row.id!);}
  }
  if(incomplete)throw new Error('回传已停止、旧授权已撤销；部分本地贡献载荷清理未完成，请重试停止并撤回。');
}
