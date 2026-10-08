/**
 * End-of-day wrap block for the Daily view: the facts the evening card needs
 * beyond what the standup block already carries. "What today gave" reuses
 * `standup.today` on the client; this module adds the quiet-rule inputs
 * (newest activity today), the open sessions, and tomorrow's first move.
 *
 * The show/hide decision itself lives on the CLIENT (`wrapVisible` in
 * WrapCard.tsx) — the payload is cached, so a server-computed "show now"
 * boolean would freeze inside the cache.
 */
import { getDb } from './db';
import { displayNameFor } from './display-name';
import { getWorkingDays } from './user-config';
import type { Session } from './sessions';

export interface WrapOpenSession {
  workItemId: number;
  /** Pre-formatted `**title** (#id)`, or `#id` when the title is unknown. */
  displayName: string;
  startedAt: string;
}

export interface WrapFirstMove {
  workItemId: number;
  displayName: string;
  /** RemainingWork hours; null = unknown (render the line without hours). */
  remainingHours: number | null;
}

export interface WrapBlock {
  isWorkingDay: boolean;
  /** Newest session start/end/event today (ISO); null = nothing today. */
  lastActivityAt: string | null;
  stillOpen: WrapOpenSession[];
  firstMove: WrapFirstMove | null;
}

/** Per-item newest activity timestamp within today's local-day window. */
export interface WrapActivityRow {
  workItemId: number;
  lastTs: string;
}

interface ActivityQueryRow {
  work_item_id: number;
  last_ts: string;
}

export function isWorkingDayFor(now: Date): boolean {
  return getWorkingDays().has(now.getDay());
}

/**
 * Newest activity timestamp per work item for TODAY (local day): session
 * starts, session ends, and any session event. MAX() over the TEXT columns
 * is chronologically correct — every timestamp is `Date.toISOString()`
 * output (fixed-width UTC), the repo-wide convention.
 */
export function todayActivityRows(now: Date = new Date()): WrapActivityRow[] {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const s = dayStart.toISOString();
  const e = dayEnd.toISOString();
  const rows = getDb()
    .prepare<string[], ActivityQueryRow>(
      `SELECT work_item_id, MAX(ts) AS last_ts FROM (
         SELECT work_item_id, started_at AS ts FROM sessions
          WHERE datetime(started_at) >= datetime(?) AND datetime(started_at) < datetime(?)
         UNION ALL
         SELECT work_item_id, ended_at AS ts FROM sessions
          WHERE ended_at IS NOT NULL
            AND datetime(ended_at) >= datetime(?) AND datetime(ended_at) < datetime(?)
         UNION ALL
         SELECT work_item_id, created_at AS ts FROM session_events
          WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
       )
       GROUP BY work_item_id`,
    )
    .all(s, e, s, e, s, e);
  return rows.map(r => ({ workItemId: r.work_item_id, lastTs: r.last_ts }));
}

export function buildWrap(opts: {
  activityRows: WrapActivityRow[];
  activeSessions: Session[];
  titleFor: (workItemId: number) => string | null;
  /** True when the work item's REAL state is a done state right now. */
  isDone: (workItemId: number) => boolean;
  /** RemainingWork hours for the item; null when unknown. */
  remainingFor: (workItemId: number) => number | null;
  isWorkingDay: boolean;
}): WrapBlock {
  const displayName = (id: number) => displayNameFor(id, opts.titleFor(id));

  let lastActivityAt: string | null = null;
  for (const r of opts.activityRows) {
    if (lastActivityAt == null || r.lastTs > lastActivityAt) lastActivityAt = r.lastTs;
  }

  const stillOpen: WrapOpenSession[] = opts.activeSessions.map(sess => ({
    workItemId: sess.workItemId,
    displayName: displayName(sess.workItemId),
    startedAt: sess.startedAt,
  }));

  // Tomorrow's first move: the item touched LAST today that isn't done.
  const candidates = [...opts.activityRows]
    .filter(r => !opts.isDone(r.workItemId))
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
  const first = candidates[0];
  const firstMove: WrapFirstMove | null = first
    ? {
        workItemId: first.workItemId,
        displayName: displayName(first.workItemId),
        remainingHours: opts.remainingFor(first.workItemId),
      }
    : null;

  return { isWorkingDay: opts.isWorkingDay, lastActivityAt, stillOpen, firstMove };
}
