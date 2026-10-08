/**
 * Capacity math (slice R5).
 *
 * Given a sprint window, computes:
 *   working_hours_total  = working_days × workday_hours
 *   meeting_hours        = BUSY + OOF, clipped to the working window
 *                          (the configured workday window on working
 *                          days) so an all-day meeting doesn't steal 24
 *                          hours. TENTATIVE counts at the configured weight
 *                          (default 0 — ignored).
 * The week itself (days, hours, window, tentative weight) comes from
 * ./user-config, shared with effort math so the two agree about a "day".
 *   available_hours      = working_hours_total - meeting_hours
 *   difference           = planned_hours - available_hours
 *
 * Returns sensible defaults if no calendar URL is configured (available
 * hours = working hours total, hasUrl=false). Errors during fetch are
 * surfaced — never silently swallowed.
 */
import { listBusyInWindow, getCalendarUrl, type BusyInterval } from './calendar';
import { listDaysOff, toIsoDate } from './days-off';
import {
  getTentativeWeight,
  getWorkdayEndHour,
  getWorkdayHours,
  getWorkdayStartHour,
  getWorkingDays,
} from './user-config';

export interface Capacity {
  sprintStart: string;
  sprintEnd: string;
  workingDays: number;
  /**
   * Working days from today (inclusive, if today is a workday) through
   * sprintEnd. 0 once the sprint is over. Use this for "days left" reads on
   * the dashboard — counts only the configured working days.
   */
  workingDaysRemaining: number;
  workdayHours: number;
  workingHoursTotal: number;
  /** workingDaysRemaining × workdayHours — working hours left from today on. */
  workingHoursRemaining: number;
  meetingHours: {
    busy: number;
    tentative: number;
    oof: number;
    weighted: number;
  };
  availableHours: number;
  /**
   * Real desk time STILL AHEAD: remaining working hours minus only the meetings
   * that are still in the future. This is the number that visibly counts down
   * as the sprint progresses (vs availableHours, which is the whole-sprint figure).
   */
  availableHoursRemaining: number;
  /**
   * Confirmed days off inside this sprint that land on working days
   * (a working day). Each one is subtracted from the sprint as a WHOLE working
   * day, and its meetings are dropped too — see server/days-off.ts for
   * where the confirmations come from.
   */
  daysOff: number;
  plannedHours: number;
  difference: number;
  hasUrl: boolean;
  fetchError?: string;
}

export interface ComputeCapacityOptions {
  sprintStart: Date;
  sprintEnd: Date;
  plannedHours: number;
  /** Defaults come from ./user-config; tests hand in their own. */
  workingDays?: ReadonlySet<number>;
  workdayHours?: number;
  workdayStartHour?: number;
  workdayEndHour?: number;
  /** "Now" for the workingDaysRemaining count. Defaults to new Date(). */
  now?: Date;
  /**
   * Confirmed days off as ISO dates (YYYY-MM-DD). Defaults to the stored
   * list from server/days-off.ts; tests hand in their own.
   */
  daysOffDates?: string[];
}

