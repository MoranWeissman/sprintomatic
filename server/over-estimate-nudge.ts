/**
 * Chat side of "this task is going over": when a task with an open session
 * passes its estimate, the next tool response carries one quiet line about
 * it. Said once per task, ever — not every minute.
 *
 * The estimate comes from the dashboard payload already in memory (no board
 * read on every tool call); the logged time comes fresh from the timer table.
 */
import { getDb } from './db';
import { peekDashboardPayload } from './dashboard-cache';
import { displayNameFor } from './display-name';
import { overEstimate, overEstimateText } from './over-estimate';
import { getLocalLoggedMap, getSetting, setSetting } from './timers';

const NUDGED_KEY = 'over_estimate_nudged';
/** Only the most recent ids are kept, so the list doesn't grow forever. */
const KEEP_IDS = 200;

export interface NudgeTask {
  id: number;
  title: string;
  originalEstimate?: number | null;
  completedWork?: number | null;
}

/** Pure core: which open tasks are newly over, and the text for them. */
export function pickOverEstimate(
  openIds: number[],
  tasks: Map<number, NudgeTask>,
  logged: Map<number, number>,
  alreadyNudged: Set<number>,
): { ids: number[]; text: string | null } {
  const lines: string[] = [];
  const ids: number[] = [];
  for (const id of new Set(openIds)) {
    if (alreadyNudged.has(id)) continue;
    const t = tasks.get(id);
    if (!t) continue;
    const o = overEstimate({ ...t, loggedSeconds: logged.get(id) ?? 0 });
    if (!o) continue;
    ids.push(id);
    lines.push(`  - ${displayNameFor(t.id, t.title)}: ${overEstimateText(o)}`);
  }
  if (ids.length === 0) return { ids, text: null };
  return {
    ids,
    text: [
      '',
      'GOING OVER — this task has passed its estimate:',
      ...lines,
      'Tell the user once, calmly, in one short sentence, and ask whether the hours left (Remaining Work) need updating.',
      'Never change the Original Estimate. This is said only once per task.',
    ].join('\n'),
  };
}

export function checkOverEstimateNudge(): string | null {
  // A nudge must never break the tool response it rides on.
  try {
    return overEstimateNudge();
  } catch {
    return null;
  }
}

function overEstimateNudge(): string | null {
  const payload = peekDashboardPayload();
  if (!payload) return null;
  const openIds = getDb()
    .prepare<[], { id: number }>(`SELECT work_item_id AS id FROM sessions WHERE ended_at IS NULL`)
    .all()
    .map(r => r.id);
  if (openIds.length === 0) return null;

  const tasks = new Map<number, NudgeTask>();
  const { inProgress, upNext, done } = payload.workItems;
  for (const w of [...inProgress, ...upNext, ...done]) {
    tasks.set(Number(w.id), { id: Number(w.id), title: w.title, originalEstimate: w.originalEstimate, completedWork: w.completedWork });
  }

  const nudged = readNudged();
  const { ids, text } = pickOverEstimate(openIds, tasks, getLocalLoggedMap(), new Set(nudged));
  if (ids.length > 0) setSetting(NUDGED_KEY, JSON.stringify([...nudged, ...ids].slice(-KEEP_IDS)));
  return text;
}

function readNudged(): number[] {
  try {
    const v = JSON.parse(getSetting(NUDGED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}
