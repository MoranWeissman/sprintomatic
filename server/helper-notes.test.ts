import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test, carrying the final helper_notes shape (with the new columns).
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  addNote,
  listNotes,
  pinNote,
  unpinNote,
  dismissNote,
  ensureCapacityNudge,
  reviewNotesAgainstBoard,
  clearedNotesLine,
  ensureStaleRemainingNudge,
} from './helper-notes';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE helper_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      dismissed_at TEXT,
      pinned_at    TEXT,
      work_item_id INTEGER
    );
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

describe('addNote', () => {
  it('stores an optional work item id and returns it', () => {
    const note = addNote('Review rules model has gone quiet', 100906);
    expect(note.workItemId).toBe(100906);
    expect(note.pinnedAt).toBeNull();
    const [read] = listNotes();
    expect(read.workItemId).toBe(100906);
  });

  it('defaults work item id to null when omitted', () => {
    const note = addNote('You have room left this sprint');
    expect(note.workItemId).toBeNull();
  });
});

describe('pinNote / unpinNote', () => {
  it('pins a note and surfaces it before newer unpinned notes', () => {
    const older = addNote('older note');
    addNote('newer note');
    pinNote(older.id);

    const ordered = listNotes();
    expect(ordered[0].id).toBe(older.id);
    expect(ordered[0].pinnedAt).not.toBeNull();
  });

  it('unpins a note so it returns to newest-first order', () => {
    const older = addNote('older note');
    const newer = addNote('newer note');
    pinNote(older.id);
    unpinNote(older.id);

    const ordered = listNotes();
    expect(ordered[0].id).toBe(newer.id);
    expect(ordered.find(n => n.id === older.id)!.pinnedAt).toBeNull();
  });
});

describe('ensureCapacityNudge — refresh behaviour', () => {
  it('fires once when the gap clears the threshold', () => {
    const note = ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 });
    expect(note).not.toBeNull();
    expect(listNotes()).toHaveLength(1);
    expect(listNotes()[0].body).toContain('60h');
  });

  it('does NOT re-fire when the numbers are essentially unchanged', () => {
    ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 });
    const again = ensureCapacityNudge({ sprintName: '26_13', difference: -61, availableHours: 74, plannedHours: 13 });
    expect(again).toBeNull();
    expect(listNotes()).toHaveLength(1);
  });

  it('REPLACES the old note with fresh numbers when capacity drifts a lot (same sprint)', () => {
    ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 });
    // Big drift: room jumps to ~72h after a meeting was cancelled.
    const refreshed = ensureCapacityNudge({ sprintName: '26_13', difference: -72, availableHours: 85, plannedHours: 13 });
    expect(refreshed).not.toBeNull();
    const open = listNotes();
    expect(open).toHaveLength(1); // old one retired, not stacked
    expect(open[0].body).toContain('72h');
    expect(open[0].body).not.toContain('60h');
  });

  it('REPLACES a stale previous-sprint note when the sprint rolls over', () => {
    ensureCapacityNudge({ sprintName: '26_12', difference: -60, availableHours: 73, plannedHours: 13 });
    const next = ensureCapacityNudge({ sprintName: '26_13', difference: -72, availableHours: 85, plannedHours: 13 });
    expect(next).not.toBeNull();
    const open = listNotes();
    expect(open).toHaveLength(1);
    expect(open[0].body).toContain('72h');
  });

  it('does NOT resurrect a note the user already dismissed (same sprint, similar numbers)', () => {
    const first = ensureCapacityNudge({ sprintName: '26_13', difference: -60, availableHours: 73, plannedHours: 13 })!;
    dismissNote(first.id);
    // Same sprint, numbers basically unchanged → the user already said no, leave it dismissed.
    const again = ensureCapacityNudge({ sprintName: '26_13', difference: -61, availableHours: 74, plannedHours: 13 });
    expect(again).toBeNull();
    expect(listNotes()).toHaveLength(0);
  });
});

