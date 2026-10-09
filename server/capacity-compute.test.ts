import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the calendar feed (URL presence + the busy intervals) so
// computeCapacity runs hermetically. The week itself (9h, Sun-Thu,
// 08:00-18:00) is pinned for every test in vitest.setup.ts.
const { intervals } = vi.hoisted(() => ({ intervals: { value: [] as unknown[] } }));

vi.mock('./calendar', () => ({
  getCalendarUrl: () => 'https://example.com/calendar.ics',
  listBusyInWindow: async () => intervals.value,
}));
// Days off default to the stored list (a real SQLite read) — pin it empty so
// these tests stay hermetic; specific tests pass daysOffDates explicitly.
vi.mock('./days-off', () => ({
  listDaysOff: () => [],
  toIsoDate: (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
}));

import { computeCapacity } from './capacity';

const mtg = (
  y: number,
  m: number,
  day: number,
  startH: number,
  endH: number,
  busyStatus: 'BUSY' | 'TENTATIVE' | 'OOF' = 'BUSY',
) => ({ start: new Date(y, m - 1, day, startH), end: new Date(y, m - 1, day, endH), busyStatus });

describe('computeCapacity — whole-sprint vs remaining', () => {
  beforeEach(() => {
    intervals.value = [];
  });

  // Sprint: Sun Jun 7 .. Thu Jun 18 2026 = 10 working days (Sun-Thu) × 9h = 90h.
  const sprintStart = new Date(2026, 5, 7);
  const sprintEnd = new Date(2026, 5, 18, 23, 59);

  it('with no meetings, available == working hours for both whole and remaining', async () => {
    const now = new Date(2026, 5, 10, 12); // Wed mid-sprint
    const cap = await computeCapacity({ sprintStart, sprintEnd, plannedHours: 0, now });
    expect(cap.workingHoursTotal).toBe(90);
    expect(cap.availableHours).toBe(90);
    // Remaining working days from Wed Jun 10: Wed,Thu + next Sun-Thu = 7 days × 9 = 63h.
    expect(cap.workingDaysRemaining).toBe(7);
    expect(cap.workingHoursRemaining).toBe(63);
    expect(cap.availableHoursRemaining).toBe(63);
  });

  it('counts every meeting against the whole sprint, but only future ones against remaining', async () => {
    const now = new Date(2026, 5, 10, 12); // Wed Jun 10, noon
    intervals.value = [
      mtg(2026, 6, 8, 10, 12), // Mon: past 2h
      mtg(2026, 6, 10, 11, 14), // Wed: straddles noon — whole 3h, remaining 2h (12-14)
      mtg(2026, 6, 15, 10, 12), // Sun: future 2h
      mtg(2026, 6, 13, 10, 12), // Sat: weekend, ignored entirely
      mtg(2026, 6, 16, 10, 12, 'TENTATIVE'), // future but tentative — counted, weight 0
    ];
    const cap = await computeCapacity({ sprintStart, sprintEnd, plannedHours: 0, now });

    // Whole sprint: 2 + 3 + 2 = 7h of weighted meetings (tentative weight 0, Sat 0).
    expect(cap.meetingHours.weighted).toBe(7);
    expect(cap.meetingHours.tentative).toBe(2); // tracked, even though weight 0
    expect(cap.availableHours).toBe(90 - 7); // 83

    // Remaining: only future portions — Wed 12-14 (2h) + Sun (2h) = 4h.
    expect(cap.availableHoursRemaining).toBe(63 - 4); // 59
  });

  it('ignores tentative meetings in the available math', async () => {
    const now = new Date(2026, 5, 8, 9); // Mon morning
    intervals.value = [mtg(2026, 6, 10, 10, 13, 'TENTATIVE')]; // 3h tentative, future
    const cap = await computeCapacity({ sprintStart, sprintEnd, plannedHours: 0, now });
    expect(cap.meetingHours.weighted).toBe(0);
    expect(cap.availableHours).toBe(90);
    expect(cap.availableHoursRemaining).toBe(cap.workingHoursRemaining);
  });
});

describe('computeCapacity — confirmed days off', () => {
  beforeEach(() => {
    intervals.value = [];
  });

  // Same sprint: Sun Jun 7 .. Thu Jun 18 2026 = 10 working days x 9h = 90h.
  const sprintStart = new Date(2026, 5, 7);
  const sprintEnd = new Date(2026, 5, 18, 23, 59);

  it('a mid-sprint day off cuts a WHOLE working day from total and remaining', async () => {
    const now = new Date(2026, 5, 8, 9); // Mon Jun 8, morning
    const cap = await computeCapacity({
      sprintStart,
      sprintEnd,
      plannedHours: 0,
      now,
      daysOffDates: ['2026-06-10'], // Wed, inside the sprint
    });
    expect(cap.daysOff).toBe(1);
    expect(cap.workingDays).toBe(9);
    expect(cap.workingHoursTotal).toBe(81);
    // Remaining from Mon Jun 8 = 9 working days, minus the future day off = 8.
    expect(cap.workingDaysRemaining).toBe(8);
    expect(cap.workingHoursRemaining).toBe(72);
    expect(cap.availableHours).toBe(81);
    expect(cap.availableHoursRemaining).toBe(72);
  });

  it('drops the day-off day\'s meetings — no double punishment', async () => {
    const now = new Date(2026, 5, 8, 9); // Mon Jun 8, morning
    intervals.value = [
      mtg(2026, 6, 10, 10, 12), // BUSY on the day off — must vanish
      mtg(2026, 6, 11, 10, 12), // BUSY on a normal Thursday — still counts
    ];
    const cap = await computeCapacity({
      sprintStart,
      sprintEnd,
      plannedHours: 0,
      now,
      daysOffDates: ['2026-06-10'],
    });
    expect(cap.meetingHours.busy).toBe(2); // only the Thursday meeting
    expect(cap.availableHours).toBe(81 - 2);
    expect(cap.availableHoursRemaining).toBe(72 - 2);
  });

  it('a day off in the past cuts the total but not the remaining', async () => {
    const now = new Date(2026, 5, 15, 9); // Mon Jun 15
    const cap = await computeCapacity({
      sprintStart,
      sprintEnd,
      plannedHours: 0,
      now,
      daysOffDates: ['2026-06-10'], // Wed last week
    });
    expect(cap.daysOff).toBe(1);
    expect(cap.workingHoursTotal).toBe(81);
    // Mon 15 .. Thu 18 = 4 working days, none of them off.
    expect(cap.workingDaysRemaining).toBe(4);
    expect(cap.workingHoursRemaining).toBe(36);
  });

  it('ignores a day off on a Friday or outside the sprint', async () => {
    const now = new Date(2026, 5, 8, 9);
    const cap = await computeCapacity({
      sprintStart,
      sprintEnd,
      plannedHours: 0,
      now,
      daysOffDates: ['2026-06-12', '2026-07-01'], // Friday + next month
    });
    expect(cap.daysOff).toBe(0);
    expect(cap.workingHoursTotal).toBe(90);
    expect(cap.workingDaysRemaining).toBe(9);
  });
});

describe('computeCapacity — free hours today', () => {
  beforeEach(() => {
    intervals.value = [];
  });
  const sprintStart = new Date(2026, 5, 7);
  const sprintEnd = new Date(2026, 5, 18, 23, 59);

  it('is the rest of the workday minus the meetings still ahead today', async () => {
    const now = new Date(2026, 5, 10, 12); // Wed noon; window ends 18:00
    intervals.value = [
      mtg(2026, 6, 10, 9, 10), // this morning, already past
      mtg(2026, 6, 10, 13, 15), // 2h still ahead today
      mtg(2026, 6, 11, 10, 12), // tomorrow, not today
    ];
    const cap = await computeCapacity({ sprintStart, sprintEnd, plannedHours: 0, now });
    expect(cap.freeHoursToday).toBe(4);
  });

  it('is capped at the workday length before the day starts', async () => {
    const now = new Date(2026, 5, 10, 6); // before 08:00; window is 10h, the day is 9h
    const cap = await computeCapacity({ sprintStart, sprintEnd, plannedHours: 0, now });
    expect(cap.freeHoursToday).toBe(9);
  });

  it('is 0 after the workday and on a day off', async () => {
    const late = await computeCapacity({ sprintStart, sprintEnd, plannedHours: 0, now: new Date(2026, 5, 10, 19) });
    expect(late.freeHoursToday).toBe(0);
    const off = await computeCapacity({
      sprintStart,
      sprintEnd,
      plannedHours: 0,
      now: new Date(2026, 5, 10, 12),
      daysOffDates: ['2026-06-10'],
    });
    expect(off.freeHoursToday).toBe(0);
    expect(off.isWorkToday).toBe(false);
    expect(late.isWorkToday).toBe(true);
  });
});
