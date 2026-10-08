/**
 * Confirmed days off.
 *
 * The user's published Outlook feed shows days off only as all-day events
 * marked FREE — identical in the data to colleagues' vacations sitting in
 * the same calendar, and the published feed carries no organizer field
 * either (verified). So the code can never tell whose day off an all-day
 * entry is; the user has to confirm. The flow: orient asks about all-day
 * entries that overlap the sprint, the answer lands here, and capacity math
 * subtracts confirmed days off as WHOLE working days.
 *
 * Storage: two JSON values in the settings table.
 *   days_off                  — sorted ISO dates the user confirmed as off.
 *   days_off_dismissed_ranges — {start,end} ranges the user said are NOT
 *                               their day off, so the same calendar entry
 *                               never raises the question again.
 */
import { getSetting, setSetting } from './timers';
import { getWorkingDays } from './user-config';

const DAYS_OFF_KEY = 'days_off';
const DISMISSED_KEY = 'days_off_dismissed_ranges';

/** Local calendar date of a Date, as YYYY-MM-DD. */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Shift an ISO date by whole days (negative allowed). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toIsoDate(new Date(y, m - 1, d + days));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(s: string): void {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) {
    throw new Error(`"${s}" doesn't look like a date. Write it as YYYY-MM-DD, like 2026-08-27.`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error(`"${s}" isn't a real calendar date — check the month and the day.`);
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Store dates the user confirmed as their days off. Validates every date
 * first (nothing is written when any of them is junk), merges into the
 * stored set, and is idempotent — storing the same date twice keeps one.
 * Returns the FULL stored list after the merge, sorted.
 */
export function addDaysOff(dates: string[]): { stored: string[] } {
  for (const d of dates) assertIsoDate(d);
  const set = new Set(listDaysOff());
  for (const d of dates) set.add(d);
  const stored = [...set].sort();
  setSetting(DAYS_OFF_KEY, JSON.stringify(stored));
  return { stored };
}

/**
 * Take dates back out of the stored set. Returns only the dates that were
 * actually stored (asking to remove a date that was never there is not an
 * error — it just doesn't appear in `removed`).
 */
export function removeDaysOff(dates: string[]): { removed: string[] } {
  for (const d of dates) assertIsoDate(d);
  const set = new Set(listDaysOff());
  const removed: string[] = [];
  for (const d of dates) {
    if (set.delete(d)) removed.push(d);
  }
  setSetting(DAYS_OFF_KEY, JSON.stringify([...set].sort()));
  return { removed: removed.sort() };
}

/** All confirmed days off, sorted. */
export function listDaysOff(): string[] {
  const stored = readJson<string[]>(DAYS_OFF_KEY, []);
  return stored.filter(d => typeof d === 'string' && ISO_DATE.test(d)).sort();
}

/**
 * Remember "this calendar entry is NOT my day off" for one exact
 * {start,end} range, so the question never repeats for it. Both ends are
 * inclusive ISO dates.
 */
export function dismissRange(start: string, end: string): void {
  assertIsoDate(start);
  assertIsoDate(end);
  if (start > end) {
    throw new Error(
      `The range starts on ${start} but ends earlier, on ${end} — swap them around.`,
    );
  }
  const ranges = listDismissedRanges();
  if (ranges.some(r => r.start === start && r.end === end)) return; // already dismissed
  ranges.push({ start, end });
  ranges.sort((a, b) => (a.start === b.start ? (a.end < b.end ? -1 : 1) : a.start < b.start ? -1 : 1));
  setSetting(DISMISSED_KEY, JSON.stringify(ranges));
}

/** Ranges the user said are not their days off, sorted by start. */
export function listDismissedRanges(): { start: string; end: string }[] {
  const stored = readJson<{ start: string; end: string }[]>(DISMISSED_KEY, []);
  return stored.filter(
    r =>
      r != null &&
      typeof r.start === 'string' &&
      typeof r.end === 'string' &&
      ISO_DATE.test(r.start) &&
      ISO_DATE.test(r.end),
  );
}

/** The working days inside an inclusive ISO-date range. */
function workingDatesIn(start: string, end: string): string[] {
  const out: string[] = [];
  const workingDays = getWorkingDays();
  for (let iso = start; iso <= end; iso = addDaysIso(iso, 1)) {
    const [y, m, d] = iso.split('-').map(Number);
    if (workingDays.has(new Date(y, m - 1, d).getDay())) out.push(iso);
  }
  return out;
}

/**
 * The pure core of {@link candidateDayOffRanges}: same filtering, but the
 * dismissed ranges and the stored days off are handed in instead of read
 * from storage — so tests need no database.
 */
export function candidateDayOffRangesPure(
  allDay: { start: string; end: string }[],
  windowStart: string,
  windowEnd: string,
  dismissed: { start: string; end: string }[],
  storedDaysOff: string[],
): { start: string; end: string }[] {
  const stored = new Set(storedDaysOff);
  const dismissedKeys = new Set(dismissed.map(r => `${r.start}|${r.end}`));
  const seen = new Set<string>();
  const out: { start: string; end: string }[] = [];
  for (const r of allDay) {
    if (!ISO_DATE.test(r.start) || !ISO_DATE.test(r.end) || r.start > r.end) continue;
    if (r.start > windowEnd || r.end < windowStart) continue; // no overlap
    const key = `${r.start}|${r.end}`;
    if (seen.has(key)) continue; // identical ranges collapse to one
    seen.add(key);
    if (dismissedKeys.has(key)) continue; // the user already said "not mine"
    // A range whose working days are ALL confirmed already (or that holds no
    // working day at all — a Fri-Sat entry) has nothing left to ask about.
    const workDates = workingDatesIn(r.start, r.end);
    if (workDates.length === 0) continue;
    if (workDates.every(d => stored.has(d))) continue;
    out.push({ start: r.start, end: r.end });
  }
  out.sort((a, b) => (a.start === b.start ? (a.end < b.end ? -1 : 1) : a.start < b.start ? -1 : 1));
  return out;
}

/**
 * All-day calendar ranges worth asking the user about: they overlap the
 * [windowStart, windowEnd] window (inclusive ISO dates), the user hasn't
 * dismissed that exact range, and at least one of the range's working days
 * (in the configured week) isn't already stored as a day off. Identical ranges are merged.
 */
export function candidateDayOffRanges(
  allDay: { start: string; end: string }[],
  windowStart: string,
  windowEnd: string,
): { start: string; end: string }[] {
  return candidateDayOffRangesPure(
    allDay,
    windowStart,
    windowEnd,
    listDismissedRanges(),
    listDaysOff(),
  );
}
