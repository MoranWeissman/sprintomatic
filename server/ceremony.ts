/**
 * Ceremony schedule + "what's next" computation.
 *
 * Schedule is persisted as a single JSON blob in the existing `settings`
 * key/value table under `ceremony_schedule`. No new SQLite table needed.
 *
 * Recurrence kinds:
 *  - `weekdays`: every working day at a fixed HH:MM (used for the Daily).
 *    "Working day" follows the configured week (./user-config), shared
 *    with capacity + standup so they never disagree about which days count.
 *  - `sprint_relative`: anchored to the current sprint's start date — pick a
 *    week (1 or 2), a JS day-of-week (0=Sun .. 6=Sat), and an HH:MM.
 *
 * `computeUpcomingCeremonies` produces a flat, sorted list of upcoming
 * occurrences for the next N days. An entry is "suggested" if it's within
 * 15 minutes before its start time or up to 60 minutes after — this is what
 * the UI uses to highlight a recommended mode for the dashboard.
 *
 * All time math is done in the server's local timezone (The user's mac).
 */
import { getSetting, setSetting } from './timers';
import { getWorkingDays } from './user-config';

/**
 * Schedule entry ids — same ids the frontend uses for workspace modes.
 * (Mode "day" maps to the "Daily" event; the rest are 1:1.)
 */
export type CeremonyId = 'daily' | 'preplan' | 'plan' | 'demo' | 'retro';

/** Mode the dashboard switches into when this entry is suggested. */
export type ModeId = 'day' | 'preplan' | 'plan' | 'demo' | 'retro';

const REQUIRED_IDS: CeremonyId[] = ['daily', 'preplan', 'plan', 'demo', 'retro'];
const VALID_IDS: Set<string> = new Set<string>(REQUIRED_IDS);

export function modeForCeremony(id: CeremonyId): ModeId {
  return id === 'daily' ? 'day' : id;
}

export type CeremonyRecurrence =
  | { kind: 'weekdays'; time: string }
  | { kind: 'sprint_relative'; weekOfSprint: 1 | 2; dayOfWeek: number; time: string };

export interface CeremonyConfig {
  id: CeremonyId;
  label: string;
  enabled: boolean;
  recurrence: CeremonyRecurrence;
}

export interface CeremonySchedule {
  version: 1;
  ceremonies: CeremonyConfig[];
}

export interface UpcomingCeremony {
  id: CeremonyId;
  label: string;
  startsAt: string;
  minutesUntil: number;
  isSuggested: boolean;
}

const SETTINGS_KEY = 'ceremony_schedule';

const DEFAULT_SCHEDULE: CeremonySchedule = {
  version: 1,
  ceremonies: [
    {
      id: 'daily',
      label: 'Daily',
      enabled: true,
      recurrence: { kind: 'weekdays', time: '09:00' },
    },
    {
      id: 'preplan',
      label: 'Pre-planning',
      enabled: true,
      recurrence: { kind: 'sprint_relative', weekOfSprint: 2, dayOfWeek: 3, time: '14:00' },
    },
    {
      id: 'plan',
      label: 'Planning',
      enabled: true,
      recurrence: { kind: 'sprint_relative', weekOfSprint: 1, dayOfWeek: 1, time: '09:00' },
    },
    {
      id: 'demo',
      label: 'Demo',
      enabled: true,
      recurrence: { kind: 'sprint_relative', weekOfSprint: 2, dayOfWeek: 5, time: '11:00' },
    },
    {
      id: 'retro',
      label: 'Retro',
      enabled: true,
      recurrence: { kind: 'sprint_relative', weekOfSprint: 2, dayOfWeek: 5, time: '13:00' },
    },
  ],
};

/* ============================================================ */
/*  Persistence                                                   */
/* ============================================================ */

export function getCeremonySchedule(): CeremonySchedule {
  const raw = getSetting(SETTINGS_KEY);
  if (!raw) {
    setSetting(SETTINGS_KEY, JSON.stringify(DEFAULT_SCHEDULE));
    return cloneSchedule(DEFAULT_SCHEDULE);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    validateSchedule(parsed);
    return parsed as CeremonySchedule;
  } catch {
    // Corrupt or stale shape — fall back to defaults, but don't overwrite
    // the raw value so a human can inspect it later if needed.
    return cloneSchedule(DEFAULT_SCHEDULE);
  }
}

export function setCeremonySchedule(schedule: CeremonySchedule): void {
  validateSchedule(schedule);
  setSetting(SETTINGS_KEY, JSON.stringify(schedule));
}

function cloneSchedule(s: CeremonySchedule): CeremonySchedule {
  return JSON.parse(JSON.stringify(s)) as CeremonySchedule;
}

