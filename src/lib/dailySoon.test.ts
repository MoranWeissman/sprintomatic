import { describe, it, expect } from 'vitest';
import { dailySoonKey } from './dailySoon';
import type { ApiUpcomingCeremony } from './api';

const now = new Date('2026-07-05T08:40:00Z');
const meeting = (id: ApiUpcomingCeremony['id'], iso: string): ApiUpcomingCeremony => ({
  id, label: id, startsAt: iso, minutesUntil: 0, isSuggested: false,
});

describe('dailySoonKey', () => {
  it('gives the start time when the daily meeting is 30 minutes away or less', () => {
    expect(dailySoonKey([meeting('daily', '2026-07-05T09:00:00Z')], now)).toBe('2026-07-05T09:00:00Z');
    expect(dailySoonKey([meeting('daily', '2026-07-05T09:10:00Z')], now)).toBe('2026-07-05T09:10:00Z');
  });

  it('is null when the meeting is further away or already started', () => {
    expect(dailySoonKey([meeting('daily', '2026-07-05T09:11:00Z')], now)).toBeNull();
    expect(dailySoonKey([meeting('daily', '2026-07-05T08:39:00Z')], now)).toBeNull();
  });

  it('ignores other meetings', () => {
    expect(dailySoonKey([meeting('retro', '2026-07-05T09:00:00Z')], now)).toBeNull();
  });
});
