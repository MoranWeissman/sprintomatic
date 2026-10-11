/**
 * Helper's notes store (slice R3).
 *
 * Local-only (never in Azure DevOps): individual nudges in `helper_notes`,
 * newest-first, soft-dismissed (the user ticks them off — we set dismissed_at, we
 * don't delete). The assistant writes these via MCP; the Day dashboard reads
 * them via the payload.
 */
import { getDb } from './db';
import { displayNameFor } from './display-name';
import { isDoneState } from './states';
import { listDaysOff } from './days-off';
import { taskCheckup, type CheckupSession } from './task-checkup';
import { getLocalLoggedMap } from './timers';
import { getWorkingDays } from './user-config';
import { getUsualHours } from './work-hours';

const CAPACITY_NUDGE_KEY = 'capacity_nudge_state';
const STALE_REMAINING_NUDGE_PREFIX = 'stale_remaining_nudge';

/**
 * Guard state for the capacity nudge. We remember the sprint, the direction
 * (over/under), the gap we last showed, and the id of the note we posted — so
 * we can RETIRE a stale note and post a fresh one when the numbers actually
 * move, instead of leaving a frozen snapshot on the board. `noteId` is null for
 * legacy rows written before this field existed.
 */
interface StoredCapacityNudge {
  sprintName: string;
  direction: 'over' | 'under';
  addedAt: string;
  /** The rounded gap (h) the last-posted note quoted. */
  gap?: number;
  /** Id of the note we posted, so we can dismiss it on refresh. */
  noteId?: number | null;
}

/**
 * How far the gap must move (hours) before we replace the note with fresh
 * numbers. Below this, the old note is "close enough" — leave it (and respect
 * a dismissal). At/above this, the snapshot is misleading, so refresh it.
 */
const CAPACITY_REFRESH_TOLERANCE_H = 8;

export interface HelperNote {
  id: number;
  body: string;
  createdAt: string;
  pinnedAt: string | null;
  workItemId: number | null;
}

export interface HelperNotes {
  notes: HelperNote[];
}

/** Add a nudge. `workItemId` ties it to a task so Focus can show it. Returns the created note. */
export function addNote(body: string, workItemId: number | null = null): HelperNote {
  const db = getDb();
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note body is required.');
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO helper_notes (body, created_at, work_item_id) VALUES (?, ?, ?)`)
    .run(trimmed, createdAt, workItemId);
  return { id: Number(info.lastInsertRowid), body: trimmed, createdAt, pinnedAt: null, workItemId };
}

/** Open (not-yet-dismissed) notes: kept ones first, then newest first. */
export function listNotes(limit = 5): HelperNote[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, body, created_at AS createdAt, pinned_at AS pinnedAt, work_item_id AS workItemId
         FROM helper_notes
        WHERE dismissed_at IS NULL
        ORDER BY (pinned_at IS NOT NULL) DESC, datetime(created_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as HelperNote[];
  return rows;
}

/** Tick a note off (soft-dismiss). Returns true if a still-open note was dismissed. */
export function dismissNote(id: number): boolean {
  const db = getDb();
  const info = db
    .prepare(`UPDATE helper_notes SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`)
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** Keep a note (pin it). Returns true if a still-open note was pinned. */
export function pinNote(id: number): boolean {
  const db = getDb();
  const info = db
    .prepare(`UPDATE helper_notes SET pinned_at = ? WHERE id = ? AND dismissed_at IS NULL`)
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** Un-keep a note (unpin it). Returns true if a still-open note was unpinned. */
export function unpinNote(id: number): boolean {
  const db = getDb();
  const info = db
    .prepare(`UPDATE helper_notes SET pinned_at = NULL WHERE id = ? AND dismissed_at IS NULL`)
    .run(id);
  return info.changes > 0;
}

/** Combined read for the dashboard payload + the MCP get tool. */
export function getHelperNotes(limit = 5): HelperNotes {
  return { notes: listNotes(limit) };
}

/**
 * Add a capacity nudge when planned hours diverge from the hours-available-
 * after-meetings by `thresholdHours` (default 8h = a full the user-day). Deduped
 * via a settings key — fires at most once per sprint per direction
 * (over/under). If sprint changes or direction flips, fires again. Returns
 * the new note, or null if the gap is below threshold or already nudged.
 */
export function ensureCapacityNudge(opts: {
  sprintName: string;
  difference: number;
  availableHours: number;
  plannedHours: number;
  thresholdHours?: number;
}): HelperNote | null {
  const threshold = opts.thresholdHours ?? 8;
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(CAPACITY_NUDGE_KEY) as
    | { value: string }
    | undefined;

  let prev: StoredCapacityNudge | null = null;
  if (row) {
    try {
      prev = JSON.parse(row.value) as StoredCapacityNudge;
    } catch {
      /* corrupt state — treat as no prior nudge */
    }
  }

  if (Math.abs(opts.difference) < threshold) {
    // The hours are fine now (or it's a new sprint that fits). The old note
    // is no longer true, so it goes, unless the user kept it.
    if (prev?.noteId != null) {
      db.prepare(`UPDATE helper_notes SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL AND pinned_at IS NULL`)
        .run(new Date().toISOString(), prev.noteId);
    }
    if (row) db.prepare(`DELETE FROM settings WHERE key = ?`).run(CAPACITY_NUDGE_KEY);
    return null;
  }
  const direction: 'over' | 'under' = opts.difference > 0 ? 'over' : 'under';
  const gap = Math.round(Math.abs(opts.difference));

  if (prev && prev.sprintName === opts.sprintName && prev.direction === direction) {
    // Same sprint, same direction. Only act if the numbers have drifted enough
    // that the posted note is now misleading. Within tolerance we leave the
    // existing note exactly as-is — which also means a dismissed note STAYS
    // dismissed (we never resurrect a nudge the user already waved off).
    const prevGap = prev.gap ?? gap;
    if (Math.abs(prevGap - gap) < CAPACITY_REFRESH_TOLERANCE_H) return null;
  }

  // We're going to post a fresh note (new sprint, flipped direction, or the
  // gap drifted past tolerance). Retire the previous note first so the board
  // never shows two capacity nudges or a stale snapshot alongside the new one.
  if (prev && prev.noteId != null) {
    dismissNote(prev.noteId);
  }

  const planned = Math.round(opts.plannedHours);
  const available = Math.round(opts.availableHours);
  const body =
    direction === 'over'
      ? `You're planned about ${gap}h over capacity this sprint (${planned}h planned vs ~${available}h available after meetings). Want to trim or push something?`
      : `You've got about ${gap}h of room left this sprint (${planned}h planned vs ~${available}h available after meetings). Want to pull something in?`;

  const note = addNote(body);

  const next: StoredCapacityNudge = {
    sprintName: opts.sprintName,
    direction,
    addedAt: new Date().toISOString(),
    gap,
    noteId: note.id,
  };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CAPACITY_NUDGE_KEY, JSON.stringify(next));

  return note;
}

