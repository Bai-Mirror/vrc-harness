import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { recordFacts, storedFacts, type NewFact } from './archive/facts.ts';
import { validAttribute } from './archive/contract.ts';
import { withStateEvent } from './state/tx.ts';

export type IntentUpdate = { object: string; attribute: string; content: string | null;
  sourceMessageId: string; quote: string; replaces?: string };
export type IntentItem = IntentUpdate & { id: string; sourceRevision: number };

export function parseIntentSnapshot(value: unknown): IntentItem[] {
  if (!Array.isArray(value) || value.length>1000) throw new Error('要求快照无效');
  const keys=new Set<string>();
  return value.map(item=>{
    if (!item || typeof item!=='object' || Array.isArray(item)) throw new Error('要求快照条目无效');
    const {id,sourceRevision,...update}=item;
    if (typeof id!=='string' || !id || !Number.isSafeInteger(sourceRevision) || sourceRevision<1) throw new Error('要求快照缺少来源修订');
    const parsed=parseIntentUpdates([update])[0]!;
    const key=`${parsed.object}\0${parsed.attribute}`;
    if(keys.has(key))throw new Error('要求快照包含重复属性');keys.add(key);
    return {...parsed,id,sourceRevision};
  });
}

export function parseIntentUpdates(value: unknown): IntentUpdate[] {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new Error('每次整理需要 1 至 24 条具体要求');
  const keys = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some(k => !['object','attribute','content','sourceMessageId','quote','replaces'].includes(k)) ||
      typeof item.object !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(item.object) ||
      typeof item.attribute !== 'string' || !validAttribute(item.attribute) ||
      !(item.content === null || typeof item.content === 'string' && item.content.trim() && item.content.length <= 2000) ||
      typeof item.sourceMessageId !== 'string' || !item.sourceMessageId ||
      typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 2000 ||
      item.replaces !== undefined && (typeof item.replaces !== 'string' || !item.replaces)) throw new Error('要求解释缺少对象、内容或用户原文依据');
    const key = `${item.object}\0${item.attribute}`;
    if (keys.has(key)) throw new Error('同一次整理不能重复修改同一要求');
    keys.add(key);
    return item as IntentUpdate;
  });
}

/** A projection of the existing fact store, never a second authority or an authorization source. */
export function currentIntent(db: DatabaseSync, projectId: string): IntentItem[] {
  const latest = new Map<string, IntentItem>();
  for (const fact of storedFacts(db, projectId)) {
    if (fact.scope !== 'project-intent' || !fact.objectId.startsWith('intent:')) continue;
    const value = fact.value as Omit<IntentItem,'id'> | null;
    const key = `${fact.objectId}\0${fact.attribute}`;
    if (!value || typeof value.content !== 'string' && value.content !== null) { latest.delete(key); continue; }
    latest.set(key, { ...value, id: fact.id });
  }
  return [...latest.values()];
}

/** AI interpretations require exact user-source quotes and explicit replacement of a newer decision. */
export function recordIntent(db: DatabaseSync, projectId: string, interactionId: string, revision: number, updates: IntentUpdate[]): void {
  withStateEvent(db, { actor:'runtime', entityType:'interaction', entityId:interactionId, action:'intent_updated',
    reason:'保存有用户原文依据的要求解释', payload:{revision,updates} }, () => {
    const request=db.prepare(`SELECT i.revision,s.revision AS currentRevision FROM project_interaction i
      JOIN project_session s ON s.project_id=i.project_id WHERE i.id=? AND i.project_id=?`).get(interactionId,projectId);
    if (!request || request.revision!==revision || request.currentRevision!==revision) throw new Error('要求解释的会话修订已失效');
    const current = currentIntent(db, projectId);
    const facts: NewFact[] = parseIntentUpdates(updates).map(update => {
      const source = db.prepare(`SELECT m.content,i.revision FROM project_message m JOIN project_interaction i ON i.id=m.id
        WHERE m.id=? AND m.project_id=? AND m.role='user'`).get(update.sourceMessageId,projectId);
      if (!source || Number(source.revision)>revision || !String(source.content).includes(update.quote))
        throw new Error('要求解释必须引用本项目已收到的用户原文，不能引用 AI 回复或资料作为用户决定');
      const prior = current.find(item=>item.object===update.object && item.attribute===update.attribute);
      if (prior && (update.replaces!==prior.id || Number(source.revision)<=prior.sourceRevision))
        throw new Error('修改已有要求须引用当前要求及更晚的用户消息；旧意见不能复活');
      if (!prior && update.replaces) throw new Error('被替代的要求不存在');
      return {objectId:`intent:${update.object}`,attribute:update.attribute,
        value:{...update,sourceRevision:Number(source.revision)},source:{type:'harness_scan',ref:`project_message:${update.sourceMessageId}`},
        observer:'coordinator-intent/1',status:'inferred',evidenceLevel:'inference',scope:'project-intent',shareLayer:'excluded',
        inputFingerprint:createHash('sha256').update(String(source.content)).digest('hex'),supersedes:prior?.id??null};
    });
    recordFacts(db,projectId,facts);
  });
}
