// server/sh-created.ts
/**
 * Local marker store: which Azure DevOps work items did sprintomatic itself
 * create? (R12 Thread 2.)
 *
 * Used so the dashboard can show a discreet "SH" pip on items the MCP made
 * via `task_create` / `story_create`. Nothing goes to ADO — invisible to
 * anyone else viewing the board. If `~/.sprintomatic/data.db` is wiped,
 * the markers are gone; that's acceptable (the data lives on the user's laptop
 * already alongside timers, sessions, helper notes).
 */
import { getDb } from './db';

export type SHCreatedKind = 'task' | 'story' | 'feature';

/** Insert a marker. Idempotent (PRIMARY KEY on work_item_id). */
export function markSHCreated(workItemId: number, kind: SHCreatedKind): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sh_created_items (work_item_id, kind, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(workItemId, kind, new Date().toISOString());
}

/** Returns the IDs sprintomatic created, optionally filtered by kind. */
export function getSHCreatedIdSet(opts: { kind?: SHCreatedKind } = {}): Set<number> {
  const db = getDb();
  const rows = opts.kind
    ? db
        .prepare<[string], { work_item_id: number }>(
          `SELECT work_item_id FROM sh_created_items WHERE kind = ?`,
        )
        .all(opts.kind)
    : db
        .prepare<[], { work_item_id: number }>(
          `SELECT work_item_id FROM sh_created_items`,
        )
        .all();
  return new Set(rows.map(r => r.work_item_id));
}
