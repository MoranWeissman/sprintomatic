/**
 * The user's usual work hours, learned from when they really log things.
 *
 * Used for one question: a timer ran for a long stretch with nothing logged.
 * Was that work, or a timer left on overnight? Only the part of the stretch
 * inside the usual hours, on a work day, can be work.
 *
 * The rule is plain on purpose, so a note can say why it counted what it
 * counted: an hour of the day is "usual" when something was logged in it on
 * at least 1 in 4 of the work days with any activity. One late night doesn't
 * move it. Too little history → no usual hours, and callers keep the plain
 * 2h rule.
 */
import { getDb } from './db';
import { listDaysOff, toIsoDate } from './days-off';
import { getWorkingDays } from './user-config';

/** How far back to learn from. Old habits stop counting. */
const LEARN_DAYS = 60;

/** Fewer active work days than this, and there's nothing to learn yet. */
export const MIN_ACTIVE_DAYS = 10;

/** An hour is usual when it was active on at least this share of the days. */
const USUAL_SHARE = 0.25;

const HOUR_MS = 60 * 60 * 1000;

export interface UsualHours {
  /** Hours of the day (0–23, local time) that count as usual. */
  hours: ReadonlySet<number>;
  workingDays: ReadonlySet<number>;
  /** Confirmed days off, as yyyy-mm-dd. */
  daysOff: ReadonlySet<string>;
}

/** The usual hours from a list of activity times, or null when too few. Pure. */
export function learnUsualHours(activity: Date[], workingDays: ReadonlySet<number>): Set<number> | null {
  const daysByHour = new Map<number, Set<string>>();
  const days = new Set<string>();
  for (const t of activity) {
    if (!workingDays.has(t.getDay())) continue;
    const day = toIsoDate(t);
    days.add(day);
    const set = daysByHour.get(t.getHours()) ?? new Set<string>();
    set.add(day);
    daysByHour.set(t.getHours(), set);
  }
  if (days.size < MIN_ACTIVE_DAYS) return null;
  const hours = new Set<number>();
  for (const [h, set] of daysByHour) if (set.size >= days.size * USUAL_SHARE) hours.add(h);
  return hours.size > 0 ? hours : null;
}

/** How much of a stretch falls inside the usual hours on a work day. Pure. */
export function usualMsBetween(fromMs: number, toMs: number, usual: UsualHours): number {
  let total = 0;
  let t = fromMs;
  while (t < toMs) {
    const d = new Date(t);
    const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    const end = Math.min(nextHour, toMs);
    if (usual.hours.has(d.getHours()) && usual.workingDays.has(d.getDay()) && !usual.daysOff.has(toIsoDate(d))) {
      total += end - t;
    }
    t = end;
  }
  return total;
}

/** "09:00–17:00", or a list when the hours have gaps. Pure. */
export function usualHoursText(hours: ReadonlySet<number>): string {
  const sorted = [...hours].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const h of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else runs.push([h, h + 1]);
  }
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return runs.map(([a, b]) => `${hh(a)}–${hh(b)}`).join(', ');
}

/** Hours, for a stretch, that a quiet timer may count: inside usual hours,
 *  at most `maxMs`. Without learned hours, the whole stretch up to `maxMs`. */
export function quietCountMs(fromMs: number, toMs: number, maxMs: number, usual: UsualHours | null): number {
  const span = Math.max(0, toMs - fromMs);
  return Math.min(maxMs, usual ? usualMsBetween(fromMs, toMs, usual) : span);
}

/** The user's usual hours from the local record, or null when too little. */
export function getUsualHours(now = new Date()): UsualHours | null {
  const since = new Date(now.getTime() - LEARN_DAYS * 24 * HOUR_MS).toISOString();
  const rows = getDb()
    .prepare<[string, string], { at: string }>(
      `SELECT created_at AS at FROM session_events WHERE created_at > ?
       UNION ALL SELECT started_at AS at FROM sessions WHERE started_at > ?`,
    )
    .all(since, since);
  const workingDays = getWorkingDays();
  const hours = learnUsualHours(rows.map(r => new Date(r.at)), workingDays);
  if (!hours) return null;
  return { hours, workingDays, daysOff: new Set(listDaysOff()) };
}