/**
 * One row per "going" task that's a candidate for the quiet-task check.
 * Caller is responsible for filtering to Task type and 'going' state.
 */
export interface StaleRemainingCandidate {
  workItemId: number;
  title: string;
  originalEstimate: number | null;
  remainingWork: number | null;
}

/** The fixed end of every old-style "task going too long" note, before
 *  server/task-checkup.ts wrote them. Lets an old copy still be found. */
const OLD_STALE_REMAINING_TAIL = 'update Remaining or move the task off your plate.';

/**
 * Check every going task that has gone quiet and write one note per task
 * with a real suggestion (server/task-checkup.ts decides what it says).
 * A task that is fine again gets its note cleared, so a note never stays
 * after it stops being true. Returns the notes that were freshly added.
 */
export function scanStaleRemaining(opts: {
  sprintName: string;
  candidates: StaleRemainingCandidate[];
  now?: Date;
}): HelperNote[] {
  const now = opts.now ?? new Date();
  const db = getDb();

  // A task that's no longer going in this sprint (moved back, moved out,
  // finished) is never checked again, so its note would stay forever.
  // Clear those first.
  const going = new Set(opts.candidates.map(c => c.workItemId));
  const noted = new Set<number>();
  for (const r of db
    .prepare(`SELECT key FROM settings WHERE substr(key, 1, ?) = ?`)
    .all(STALE_REMAINING_NUDGE_PREFIX.length + 1, `${STALE_REMAINING_NUDGE_PREFIX}_`) as { key: string }[]) {
    noted.add(Number(r.key.slice(r.key.lastIndexOf('_') + 1)));
  }
  for (const r of db
    .prepare(`SELECT work_item_id FROM helper_notes WHERE dismissed_at IS NULL AND work_item_id IS NOT NULL AND body LIKE ?`)
    .all(`%${OLD_STALE_REMAINING_TAIL}`) as { work_item_id: number }[]) {
    noted.add(r.work_item_id);
  }
  for (const id of noted) if (!going.has(id)) clearStaleRemainingNudge(id);

  if (opts.candidates.length === 0) return [];
  const ids = opts.candidates.map(c => c.workItemId);
  const placeholders = ids.map(() => '?').join(',');

  const sessionRows = db
    .prepare(
      `SELECT id, work_item_id, started_at, ended_at, waiting_note FROM sessions WHERE work_item_id IN (${placeholders})`,
    )
    .all(...ids) as { id: string; work_item_id: number; started_at: string; ended_at: string | null; waiting_note: string | null }[];
  const eventRows = db
    .prepare(`SELECT session_id, type, created_at FROM session_events WHERE work_item_id IN (${placeholders})`)
    .all(...ids) as { session_id: string; type: string; created_at: string }[];
  const eventsBySession = new Map<string, { type: string; at: Date }[]>();
  for (const e of eventRows) {
    const list = eventsBySession.get(e.session_id) ?? [];
    list.push({ type: e.type, at: new Date(e.created_at) });
    eventsBySession.set(e.session_id, list);
  }
  const sessionsByItem = new Map<number, CheckupSession[]>();
  for (const r of sessionRows) {
    const events = eventsBySession.get(r.id) ?? [];
    const list = sessionsByItem.get(r.work_item_id) ?? [];
    list.push({
      start: new Date(r.started_at),
      end: r.ended_at ? new Date(r.ended_at) : null,
      activity: events.map(e => e.at),
      stuck: r.waiting_note != null || events.some(e => e.type === 'blocker'),
    });
    sessionsByItem.set(r.work_item_id, list);
  }

  const logged = getLocalLoggedMap();
  const workingDays = getWorkingDays();
  const daysOff = new Set(listDaysOff());
  const usual = getUsualHours(now);

  const created: HelperNote[] = [];
  for (const c of opts.candidates) {
    const body = taskCheckup({
      now,
      workItemId: c.workItemId,
      title: c.title,
      estimate: c.originalEstimate,
      remaining: c.remainingWork,
      workedHours: (logged.get(c.workItemId) ?? 0) / 3600,
      sessions: sessionsByItem.get(c.workItemId) ?? [],
      workingDays,
      daysOff,
      usual,
    });
    if (body) {
      const note = ensureStaleRemainingNudge({ sprintName: opts.sprintName, workItemId: c.workItemId, body });
      if (note) created.push(note);
    } else {
      clearStaleRemainingNudge(c.workItemId);
    }
  }
  return created;
}

