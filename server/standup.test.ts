import { describe, it, expect } from 'vitest';
import { previousWorkingDayStart } from './standup';

// June 7 2026 is a Sunday. Mon=8, ..., Thu=4 (Jun 4), Fri=Jun 5, Sat=Jun 6.
const startOfDay = (y: number, m: number, day: number) => new Date(y, m - 1, day, 0, 0, 0, 0);

describe('previousWorkingDayStart (Sun-Thu)', () => {
  it('on a Sunday reaches back over the weekend to Thursday', () => {
    const prev = previousWorkingDayStart(startOfDay(2026, 6, 7)); // Sunday
    expect(prev.getDay()).toBe(4); // Thursday
    expect(prev.getMonth()).toBe(5); // June (0-based)
    expect(prev.getDate()).toBe(4); // Jun 4
  });

  it('on a Monday returns the prior Sunday (a working day)', () => {
    const prev = previousWorkingDayStart(startOfDay(2026, 6, 8)); // Monday
    expect(prev.getDay()).toBe(0); // Sunday
    expect(prev.getDate()).toBe(7); // Jun 7
  });

  it('mid-week returns the literal previous day', () => {
    const prev = previousWorkingDayStart(startOfDay(2026, 6, 10)); // Wednesday
    expect(prev.getDay()).toBe(2); // Tuesday
    expect(prev.getDate()).toBe(9); // Jun 9
  });
});
