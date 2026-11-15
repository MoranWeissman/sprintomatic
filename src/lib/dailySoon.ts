import type { ApiUpcomingCeremony } from './api';

/** How long before the daily meeting the page switches to Daily. */
export const DAILY_SOON_MINUTES = 30;

/**
 * When the daily meeting starts within the next 30 minutes, returns its start
 * time (a key for "this meeting"). Otherwise null. Uses the live clock, not
 * the cached minutesUntil, so it turns on and off on time.
 */
export function dailySoonKey(upcoming: ApiUpcomingCeremony[], now: Date): string | null {
  for (const c of upcoming) {
    if (c.id !== 'daily') continue;
    const mins = (Date.parse(c.startsAt) - now.getTime()) / 60_000;
    if (mins >= 0 && mins <= DAILY_SOON_MINUTES) return c.startsAt;
  }
  return null;
}
