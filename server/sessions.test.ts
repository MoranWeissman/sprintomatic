import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test, carrying the final sessions/session_events shape.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  startSession, sessionOwnershipHint, sessionsOwnedByChat, setSessionWaiting, logEvent, endSession,
  listRecentlyEnded, getSession, chatCwdKey,
} from './sessions';

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
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      work_item_id    INTEGER NOT NULL,
      type            TEXT NOT NULL,
      text            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      standup_summary TEXT
    );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

describe('chatCwdKey', () => {
  it('keeps the whole path the model supplies', () => {
    expect(chatCwdKey('/home/x/projects/infra-repo')).toBe(
      '/home/x/projects/infra-repo',
    );
  });
  it('drops a trailing slash so two spellings of one folder match', () => {
    expect(chatCwdKey('/home/x/projects/sprintomatic/')).toBe('/home/x/projects/sprintomatic');
  });
  it('returns null for null/empty/root/junk', () => {
    expect(chatCwdKey(null)).toBeNull();
    expect(chatCwdKey(undefined)).toBeNull();
    expect(chatCwdKey('')).toBeNull();
    expect(chatCwdKey('   ')).toBeNull();
    expect(chatCwdKey('/')).toBeNull();
    expect(chatCwdKey('.')).toBeNull();
    expect(chatCwdKey('..')).toBeNull();
  });
  it('accepts a bare folder name as it is', () => {
    expect(chatCwdKey('sprintomatic')).toBe('sprintomatic');
  });
  it('refuses a relative path — there is nothing here to resolve it against', () => {
    expect(chatCwdKey('./design')).toBeNull();
    expect(chatCwdKey('../sprintomatic/design')).toBeNull();
  });
});

describe('sessionOwnershipHint', () => {
  const ROOT = '/home/dev/projects/sprintomatic';
  const FEATURE = `${ROOT}/100901-declarative-continuous-deployment-cd-and/design`;

  it('is mine when the folders are the same', () => {
    expect(sessionOwnershipHint(ROOT, ROOT)).toBe('mine');
  });

  // The real case from the CD design week: the session was opened at the
  // workspace root, the chat worked in a feature folder under it, and every
  // single log came back saying it was a different chat's work.
  it('is mine when the chat sits inside the session folder', () => {
    expect(sessionOwnershipHint(ROOT, FEATURE)).toBe('mine');
  });
  it('is mine when the session sits inside the chat folder', () => {
    expect(sessionOwnershipHint(FEATURE, ROOT)).toBe('mine');
  });

  it("is another chat's work for two folders that are side by side", () => {
    expect(sessionOwnershipHint(ROOT, '/home/dev/projects/infra-repo')).toBe(
      'other-repo',
    );
  });
  it('does not treat a name that merely starts the same as inside', () => {
    expect(sessionOwnershipHint(ROOT, `${ROOT}-notes`)).toBe('other-repo');
  });

  it('is unknown when either side is missing', () => {
    expect(sessionOwnershipHint(null, ROOT)).toBe('unknown');
    expect(sessionOwnershipHint(ROOT, null)).toBe('unknown');
    expect(sessionOwnershipHint(null, null)).toBe('unknown');
  });

  // Rows written before this change hold only a folder name.
  it('matches an old row by name when the names agree', () => {
    expect(sessionOwnershipHint('sprintomatic', ROOT)).toBe('mine');
  });
  it('stays quiet on an old row it cannot place, rather than warn wrongly', () => {
    expect(sessionOwnershipHint('sprintomatic', FEATURE)).toBe('unknown');
  });
  it('still tells two different bare names apart', () => {
    expect(sessionOwnershipHint('sprintomatic', 'infra-repo')).toBe('other-repo');
  });
});

