/**
 * Retro draft — the sprint's own record turned into talking points.
 *
 * The user runs a team retro but finds it hard to recall what went well and
 * what got in the way. The tool watched the whole sprint: the board, the
 * session log, blocks, estimates, days off. So the tool writes the FIRST
 * DRAFT and the user only keeps or drops lines. Nothing is invented — every
 * candidate line carries the evidence it was built from, or it doesn't exist.
 *
 * Split the usual way: `buildRetroDraft` is pure (tested with fakes),
 * `buildRetro` gathers the live inputs, and the saved retro lives under a
 * per-sprint settings key so next sprint can show "last retro you said…".
 */
import { buildDashboardCached } from './dashboard-cache';
import { getWorkItemsWithParents } from './ado';
import { getDb } from './db';
import { displayNameFor } from './display-name';
import { listDaysOff } from './days-off';
import { isDoneState } from './states';

/* ============================================================ */
/*  Shapes                                                       */
/* ============================================================ */

export type RetroBucket = 'well' | 'way' | 'talk';

export interface RetroCandidate {
  /** Stable identity across rebuilds, so a kept/dropped choice sticks. */
  key: string;
  bucket: RetroBucket;
  /** The line the user would say out loud. Plain English, names not ids. */
  text: string;
  /** Where the line came from — board state, log entry, estimate numbers. */
  evidence: string;
}

export interface RetroDraft {
  /** One line: what was planned vs what got done, days off included. */
  sprintLine: string;
  candidates: RetroCandidate[];
}

/** What the pure builder needs to know about the sprint. All facts, no I/O. */
export interface RetroInputs {
  sprintName: string;
  stories: { id: number; title: string; state: string }[];
  tasks: {
    id: number;
    title: string;
    state: string;
    originalEstimate?: number;
    completedWork?: number;
  }[];
  /** Session-log 'blocker' entries inside the sprint window. */
  blockerEvents: { workItemId: number; title: string; text: string }[];
  /** Session-log 'decision' entries inside the sprint window. */
  decisionEvents: { workItemId: number; title: string; text: string }[];
  /** Confirmed days off that fall inside this sprint. */
  daysOffCount: number;
}

/* ============================================================ */
/*  The pure draft builder                                       */
/* ============================================================ */

/** A finished task ran long when it took at least this much over its estimate. */
const OVERRUN_FACTOR = 1.5;
/** …and the miss is only worth saying when it's at least this many hours. */
const OVERRUN_MIN_H = 2;

const trimText = (s: string, max = 110): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

/** Log entries often open with their own marker ("BLOCKED: …"). The retro
 *  line already says the item got stuck, so saying it twice reads silly. */
const stripLogPrefix = (s: string): string => s.replace(/^\s*(?:UN)?BLOCKED\s*[:\u2014-]\s*/i, '');

