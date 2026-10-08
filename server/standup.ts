/**
 * Standup builder (R9). Pulls yesterday's and today's session activity
 * into the shape the user reads aloud to the delivery manager: a short
 * "what I did" + "what I'm doing" block, optimized for glancing and
 * speaking. No new ADO calls — works from the sessions DB only, joined
 * to titles already in the dashboard payload.
 *
 * Surfaced only in the Daily view (per the user 2026-06-03 — the user doesn't
 * want this card in front of them during deep work).
 */
import { getDb } from './db';
import { displayNameFor } from './display-name';
import { getWorkingDays } from './user-config';

export interface StandupTask {
  workItemId: number;
  title: string;
  /** Raw ADO state ("Active" / "Blocked" / "Done" / etc.) — UI maps to a chip. */
  adoState: string;
}

export interface StandupEntry {
  /** The story this row is about. (Sessions on Tasks roll up to their parent Story.) */
  workItemId: number;
  /** Pre-formatted `**title** (#id)` ready to echo. */
  displayName: string;
  /** First-sentence summary of the latest progress event in window. Null when there are no progress events. */
  summary: string | null;
  /**
   * Total minutes the session(s) under this story were open within the window.
   * Pulled from session start/end timestamps, capped at window duration to
   * avoid counting ghost-time. Null when any session is still live.
   */
  minutesInWindow: number | null;
  /** Aggregated session state for visual cue (live wins, then paused, then closed). */
  state: 'live' | 'paused' | 'closed';
  /**
   * The story's real Azure DevOps state ("New" / "Active" / "Done" / etc.).
   * Drives the status pill, so the recap reads the same as the stories list
   * instead of guessing from the (often partial) worked-task list. Empty when
   * the story isn't in the current sprint payload.
   */
  storyState: string;
  /** Tasks under this story that had session activity in the window. Empty when the session was on the story itself. */
  tasks: StandupTask[];
}

export interface StandupBlock {
  /** ISO date of "yesterday" used for the lookup (most-recent prior calendar day). */
  yesterdayDate: string;
  /** ISO date of "today" used for the lookup. */
  todayDate: string;
  yesterday: StandupEntry[];
  today: StandupEntry[];
}

const MS_PER_MIN = 60 * 1000;

interface SessionRow {
  id: string;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
}

interface ProgressEventRow {
  work_item_id: number;
  text: string;
  standup_summary: string | null;
  created_at: string;
}

/**
 * Pick the standup blurb for a progress event:
 *  - If the AI wrote a `standup_summary` (preferred), use it verbatim.
 *  - Otherwise fall back to the first ~280 chars of the long-form text,
 *    rounded down to the last sentence boundary so it doesn't end mid-word.
 *
 * Why this matters: The user reads these the next morning. "Paused, blocked."
 * alone is useless context; ~3 sentences of why-and-where gets them back
 * on the page without thinking.
 */
function blurbFor(row: ProgressEventRow): string {
  if (row.standup_summary && row.standup_summary.trim().length > 0) {
    return row.standup_summary.trim();
  }
  const trimmed = row.text.trim();
  if (trimmed.length <= 280) return trimmed;
  // Walk sentence boundaries until we'd exceed the cap, then stop at the
  // boundary right before. Sentence terminators: . ! ?
  const re = /[.!?]\s+/g;
  let cut = -1;
  for (let m: RegExpExecArray | null; (m = re.exec(trimmed)); ) {
    const end = m.index + 1; // include the punctuation
    if (end > 280) break;
    cut = end;
  }
  if (cut > 0) return trimmed.slice(0, cut).trim();
  // No sentence boundary inside the cap (a single long sentence) — hard cut
  // with an ellipsis.
  return trimmed.slice(0, 277).trimEnd() + '…';
}

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sessionsTouchingWindow(startISO: string, endISO: string): SessionRow[] {
  // Any session whose [started_at, ended_at-or-now] interval overlaps the
  // window. Open sessions (ended_at IS NULL) count as ending "now".
  return getDb()
    .prepare<[string, string, string], SessionRow>(
      `SELECT id, work_item_id, started_at, ended_at
         FROM sessions
        WHERE datetime(started_at) < datetime(?)
          AND datetime(COALESCE(ended_at, ?)) >= datetime(?)
        ORDER BY datetime(started_at) ASC`,
    )
    .all(endISO, endISO, startISO);
}

function latestProgressByItem(
  workItemIds: number[],
  startISO: string,
  endISO: string,
): Map<number, ProgressEventRow> {
  if (workItemIds.length === 0) return new Map();
  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<(number | string)[], ProgressEventRow>(
      `SELECT work_item_id, text, standup_summary, created_at
         FROM session_events
        WHERE type = 'progress'
          AND work_item_id IN (${placeholders})
          AND datetime(created_at) >= datetime(?)
          AND datetime(created_at) < datetime(?)
        ORDER BY work_item_id ASC, datetime(created_at) DESC`,
    )
    .all(...workItemIds, startISO, endISO);
  const out = new Map<number, ProgressEventRow>();
  for (const r of rows) {
    if (!out.has(r.work_item_id)) out.set(r.work_item_id, r);
  }
  return out;
}