describe('sessionsOwnedByChat', () => {
  const ROOT = '/home/dev/projects/features';
  const FEATURE = `${ROOT}/100901-declarative-continuous-deployment-cd-and`;
  const OTHER = '/home/dev/projects/infra-repo';

  const fake = (workItemId: number, cwd: string | null) =>
    ({ id: `s-${workItemId}`, workItemId, cwd } as unknown as Parameters<
      typeof sessionsOwnedByChat
    >[0][number]);

  it('keeps a session started in the same folder', () => {
    expect(sessionsOwnedByChat([fake(1, ROOT)], ROOT).map(s => s.workItemId)).toEqual([1]);
  });

  it('keeps a session started in a feature folder under this chat', () => {
    expect(sessionsOwnedByChat([fake(1, FEATURE)], ROOT).map(s => s.workItemId)).toEqual([1]);
  });

  it("drops a session from another chat's repo", () => {
    expect(sessionsOwnedByChat([fake(1, OTHER)], ROOT)).toEqual([]);
  });

  // Never block on a guess: an old row holding only a folder name we can't
  // place reads as 'unknown', and unknown must not stop a switch.
  it('drops an old row it cannot place', () => {
    expect(sessionsOwnedByChat([fake(1, 'features')], FEATURE)).toEqual([]);
    expect(sessionsOwnedByChat([fake(1, null)], ROOT)).toEqual([]);
  });

  it('drops everything when this chat has no cwd', () => {
    expect(sessionsOwnedByChat([fake(1, ROOT)], null)).toEqual([]);
  });

  it('returns an empty list for an empty list', () => {
    expect(sessionsOwnedByChat([], ROOT)).toEqual([]);
  });

  it('keeps only the matching ones out of a mixed list', () => {
    const got = sessionsOwnedByChat([fake(1, OTHER), fake(2, ROOT), fake(3, FEATURE)], ROOT);
    expect(got.map(s => s.workItemId)).toEqual([2, 3]);
  });
});

describe('startSession cwd stamp', () => {
  it('stores the given cwd on a new session', () => {
    const s = startSession({ workItemId: 1, cwd: 'repo-x' });
    expect(s.cwd).toBe('repo-x');
    expect(s.waitingNote).toBeNull();
    expect(s.waitingSince).toBeNull();
  });

  it('stores null when cwd is explicitly null (unknown launch dir)', () => {
    const s = startSession({ workItemId: 2, cwd: null });
    expect(s.cwd).toBeNull();
  });

  it('is idempotent and backfills a null cwd on the existing open session', () => {
    // Simulate an OLD session row (pre-migration: cwd null).
    h.db.value!
      .prepare(`INSERT INTO sessions (id, work_item_id, started_at, client) VALUES ('old-1', 3, '2026-06-30T08:00:00.000Z', 'claude-code')`)
      .run();
    const s = startSession({ workItemId: 3, cwd: 'repo-x' });
    expect(s.id).toBe('old-1'); // same session, not a new one
    expect(s.cwd).toBe('repo-x'); // learned its home
    const stored = h.db.value!.prepare(`SELECT cwd FROM sessions WHERE id = 'old-1'`).get() as { cwd: string };
    expect(stored.cwd).toBe('repo-x');
  });

  it('does not overwrite an existing cwd on the idempotent path', () => {
    startSession({ workItemId: 4, cwd: 'repo-x' });
    const again = startSession({ workItemId: 4, cwd: 'repo-y' });
    expect(again.cwd).toBe('repo-x');
  });
});

describe('sessionOwnershipHint', () => {
  it("returns 'mine' when both sides match", () => {
    expect(sessionOwnershipHint('repo-x', 'repo-x')).toBe('mine');
  });
  it("returns 'other-repo' when both known and different", () => {
    expect(sessionOwnershipHint('repo-x', 'repo-y')).toBe('other-repo');
  });
  it("returns 'unknown' when either side is null", () => {
    expect(sessionOwnershipHint(null, 'repo-x')).toBe('unknown');
    expect(sessionOwnershipHint('repo-x', null)).toBe('unknown');
    expect(sessionOwnershipHint(null, null)).toBe('unknown');
  });
});