/** The settings key that says "this task already has its note this sprint". */
function staleKey(sprintName: string, workItemId: number): string {
  return `${STALE_REMAINING_NUDGE_PREFIX}_${sprintName}_${workItemId}`;
}

/**
 * Write the quiet-task note, once per task per sprint. The mark's value is
 * the note's id, so the note can be found again and cleared when it stops
 * being true. Exported for tests.
 */
export function ensureStaleRemainingNudge(opts: {
  sprintName: string;
  workItemId: number;
  body: string;
}): HelperNote | null {
  const key = staleKey(opts.sprintName, opts.workItemId);
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (row) return null;

  // A task carried into a new sprint gets a fresh note; the old sprint's copy
  // of the same note goes, so the user never sees it twice. Kept notes stay.
  dismissOpenStaleNotes(opts.workItemId);
  const note = addNote(opts.body, opts.workItemId);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(note.id));
  // Marks from earlier sprints can never match again; drop them.
  const sprintPrefix = `${STALE_REMAINING_NUDGE_PREFIX}_${opts.sprintName}_`;
  db.prepare(
    `DELETE FROM settings WHERE key LIKE '${STALE_REMAINING_NUDGE_PREFIX}%' AND substr(key, 1, ?) != ?`,
  ).run(sprintPrefix.length, sprintPrefix);
  return note;
}

/**
 * The task is fine again: clear its quiet-task note (unless the user kept
 * it) and drop the mark, so the note can come back if the task goes quiet
 * again later. Exported for tests.
 */
export function clearStaleRemainingNudge(workItemId: number): void {
  dismissOpenStaleNotes(workItemId);
  const del = getDb().prepare(`DELETE FROM settings WHERE key = ?`);
  for (const m of staleMarks(workItemId)) del.run(m.key);
}

/** This task's marks, from any sprint. Matched in code: in LIKE, `_` is a
 *  wildcard, so task 100001 would also catch task 1100001. */
function staleMarks(workItemId: number): { key: string; value: string }[] {
  const rows = getDb()
    .prepare(`SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?`)
    .all(STALE_REMAINING_NUDGE_PREFIX.length + 1, `${STALE_REMAINING_NUDGE_PREFIX}_`) as {
    key: string;
    value: string;
  }[];
  return rows.filter(r => r.key.endsWith(`_${workItemId}`));
}

