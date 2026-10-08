/**
 * One-shot backfill for the markdown archive (R8). Walks every work item
 * in the current sprint that has at least one session in the DB, mirrors
 * its markdown file, then writes the sprint summary.
 *
 * Use cases:
 *   - First-time setup after upgrading to the version that ships R8.
 *   - Fresh machine: regenerate the archive from the DB.
 *   - Manual recovery after an external edit / deleted file.
 *
 * Run: `npx tsx scripts/backfill-archive.ts`
 */
import { buildDashboardCached } from '../server/dashboard-cache';
import { mirrorSprintSummary, mirrorTaskFile } from '../server/archive';
import { getDb } from '../server/db';

async function main() {
  const { payload } = await buildDashboardCached();
  if (!payload.sprint) {
    console.error('No current sprint — nothing to backfill.');
    process.exit(1);
  }
  const sprintTaskIds = new Set<number>();
  for (const list of [payload.workItems.inProgress, payload.workItems.upNext, payload.workItems.done]) {
    for (const w of list) sprintTaskIds.add(Number(w.id));
  }

  const rows = getDb()
    .prepare<[], { work_item_id: number }>(
      `SELECT DISTINCT work_item_id FROM sessions ORDER BY work_item_id`,
    )
    .all();
  const candidates = rows.map(r => r.work_item_id).filter(id => sprintTaskIds.has(id));

  if (candidates.length === 0) {
    console.log('No sessions in the current sprint to backfill.');
  } else {
    console.log(`Backfilling ${candidates.length} task file(s)...`);
    for (const id of candidates) {
      const result = await mirrorTaskFile(id);
      console.log(`  #${id} → ${result.ok ? result.path : 'SKIP: ' + result.reason}`);
    }
  }

  const summary = await mirrorSprintSummary();
  console.log(`Sprint summary: ${summary.ok ? summary.path : 'SKIP: ' + summary.reason}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
