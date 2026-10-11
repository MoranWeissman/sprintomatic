import { describe, it, expect } from 'vitest';
import type { UsualHours } from './work-hours';
import { hoursText, quietWorkDays, taskCheckup, type CheckupInput, type CheckupSession } from './task-checkup';

// Sun–Thu work week, Fri + Sat off. Local dates on purpose: the check counts
// days the way the user's clock sees them.
const SUN_THU = new Set([0, 1, 2, 3, 4]);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m); // Oct 2026: the 4th is a Sunday

function session(start: Date, end: Date | null, extra: Partial<CheckupSession> = {}): CheckupSession {
  return { start, end, activity: [], stuck: false, ...extra };
}

function input(over: Partial<CheckupInput>): CheckupInput {
  return {
    now: at(13, 10), // Tue
    workItemId: 100001,
    title: 'Example task',
    estimate: 4,
    remaining: 2,
    workedHours: 2,
    sessions: [session(at(6, 9), at(6, 11))], // Tue the week before
    workingDays: SUN_THU,
    daysOff: new Set(),
    usual: null,
    ...over,
  };
}

describe('hoursText', () => {
  it('reads like people talk', () => {
    expect(hoursText(0.75)).toBe('45m');
    expect(hoursText(2)).toBe('2h');
    expect(hoursText(2.5)).toBe('2h 30m');
    expect(hoursText(0.01)).toBe('5m');
  });
});

describe('quietWorkDays', () => {
  it('a weekend does not count', () => {
    // Thu evening → Sun morning: Fri and Sat are off, Sun isn't over yet.
    expect(quietWorkDays(at(8, 18), at(11, 10), SUN_THU, new Set())).toBe(0);
  });

  it('a day off does not count', () => {
    // Sun → Wed: Mon and Tue in between, Mon is a day off.
    expect(quietWorkDays(at(4, 10), at(7, 10), SUN_THU, new Set(['2026-10-05']))).toBe(1);
  });
});

describe('taskCheckup', () => {
  it('says nothing while a session is open', () => {
    expect(taskCheckup(input({ sessions: [session(at(6, 9), null)] }))).toBeNull();
  });

  it('says nothing after only a weekend', () => {
    expect(taskCheckup(input({ now: at(11, 10), sessions: [session(at(8, 9), at(8, 11))] }))).toBeNull();
  });

  it('asks about a task with no work logged at all', () => {
    expect(taskCheckup(input({ sessions: [] }))).toContain('no work on it has been logged here');
  });

  it('asks whether it is still stuck', () => {
    const text = taskCheckup(input({ sessions: [session(at(6, 9), at(6, 11), { stuck: true })] }));
    expect(text).toContain('it was stuck when you last left it');
    expect(text).toContain('mark it Blocked');
  });

  it('notices no time was logged', () => {
    expect(taskCheckup(input({ workedHours: 0 }))).toContain('no time is logged on it yet');
  });

  it('asks for hours when Remaining is empty', () => {
    expect(taskCheckup(input({ remaining: null }))).toContain('Remaining is empty');
  });

  it('says it is bigger than planned', () => {
    expect(taskCheckup(input({ estimate: 2, workedHours: 2.5, remaining: 1 }))).toContain('bigger than planned');
  });

  it('suggests a number when Remaining never went down', () => {
    const text = taskCheckup(input({ estimate: 4, remaining: 4, workedHours: 1 }));
    expect(text).toContain('About 3h left would fit your plan of 4h');
  });

  it('points out a timer left on overnight', () => {
    const text = taskCheckup(input({ sessions: [session(at(6, 23, 43), at(7, 7, 45))], now: at(12, 10) }));
    expect(text).toContain('One timer stayed on from Tue 23:43 to Wed 07:45');
    expect(text).toContain('only 2h of that counts');
  });

  it('a timer left on outside usual hours counts nothing', () => {
    const usual: UsualHours = { hours: new Set([9, 10, 11, 12, 13, 14, 15, 16]), workingDays: SUN_THU, daysOff: new Set() };
    const text = taskCheckup(input({ usual, sessions: [session(at(6, 23, 43), at(7, 7, 45))], now: at(12, 10) }));
    expect(text).toContain("That's outside your usual hours (09:00–17:00), so none of it counts.");
  });

  it('counts the quiet days in work days', () => {
    // Last touched Tue the 6th; now Tue the 13th → Wed, Thu, Sun, Mon = 4.
    expect(taskCheckup(input({}))).toContain('for 4 work days');
  });
});
