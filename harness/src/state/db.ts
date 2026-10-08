import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  { version: 1, file: new URL('./migrations/0001_init.sql', import.meta.url) },
  { version: 2, file: new URL('./migrations/0002_task_proofs.sql', import.meta.url) },
  { version: 3, file: new URL('./migrations/0003_lock_epoch.sql', import.meta.url) },
  { version: 4, file: new URL('./migrations/0004_import_report.sql', import.meta.url) },
  { version: 5, file: new URL('./migrations/0005_provider_snapshot.sql', import.meta.url) },
  { version: 6, file: new URL('./migrations/0006_outbox_closed.sql', import.meta.url) },
  { version: 7, file: new URL('./migrations/0007_scheduler_lease.sql', import.meta.url) },
  { version: 8, file: new URL('./migrations/0008_formal_workflow.sql', import.meta.url) },
  { version: 9, file: new URL('./migrations/0009_product_catalog.sql', import.meta.url) },
  { version: 10, file: new URL('./migrations/0010_project_assets.sql', import.meta.url) },
  { version: 11, file: new URL('./migrations/0011_project_variants.sql', import.meta.url) },
  { version: 12, file: new URL('./migrations/0012_workflow_context.sql', import.meta.url) },
  { version: 13, file: new URL('./migrations/0013_workflow_pack.sql', import.meta.url) },
  { version: 14, file: new URL('./migrations/0014_workflow_variables.sql', import.meta.url) },
  { version: 15, file: new URL('./migrations/0015_booth_jit_assets.sql', import.meta.url) },
  { version: 16, file: new URL('./migrations/0016_managed_pack_lifecycle.sql', import.meta.url) },
  { version: 17, file: new URL('./migrations/0017_candidate_trials.sql', import.meta.url) },
  { version: 18, file: new URL('./migrations/0018_candidate_authoring.sql', import.meta.url) },
  { version: 19, file: new URL('./migrations/0019_contribution_queue.sql', import.meta.url) },
  { version: 20, file: new URL('./migrations/0020_contribution_receipts.sql', import.meta.url) },
  { version: 21, file: new URL('./migrations/0021_project_recovery.sql', import.meta.url) },
  { version: 22, file: new URL('./migrations/0022_project_archive.sql', import.meta.url) },
  { version: 23, file: new URL('./migrations/0023_project_share.sql', import.meta.url) },
  { version: 24, file: new URL('./migrations/0024_asset_catalog.sql', import.meta.url) },
  { version: 25, file: new URL('./migrations/0025_booth_version_pool.sql', import.meta.url) },
  { version: 26, file: new URL('./migrations/0026_contribution_sharing.sql', import.meta.url) },
  { version: 27, file: new URL('./migrations/0027_project_interactions.sql', import.meta.url) },
  { version: 28, file: new URL('./migrations/0028_production_proposals.sql', import.meta.url) },
  { version: 29, file: new URL('./migrations/0029_project_exploration.sql', import.meta.url) },
  { version: 30, file: new URL('./migrations/0030_gate_selection.sql', import.meta.url) },
  { version: 31, file: new URL('./migrations/0031_local_maintenance.sql', import.meta.url) },
  { version: 32, file: new URL('./migrations/0032_manual_face.sql', import.meta.url) },
  { version: 33, file: new URL('./migrations/0033_manual_preparation.sql', import.meta.url) },
  { version: 34, file: new URL('./migrations/0034_contribution_acceptance.sql', import.meta.url) },
  { version: 35, file: new URL('./migrations/0035_workflow_inputs.sql', import.meta.url) },
  { version: 36, file: new URL('./migrations/0036_production_continuation.sql', import.meta.url) },
  { version: 37, file: new URL('./migrations/0037_production_rebuild.sql', import.meta.url) },
  { version: 38, file: new URL('./migrations/0038_archived_preparation.sql', import.meta.url) },
];
/** Highest schema version this Runtime can open. */
export const SCHEMA_VERSION = Math.max(...migrations.map(migration => migration.version));

/** Open a state database and apply each pending migration atomically. Caller closes it. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    // Applied versions, not just the highest: migrations numbered on parallel branches may land out of order.
    const applied = new Set((db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>).map(row => row.version));
    // A database a newer Runtime migrated is refused, whether its extra migration comes after this one's last or fills a gap.
    const unknown = [...applied].filter(version => !migrations.some(migration => migration.version === version));
    if (unknown.length) throw new Error(`Unsupported schema version ${Math.max(...unknown)}`);
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(readFileSync(migration.file, 'utf8'));
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
