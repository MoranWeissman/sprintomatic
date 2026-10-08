import { describe, it, expect, vi } from 'vitest';

// Use the built-in default schedule (Daily = weekdays @ 09:00) by making the
// settings lookup return nothing, so getCeremonySchedule() falls back to it.
vi.mock('./timers', () => ({ getSetting: () => undefined, setSetting: () => {} }));

import {
  ceremonyTodayLine,
  computeUpcomingCeremonies,
  type CeremonyConfig,
  type CeremonySchedule,
} from './ceremony';

// Working week is Sun–Thu (0..4); Fri (5) + Sat (6) are off. These guard the
// regression where the Daily recurrence was hardcoded to Mon–Fri, which on a
// Sunday skipped today's Daily and wrongly offered Friday's.
describe('Daily recurrence follows the working week (Sun–Thu)', () => {
  it('includes Sunday and never Friday or Saturday', () => {
    const now = new Date(2026, 5, 14, 8, 0, 0); // Sunday 2026-06-14, before 09:00
    const dows = computeUpcomingCeremonies({ now })
      .filter(u => u.id === 'daily')
      .map(u => new Date(u.startsAt).getDay());

    expect(dows.length).toBeGreaterThan(0);
    expect(dows.every(d => d >= 0 && d <= 4)).toBe(true); // all on Sun–Thu
    expect(dows).toContain(0); // today (Sunday) is a working day
  });

  it('after Thursday, the next Daily is Sunday — not Friday', () => {
    const now = new Date(2026, 5, 11, 18, 0, 0); // Thursday 2026-06-11, after the daily
    const firstFuture = computeUpcomingCeremonies({ now })
      .filter(u => u.id === 'daily')
      .find(u => u.minutesUntil >= 0);

    expect(firstFuture).toBeDefined();
    expect(new Date(firstFuture!.startsAt).getDay()).toBe(0); // Sunday, not Friday(5)
  });
});

/* ============================================================ */
/*  ceremonyTodayLine (pure — schedule handed in by the caller)   */
/* ============================================================ */

// Calendar anchors: 2026-06-14 is a Sunday (verified by the tests above).
// Sprint = Sun 2026-06-14 .. Thu 2026-06-25, two weeks, Sun-Thu working week.
const START = new Date(2026, 5, 14);
const FINISH = new Date(2026, 5, 25);

function sched(...ceremonies: CeremonyConfig[]): CeremonySchedule {
  return { version: 1, ceremonies };
}

const PLAN: CeremonyConfig = {
  id: 'plan',
  label: 'Planning',
  enabled: true,
  recurrence: { kind: 'sprint_relative', weekOfSprint: 1, dayOfWeek: 1, time: '09:00' },
};
const RETRO: CeremonyConfig = {
  id: 'retro',
  label: 'Retro',
  enabled: true,
  recurrence: { kind: 'sprint_relative', weekOfSprint: 2, dayOfWeek: 4, time: '13:00' },
};
const DAILY: CeremonyConfig = {
  id: 'daily',
  label: 'Daily',
  enabled: true,
  recurrence: { kind: 'weekdays', time: '09:30' },
};

describe('ceremonyTodayLine', () => {
  it('planning day gets the Plan-page wording, whatever the hour', () => {
    const now = new Date(2026, 5, 15, 16, 0); // Monday of week 1, afternoon
    expect(ceremonyTodayLine(sched(PLAN), START, FINISH, now)).toBe(
      'Planning is today at 09:00 — the Plan page is ready for it.',
    );
  });

  it('any other ceremony gets the plain label wording', () => {
    const now = new Date(2026, 5, 25, 8, 0); // Thursday of week 2
    expect(ceremonyTodayLine(sched(RETRO), START, FINISH, now)).toBe(
      'Retro is today at 13:00.',
    );
  });

  it('two rare ones on the same day join with a space, earliest first', () => {
    // Retro moved onto planning day to force two hits on one date.
    const retroSameDay: CeremonyConfig = {
      ...RETRO,
      recurrence: { kind: 'sprint_relative', weekOfSprint: 1, dayOfWeek: 1, time: '13:00' },
    };
    const now = new Date(2026, 5, 15, 8, 0); // Monday of week 1
    expect(ceremonyTodayLine(sched(retroSameDay, PLAN), START, FINISH, now)).toBe(
      'Planning is today at 09:00 — the Plan page is ready for it. Retro is today at 13:00.',
    );
  });

  it('a day with nothing scheduled says null', () => {
    const now = new Date(2026, 5, 16, 9, 0); // Tuesday of week 1
    expect(ceremonyTodayLine(sched(PLAN, RETRO), START, FINISH, now)).toBeNull();
  });

  it('a turned-off ceremony never shows up', () => {
    const now = new Date(2026, 5, 15, 9, 0); // Monday of week 1
    expect(ceremonyTodayLine(sched({ ...PLAN, enabled: false }), START, FINISH, now)).toBeNull();
  });

  it('the Daily never speaks — an every-day reminder is wallpaper, not a reminder', () => {
    const workingDay = new Date(2026, 5, 15, 8, 0); // Monday — the Daily IS today
    expect(ceremonyTodayLine(sched(DAILY), START, FINISH, workingDay)).toBeNull();
    const friday = new Date(2026, 5, 19, 9, 0); // day off anyway
    expect(ceremonyTodayLine(sched(DAILY), START, FINISH, friday)).toBeNull();
  });

  it('sprint-relative entries need a sprint start; without one they are skipped', () => {
    const now = new Date(2026, 5, 15, 9, 0); // Monday of week 1
    expect(ceremonyTodayLine(sched(PLAN), null, null, now)).toBeNull();
  });

  it('projects the NEXT sprint too, so a planning day right after the finish is caught', () => {
    // Next sprint is assumed to start the day after FINISH (Fri 2026-06-26);
    // its week-1 Monday is 2026-06-29.
    const now = new Date(2026, 5, 29, 8, 0);
    expect(ceremonyTodayLine(sched(PLAN), START, FINISH, now)).toBe(
      'Planning is today at 09:00 — the Plan page is ready for it.',
    );
  });
});
