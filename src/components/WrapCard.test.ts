import { describe, it, expect } from 'vitest';
import { wrapVisible } from './WrapCard';

// Local-time constructor: month is 0-based.
const at = (h: number, m = 0) => new Date(2026, 6, 5, h, m, 0);

const base = { isWorkingDay: true, workedToday: true, workdayEndHour: 18 };

describe('wrapVisible', () => {
  it('shows in the last hour of the workday', () => {
    expect(wrapVisible({ ...base, now: at(17, 0) })).toBe(true);
    expect(wrapVisible({ ...base, now: at(17, 45) })).toBe(true);
  });

  it('stays hidden in the afternoon before that', () => {
    expect(wrapVisible({ ...base, now: at(16, 59) })).toBe(false);
    expect(wrapVisible({ ...base, now: at(14, 0) })).toBe(false);
  });

  it('still shows after the workday ended', () => {
    expect(wrapVisible({ ...base, now: at(21, 0) })).toBe(true);
  });

  it('follows the end hour from settings', () => {
    expect(wrapVisible({ ...base, workdayEndHour: 16, now: at(15, 0) })).toBe(true);
    expect(wrapVisible({ ...base, workdayEndHour: 16, now: at(14, 59) })).toBe(false);
  });

  it('uses 17:00 when an older payload has no end hour', () => {
    expect(wrapVisible({ isWorkingDay: true, workedToday: true, now: at(16, 0) })).toBe(true);
    expect(wrapVisible({ isWorkingDay: true, workedToday: true, now: at(15, 59) })).toBe(false);
  });

  it('hidden on a day off or a day with no work', () => {
    expect(wrapVisible({ ...base, isWorkingDay: false, now: at(17, 30) })).toBe(false);
    expect(wrapVisible({ ...base, workedToday: false, now: at(17, 30) })).toBe(false);
  });
});
