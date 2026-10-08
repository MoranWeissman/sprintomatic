/**
 * One-shot cleanup for the timer-entry drift the user caught 2026-06-02.
 *
 * Two corrections, both idempotent:
 *   1. Any time_entry with `ended_at IS NULL` that has NO open session
 *      for the same work item is a leaked timer (session ended without
 *      pause firing, or pause itself was missed). Force-end it at the
 *      session_end timestamp if one exists, otherwise at the session's
 *      latest event, otherwise at started_at + 5min (worst case: assume
 *      a brief blip, not a 5-day ghost).
 *   2. Any closed time_entry with `synced_to_ado = 0` gets flipped to
 *      synced. The new model: once a session ends, its silent time is
 *      accounted for via the burndown — localUncapturedSeconds is only
 *      meaningful for currently-running timers.
 *
 * Prints a before/after summary.
 */
import { getDb } from '../server/db';

interface TimeEntry {
  id: number;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
  synced_to_ado: number;
}

function main() {
  const db = getDb();
  const before = db.prepare<[], { running: number; unsynced: number }>(
    `SELECT
       SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN ended_at IS NOT NULL AND synced_to_ado = 0 THEN 1 ELSE 0 END) AS unsynced
     FROM time_entries`,
  ).get();
  console.log('Before:', before);

  // 1. Find timer rows that look leaked: ended_at IS NULL but no open session.
  const leaked = db.prepare<[], TimeEntry>(
    `SELECT t.id, t.work_item_id, t.started_at, t.ended_at, t.synced_to_ado
       FROM time_entries t
       WHERE t.ended_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM sessions s
            WHERE s.work_item_id = t.work_item_id
              AND s.ended_at IS NULL
         )`,
  ).all();

  console.log(`\nLeaked timers (running rows with no live session): ${leaked.length}`);
  for (const r of leaked) {
    // Pick the best closing timestamp we can find for this work item.
    const lastSessionEnd = db
      .prepare<[number], { ended_at: string }>(
        `SELECT ended_at FROM sessions WHERE work_item_id = ? AND ended_at IS NOT NULL
         ORDER BY datetime(ended_at) DESC LIMIT 1`,
      )
      .get(r.work_item_id);
    const lastEvent = db
      .prepare<[number], { created_at: string }>(
        `SELECT created_at FROM session_events WHERE work_item_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(r.work_item_id);

    let endedAt: string;
    if (lastSessionEnd && lastSessionEnd.ended_at > r.started_at) {
      endedAt = lastSessionEnd.ended_at;
    } else if (lastEvent && lastEvent.created_at > r.started_at) {
      endedAt = lastEvent.created_at;
    } else {
      // No signal — assume a 5-minute blip rather than days.
      endedAt = new Date(new Date(r.started_at).getTime() + 5 * 60 * 1000).toISOString();
    }

    db.prepare(`UPDATE time_entries SET ended_at = ?, synced_to_ado = 1 WHERE id = ?`).run(
      endedAt,
      r.id,
    );
    console.log(
      `  #${r.work_item_id} entry ${r.id}: closed ${r.started_at} → ${endedAt}, marked synced`,
    );
  }

  // 2. Mark all closed-unsynced rows as synced.
  const flipped = db
    .prepare(
      `UPDATE time_entries SET synced_to_ado = 1
        WHERE ended_at IS NOT NULL AND synced_to_ado = 0`,
    )
    .run();
  console.log(`\nClosed-unsynced rows flipped to synced: ${flipped.changes}`);

  const after = db.prepare<[], { running: number; unsynced: number }>(
    `SELECT
       SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN ended_at IS NOT NULL AND synced_to_ado = 0 THEN 1 ELSE 0 END) AS unsynced
     FROM time_entries`,
  ).get();
  console.log('\nAfter:', after);
}

main();