/* ============================================================ */
/*  Validation                                                    */
/* ============================================================ */

function validateSchedule(value: unknown): asserts value is CeremonySchedule {
  if (!value || typeof value !== 'object') {
    throw new Error('Schedule must be an object');
  }
  const s = value as Record<string, unknown>;
  if (s.version !== 1) {
    throw new Error('Schedule version must be 1');
  }
  if (!Array.isArray(s.ceremonies)) {
    throw new Error('Schedule.ceremonies must be an array');
  }

  const seenIds = new Set<string>();
  for (const item of s.ceremonies as unknown[]) {
    if (!item || typeof item !== 'object') {
      throw new Error('Each ceremony must be an object');
    }
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !VALID_IDS.has(c.id)) {
      throw new Error(`Unknown ceremony id: ${String(c.id)}`);
    }
    if (seenIds.has(c.id)) {
      throw new Error(`Duplicate ceremony id: ${c.id}`);
    }
    seenIds.add(c.id);
    if (typeof c.label !== 'string' || !c.label.trim()) {
      throw new Error(`Ceremony ${c.id}: label must be a non-empty string`);
    }
    if (typeof c.enabled !== 'boolean') {
      throw new Error(`Ceremony ${c.id}: enabled must be a boolean`);
    }
    validateRecurrence(c.id, c.recurrence);
  }

  const missing = REQUIRED_IDS.filter(id => !seenIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Missing required ceremony ids: ${missing.join(', ')}`);
  }
}

function validateRecurrence(id: string, value: unknown): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`Ceremony ${id}: recurrence must be an object`);
  }
  const r = value as Record<string, unknown>;
  if (r.kind === 'weekdays') {
    if (typeof r.time !== 'string' || !isValidHHMM(r.time)) {
      throw new Error(`Ceremony ${id}: time must be HH:MM`);
    }
    return;
  }
  if (r.kind === 'sprint_relative') {
    if (r.weekOfSprint !== 1 && r.weekOfSprint !== 2) {
      throw new Error(`Ceremony ${id}: weekOfSprint must be 1 or 2`);
    }
    if (typeof r.dayOfWeek !== 'number' || !Number.isInteger(r.dayOfWeek) || r.dayOfWeek < 0 || r.dayOfWeek > 6) {
      throw new Error(`Ceremony ${id}: dayOfWeek must be an integer 0-6`);
    }
    if (typeof r.time !== 'string' || !isValidHHMM(r.time)) {
      throw new Error(`Ceremony ${id}: time must be HH:MM`);
    }
    return;
  }
  throw new Error(`Ceremony ${id}: unknown recurrence kind`);
}

function isValidHHMM(s: string): boolean {
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
}

/* ============================================================ */
/*  Upcoming computation                                          */
/* ============================================================ */

interface ComputeArgs {
  sprintStart: Date | null;
  sprintFinish: Date | null;
  now: Date;
  lookaheadDays?: number;
}

export function computeUpcomingCeremonies(args: ComputeArgs): UpcomingCeremony[] {
  const lookaheadDays = args.lookaheadDays ?? 14;
  const schedule = getCeremonySchedule();
  const now = args.now;
  const horizon = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);

  const out: UpcomingCeremony[] = [];

  for (const c of schedule.ceremonies) {
    if (!c.enabled) continue;
    if (c.recurrence.kind === 'weekdays') {
      out.push(...enumerateWeekday(c, now, horizon));
    } else {
      // sprint_relative requires a sprint anchor; without one, skip silently.
      if (!args.sprintStart) continue;
      const projected = projectSprintRelative(c, args.sprintStart, now, horizon);
      for (const p of projected) out.push(p);
      // Optionally project the next sprint if its window overlaps the
      // lookahead — we make a best-effort assumption that sprints are
      // back-to-back 2-week cycles.
      if (args.sprintFinish) {
        const nextStart = new Date(args.sprintFinish.getTime() + 24 * 60 * 60 * 1000);
        if (nextStart.getTime() <= horizon.getTime()) {
          const projectedNext = projectSprintRelative(c, nextStart, now, horizon);
          for (const p of projectedNext) {
            // Avoid duplicates if both projections land on the same date.
            if (!out.some(o => o.id === p.id && o.startsAt === p.startsAt)) {
              out.push(p);
            }
          }
        }
      }
    }
  }

  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return out;
}

function enumerateWeekday(c: CeremonyConfig, now: Date, horizon: Date): UpcomingCeremony[] {
  if (c.recurrence.kind !== 'weekdays') return [];
  const time = c.recurrence.time;
  const result: UpcomingCeremony[] = [];

  // Walk from today (inclusive) day-by-day until horizon.
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const workingDays = getWorkingDays();
  while (cursor.getTime() <= horizon.getTime()) {
    const dow = cursor.getDay();
    if (workingDays.has(dow)) {
      const startsAt = applyTime(cursor, time);
      // Include past-today occurrences too — they may still be "suggested"
      // (within 60 min after start). Skip ones that have ended (older than
      // suggested window) AND are in the past beyond the suggestion grace.
      const minutesUntil = Math.round((startsAt.getTime() - now.getTime()) / 60000);
      if (minutesUntil >= -60) {
        result.push(makeUpcoming(c, startsAt, minutesUntil));
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function projectSprintRelative(
  c: CeremonyConfig,
  sprintStart: Date,
  now: Date,
  horizon: Date,
): UpcomingCeremony[] {
  if (c.recurrence.kind !== 'sprint_relative') return [];
  const target = resolveSprintRelativeDay(c.recurrence, sprintStart);
  const startsAt = applyTime(target, c.recurrence.time);

  // Only include if within lookahead window AND within suggestion grace.
  const minutesUntil = Math.round((startsAt.getTime() - now.getTime()) / 60000);
  if (startsAt.getTime() > horizon.getTime()) return [];
  if (minutesUntil < -60) return [];
  return [makeUpcoming(c, startsAt, minutesUntil)];
}

/**
 * The calendar day a sprint-relative entry lands on, for a given sprint
 * start: sprintStart + (weekOfSprint - 1) * 7 days, then advance forward to
 * the requested day of week.
 */
function resolveSprintRelativeDay(
  r: { weekOfSprint: 1 | 2; dayOfWeek: number },
  sprintStart: Date,
): Date {
  const anchor = new Date(
    sprintStart.getFullYear(),
    sprintStart.getMonth(),
    sprintStart.getDate() + (r.weekOfSprint - 1) * 7,
  );
  let delta = r.dayOfWeek - anchor.getDay();
  if (delta < 0) delta += 7;
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + delta);
}

function applyTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(n => Number(n));
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/* ============================================================ */
/*  Today's ceremonies (for the orient greeting)                  */
/* ============================================================ */

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The HH:MM an enabled entry starts today, or null when it doesn't land on
 * today's date. For sprint-relative entries we also project the next sprint
 * (assumed back-to-back, same as computeUpcomingCeremonies) so a meeting on
 * the first day after the sprint ends isn't missed.
 */
function todayTimeFor(
  c: CeremonyConfig,
  sprintStart: Date | null,
  sprintFinish: Date | null,
  now: Date,
): string | null {
  if (c.recurrence.kind === 'weekdays') {
    return getWorkingDays().has(now.getDay()) ? c.recurrence.time : null;
  }
  if (!sprintStart) return null;
  const anchors = [sprintStart];
  if (sprintFinish) {
    anchors.push(
      new Date(sprintFinish.getFullYear(), sprintFinish.getMonth(), sprintFinish.getDate() + 1),
    );
  }
  for (const anchor of anchors) {
    if (sameLocalDay(resolveSprintRelativeDay(c.recurrence, anchor), now)) {
      return c.recurrence.time;
    }
  }
  return null;
}

/**
 * One pre-formatted plain-English sentence naming every enabled ceremony that
 * falls on today's date — or null when none does. Pure: the caller hands in
 * the schedule and the sprint window, so tests need no settings table. The
 * orient packet ships this verbatim; the plan ceremony gets an extra nudge
 * because the Plan page is built for that meeting.
 */
export function ceremonyTodayLine(
  schedule: CeremonySchedule,
  sprintStart: Date | null,
  sprintFinish: Date | null,
  now: Date,
): string | null {
  const hits: Array<{ time: string; text: string }> = [];
  for (const c of schedule.ceremonies) {
    if (!c.enabled) continue;
    // The daily happens every working day — announcing it every morning
    // would turn the one ceremony reminder the user gets into wallpaper.
    // Only the rare ones (planning, demo, retro, pre-planning) speak.
    if (c.id === 'daily') continue;
    const time = todayTimeFor(c, sprintStart, sprintFinish, now);
    if (!time) continue;
    const text =
      c.id === 'plan'
        ? `Planning is today at ${time} — the Plan page is ready for it.`
        : `${c.label} is today at ${time}.`;
    hits.push({ time, text });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.time.localeCompare(b.time));
  return hits.map(h => h.text).join(' ');
}

function makeUpcoming(c: CeremonyConfig, startsAt: Date, minutesUntil: number): UpcomingCeremony {
  // Suggested: within 15 min before start OR within 60 min after start.
  const isSuggested = minutesUntil <= 15 && minutesUntil >= -60;
  return {
    id: c.id,
    label: c.label,
    startsAt: startsAt.toISOString(),
    minutesUntil,
    isSuggested,
  };
}