export function buildRetroDraft(inputs: RetroInputs): RetroDraft {
  const candidates: RetroCandidate[] = [];

  const storiesDone = inputs.stories.filter(s => isDoneState(s.state));
  const tasksDone = inputs.tasks.filter(t => isDoneState(t.state));

  // ---- Went well: stories that finished --------------------------------
  for (const s of storiesDone) {
    candidates.push({
      key: `story-closed-${s.id}`,
      bucket: 'well',
      text: `${displayNameFor(s.id, s.title)} was finished this sprint.`,
      evidence: `Board state: ${s.state}.`,
    });
  }

  // ---- Went well: plain volume — tasks that actually finished ----------
  if (tasksDone.length >= 3) {
    candidates.push({
      key: 'tasks-done',
      bucket: 'well',
      text: `${tasksDone.length} of ${inputs.tasks.length} tasks were finished.`,
      evidence: 'Board states across the sprint\'s tasks.',
    });
  }

  // ---- Went well: estimates that landed --------------------------------
  const measured = tasksDone.filter(
    t => t.originalEstimate != null && t.originalEstimate > 0 && t.completedWork != null,
  );
  const landed = measured.filter(
    t => (t.completedWork as number) <= (t.originalEstimate as number) * OVERRUN_FACTOR,
  );
  if (measured.length >= 3 && landed.length === measured.length) {
    candidates.push({
      key: 'estimates-landed',
      bucket: 'well',
      text: `All ${measured.length} finished tasks came in close to their estimates.`,
      evidence: `Every closed task's completed hours were within ${OVERRUN_FACTOR}× its estimate.`,
    });
  }

  // ---- Got in the way: blocks ------------------------------------------
  // One line per blocked item (first block's words), and a talking point
  // when the same item got stuck more than once.
  const blocksByItem = new Map<number, { title: string; texts: string[] }>();
  for (const b of inputs.blockerEvents) {
    const cur = blocksByItem.get(b.workItemId) ?? { title: b.title, texts: [] };
    cur.texts.push(b.text);
    blocksByItem.set(b.workItemId, cur);
  }
  for (const [id, b] of blocksByItem) {
    candidates.push({
      key: `blocked-${id}`,
      bucket: 'way',
      text: `${displayNameFor(id, b.title)} got stuck: ${trimText(stripLogPrefix(b.texts[0]))}`,
      evidence: `${b.texts.length} block ${b.texts.length === 1 ? 'entry' : 'entries'} in the session log.`,
    });
    if (b.texts.length >= 2) {
      candidates.push({
        key: `talk-reblocked-${id}`,
        bucket: 'talk',
        text: `${displayNameFor(id, b.title)} got stuck ${b.texts.length} times — worth asking why it keeps coming back.`,
        evidence: `${b.texts.length} separate block entries in the session log.`,
      });
    }
  }

  // ---- Got in the way: estimates that ran long -------------------------
  const overruns = measured.filter(
    t =>
      (t.completedWork as number) > (t.originalEstimate as number) * OVERRUN_FACTOR &&
      (t.completedWork as number) - (t.originalEstimate as number) >= OVERRUN_MIN_H,
  );
  for (const t of overruns) {
    candidates.push({
      key: `overran-${t.id}`,
      bucket: 'way',
      text: `${displayNameFor(t.id, t.title)} took ${Math.round(t.completedWork as number)}h against an estimate of ${Math.round(t.originalEstimate as number)}h.`,
      evidence: `Board hours: ${t.completedWork}h done vs ${t.originalEstimate}h estimated.`,
    });
  }
  if (overruns.length >= 2) {
    candidates.push({
      key: 'talk-overruns',
      bucket: 'talk',
      text: `${overruns.length} tasks ran well past their estimate this sprint — maybe the estimates were made before the work was understood.`,
      evidence: overruns.map(t => `#${t.id}`).join(', '),
    });
  }

  // ---- Got in the way: work still open at retro time -------------------
  const openStories = inputs.stories.filter(s => !isDoneState(s.state));
  for (const s of openStories) {
    candidates.push({
      key: `open-${s.id}`,
      bucket: 'way',
      text: `${displayNameFor(s.id, s.title)} isn't finished and will carry into the next sprint.`,
      evidence: `Board state: ${s.state}.`,
    });
  }

  // ---- Worth saying: decisions made mid-sprint -------------------------
  for (const d of inputs.decisionEvents) {
    candidates.push({
      key: `decision-${d.workItemId}-${hashText(d.text)}`,
      bucket: 'talk',
      text: `On ${displayNameFor(d.workItemId, d.title)} a call was made mid-sprint: ${trimText(d.text)}`,
      evidence: 'Decision entry in the session log.',
    });
  }

  // ---- The one-line summary --------------------------------------------
  const parts = [
    `${storiesDone.length} of ${inputs.stories.length} stories finished`,
    `${tasksDone.length} of ${inputs.tasks.length} tasks done`,
  ];
  if (inputs.daysOffCount > 0) {
    parts.push(`${inputs.daysOffCount} working ${inputs.daysOffCount === 1 ? 'day' : 'days'} off`);
  }
  const sprintLine = `Sprint ${inputs.sprintName}: ${parts.join(', ')}.`;

  return { sprintLine, candidates };
}

/** Tiny stable hash so two different decisions on one item get two keys. */
function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/* ============================================================ */
/*  Saved retro — one settings key per sprint                    */
/* ============================================================ */

const RETRO_KEY_PREFIX = 'retro_';

export interface SavedRetroItem {
  key: string;
  bucket: RetroBucket;
  text: string;
  decision: 'keep' | 'drop';
}

export interface SavedRetro {
  sprintName: string;
  savedAt: string;
  items: SavedRetroItem[];
}

/**
 * Save the user's keep/drop pass. Stores the full text snapshot, not just
 * the choices — a past sprint's draft can't be rebuilt once the board moves
 * on, so what was kept must survive on its own.
 */
export function saveRetro(sprintName: string, items: SavedRetroItem[]): SavedRetro {
  const saved: SavedRetro = { sprintName, savedAt: new Date().toISOString(), items };
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(`${RETRO_KEY_PREFIX}${sprintName}`, JSON.stringify(saved));
  return saved;
}