describe('reviewNotesAgainstBoard — the stale-note sweep', () => {
  const boardWith = (...items: { id: number; title: string; state: string }[]) =>
    async (_ids: number[]) => items;

  it('clears a note whose linked item is closed on the board, and names it', async () => {
    const note = addNote('Run design is waiting on you', 100001);
    const review = await reviewNotesAgainstBoard(
      boardWith({ id: 100001, title: 'Run design', state: 'Closed' }),
    );
    expect(review.cleared).toEqual([
      { noteId: note.id, workItemId: 100001, displayName: '**Run design** (#100001)' },
    ]);
    expect(review.notes).toHaveLength(0);
    expect(listNotes()).toHaveLength(0); // actually dismissed in the db
  });

  it('clears a note whose item is gone from the board entirely (deleted)', async () => {
    addNote('Ghost task needs a look', 100002);
    const review = await reviewNotesAgainstBoard(boardWith(/* nothing comes back */));
    expect(review.cleared).toHaveLength(1);
    expect(review.cleared[0].displayName).toBe('#100002'); // no title to show
    expect(listNotes()).toHaveLength(0);
  });

  it('keeps a note whose item is still open, enriched with the live state', async () => {
    addNote('Estimate looks low here', 100003);
    const review = await reviewNotesAgainstBoard(
      boardWith({ id: 100003, title: 'Wire the export', state: 'Active' }),
    );
    expect(review.cleared).toHaveLength(0);
    expect(review.notes[0].boardState).toBe('Active');
    expect(review.notes[0].itemDisplayName).toBe('**Wire the export** (#100003)');
    expect(listNotes()).toHaveLength(1);
  });

  it('never touches a note with no linked item, and never calls the board for it', async () => {
    addNote('Good week for deep work');
    let called = false;
    const review = await reviewNotesAgainstBoard(async ids => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(review.cleared).toHaveLength(0);
    expect(review.notes[0].boardState).toBeNull();
  });

  it('never clears a PINNED note, even when its item is closed — a pin is a doubt', async () => {
    const note = addNote('Keep this in front of me', 100004);
    pinNote(note.id);
    const review = await reviewNotesAgainstBoard(
      boardWith({ id: 100004, title: 'Old story', state: 'Closed' }),
    );
    expect(review.cleared).toHaveLength(0);
    expect(review.notes[0].boardState).toBe('Closed'); // shown, so the assistant can ask
    expect(listNotes()).toHaveLength(1);
  });

  it('clears nothing when the board read fails — no proof, no action', async () => {
    addNote('Might be stale', 100005);
    const review = await reviewNotesAgainstBoard(async () => {
      throw new Error('board down');
    });
    expect(review.cleared).toHaveLength(0);
    expect(review.notes[0].boardState).toBeNull(); // unbacked → dropped, not guessed
    expect(listNotes()).toHaveLength(1);
  });
});

describe('clearedNotesLine', () => {
  it('says nothing when nothing was cleared', () => {
    expect(clearedNotesLine([])).toBeNull();
  });

  it('one note → one plain sentence naming it', () => {
    expect(
      clearedNotesLine([{ noteId: 1, workItemId: 100001, displayName: '**Run design** (#100001)' }]),
    ).toBe('I cleared an old note about **Run design** (#100001) — that work is closed on the board now.');
  });

  it('several notes → one sentence listing all the names', () => {
    const line = clearedNotesLine([
      { noteId: 1, workItemId: 100001, displayName: '**Run design** (#100001)' },
      { noteId: 2, workItemId: 100002, displayName: '**Ship it** (#100002)' },
    ]);
    expect(line).toBe(
      "I cleared 2 old notes about work that's closed on the board now: **Run design** (#100001) and **Ship it** (#100002).",
    );
  });
});

describe('ensureStaleRemainingNudge — one note per task', () => {
  const base = { workItemId: 100001, title: 'Example task', remainingWork: 3, daysSince: 4 };

  it('a new sprint replaces the old sprint\'s copy of the note', () => {
    ensureStaleRemainingNudge({ ...base, sprintName: 'S1' });
    ensureStaleRemainingNudge({ ...base, sprintName: 'S2' });
    const open = listNotes(10).filter(n => n.workItemId === 100001);
    expect(open).toHaveLength(1);
  });

  it('a kept copy stays', () => {
    const first = ensureStaleRemainingNudge({ ...base, sprintName: 'S1' });
    pinNote(first!.id);
    ensureStaleRemainingNudge({ ...base, sprintName: 'S2' });
    expect(listNotes(10).filter(n => n.workItemId === 100001)).toHaveLength(2);
  });

  it('other notes on the same task stay', () => {
    addNote('A note the user wrote about this task.', 100001);
    ensureStaleRemainingNudge({ ...base, sprintName: 'S1' });
    expect(listNotes(10).filter(n => n.workItemId === 100001)).toHaveLength(2);
  });
});
