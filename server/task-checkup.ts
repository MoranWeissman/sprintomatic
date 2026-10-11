/**
 * The note for a task that has gone quiet: what really happened, and one
 * suggestion with a real number. Pure — helper-notes.ts reads the database
 * and passes everything in.
 *
 * It answers the questions a person would ask before nagging:
 *   - Were those quiet days work days? A weekend or a day off doesn't count.
 *   - Was the task stuck when the user left it? Then ask about that, not hours.
 *   - Did a timer stay on with nothing logged (a forgotten pause)? Then say
 *     how much of it was counted, so the hours below are read with care.
 *   - What do the hours say? Worked time against the first estimate and
 *     Remaining gives a number to suggest, instead of "update Remaining".
 *
 * It only suggests. The board belongs to the user; nothing here changes it.
 */
import { toIsoDate } from './days-off';
import { displayNameFor } from './display-name';
import { STALE_IDLE_MINUTES } from './session-activity';

/** How many full work days of nothing before the note is worth writing. */
export const QUIET_WORK_DAYS = 2;

/** Same cap the timers use: a quiet stretch counts this much at most. */
const MAX_QUIET_MS = STALE_IDLE_MINUTES * 60 * 1000;

/** Under this much worked time, the task counts as not started. */
const STARTED_HOURS = 0.25;

/** How far back to look for a timer left on. Older ones are old news. */
const FORGOTTEN_LOOKBACK_DAYS = 14;

export interface CheckupSession {
  start: Date;
  /** null while the session is still open. */
  end: Date | null;
  /** When something was logged in it (progress, blocker, …). */
  activity: Date[];
  /** It logged a blocker or said it was waiting on someone. */
  stuck: boolean;
}

export interface CheckupInput {
  now: Date;
  workItemId: number;
  title: string;
  estimate: number | null;
  remaining: number | null;
  /** Time counted on this task so far, in hours (quiet stretches capped). */
  workedHours: number;
  /** Every session on this task, any order. */
  sessions: CheckupSession[];
  /** Weekdays the user works, 0 = Sunday. */
  workingDays: ReadonlySet<number>;
  /** Confirmed days off, as yyyy-mm-dd. */
  daysOff: ReadonlySet<string>;
}

/** Hours as people say them: 45m, 2h, 2h 30m. Rounded to 5 minutes. */
export function hoursText(h: number): string {
  const mins = Math.round((h * 60) / 5) * 5;
  if (mins < 60) return `${Math.max(mins, 5)}m`;
  const whole = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${whole}h` : `${whole}h ${rest}m`;
}

/** "Thu 23:43", in local time. */
function whenText(d: Date): string {
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Full work days between two moments: the days after `from`'s day and
 * before `to`'s day. Today isn't over, so it doesn't count yet.
 */
export function quietWorkDays(
  from: Date,
  to: Date,
  workingDays: ReadonlySet<number>,
  daysOff: ReadonlySet<string>,
): number {
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  const stop = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  let n = 0;
  while (day < stop) {
    if (workingDays.has(day.getDay()) && !daysOff.has(toIsoDate(day))) n++;
    day.setDate(day.getDate() + 1);
  }
  return n;
}

/** The longest stretch where a timer ran with nothing logged, past the cap. */
export function longestForgottenStretch(
  sessions: CheckupSession[],
  now: Date,
): { from: Date; to: Date } | null {
  const since = now.getTime() - FORGOTTEN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let best: { from: Date; to: Date } | null = null;
  for (const s of sessions) {
    if (!s.end || s.end.getTime() < since) continue;
    const points = [s.start, ...s.activity.filter(a => a > s.start && a < s.end!), s.end].sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    for (let i = 1; i < points.length; i++) {
      const gap = points[i].getTime() - points[i - 1].getTime();
      if (gap > MAX_QUIET_MS && (!best || gap > best.to.getTime() - best.from.getTime())) {
        best = { from: points[i - 1], to: points[i] };
      }
    }
  }
  return best;
}

/** The newest moment anything happened on the task. */
function lastActivity(sessions: CheckupSession[]): Date | null {
  let last: Date | null = null;
  for (const s of sessions) {
    for (const t of [s.start, s.end, ...s.activity]) {
      if (t && (!last || t > last)) last = t;
    }
  }
  return last;
}

/**
 * The note to write, or null when there is nothing worth saying: the task is
 * being worked on right now, or it hasn't been quiet for long enough.
 */
export function taskCheckup(input: CheckupInput): string | null {
  const { now, sessions, estimate, remaining, workedHours } = input;
  if (sessions.some(s => s.end == null)) return null;

  const name = displayNameFor(input.workItemId, input.title);
  const last = lastActivity(sessions);

  if (!last) {
    return `${name} is in progress on the board, but no work on it has been logged here. Are you still on it? If not, move it back or to the next sprint.`;
  }

  const quiet = quietWorkDays(last, now, input.workingDays, input.daysOff);
  if (quiet < QUIET_WORK_DAYS) return null;

  const since = `Nothing has happened on ${name} for ${quiet} work days`;
  const newest = [...sessions].sort((a, b) => b.start.getTime() - a.start.getTime())[0];

  if (newest.stuck) {
    return `${since}, and it was stuck when you last left it (${whenText(last)}). Is it still stuck? If yes, mark it Blocked on the board. If not, pick it back up or move it to the next sprint.`;
  }

  if (workedHours < STARTED_HOURS) {
    return `${since}, and no time is logged on it yet. Still planning to do it this sprint? If not, move it to the next sprint.`;
  }

  const worked = hoursText(workedHours);
  let hours: string;
  if (remaining == null) {
    hours = `You've put about ${worked} into it, but Remaining is empty on the board. How many hours are left?`;
  } else if (estimate != null && workedHours >= estimate && remaining > 0) {
    hours = `You've put about ${worked} into it. That's already the whole ${hoursText(estimate)} you planned, and Remaining still says ${hoursText(remaining)}. So it's bigger than planned. How many hours are really left?`;
  } else if (estimate != null && remaining >= estimate) {
    const fits = Math.max(0.5, Math.round((estimate - workedHours) * 2) / 2);
    hours = `You've put about ${worked} into it, but Remaining still says ${hoursText(remaining)}. About ${hoursText(fits)} left would fit your plan of ${hoursText(estimate)}. Tell me the real number and I'll update the board.`;
  } else {
    hours = `It still has ${hoursText(remaining)} left. Pick it back up, or move it to the next sprint?`;
  }

  const stretch = longestForgottenStretch(sessions, now);
  const timer = stretch
    ? ` One timer stayed on from ${whenText(stretch.from)} to ${whenText(stretch.to)} with nothing logged, so only ${hoursText(MAX_QUIET_MS / 3_600_000)} of that counts.`
    : '';

  return `${since}. ${hours}${timer}`;
}