function clampMs(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function minutesInWindow(sessions: SessionRow[], startISO: string, endISO: string, nowMs: number): number {
  const winStart = Date.parse(startISO);
  const winEnd = Date.parse(endISO);
  let total = 0;
  for (const s of sessions) {
    const sStart = Date.parse(s.started_at);
    const sEnd = s.ended_at ? Date.parse(s.ended_at) : nowMs;
    const overlap = clampMs(Math.min(sEnd, winEnd) - Math.max(sStart, winStart), winEnd - winStart);
    total += overlap;
  }
  return Math.round(total / MS_PER_MIN);
}

interface BuildOpts {
  /**
   * Look-up for each work-item id touched by a session. `parentId` lets the
   * standup roll Tasks up to their parent Story so each row in the card is a
   * Story (the unit the user talks about), not a Task. `type` lets the standup
   * skip Feature/Epic entries — sessions on those are always a data mistake.
   */
  taskMeta: Map<number, { title: string; parentId: number | null; parentTitle: string | null; type: string; state: string }>;
  /** Override "now" for tests; defaults to the current clock. */
  now?: Date;
}

const STANDUP_SKIP_TYPES = new Set(['feature', 'epic']);
const STANDUP_STORY_LEVEL_TYPES = new Set(['user story', 'story', 'bug']);

/**
 * Decide which story id a session rolls up to. Tasks roll up to their parent;
 * Stories/Bugs are themselves the row. Features/Epics are dropped (sessions on
 * those are data mistakes — the user doesn't speak about them in the standup).
 * Returns null when the session item should be excluded entirely.
 */
function rollUpToStory(
  sessionItemId: number,
  taskMeta: BuildOpts['taskMeta'],
): { storyId: number; storyTitle: string; sessionItemType: 'story' | 'task' } | null {
  const meta = taskMeta.get(sessionItemId);
  // Unknown item (not in current sprint payload): treat the session item as
  // its own row so we don't silently drop data the user logged against it.
  if (!meta) {
    return { storyId: sessionItemId, storyTitle: `#${sessionItemId}`, sessionItemType: 'story' };
  }
  const t = meta.type.toLowerCase();
  if (STANDUP_SKIP_TYPES.has(t)) return null;
  if (t === 'task') {
    if (meta.parentId != null) {
      const parentMeta = taskMeta.get(meta.parentId);
      // Parent is itself a Feature/Epic (rare) — fall back to the Task as the
      // row rather than skip the work entirely.
      if (parentMeta && STANDUP_SKIP_TYPES.has(parentMeta.type.toLowerCase())) {
        return { storyId: sessionItemId, storyTitle: meta.title, sessionItemType: 'task' };
      }
      return {
        storyId: meta.parentId,
        storyTitle: parentMeta?.title ?? meta.parentTitle ?? `#${meta.parentId}`,
        sessionItemType: 'task',
      };
    }
    // Task with no parent — render the task itself as the row.
    return { storyId: sessionItemId, storyTitle: meta.title, sessionItemType: 'task' };
  }
  // Story / Bug / anything else story-level: the item itself is the row.
  return {
    storyId: sessionItemId,
    storyTitle: meta.title,
    sessionItemType: STANDUP_STORY_LEVEL_TYPES.has(t) ? 'story' : 'story',
  };
}

function entriesForWindow(
  startISO: string,
  endISO: string,
  opts: BuildOpts,
  nowMs: number,
): StandupEntry[] {
  const sessions = sessionsTouchingWindow(startISO, endISO);
  if (sessions.length === 0) return [];

  interface StoryBucket {
    storyId: number;
    storyTitle: string;
    sessions: SessionRow[];
    /** Distinct task ids (only Tasks, not the story itself) that had sessions. */
    taskItemIds: Set<number>;
    /** Every session item id (Task or Story) that fed into this bucket — used to pull latest progress. */
    sessionItemIds: Set<number>;
  }

  const buckets = new Map<number, StoryBucket>();
  for (const s of sessions) {
    const roll = rollUpToStory(s.work_item_id, opts.taskMeta);
    if (!roll) continue;
    let bucket = buckets.get(roll.storyId);
    if (!bucket) {
      bucket = {
        storyId: roll.storyId,
        storyTitle: roll.storyTitle,
        sessions: [],
        taskItemIds: new Set(),
        sessionItemIds: new Set(),
      };
      buckets.set(roll.storyId, bucket);
    }
    bucket.sessions.push(s);
    bucket.sessionItemIds.add(s.work_item_id);
    if (roll.sessionItemType === 'task' && s.work_item_id !== roll.storyId) {
      bucket.taskItemIds.add(s.work_item_id);
    }
  }

  if (buckets.size === 0) return [];

  // Pull latest progress event per session item id across the window, then
  // pick the newest one per bucket — that's "what got done on this story."
  const allItemIds = Array.from(
    new Set([...buckets.values()].flatMap(b => Array.from(b.sessionItemIds))),
  );
  const progressByItem = latestProgressByItem(allItemIds, startISO, endISO);

  const entries: StandupEntry[] = [];
  for (const bucket of buckets.values()) {
    const hasOpen = bucket.sessions.some(r => r.ended_at == null);
    const allClosed = bucket.sessions.every(r => r.ended_at != null);
    const state: StandupEntry['state'] = hasOpen ? 'live' : allClosed ? 'closed' : 'paused';
    const minutes = hasOpen ? null : minutesInWindow(bucket.sessions, startISO, endISO, nowMs);

    // Newest progress text across any session item in the bucket.
    let latest: ProgressEventRow | null = null;
    for (const itemId of bucket.sessionItemIds) {
      const pe = progressByItem.get(itemId);
      if (!pe) continue;
      if (!latest || pe.created_at > latest.created_at) latest = pe;
    }
    const summary = latest ? blurbFor(latest) : null;

    // Tasks list for the row — what got worked under this story in the window.
    const tasks: StandupTask[] = [];
    for (const taskId of bucket.taskItemIds) {
      const meta = opts.taskMeta.get(taskId);
      tasks.push({
        workItemId: taskId,
        title: meta?.title ?? `#${taskId}`,
        adoState: meta?.state ?? 'Active',
      });
    }
    // Stable order: title alphabetic — keeps day-to-day reads consistent.
    tasks.sort((a, b) => a.title.localeCompare(b.title));

    entries.push({
      workItemId: bucket.storyId,
      displayName: displayNameFor(bucket.storyId, bucket.storyTitle),
      summary,
      minutesInWindow: minutes,
      state,
      storyState: opts.taskMeta.get(bucket.storyId)?.state ?? '',
      tasks,
    });
  }

  // Live first, then paused, then closed.
  const stateOrder: Record<StandupEntry['state'], number> = { live: 0, paused: 1, closed: 2 };
  entries.sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);

  return entries;
}

