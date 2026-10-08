import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The timer store reads the live SQLite through getDb(). Swap in a fresh
 * in-memory database per test, carrying the same table shape as the real one.
 */
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  startTimer,
  pauseTimer,
  getTimerSnapshot,
  countedMs,
  recordFailedSync,
  getPendingChangesCount,
  listOpenPendingChanges,
  markPendingChangesApplied,
  describeUnfinishedBoardChanges,
} from './timers';

const TASK_ID = 100001;
const OTHER_TASK_ID = 100002;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE time_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id  INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      note          TEXT,
      synced_to_ado INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pending_changes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      applied_at   TEXT,
      error        TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      work_item_id INTEGER NOT NULL,
      type         TEXT NOT NULL,
      text         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

describe('the local stopwatch', () => {
  it('starts once and keeps the same row when asked again', () => {
    const first = startTimer(TASK_ID);
    const second = startTimer(TASK_ID);
    expect(second.id).toBe(first.id);
    expect(getTimerSnapshot(TASK_ID).running).not.toBeNull();
  });

  it('stops when paused, and pausing again does nothing', () => {
    startTimer(TASK_ID);
    expect(pauseTimer(TASK_ID)).not.toBeNull();
    expect(getTimerSnapshot(TASK_ID).running).toBeNull();
    expect(pauseTimer(TASK_ID)).toBeNull();
  });
});

const HOUR = 60 * 60 * 1000;

describe('counting a quiet stretch', () => {
  it('counts a busy stretch in full', () => {
    expect(countedMs(0, [1 * HOUR], 2 * HOUR)).toBe(2 * HOUR);
  });

  it('counts a forgotten session as 2 hours, not 5 days', () => {
    // Opened, nothing logged for 5 days, then a wrap-up note and the close.
    const end = 5 * 24 * HOUR;
    expect(countedMs(0, [end - 14_000], end)).toBe(2 * HOUR + 14_000);
  });

  it('ignores activity outside the timer', () => {
    expect(countedMs(10 * HOUR, [1 * HOUR, 20 * HOUR], 11 * HOUR)).toBe(1 * HOUR);
  });
});

describe('a session left open for days', () => {
  it('stores only the counted time when it is finally stopped', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * HOUR).toISOString();
    h.db.value!.prepare(`INSERT INTO time_entries (work_item_id, started_at) VALUES (?, ?)`).run(TASK_ID, fiveDaysAgo);
    expect(getTimerSnapshot(TASK_ID).totalSeconds).toBe(2 * 60 * 60);
    pauseTimer(TASK_ID);
    expect(getTimerSnapshot(TASK_ID).totalSeconds).toBe(2 * 60 * 60);
  });
});

describe('changes that never reached the board', () => {
  it('counts nothing when everything went through', () => {
    expect(getPendingChangesCount()).toBe(0);
    expect(listOpenPendingChanges()).toEqual([]);
    expect(describeUnfinishedBoardChanges()).toBeNull();
  });

  it('remembers a failed push and counts it', () => {
    recordFailedSync(TASK_ID, 'effort', { hours: 3 }, 'the board did not answer');
    expect(getPendingChangesCount()).toBe(1);
    const open = listOpenPendingChanges();
    expect(open).toHaveLength(1);
    expect(open[0].workItemId).toBe(TASK_ID);
    expect(open[0].kind).toBe('effort');
    expect(open[0].error).toBe('the board did not answer');
  });

  it('clears a task’s failures once a later try goes through', () => {
    recordFailedSync(TASK_ID, 'effort', { hours: 3 }, 'the board did not answer');
    recordFailedSync(TASK_ID, 'state', { target: 'done' }, 'the board did not answer');
    recordFailedSync(OTHER_TASK_ID, 'state', { target: 'done' }, 'the board did not answer');

    markPendingChangesApplied(TASK_ID);

    const open = listOpenPendingChanges();
    expect(open).toHaveLength(1);
    expect(open[0].workItemId).toBe(OTHER_TASK_ID);
    expect(getPendingChangesCount()).toBe(1);
  });

  it('describes what is left in plain words, naming the tasks', () => {
    recordFailedSync(TASK_ID, 'effort', { hours: 3 }, 'the board did not answer');
    recordFailedSync(OTHER_TASK_ID, 'state', { target: 'done' }, 'the board did not answer');
    const sentence = describeUnfinishedBoardChanges()!;
    expect(sentence).toContain('2');
    expect(sentence).toContain(String(TASK_ID));
    expect(sentence).toContain(String(OTHER_TASK_ID));
  });
});
