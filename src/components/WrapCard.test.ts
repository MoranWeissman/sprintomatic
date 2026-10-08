import { describe, it, expect } from 'vitest';
import { wrapVisible } from './WrapCard';

// Local-time constructor: month is 0-based. 2026-07-05 is a Sunday (working day).
const at = (h: number, m = 0) => new Date(2026, 6, 5, h, m, 0);
const isoMinutesBefore = (now: Date, min: number) => new Date(now.getTime() - min * 60_000).toISOString();

const base = { isWorkingDay: true, workedToday: true };

describe('wrapVisible', () => {
  it('shows when afternoon + quiet + worked + working day', () => {
    const now = at(16, 30);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 90) })).toBe(true);
  });

  it('hidden before 14:00 even when quiet', () => {
    const now = at(13, 59);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 90) })).toBe(false);
  });

  it('boundary: exactly 14:00 and exactly 60 minutes of quiet both count', () => {
    const now = at(14, 0);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 60) })).toBe(true);
  });

  it('hidden while activity is fresher than the quiet gap', () => {
    const now = at(16, 30);
    expect(wrapVisible({ ...base, now, lastActivityAt: isoMinutesBefore(now, 59) })).toBe(false);
  });

  it('hidden on a day off, an empty day, or with no activity timestamp', () => {
    const now = at(16, 30);
    const quiet = isoMinutesBefore(now, 90);
    expect(wrapVisible({ ...base, isWorkingDay: false, now, lastActivityAt: quiet })).toBe(false);
    expect(wrapVisible({ ...base, workedToday: false, now, lastActivityAt: quiet })).toBe(false);
    expect(wrapVisible({ ...base, now, lastActivityAt: null })).toBe(false);
  });
});
