/**
 * One place that decides how a live work session reads at a glance:
 *   - waiting: the chat paused to ask the user something (waitingSince set).
 *   - stale:   no activity for STALE_IDLE_MINUTES+ (the chat went quiet).
 *   - working: recently active.
 * Shared by orient (the morning greeting) and the dashboard (Focus panels)
 * so both agree on one threshold instead of inventing two.
 */
export const STALE_IDLE_MINUTES = 120;

export type SessionActivityState = 'working' | 'waiting' | 'stale';

export function sessionActivityState(opts: { idleMinutes: number; waiting: boolean }): SessionActivityState {
  if (opts.waiting) return 'waiting';
  if (opts.idleMinutes >= STALE_IDLE_MINUTES) return 'stale';
  return 'working';
}
