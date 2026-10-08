import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface StateEvent {
  workflowId?: string | null;
  actor: string;
  entityType: string;
  entityId: string;
  action: string;
  reason: string;
  payload?: unknown;
}

/** State writes should use this helper so their event commits in the same transaction. */
export function withStateEvent<T>(db: DatabaseSync, event: StateEvent, change: () => T): T {
  const savepoint = db.isTransaction ? `event_${randomUUID().replaceAll('-', '')}` : undefined;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = change();
    db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      event.workflowId ?? null,
      event.actor,
      event.entityType,
      event.entityId,
      event.action,
      event.reason,
      JSON.stringify(event.payload ?? {}),
    );
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (savepoint) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
    else db.exec('ROLLBACK');
    throw error;
  }
}

/** Record an event only when the entity's latest event differs; the check and insert share one transaction. */
export function recordEventOnce(db: DatabaseSync, event: StateEvent): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const last = db.prepare(`SELECT action, reason FROM event WHERE entity_type = ? AND entity_id = ?
      ORDER BY seq DESC LIMIT 1`).get(event.entityType, event.entityId) as { action: string; reason: string } | undefined;
    const write = last?.action !== event.action || last.reason !== event.reason;
    if (write) db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.workflowId ?? null, event.actor, event.entityType, event.entityId,
      event.action, event.reason, JSON.stringify(event.payload ?? {}));
    db.exec('COMMIT');
    return write;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
