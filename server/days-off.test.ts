import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The days-off store reads the live SQLite through getDb(). Swap in a fresh
 * in-memory database per test, carrying only the settings table it uses.
 */
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  addDaysOff,
  removeDaysOff,
  listDaysOff,
  dismissRange,
  listDismissedRanges,
  candidateDayOffRanges,
  candidateDayOffRangesPure,
  toIsoDate,
  addDaysIso,
} from './days-off';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

// Real weekdays for the dates below: 2026-08-27 is a Thursday, 2026-08-28 a
// Friday, 2026-08-29 a Saturday, 2026-08-30 a Sunday, 2026-08-31 a Monday.

describe('date helpers', () => {
  it('toIsoDate uses the local calendar date', () => {
    expect(toIsoDate(new Date(2026, 7, 27, 23, 59))).toBe('2026-08-27');
  });
  it('addDaysIso steps across a month boundary', () => {
    expect(addDaysIso('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysIso('2026-09-01', -1)).toBe('2026-08-31');
  });
});

describe('addDaysOff / removeDaysOff / listDaysOff', () => {
  it('stores dates, sorted, and is idempotent', () => {
    addDaysOff(['2026-08-31', '2026-08-27']);
    const again = addDaysOff(['2026-08-27']);
    expect(again.stored).toEqual(['2026-08-27', '2026-08-31']);
    expect(listDaysOff()).toEqual(['2026-08-27', '2026-08-31']);
  });

  it('refuses a date that is not YYYY-MM-DD, and stores nothing from that call', () => {
    expect(() => addDaysOff(['2026-08-27', '27-08-2026'])).toThrow(/YYYY-MM-DD/);
    expect(listDaysOff()).toEqual([]);
  });

  it('refuses a date that does not exist on the calendar', () => {
    expect(() => addDaysOff(['2026-02-30'])).toThrow(/isn't a real calendar date/);
  });

  it('removes only what was stored and reports exactly that', () => {
    addDaysOff(['2026-08-27', '2026-08-31']);
    const r = removeDaysOff(['2026-08-31', '2026-09-01']);
    expect(r.removed).toEqual(['2026-08-31']);
    expect(listDaysOff()).toEqual(['2026-08-27']);
  });
});

describe('dismissRange / listDismissedRanges', () => {
  it('remembers a dismissed range once, even when dismissed twice', () => {
    dismissRange('2026-08-31', '2026-09-04');
    dismissRange('2026-08-31', '2026-09-04');
    expect(listDismissedRanges()).toEqual([{ start: '2026-08-31', end: '2026-09-04' }]);
  });

  it('refuses a range that ends before it starts', () => {
    expect(() => dismissRange('2026-09-04', '2026-08-31')).toThrow(/ends earlier/);
  });
});

describe('candidateDayOffRanges', () => {
  const WINDOW = ['2026-08-23', '2026-09-03'] as const; // Sun .. Thu

  it('keeps ranges that overlap the window and drops the rest', () => {
    const out = candidateDayOffRanges(
      [
        { start: '2026-08-27', end: '2026-08-27' }, // inside
        { start: '2026-09-01', end: '2026-09-08' }, // overlaps the end
        { start: '2026-09-10', end: '2026-09-11' }, // fully after
      ],
      ...WINDOW,
    );
    expect(out).toEqual([
      { start: '2026-08-27', end: '2026-08-27' },
      { start: '2026-09-01', end: '2026-09-08' },
    ]);
  });

  it('merges identical ranges into one', () => {
    const out = candidateDayOffRanges(
      [
        { start: '2026-08-27', end: '2026-08-27' },
        { start: '2026-08-27', end: '2026-08-27' },
      ],
      ...WINDOW,
    );
    expect(out).toHaveLength(1);
  });

  it('drops a range the user already dismissed — that exact range only', () => {
    dismissRange('2026-08-27', '2026-08-27');
    const out = candidateDayOffRanges(
      [
        { start: '2026-08-27', end: '2026-08-27' },
        { start: '2026-08-27', end: '2026-08-31' }, // different range, still asked
      ],
      ...WINDOW,
    );
    expect(out).toEqual([{ start: '2026-08-27', end: '2026-08-31' }]);
  });

  it('drops a range whose working days are all already stored as days off', () => {
    // Thu 27 .. Sun 30: working days are Thu + Sun (Fri + Sat are off anyway).
    addDaysOff(['2026-08-27', '2026-08-30']);
    const out = candidateDayOffRanges([{ start: '2026-08-27', end: '2026-08-30' }], ...WINDOW);
    expect(out).toEqual([]);
  });

  it('keeps a range where only SOME working days are stored', () => {
    addDaysOff(['2026-08-27']);
    const out = candidateDayOffRanges([{ start: '2026-08-27', end: '2026-08-30' }], ...WINDOW);
    expect(out).toEqual([{ start: '2026-08-27', end: '2026-08-30' }]);
  });

  it('drops a weekend-only range — there is no working day to ask about', () => {
    // Fri 28 .. Sat 29.
    const out = candidateDayOffRanges([{ start: '2026-08-28', end: '2026-08-29' }], ...WINDOW);
    expect(out).toEqual([]);
  });

  it('sorts the result by start date', () => {
    const out = candidateDayOffRanges(
      [
        { start: '2026-08-31', end: '2026-09-01' },
        { start: '2026-08-27', end: '2026-08-27' },
      ],
      ...WINDOW,
    );
    expect(out.map(r => r.start)).toEqual(['2026-08-27', '2026-08-31']);
  });
});

describe('candidateDayOffRangesPure', () => {
  it('needs no storage — dismissed and stored are handed in', () => {
    const out = candidateDayOffRangesPure(
      [
        { start: '2026-08-27', end: '2026-08-27' },
        { start: '2026-08-31', end: '2026-09-04' },
      ],
      '2026-08-23',
      '2026-09-10',
      [{ start: '2026-08-31', end: '2026-09-04' }],
      [],
    );
    expect(out).toEqual([{ start: '2026-08-27', end: '2026-08-27' }]);
  });

  it('skips junk ranges instead of looping on them', () => {
    const out = candidateDayOffRangesPure(
      [
        { start: 'garbage', end: '2026-08-27' },
        { start: '2026-08-29', end: '2026-08-27' }, // backwards
      ],
      '2026-08-23',
      '2026-09-10',
      [],
      [],
    );
    expect(out).toEqual([]);
  });
});