export async function computeCapacity(opts: ComputeCapacityOptions): Promise<Capacity> {
  const workdaySet = opts.workingDays ?? getWorkingDays();
  const workdayHours = opts.workdayHours ?? getWorkdayHours();
  const workdayStart = opts.workdayStartHour ?? getWorkdayStartHour();
  const workdayEnd = opts.workdayEndHour ?? getWorkdayEndHour();
  const tentativeWeight = getTentativeWeight();
  const now = opts.now ?? new Date();

  // Confirmed days off. Belt and braces on the stored read: a surprise from
  // the settings table must not cost the capacity numbers — no days off is
  // the safe fallback.
  let storedDaysOff: string[];
  if (opts.daysOffDates) {
    storedDaysOff = opts.daysOffDates;
  } else {
    try {
      storedDaysOff = listDaysOff();
    } catch {
      storedDaysOff = [];
    }
  }
  const sprintStartIso = toIsoDate(opts.sprintStart);
  const sprintEndIso = toIsoDate(opts.sprintEnd);
  const todayIso = toIsoDate(now);
  // Only days off that actually change the math count: inside the sprint AND
  // on a working day (a day off on a Friday was never counted anyway).
  const dayOffDates = new Set<string>();
  for (const d of storedDaysOff) {
    if (d < sprintStartIso || d > sprintEndIso) continue;
    const [y, m, dd] = d.split('-').map(Number);
    if (!workdaySet.has(new Date(y, m - 1, dd).getDay())) continue;
    dayOffDates.add(d);
  }
  const daysOff = dayOffDates.size;

  const workingDays = Math.max(
    0,
    countWorkingDays(opts.sprintStart, opts.sprintEnd, workdaySet) - daysOff,
  );
  const workingHoursTotal = workingDays * workdayHours;

  // Remaining working days = count from today (clamped into the sprint
  // window) through sprintEnd, minus days off that are today or later.
  // If today is past sprintEnd, this is 0.
  const remainingStart = now > opts.sprintStart ? now : opts.sprintStart;
  const daysOffRemaining = [...dayOffDates].filter(d => d >= todayIso).length;
  const workingDaysRemaining =
    now > opts.sprintEnd
      ? 0
      : Math.max(0, countWorkingDays(remainingStart, opts.sprintEnd, workdaySet) - daysOffRemaining);
  const workingHoursRemaining = workingDaysRemaining * workdayHours;

  const baseResult: Capacity = {
    sprintStart: opts.sprintStart.toISOString(),
    sprintEnd: opts.sprintEnd.toISOString(),
    workingDays,
    workingDaysRemaining,
    workdayHours,
    workingHoursTotal,
    workingHoursRemaining,
    meetingHours: { busy: 0, tentative: 0, oof: 0, weighted: 0 },
    availableHours: workingHoursTotal,
    availableHoursRemaining: workingHoursRemaining,
    daysOff,
    plannedHours: opts.plannedHours,
    difference: opts.plannedHours - workingHoursTotal,
    hasUrl: getCalendarUrl() != null,
  };

  if (!baseResult.hasUrl) return baseResult;

  let intervals: BusyInterval[];
  try {
    intervals = await listBusyInWindow(opts.sprintStart, opts.sprintEnd);
  } catch (e) {
    return {
      ...baseResult,
      fetchError: e instanceof Error ? e.message : String(e),
    };
  }

  let busyMins = 0;
  let tentativeMins = 0;
  let oofMins = 0;
  // Same buckets but only counting the portion of each meeting still ahead of
  // `now`, so we can work out desk time that's actually still available.
  let remBusyMins = 0;
  let remTentativeMins = 0;
  let remOofMins = 0;
  for (const iv of intervals) {
    const clippedMins = clipToWorkingHours(iv.start, iv.end, workdaySet, workdayStart, workdayEnd, dayOffDates);
    if (iv.busyStatus === 'BUSY') busyMins += clippedMins;
    else if (iv.busyStatus === 'TENTATIVE') tentativeMins += clippedMins;
    else if (iv.busyStatus === 'OOF') oofMins += clippedMins;

    const remStart = iv.start < now ? now : iv.start;
    if (remStart < iv.end) {
      const remMins = clipToWorkingHours(remStart, iv.end, workdaySet, workdayStart, workdayEnd, dayOffDates);
      if (iv.busyStatus === 'BUSY') remBusyMins += remMins;
      else if (iv.busyStatus === 'TENTATIVE') remTentativeMins += remMins;
      else if (iv.busyStatus === 'OOF') remOofMins += remMins;
    }
  }

  const busy = busyMins / 60;
  const tentative = tentativeMins / 60;
  const oof = oofMins / 60;
  const weighted = busy + tentative * tentativeWeight + oof;
  const availableHours = Math.max(0, workingHoursTotal - weighted);

  const weightedRemaining = remBusyMins / 60 + (remTentativeMins / 60) * tentativeWeight + remOofMins / 60;
  const availableHoursRemaining = Math.max(0, workingHoursRemaining - weightedRemaining);

  return {
    ...baseResult,
    meetingHours: { busy, tentative, oof, weighted },
    availableHours,
    availableHoursRemaining,
    difference: opts.plannedHours - availableHours,
  };
}

export function countWorkingDays(start: Date, end: Date, workdaySet: ReadonlySet<number>): number {
  let n = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(23, 59, 59, 999);
  while (cursor <= stop) {
    if (workdaySet.has(cursor.getDay())) n++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return n;
}

/**
 * Intersect an event with the working window (workdayStart..workdayEnd local)
 * across only working days. Returns total intersected minutes.
 */
export function clipToWorkingHours(
  start: Date,
  end: Date,
  workdaySet: ReadonlySet<number>,
  workdayStartHour: number,
  workdayEndHour: number,
  /** Calendar dates (YYYY-MM-DD, local) to skip entirely — confirmed days
   *  off. A meeting on a day that no longer exists must not ALSO punish the
   *  meeting hours. */
  excludedDates?: Set<string>,
): number {
  let totalMins = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    if (workdaySet.has(cursor.getDay()) && !excludedDates?.has(toIsoDate(cursor))) {
      const dayStart = new Date(cursor);
      dayStart.setHours(workdayStartHour, 0, 0, 0);
      const dayEnd = new Date(cursor);
      dayEnd.setHours(workdayEndHour, 0, 0, 0);
      const overlapStart = start > dayStart ? start : dayStart;
      const overlapEnd = end < dayEnd ? end : dayEnd;
      if (overlapEnd > overlapStart) {
        totalMins += (overlapEnd.getTime() - overlapStart.getTime()) / 60000;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return totalMins;
}