// "Yesterday" = the last day the user actually worked, not the literal
// calendar yesterday. Days off in the configured week are skipped, so the
// first standup after a weekend shows the last workday's work, not an empty
// weekend day.

/** Start-of-day of the most recent working day strictly before `todayStart`. */
export function previousWorkingDayStart(todayStart: Date): Date {
  const workingDays = getWorkingDays();
  const d = new Date(todayStart);
  do {
    d.setDate(d.getDate() - 1);
  } while (!workingDays.has(d.getDay()));
  return d;
}

export function buildStandup(opts: BuildOpts): StandupBlock {
  const now = opts.now ?? new Date();
  const todayStart = startOfLocalDay(now);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  // "Yesterday" = since the last working day. On a Sunday this reaches back to
  // Thursday and the empty Fri+Sat are folded in (harmless — they have no
  // activity), so the column shows the real last working day.
  const yesterdayStart = previousWorkingDayStart(todayStart);

  const yesterdayISO = todayStart.toISOString();
  const yesterday = entriesForWindow(
    yesterdayStart.toISOString(),
    yesterdayISO,
    opts,
    now.getTime(),
  );
  const today = entriesForWindow(
    todayStart.toISOString(),
    tomorrowStart.toISOString(),
    opts,
    now.getTime(),
  );

  return {
    yesterdayDate: isoDate(yesterdayStart),
    todayDate: isoDate(todayStart),
    yesterday,
    today,
  };
}

/**
 * The distinct work-item ids that any session touched within the same two
 * windows `buildStandup` reads (since the last working day → end of today).
 *
 * The recap resolves each worked item's title/parent/state from `taskMeta`,
 * which the dashboard builds from the CURRENT-sprint items only. An item worked
 * in a previous sprint (a task not yet pulled into the new sprint) is therefore
 * absent from `taskMeta`, so the recap can only show its bare `#id`. The
 * dashboard uses this id list to fetch those few missing items from Azure and
 * fold them into `taskMeta` before calling `buildStandup`, so the recap reads
 * real names regardless of which sprint the work lives in.
 */
export function workedItemIdsForStandup(now: Date = new Date()): number[] {
  const todayStart = startOfLocalDay(now);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const yesterdayStart = previousWorkingDayStart(todayStart);

  const sessions = [
    ...sessionsTouchingWindow(yesterdayStart.toISOString(), todayStart.toISOString()),
    ...sessionsTouchingWindow(todayStart.toISOString(), tomorrowStart.toISOString()),
  ];
  return [...new Set(sessions.map(s => s.work_item_id))];
}
