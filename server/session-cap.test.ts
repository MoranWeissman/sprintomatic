import { describe, it, expect, beforeEach, vi } from 'vitest';

// maxParallelSessions reads a setting + env; mock the settings store and control env.
const h = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => h.settings.get(k),
}));

import { maxParallelSessions, parallelCapExceeded } from './session-cap';
import type { Session } from './sessions';

function sess(workItemId: number): Session {
  return {
    id: `s-${workItemId}`, workItemId, startedAt: '2026-07-13T08:00:00.000Z',
    endedAt: null, client: 'claude-code', summary: null,
    cwd: null, waitingNote: null, waitingSince: null,
  };
}

beforeEach(() => {
  h.settings.clear();
  delete process.env.SH_MAX_PARALLEL_SESSIONS;
});

describe('maxParallelSessions', () => {
  it('defaults to 4 with no env and no setting', () => {
    expect(maxParallelSessions()).toBe(4);
  });
  it('setting wins over default; env wins over setting', () => {
    h.settings.set('max_parallel_sessions', '3');
    expect(maxParallelSessions()).toBe(3);
    process.env.SH_MAX_PARALLEL_SESSIONS = '2';
    expect(maxParallelSessions()).toBe(2);
  });
  it('junk / zero / negative falls back to 4', () => {
    process.env.SH_MAX_PARALLEL_SESSIONS = 'abc';
    expect(maxParallelSessions()).toBe(4);
    process.env.SH_MAX_PARALLEL_SESSIONS = '0';
    expect(maxParallelSessions()).toBe(4);
    process.env.SH_MAX_PARALLEL_SESSIONS = '-1';
    expect(maxParallelSessions()).toBe(4);
  });
  it('empty-string env var falls through to the setting', () => {
    h.settings.set('max_parallel_sessions', '3');
    process.env.SH_MAX_PARALLEL_SESSIONS = '';
    expect(maxParallelSessions()).toBe(3);
  });
});

describe('parallelCapExceeded', () => {
  it('false when under the cap', () => {
    const active = [sess(1), sess(2)];
    expect(parallelCapExceeded({ activeSessions: active, workItemId: 9, max: 4 })).toBe(false);
  });
  it('true when at the cap and the item is NEW', () => {
    const active = [sess(1), sess(2), sess(3), sess(4)];
    expect(parallelCapExceeded({ activeSessions: active, workItemId: 9, max: 4 })).toBe(true);
  });
  it('false when at the cap but the item ALREADY has an open session', () => {
    const active = [sess(1), sess(2), sess(3), sess(4)];
    expect(parallelCapExceeded({ activeSessions: active, workItemId: 3, max: 4 })).toBe(false);
  });
});
