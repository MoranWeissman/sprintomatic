import { describe, it, expect } from 'vitest';
import { learnUsualHours, usualMsBetween, usualHoursText, quietCountMs, MIN_ACTIVE_DAYS, type UsualHours } from './work-hours';

const SUN_THU = new Set([0, 1, 2, 3, 4]);
const HOUR = 60 * 60 * 1000;
// Oct 2026: the 4th is a Sunday. Local time on purpose.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

/** Work days only: Sun–Thu of the weeks starting the 4th, 11th, 18th. */
const WORK_DAYS = [4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 18, 19];

describe('learnUsualHours', () => {
  it('learns the daytime hours and ignores one late night', () => {
    const activity = WORK_DAYS.flatMap(d => [at(d, 9, 30), at(d, 13), at(d, 16, 10)]);
    activity.push(at(6, 23, 30));
    expect([...learnUsualHours(activity, SUN_THU)!].sort((a, b) => a - b)).toEqual([9, 13, 16]);
  });

  it('days off the work week are not learned from', () => {
    const activity = WORK_DAYS.map(d => at(d, 10));
    activity.push(at(9, 2), at(10, 2), at(16, 2), at(17, 2)); // Fri + Sat nights
    expect([...learnUsualHours(activity, SUN_THU)!]).toEqual([10]);
  });

  it('too little history → nothing learned', () => {
    const activity = WORK_DAYS.slice(0, MIN_ACTIVE_DAYS - 1).map(d => at(d, 10));
    expect(learnUsualHours(activity, SUN_THU)).toBeNull();
  });
});

describe('counting a quiet stretch', () => {
  const usual: UsualHours = { hours: new Set([9, 10, 11, 12, 13, 14, 15, 16]), workingDays: SUN_THU, daysOff: new Set() };

  it('only the part inside usual hours counts', () => {
    // Tue 15:00 → 19:00: 15:00–17:00 is usual.
    expect(usualMsBetween(at(6, 15).getTime(), at(6, 19).getTime(), usual)).toBe(2 * HOUR);
  });

  it('a timer left on overnight into a day off counts nothing', () => {
    // Thu 23:43 → Fri 07:45.
    expect(quietCountMs(at(8, 23, 43).getTime(), at(9, 7, 45).getTime(), 2 * HOUR, usual)).toBe(0);
  });

  it('never more than the cap', () => {
    expect(quietCountMs(at(6, 9).getTime(), at(6, 16).getTime(), 2 * HOUR, usual)).toBe(2 * HOUR);
  });

  it('without usual hours it keeps the plain cap', () => {
    expect(quietCountMs(at(8, 23, 43).getTime(), at(9, 7, 45).getTime(), 2 * HOUR, null)).toBe(2 * HOUR);
  });

  it('a confirmed day off counts nothing', () => {
    const off = { ...usual, daysOff: new Set(['2026-10-06']) };
    expect(usualMsBetween(at(6, 9).getTime(), at(6, 17).getTime(), off)).toBe(0);
  });
});

describe('usualHoursText', () => {
  it('reads as ranges', () => {
    expect(usualHoursText(new Set([9, 10, 11, 12, 13, 14, 15, 16]))).toBe('09:00–17:00');
    expect(usualHoursText(new Set([9, 10, 14, 15]))).toBe('09:00–11:00, 14:00–16:00');
  });
});
