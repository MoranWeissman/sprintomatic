import { describe, it, expect } from 'vitest';
import { sessionActivityState, STALE_IDLE_MINUTES } from './session-activity';

describe('sessionActivityState', () => {
  it('waiting beats everything, even when idle past the threshold', () => {
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES + 10, waiting: true })).toBe('waiting');
    expect(sessionActivityState({ idleMinutes: 0, waiting: true })).toBe('waiting');
  });
  it('stale when idle at or past the threshold and not waiting', () => {
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES, waiting: false })).toBe('stale');
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES + 1, waiting: false })).toBe('stale');
  });
  it('working when recently active and not waiting', () => {
    expect(sessionActivityState({ idleMinutes: STALE_IDLE_MINUTES - 1, waiting: false })).toBe('working');
    expect(sessionActivityState({ idleMinutes: 0, waiting: false })).toBe('working');
  });
});
