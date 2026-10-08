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

const CAPACITY_NUDGE_KEY = 'capacity_nudge_state';
const STALE_REMAINING_NUDGE_PREFIX = 'stale_remaining_nudge';
const MS_PER_DAY = 1000 * 60 * 60 * 24;

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
  if (Math.abs(opts.difference) < threshold) return null;
  const direction: 'over' | 'under' = opts.difference > 0 ? 'over' : 'under';
  const gap = Math.round(Math.abs(opts.difference));

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
 * One row per "going" task that's a candidate for the stale-remaining check.
 * Caller is responsible for filtering to Task type and 'going' state.
 */
export interface StaleRemainingCandidate {
  workItemId: number;
  title: string;
  remainingWork: number | null;
}

/**
 * Scan going-state tasks for stale Remaining Work. A task is "stale" when:
 *   - no row currently has an open session on it (open session = active work,
 *     not stale by definition), AND
 *   - the most recent session_event on this task is older than `staleDays`
 *     calendar days, OR no session_event has ever been recorded.
 *
 * For each stale task we add a helper note naming it by title, deduped per
 * task per sprint via a settings key — same pattern as `ensureCapacityNudge`.
 * Returns the notes that were freshly added.
 */
export function scanStaleRemaining(opts: {
  sprintName: string;
  candidates: StaleRemainingCandidate[];
  staleDays?: number;
}): HelperNote[] {
  const staleDays = opts.staleDays ?? 2;
  const staleMs = staleDays * MS_PER_DAY;
  const nowMs = Date.now();
  const db = getDb();

  if (opts.candidates.length === 0) return [];

  const ids = opts.candidates.map(c => c.workItemId);
  const placeholders = ids.map(() => '?').join(',');

  const openRows = db
    .prepare(`SELECT DISTINCT work_item_id FROM sessions WHERE ended_at IS NULL AND work_item_id IN (${placeholders})`)
    .all(...ids) as { work_item_id: number }[];
  const openIds = new Set(openRows.map(r => r.work_item_id));

  const lastRows = db
    .prepare(
      `SELECT work_item_id, MAX(created_at) AS last_at
         FROM session_events
        WHERE work_item_id IN (${placeholders})
        GROUP BY work_item_id`,
    )
    .all(...ids) as { work_item_id: number; last_at: string | null }[];
  const lastByItem = new Map<number, string>();
  for (const r of lastRows) {
    if (r.last_at) lastByItem.set(r.work_item_id, r.last_at);
  }

  const created: HelperNote[] = [];
  for (const c of opts.candidates) {
    if (openIds.has(c.workItemId)) continue;
    const lastAt = lastByItem.get(c.workItemId);
    let daysSince: number | null = null;
    if (lastAt) {
      const ageMs = nowMs - Date.parse(lastAt);
      if (ageMs < staleMs) continue;
      daysSince = Math.floor(ageMs / MS_PER_DAY);
    }

    const note = ensureStaleRemainingNudge({
      sprintName: opts.sprintName,
      workItemId: c.workItemId,
      title: c.title,
      remainingWork: c.remainingWork,
      daysSince,
    });
    if (note) created.push(note);
  }
  return created;
}

function ensureStaleRemainingNudge(opts: {
  sprintName: string;
  workItemId: number;
  title: string;
  remainingWork: number | null;
  daysSince: number | null;
}): HelperNote | null {
  const key = `${STALE_REMAINING_NUDGE_PREFIX}_${opts.sprintName}_${opts.workItemId}`;
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (row) return null;

  const displayName = displayNameFor(opts.workItemId, opts.title);
  const remPart =
    opts.remainingWork != null
      ? `Remaining still shows ${Math.round(opts.remainingWork)}h`
      : "Remaining hasn't been touched";
  const lead =
    opts.daysSince != null && opts.daysSince > 0
      ? `${displayName} has been going for ${opts.daysSince} days but ${remPart}`
      : `${displayName} has been going with no activity yet and ${remPart}`;
  const body = `${lead} — update Remaining or move the task off your plate.`;

  const note = addNote(body, opts.workItemId);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, new Date().toISOString());
  // Marks from earlier sprints can never match again; drop them.
  const sprintPrefix = `${STALE_REMAINING_NUDGE_PREFIX}_${opts.sprintName}_`;
  db.prepare(
    `DELETE FROM settings WHERE key LIKE '${STALE_REMAINING_NUDGE_PREFIX}%' AND substr(key, 1, ?) != ?`,
  ).run(sprintPrefix.length, sprintPrefix);
  return note;
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