describe('waiting flag', () => {
  it('sets the question and timestamp on an open session', () => {
    const s = startSession({ workItemId: 10, cwd: 'repo-x' });
    const w = setSessionWaiting({ sessionId: s.id, question: 'Which cluster should I target?' });
    expect(w?.waitingNote).toBe('Which cluster should I target?');
    expect(w?.waitingSince).not.toBeNull();
  });

  it('returns null for a missing or ended session (nothing stored)', () => {
    expect(setSessionWaiting({ sessionId: 'nope', question: 'q' })).toBeNull();
    const s = startSession({ workItemId: 11, cwd: 'repo-x' });
    endSession({ sessionId: s.id });
    expect(setSessionWaiting({ sessionId: s.id, question: 'q' })).toBeNull();
  });

  it('clears on the next session_log event', () => {
    const s = startSession({ workItemId: 12, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    logEvent({ sessionId: s.id, type: 'progress', text: 'the user answered; moving on' });
    expect(getSession(s.id)?.waitingNote).toBeNull();
    expect(getSession(s.id)?.waitingSince).toBeNull();
  });

  it('clears on session end', () => {
    const s = startSession({ workItemId: 13, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    endSession({ sessionId: s.id, summary: 'done for now' });
    expect(getSession(s.id)?.waitingNote).toBeNull();
    expect(getSession(s.id)?.waitingSince).toBeNull();
  });

  it('returns cleared waiting fields from endSession itself (not just in the DB)', () => {
    const s = startSession({ workItemId: 14, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'q' });
    const ended = endSession({ sessionId: s.id });
    expect(ended?.waitingNote).toBeNull();
    expect(ended?.waitingSince).toBeNull();
  });
});

describe('endSession + logEvent write atomically', () => {
  it('endSession still produces exactly the same rows as before (no behaviour change)', () => {
    const db = h.db.value!;
    const s = startSession({ workItemId: 40, cwd: 'repo-x' });
    const ended = endSession({ sessionId: s.id, summary: 'wrapped up for today' });

    expect(ended?.endedAt).not.toBeNull();
    expect(ended?.summary).toBe('wrapped up for today');

    const sessionRow = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(s.id) as {
      ended_at: string | null;
      summary: string | null;
    };
    expect(sessionRow.ended_at).not.toBeNull();
    expect(sessionRow.summary).toBe('wrapped up for today');

    const events = db
      .prepare(`SELECT * FROM session_events WHERE session_id = ?`)
      .all(s.id) as { type: string; text: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('progress');
    expect(events[0].text).toBe('wrapped up for today');
  });

  it('logEvent still produces exactly the same rows as before (no behaviour change)', () => {
    const db = h.db.value!;
    const s = startSession({ workItemId: 41, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'which cluster?' });

    const event = logEvent({ sessionId: s.id, type: 'progress', text: 'moving on' });

    expect(event?.text).toBe('moving on');
    const events = db
      .prepare(`SELECT * FROM session_events WHERE session_id = ?`)
      .all(s.id) as { text: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('moving on');

    const sessionRow = db.prepare(`SELECT waiting_note, waiting_since FROM sessions WHERE id = ?`).get(s.id) as {
      waiting_note: string | null;
      waiting_since: string | null;
    };
    expect(sessionRow.waiting_note).toBeNull();
    expect(sessionRow.waiting_since).toBeNull();
  });

  it('rolls back closing the session when logging its final summary fails', () => {
    const db = h.db.value!;
    const s = startSession({ workItemId: 42, cwd: 'repo-x' });

    // Force the second statement (the summary event insert, inside endSession's
    // transaction) to fail, the way a real crash mid-write would.
    db.exec('DROP TABLE session_events');

    expect(() => endSession({ sessionId: s.id, summary: 'wrap up' })).toThrow();

    const row = db.prepare(`SELECT ended_at, summary FROM sessions WHERE id = ?`).get(s.id) as {
      ended_at: string | null;
      summary: string | null;
    };
    // The UPDATE that marks the session closed must NOT have stuck — otherwise
    // the session would read as closed with no matching event.
    expect(row.ended_at).toBeNull();
    expect(row.summary).toBeNull();
  });

  it('rolls back the new event when clearing the waiting flag fails', () => {
    const db = h.db.value!;
    const s = startSession({ workItemId: 43, cwd: 'repo-x' });
    setSessionWaiting({ sessionId: s.id, question: 'which cluster?' });

    // Force the second statement (clearing waiting_note, inside logEvent's own
    // transaction) to fail on purpose, via a trigger that blocks it.
    db.exec(`
      CREATE TRIGGER block_waiting_clear
      BEFORE UPDATE OF waiting_note ON sessions
      WHEN NEW.id = '${s.id}'
      BEGIN SELECT RAISE(ABORT, 'forced failure for test');
      END;
    `);

    expect(() => logEvent({ sessionId: s.id, type: 'progress', text: 'should not stick' })).toThrow();

    const events = db.prepare(`SELECT * FROM session_events WHERE session_id = ?`).all(s.id);
    // The event insert must NOT have stuck — otherwise a fresh event would
    // exist while the session still reads as waiting on the user.
    expect(events).toHaveLength(0);
    expect(getSession(s.id)?.waitingNote).toBe('which cluster?');
  });
});

describe('listRecentlyEnded', () => {
  it('returns sessions ended inside the window and skips older or open ones', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const db = h.db.value!;
    const ins = db.prepare(
      `INSERT INTO sessions (id, work_item_id, started_at, ended_at, client) VALUES (?, ?, ?, ?, 'claude-code')`,
    );
    ins.run('recent', 20, '2026-07-01T09:00:00.000Z', '2026-07-01T10:30:00.000Z'); // 1.5h ago — in
    ins.run('old', 21, '2026-07-01T01:00:00.000Z', '2026-07-01T02:00:00.000Z');    // 10h ago — out
    ins.run('open', 22, '2026-07-01T11:00:00.000Z', null);                          // open — out
    const got = listRecentlyEnded(4, now);
    expect(got.map(s => s.id)).toEqual(['recent']);
  });
});