export function getSavedRetro(sprintName: string): SavedRetro | null {
  const row = getDb()
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(`${RETRO_KEY_PREFIX}${sprintName}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SavedRetro;
  } catch {
    return null;
  }
}

/**
 * The most recently saved retro that is NOT the given sprint's — what last
 * sprint's meeting kept, so this sprint can open with it.
 */
export function getPreviousRetro(currentSprintName: string): SavedRetro | null {
  const rows = getDb()
    .prepare(`SELECT key, value FROM settings WHERE key LIKE ?`)
    .all(`${RETRO_KEY_PREFIX}%`) as { key: string; value: string }[];
  let best: SavedRetro | null = null;
  for (const r of rows) {
    let parsed: SavedRetro;
    try {
      parsed = JSON.parse(r.value) as SavedRetro;
    } catch {
      continue;
    }
    if (parsed.sprintName === currentSprintName) continue;
    if (!best || parsed.savedAt > best.savedAt) best = parsed;
  }
  return best;
}

/* ============================================================ */
/*  The live assembler                                           */
/* ============================================================ */

export interface RetroView {
  sprintName: string;
  sprintLine: string;
  /** Draft candidates merged with any saved keep/drop choices. */
  items: (RetroCandidate & { decision: 'keep' | 'drop' })[];
  savedAt: string | null;
  /** What LAST sprint's retro kept, for the "did we change it?" opener. */
  previous: { sprintName: string; kept: { bucket: RetroBucket; text: string }[] } | null;
}

/** Build the live retro view for the current sprint. Throws when no sprint. */
export async function buildRetro(): Promise<RetroView> {
  const { payload } = await buildDashboardCached();
  const sprint = payload.sprint;
  if (!sprint) throw new Error('No current sprint — a retro needs a sprint to look back on.');

  const stories = payload.userStories.map(g => ({
    id: Number(g.id),
    title: g.title,
    state: g.state,
  }));
  const allTasks = [
    ...payload.workItems.inProgress,
    ...payload.workItems.upNext,
    ...payload.workItems.done,
  ].filter(w => w.type.toLowerCase() === 'task');
  const tasks = allTasks.map(t => ({
    id: Number(t.id),
    title: t.title,
    state: t.state,
    originalEstimate: t.originalEstimate,
    completedWork: t.completedWork,
  }));

  const titleById = new Map<number, string>();
  for (const t of tasks) titleById.set(t.id, t.title);
  for (const s of stories) titleById.set(s.id, s.title);

  const db = getDb();
  const events = db
    .prepare(
      `SELECT work_item_id AS workItemId, type, text
         FROM session_events
        WHERE type IN ('blocker', 'decision')
          AND created_at >= ? AND created_at <= ?
        ORDER BY created_at ASC`,
    )
    .all(sprint.startDate, sprint.finishDate) as {
    workItemId: number;
    type: 'blocker' | 'decision';
    text: string;
  }[];
  // Session events can point at items outside this sprint's payload (a task
  // from another sprint, or one not assigned to the user). Fetch the missing
  // titles in one batch so no line falls back to a bare id; if the board
  // read fails, the bare-id fallback is still the honest one.
  const missingIds = [...new Set(events.map(e => e.workItemId))].filter(id => !titleById.has(id));
  if (missingIds.length > 0) {
    try {
      const fetched = await getWorkItemsWithParents(missingIds, { errorPolicy: 'omit' });
      for (const w of fetched) titleById.set(w.id, w.title);
    } catch {
      /* board hiccup — bare #id is better than a made-up name */
    }
  }

  const withTitle = (e: { workItemId: number; text: string }) => ({
    workItemId: e.workItemId,
    title: titleById.get(e.workItemId) ?? '',
    text: e.text,
  });

  const daysOffCount = listDaysOff().filter(
    d => d >= sprint.startDate.slice(0, 10) && d <= sprint.finishDate.slice(0, 10),
  ).length;

  const draft = buildRetroDraft({
    sprintName: sprint.name,
    stories,
    tasks,
    blockerEvents: events.filter(e => e.type === 'blocker').map(withTitle),
    decisionEvents: events.filter(e => e.type === 'decision').map(withTitle),
    daysOffCount,
  });

  const saved = getSavedRetro(sprint.name);
  const decisionByKey = new Map((saved?.items ?? []).map(i => [i.key, i.decision]));
  const prev = getPreviousRetro(sprint.name);

  return {
    sprintName: sprint.name,
    sprintLine: draft.sprintLine,
    items: draft.candidates.map(c => ({ ...c, decision: decisionByKey.get(c.key) ?? 'keep' })),
    savedAt: saved?.savedAt ?? null,
    previous: prev
      ? {
          sprintName: prev.sprintName,
          kept: prev.items.filter(i => i.decision === 'keep').map(i => ({ bucket: i.bucket, text: i.text })),
        }
      : null,
  };
}
