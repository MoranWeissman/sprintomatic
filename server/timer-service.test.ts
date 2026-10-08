import { describe, it, expect, vi } from 'vitest';

/**
 * These tests exercise the close-a-task-on-the-board path without touching
 * Azure DevOps or the real database. The board writes and the failure queue
 * are handed in as plain functions (this repo's dependency-by-optional-
 * parameter style), so the fakes below stand in for both.
 *
 * The modules the real code falls back to are mocked so that importing this
 * file never reaches the network or SQLite.
 */
vi.mock('./writes', () => ({
  setCompletedWork: async () => undefined,
  setRemaining: async () => undefined,
  setStateBucket: async () => 'Done',
}));
vi.mock('./timers', () => ({
  startTimer: () => null,
  pauseTimer: () => null,
  getTimerSnapshot: () => ({ workItemId: 0, running: null, totalSeconds: 0, unsyncedSeconds: 0 }),
  recordFailedSync: () => undefined,
}));

import { closeTaskOnBoard, decideCloseAttempt } from './timer-service';

const TASK_ID = 100001;

/** A board that says yes to everything, and remembers the order of the calls. */
function happyBoard() {
  const calls: string[] = [];
  const failures: Array<{ kind: string; error: string }> = [];
  return {
    calls,
    failures,
    deps: {
      setCompletedWork: async (id: number, hours: number) => {
        calls.push(`completed:${id}:${hours}`);
      },
      setRemaining: async (id: number, hours: number) => {
        calls.push(`remaining:${id}:${hours}`);
      },
      setStateBucket: async (id: number, bucket: string) => {
        calls.push(`state:${id}:${bucket}`);
        return 'Done';
      },
      recordFailure: (_id: number, kind: string, _payload: unknown, error: string) => {
        failures.push({ kind, error });
      },
    },
  };
}

describe('closeTaskOnBoard — all three writes land', () => {
  it('writes the hours spent, the hours left and the state, in that order', async () => {
    const board = happyBoard();
    const result = await closeTaskOnBoard({ workItemId: TASK_ID, completedHours: 3 }, board.deps);
    expect(result.ok).toBe(true);
    expect(board.calls).toEqual([
      `completed:${TASK_ID}:3`,
      `remaining:${TASK_ID}:0`,
      `state:${TASK_ID}:done`,
    ]);
    expect(result.landed).toEqual(['completedHours', 'remainingHours', 'state']);
    expect(result.newState).toBe('Done');
    expect(result.message).toBeUndefined();
    expect(board.failures).toEqual([]);
  });
});

describe('closeTaskOnBoard — the second write fails', () => {
  it('stops, reports what landed and what did not, and never says the session closed', async () => {
    const board = happyBoard();
    board.deps.setRemaining = async () => {
      throw new Error('the board did not answer');
    };
    const result = await closeTaskOnBoard({ workItemId: TASK_ID, completedHours: 3 }, board.deps);

    expect(result.ok).toBe(false);
    expect(result.landed).toEqual(['completedHours']);
    expect(result.failedStep).toBe('remainingHours');
    // The state write is never attempted once a write ahead of it fails.
    expect(board.calls).toEqual([`completed:${TASK_ID}:3`]);

    const msg = result.message!;
    expect(msg).toContain('the hours you spent');
    expect(msg).toContain('the hours left');
    expect(msg).toContain("the task's state");
    expect(msg).toContain('the board did not answer');
    expect(msg).toContain('the session is still open');
    expect(msg.toLowerCase()).not.toContain('session closed');
  });

  it('remembers the failure so it can be counted later', async () => {
    const board = happyBoard();
    board.deps.setRemaining = async () => {
      throw new Error('the board did not answer');
    };
    await closeTaskOnBoard({ workItemId: TASK_ID, completedHours: 3 }, board.deps);
    expect(board.failures).toEqual([{ kind: 'effort', error: 'the board did not answer' }]);
  });
});

describe('closeTaskOnBoard — the state write fails', () => {
  it('says both hour writes landed and the state did not', async () => {
    const board = happyBoard();
    board.deps.setStateBucket = async () => {
      throw new Error('that state is not allowed here');
    };
    const result = await closeTaskOnBoard({ workItemId: TASK_ID, completedHours: 3 }, board.deps);

    expect(result.ok).toBe(false);
    expect(result.landed).toEqual(['completedHours', 'remainingHours']);
    expect(result.failedStep).toBe('state');
    expect(result.message).toContain('that state is not allowed here');
    expect(result.message).toContain('still open');
    expect(board.failures).toEqual([{ kind: 'state', error: 'that state is not allowed here' }]);
  });
});

describe('decideCloseAttempt', () => {
  it('goes ahead for a session that is still open', () => {
    expect(decideCloseAttempt({ endedAt: null })).toBe('go');
  });
  it('says already-closed for a session that ended', () => {
    expect(decideCloseAttempt({ endedAt: '2026-08-24T10:00:00.000Z' })).toBe('already-closed');
  });
  it('says not-found when there is no session at all', () => {
    expect(decideCloseAttempt(null)).toBe('not-found');
  });
});
