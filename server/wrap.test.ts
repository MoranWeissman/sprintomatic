import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Same harness as sessions.test.ts: fresh in-memory db per test, final schema.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { todayActivityRows, buildWrap, isWorkingDayFor } from './wrap';
import type { Session } from './sessions';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id            TEXT PRIMARY KEY,
      work_item_id  INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      client        TEXT NOT NULL DEFAULT 'claude-code',
      summary       TEXT,
      cwd           TEXT,
      waiting_note  TEXT,
      waiting_since TEXT
    );
    CREATE TABLE session_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      work_item_id    INTEGER NOT NULL,
      type            TEXT NOT NULL,
      text            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      standup_summary TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

// A fixed "now": 2026-07-05 16:30 local. Sessions/events are inserted with
// ISO-UTC strings placed clearly inside or outside the local day so the
// window logic is unambiguous regardless of the machine's timezone offset:
// we derive in-window timestamps FROM `now` itself.
const NOW = new Date(2026, 6, 5, 16, 30, 0); // local time, July = month 6
const iso = (minutesBeforeNow: number) =>
  new Date(NOW.getTime() - minutesBeforeNow * 60_000).toISOString();

function insertSession(id: string, workItemId: number, startedAt: string, endedAt: string | null) {
  h.db.value!
    .prepare('INSERT INTO sessions (id, work_item_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
    .run(id, workItemId, startedAt, endedAt);
}

function insertEvent(sessionId: string, workItemId: number, createdAt: string) {
  h.db.value!
    .prepare(
      "INSERT INTO session_events (session_id, work_item_id, type, text, created_at) VALUES (?, ?, 'progress', 'worked', ?)",
    )
    .run(sessionId, workItemId, createdAt);
}

describe('todayActivityRows', () => {
  it('returns the newest timestamp per work item across starts, ends and events', () => {
    insertSession('s1', 101, iso(300), iso(200)); // started 5h ago, ended ~3h20m ago
    insertEvent('s1', 101, iso(250));
    insertSession('s2', 202, iso(90), null); // still open
    const rows = todayActivityRows(NOW);
    const byId = new Map(rows.map(r => [r.workItemId, r.lastTs]));
    expect(byId.get(101)).toBe(iso(200)); // the end is the newest touch on 101
    expect(byId.get(202)).toBe(iso(90)); // open session: only its start counts
  });

  it('ignores yesterday\'s activity and returns empty on an empty day', () => {
    // 30 hours ago is safely on a previous local day for a 16:30 "now".
    insertSession('old', 303, iso(30 * 60), iso(29 * 60));
    expect(todayActivityRows(NOW)).toEqual([]);
  });
});

function fakeSession(workItemId: number, startedAt: string): Session {
  return {
    id: `sess-${workItemId}`,
    workItemId,
    startedAt,
    endedAt: null,
    client: 'claude-code',
    summary: null,
    cwd: null,
    waitingNote: null,
    waitingSince: null,
  };
}

describe('buildWrap', () => {
  const titles = new Map<number, string>([[101, 'Fix login'], [202, 'Write docs']]);
  const base = {
    titleFor: (id: number) => titles.get(id) ?? null,
    isDone: (_id: number) => false,
    remainingFor: (_id: number) => null,
    isWorkingDay: true,
  };

  it('lastActivityAt is the newest row timestamp, null when nothing today', () => {
    const wrap = buildWrap({
      ...base,
      activityRows: [
        { workItemId: 101, lastTs: '2026-07-05T10:00:00.000Z' },
        { workItemId: 202, lastTs: '2026-07-05T12:00:00.000Z' },
      ],
      activeSessions: [],
    });
    expect(wrap.lastActivityAt).toBe('2026-07-05T12:00:00.000Z');
    const empty = buildWrap({ ...base, activityRows: [], activeSessions: [] });
    expect(empty.lastActivityAt).toBeNull();
    expect(empty.firstMove).toBeNull();
    expect(empty.stillOpen).toEqual([]);
  });

  it('firstMove picks the newest-touched not-done item, with hours when known', () => {
    const wrap = buildWrap({
      ...base,
      isDone: (id: number) => id === 202, // the newest one is done
      remainingFor: (id: number) => (id === 101 ? 3 : null),
      activityRows: [
        { workItemId: 101, lastTs: '2026-07-05T10:00:00.000Z' },
        { workItemId: 202, lastTs: '2026-07-05T12:00:00.000Z' },
      ],
      activeSessions: [],
    });
    expect(wrap.firstMove).toEqual({
      workItemId: 101,
      displayName: '**Fix login** (#101)',
      remainingHours: 3,
    });
  });

  it('firstMove is null when everything touched today is done', () => {
    const wrap = buildWrap({
      ...base,
      isDone: () => true,
      activityRows: [{ workItemId: 101, lastTs: '2026-07-05T10:00:00.000Z' }],
      activeSessions: [],
    });
    expect(wrap.firstMove).toBeNull();
  });

  it('stillOpen maps active sessions, with #id fallback for unknown titles', () => {
    const wrap = buildWrap({
      ...base,
      activityRows: [],
      activeSessions: [fakeSession(101, '2026-07-05T09:00:00.000Z'), fakeSession(999, '2026-07-05T11:00:00.000Z')],
    });
    expect(wrap.stillOpen).toEqual([
      { workItemId: 101, displayName: '**Fix login** (#101)', startedAt: '2026-07-05T09:00:00.000Z' },
      { workItemId: 999, displayName: '#999', startedAt: '2026-07-05T11:00:00.000Z' },
    ]);
  });
});

describe('isWorkingDayFor', () => {
  it('Sun-Thu true, Fri/Sat false', () => {
    expect(isWorkingDayFor(new Date(2026, 6, 5))).toBe(true);  // Sunday
    expect(isWorkingDayFor(new Date(2026, 6, 9))).toBe(true);  // Thursday
    expect(isWorkingDayFor(new Date(2026, 6, 10))).toBe(false); // Friday
    expect(isWorkingDayFor(new Date(2026, 6, 11))).toBe(false); // Saturday
  });
});
