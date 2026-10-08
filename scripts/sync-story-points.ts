/**
 * One-shot sweep: heal Story Points drift on the user's open User Stories.
 *
 * Walks every Story assigned to them in the current sprint (and any other
 * non-done iteration the user holds open work in), reads StoryPoints + Effort,
 * computes the expected points via deriveStoryPoints, and PATCHes the
 * difference. Prints a before/after table so the user sees exactly what changed.
 *
 * Run once after the MCP restart in Task 6. Delete the script after a
 * successful run (repo convention — sweeps don't live in tree).
 *
 *   npx tsx scripts/sync-story-points.ts          # dry run, prints only
 *   npx tsx scripts/sync-story-points.ts --apply  # actually PATCH
 */
import { execFile } from 'node:child_process';
import { loadAdoConfig } from '../server/config';
import { setStoryPoints } from '../server/writes';
import { deriveStoryPoints } from '../server/story-points';
import { getWorkdayHours } from '../server/user-config';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

interface StoryRow {
  id: number;
  title: string;
  state: string;
  effort: number | null;
  storyPoints: number | null;
}

async function listOpenStories(): Promise<StoryRow[]> {
  const cfg = await loadAdoConfig();
  const wiql = {
    query: `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.AssignedTo] = @Me
        AND [System.WorkItemType] = 'User Story'
        AND [System.State] NOT IN ('Done','Closed','Resolved','Completed','Removed')
    `,
  };
  const wiqlUri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/wiql?api-version=7.1`;
  const wiqlOut = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'az',
      [
        'rest', '--method', 'POST',
        '--uri', wiqlUri,
        '--resource', ADO_RESOURCE,
        '--headers', 'Content-Type=application/json',
        '--body', '@-',
        '-o', 'json',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr)));
        else resolve(String(stdout));
      },
    );
    child.stdin?.write(JSON.stringify(wiql));
    child.stdin?.end();
  });
  const parsed = JSON.parse(wiqlOut) as { workItems?: Array<{ id: number }> };
  const ids = (parsed.workItems ?? []).map(w => w.id);
  if (ids.length === 0) return [];

  const fields = [
    'System.Id', 'System.Title', 'System.State',
    'Microsoft.VSTS.Scheduling.Effort',
    'Microsoft.VSTS.Scheduling.StoryPoints',
  ].join(',');
  const batchUri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemsbatch?api-version=7.1`;
  const batchBody = { ids, fields: fields.split(',') };
  const batchOut = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'az',
      [
        'rest', '--method', 'POST',
        '--uri', batchUri,
        '--resource', ADO_RESOURCE,
        '--headers', 'Content-Type=application/json',
        '--body', '@-',
        '-o', 'json',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr)));
        else resolve(String(stdout));
      },
    );
    child.stdin?.write(JSON.stringify(batchBody));
    child.stdin?.end();
  });

  const items = JSON.parse(batchOut) as {
    value: Array<{
      id: number;
      fields: Record<string, unknown>;
    }>;
  };

  return items.value.map(w => ({
    id: w.id,
    title: String(w.fields['System.Title'] ?? ''),
    state: String(w.fields['System.State'] ?? ''),
    effort: typeof w.fields['Microsoft.VSTS.Scheduling.Effort'] === 'number'
      ? (w.fields['Microsoft.VSTS.Scheduling.Effort'] as number)
      : null,
    storyPoints: typeof w.fields['Microsoft.VSTS.Scheduling.StoryPoints'] === 'number'
      ? (w.fields['Microsoft.VSTS.Scheduling.StoryPoints'] as number)
      : null,
  }));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workday = getWorkdayHours();
  console.log(`Workday is ${workday}h. Scanning open User Stories…`);

  const stories = await listOpenStories();
  if (stories.length === 0) {
    console.log('No open stories.');
    return;
  }

  type DriftRow = StoryRow & { expected: number };
  const drift: DriftRow[] = [];
  const missingEffort: StoryRow[] = [];
  for (const s of stories) {
    if (s.effort == null) {
      missingEffort.push(s);
      continue;
    }
    const expected = deriveStoryPoints(s.effort, workday);
    if (s.storyPoints !== expected) {
      drift.push({ ...s, expected });
    }
  }

  if (drift.length === 0 && missingEffort.length === 0) {
    console.log(`All ${stories.length} open stories are aligned. Nothing to do.`);
    return;
  }

  if (drift.length > 0) {
    console.log(`\nStories with drift (${drift.length}):`);
    for (const d of drift) {
      console.log(
        `  **${d.title}** (#${d.id}) — ${d.effort}h effort, current ${d.storyPoints ?? '∅'} pts → derived ${d.expected} pts`,
      );
    }
  }

  if (missingEffort.length > 0) {
    console.log(`\nStories missing Effort (${missingEffort.length}) — these need a real estimate, not a sweep:`);
    for (const m of missingEffort) {
      console.log(`  **${m.title}** (#${m.id}) — ${m.state}`);
    }
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to PATCH the ${drift.length} drifted stor${drift.length === 1 ? 'y' : 'ies'}.`);
    return;
  }

  console.log(`\nApplying patches…`);
  for (const d of drift) {
    try {
      await setStoryPoints(d.id, d.expected);
      console.log(`  ✓ **${d.title}** (#${d.id}) — points now ${d.expected}`);
    } catch (e) {
      console.error(`  ✗ **${d.title}** (#${d.id}) — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nDone. Delete this script when you've confirmed the board looks right.`);
}

main().catch(e => { console.error(e); process.exit(1); });