/** Dismiss this task's open, not-kept quiet-task notes, old style or new. */
function dismissOpenStaleNotes(workItemId: number): void {
  const db = getDb();
  const noteIds = staleMarks(workItemId).map(m => Number(m.value)).filter(n => Number.isInteger(n) && n > 0);
  const at = new Date().toISOString();
  db.prepare(
    `UPDATE helper_notes SET dismissed_at = ?
      WHERE work_item_id = ? AND dismissed_at IS NULL AND pinned_at IS NULL
        AND (body LIKE ? OR id IN (${noteIds.map(() => '?').join(',') || 'NULL'}))`,
  ).run(at, workItemId, `%${OLD_STALE_REMAINING_TAIL}`, ...noteIds);
}

/* ============================================================ */
/*  Stale-note sweep — clear what the board proves is over       */
/* ============================================================ */

/** The board fields the sweep needs. `getWorkItemsWithParents` satisfies it. */
export interface BoardItemState {
  id: number;
  title: string;
  state: string;
}

/** A note the sweep dismissed because the board proved its work is finished. */
export interface ClearedNote {
  noteId: number;
  workItemId: number;
  /** `**<title>** (#<id>)`, or `#<id>` when the item is gone from the board. */
  displayName: string;
}

/** An open note plus what the board says about the item it points at. */
export interface ReviewedNote extends HelperNote {
  /** Live board state of the linked item; null when the note has no item,
   *  the item is gone, or the board couldn't be read. */
  boardState: string | null;
  /** Reading name of the linked item, when the board gave us a title. */
  itemDisplayName: string | null;
}

export interface NotesReview {
  /** Notes auto-dismissed this call: unpinned, tied to an item the board
   *  says is finished/removed (or that is gone from the board entirely). */
  cleared: ClearedNote[];
  /** The notes still open after the sweep, newest-first, enriched. */
  notes: ReviewedNote[];
}

/**
 * Check every open note against the board and clear the ones whose work is
 * provably over.
 *
 * The rule the user set: board says closed = clear, everything else = ask.
 * So a note is auto-dismissed ONLY when all three hold:
 *   - it points at a work item (`workItemId` set),
 *   - it is NOT pinned (a pin means the user chose to keep it — that is a
 *     doubt, and doubt goes to the user, never to code), and
 *   - the board says that item is done/removed, or the item is gone from the
 *     board entirely (deleted → the batch read omits it).
 * Everything else stays and comes back enriched with the item's live state,
 * so the assistant can judge and ASK — never guess — about the rest.
 *
 * `fetchItems` is injected (same DI-by-parameter pattern as elsewhere) and
 * must omit unknown ids rather than throw for them. A failed board read
 * clears nothing and enriches nothing: no proof, no action.
 */
export async function reviewNotesAgainstBoard(
  fetchItems: (ids: number[]) => Promise<BoardItemState[]>,
): Promise<NotesReview> {
  const open = listNotes();
  const linkedIds = [...new Set(open.filter(n => n.workItemId != null).map(n => n.workItemId as number))];

  let byId = new Map<number, BoardItemState>();
  let boardRead = false;
  if (linkedIds.length > 0) {
    try {
      const items = await fetchItems(linkedIds);
      byId = new Map(items.map(i => [i.id, i]));
      boardRead = true;
    } catch {
      /* board unreachable — sweep nothing, enrich nothing */
    }
  }

  const cleared: ClearedNote[] = [];
  const notes: ReviewedNote[] = [];
  for (const note of open) {
    const item = note.workItemId != null && boardRead ? byId.get(note.workItemId) ?? null : null;
    const gone = note.workItemId != null && boardRead && item == null;
    const finished = item != null && isDoneState(item.state);

    if (note.pinnedAt == null && (finished || gone)) {
      dismissNote(note.id);
      cleared.push({
        noteId: note.id,
        workItemId: note.workItemId as number,
        displayName: displayNameFor(note.workItemId, item?.title ?? null),
      });
      continue;
    }

    notes.push({
      ...note,
      boardState: item?.state ?? null,
      itemDisplayName: item ? displayNameFor(item.id, item.title) : null,
    });
  }

  return { cleared, notes };
}

/**
 * The pre-formatted greeting sentence for a sweep that cleared something.
 * Echoed verbatim by the assistant (house rule: the API writes the words).
 * Null when nothing was cleared, so the greeting says nothing about it.
 */
export function clearedNotesLine(cleared: ClearedNote[]): string | null {
  if (cleared.length === 0) return null;
  const names = cleared.map(c => c.displayName);
  if (names.length === 1) {
    return `I cleared an old note about ${names[0]} — that work is closed on the board now.`;
  }
  const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `I cleared ${names.length} old notes about work that's closed on the board now: ${list}.`;
}
