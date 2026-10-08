/**
 * Timer operations against the local SQLite store.
 *
 * Multiple work items can be running at once (The user works in parallel).
 * Each timer "session" is a row in time_entries; resuming a paused timer
 * creates a new row rather than mutating the old one.
 */
import { getDb } from './db';
import { STALE_IDLE_MINUTES } from './session-activity';

/** The longest quiet stretch a timer counts in full. Past this, the chat went
 * quiet (same line orient uses), so the rest of the stretch is not counted. */
const MAX_QUIET_MS = STALE_IDLE_MINUTES * 60 * 1000;

export interface TimeEntryRow {
  id: number;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  synced_to_ado: number;
}

export interface TimerSnapshot {
  workItemId: number;
  /** Currently-running entry, if any. */
  running: TimeEntryRow | null;
  /** Total elapsed seconds across ALL entries for this item (running + closed). */
  totalSeconds: number;
  /** Seconds tracked locally that haven't been pushed to ADO. */
  unsyncedSeconds: number;
}

/* ============================================================ */
/*  Mutations                                                    */
/* ============================================================ */

/**
 * Start a timer for a work item. Idempotent: if one is already running for
 * this item, returns the existing row unchanged.
 */
export function startTimer(workItemId: number): TimeEntryRow {
  const db = getDb();
  const existing = db
    .prepare<[number], TimeEntryRow>(
      `SELECT * FROM time_entries
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workItemId);
  if (existing) return existing;

  const startedAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO time_entries (work_item_id, started_at, ended_at)
       VALUES (?, ?, NULL)`,
    )
    .run(workItemId, startedAt);
  return db
    .prepare<[number], TimeEntryRow>(`SELECT * FROM time_entries WHERE id = ?`)
    .get(Number(info.lastInsertRowid))!;
}

/**
 * Pause the running timer for a work item. No-op if none is running.
 * Returns the closed row, or null if there was nothing to close.
 *
 * Also marks the closed entry as `synced_to_ado = 1`. This is the new
 * model after the user caught the 211h-of-ghost-time bug 2026-06-02:
 * `localUncapturedSeconds` is only meaningful for currently-running
 * timers (i.e. live elapsed counters). Once a session ends, its time
 * should NOT keep contributing to capacity — by then the assistant has
 * called `remainingHoursAfter` to keep ADO's RemainingWork honest, and
 * `CompletedWork` is derived from the burndown (Estimate − Remaining).
 * Keeping closed-unsynced rows around just inflates the numbers forever.
 */
export function pauseTimer(workItemId: number): TimeEntryRow | null {
  const db = getDb();
  const running = db
    .prepare<[number], TimeEntryRow>(
      `SELECT * FROM time_entries
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workItemId);
  if (!running) return null;
  // Stored as start + counted time, so a session left open for days closes
  // with the time that was really worked, not the days it sat there.
  const startMs = new Date(running.started_at).getTime();
  const endedAt = new Date(startMs + entryMs(running, Date.now())).toISOString();
  db.prepare(`UPDATE time_entries SET ended_at = ?, synced_to_ado = 1 WHERE id = ?`).run(
    endedAt,
    running.id,
  );
  return { ...running, ended_at: endedAt, synced_to_ado: 1 };
}

/* ============================================================ */
/*  Reads                                                        */
/* ============================================================ */

/**
 * Time between start and end, where any quiet stretch (no logged activity in
 * between) counts as {@link MAX_QUIET_MS} at most. Pure.
 *
 * Why: a session opened on 1 day and forgotten until 5 days later used to
 * count all 5 days. Every warning about it needs someone to answer; this does
 * not. The cost: real work done silently for more than 2 hours counts short.
 */
export function countedMs(startMs: number, activityMs: number[], endMs: number, maxQuietMs = MAX_QUIET_MS): number {
  const points = [startMs, ...activityMs.filter(t => t > startMs && t < endMs).sort((a, b) => a - b), endMs];
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.min(Math.max(0, points[i] - points[i - 1]), maxQuietMs);
  return total;
}

/** Logged activity times on a work item after a timer started. */
function activitySince(workItemId: number, startedAt: string): number[] {
  return getDb()
    .prepare<[number, string], { created_at: string }>(
      `SELECT created_at FROM session_events WHERE work_item_id = ? AND created_at > ?`,
    )
    .all(workItemId, startedAt)
    .map(r => new Date(r.created_at).getTime());
}

/** Counted length of one entry. A closed entry already stores its counted end. */
function entryMs(e: { work_item_id: number; started_at: string; ended_at: string | null }, now: number): number {
  const start = new Date(e.started_at).getTime();
  if (e.ended_at) return Math.max(0, new Date(e.ended_at).getTime() - start);
  return countedMs(start, activitySince(e.work_item_id, e.started_at), now);
}

function entrySeconds(e: { work_item_id: number; started_at: string; ended_at: string | null }, now: number): number {
  return Math.round(entryMs(e, now) / 1000);
}

export function getTimerSnapshot(workItemId: number): TimerSnapshot {
  const db = getDb();
  const entries = db
    .prepare<[number], TimeEntryRow>(
      `SELECT * FROM time_entries WHERE work_item_id = ? ORDER BY id ASC`,
    )
    .all(workItemId);

  const now = Date.now();
  let totalSeconds = 0;
  let unsyncedSeconds = 0;
  let running: TimeEntryRow | null = null;

  for (const e of entries) {
    const sec = entrySeconds(e, now);
    totalSeconds += sec;
    if (e.synced_to_ado === 0) unsyncedSeconds += sec;
    if (e.ended_at == null) running = e;
  }
  return { workItemId, running, totalSeconds, unsyncedSeconds };
}

/**
 * Local logged time per work item, as a {workItemId: seconds} map.
 * Includes both unsynced AND already-synced entries — this is total time
 * the user has tracked locally on the item.
 */
export function getLocalLoggedMap(): Map<number, number> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string; ended_at: string | null }>(
      `SELECT work_item_id, started_at, ended_at FROM time_entries`,
    )
    .all();
  const now = Date.now();
  const m = new Map<number, number>();
  for (const r of rows) {
    m.set(r.work_item_id, (m.get(r.work_item_id) ?? 0) + entrySeconds(r, now));
  }
  return m;
}

/**
 * Seconds-not-yet-in-ADO per work item: closed-unsynced entries plus any
 * currently-running session's elapsed time. This is what the UI should add
 * to ADO's CompletedWork to show "real" logged hours.
 */
export function getUncapturedSecondsMap(): Map<number, number> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string; ended_at: string | null; synced_to_ado: number }>(
      `SELECT work_item_id, started_at, ended_at, synced_to_ado
       FROM time_entries
       WHERE ended_at IS NULL OR synced_to_ado = 0`,
    )
    .all();
  const now = Date.now();
  const m = new Map<number, number>();
  for (const r of rows) {
    m.set(r.work_item_id, (m.get(r.work_item_id) ?? 0) + entrySeconds(r, now));
  }
  return m;
}

/** {workItemId: startedAt ISO} for items with a currently-running timer. */
export function getRunningStartsMap(): Map<number, string> {
  const rows = getDb()
    .prepare<[], { work_item_id: number; started_at: string }>(
      `SELECT work_item_id, started_at FROM time_entries WHERE ended_at IS NULL`,
    )
    .all();
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.work_item_id, r.started_at);
  return m;
}

/** Count of unpushed local changes (closed time entries + failed sync queue). */
export function getPendingChangesCount(): number {
  const db = getDb();
  const a = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NOT NULL AND synced_to_ado = 0`,
    )
    .get()!.n;
  const b = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM pending_changes WHERE applied_at IS NULL`,
    )
    .get()!.n;
  return a + b;
}

/* ============================================================ */
/*  Pending changes queue (for failed ADO pushes)                */
/* ============================================================ */

export interface PendingChange {
  id: number;
  workItemId: number;
  kind: string;
  payload: string;
  createdAt: string;
  error: string | null;
}

/**
 * Remember a change we tried to send to Azure DevOps and that did not go
 * through. The row stays open until a later try for the same task succeeds
 * (see `markPendingChangesApplied`), so the count below is an honest answer to
 * "is anything still out of step with the board?".
 */
export function recordFailedSync(
  workItemId: number,
  kind: 'effort' | 'state',
  payload: unknown,
  error: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_changes (work_item_id, kind, payload, created_at, error)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(workItemId, kind, JSON.stringify(payload), new Date().toISOString(), error);
}

/** Every change that still hasn't reached the board, oldest first. */
export function listOpenPendingChanges(): PendingChange[] {
  return getDb()
    .prepare<[], {
      id: number;
      work_item_id: number;
      kind: string;
      payload: string;
      created_at: string;
      error: string | null;
    }>(
      `SELECT id, work_item_id, kind, payload, created_at, error
       FROM pending_changes
       WHERE applied_at IS NULL
       ORDER BY id ASC`,
    )
    .all()
    .map(r => ({
      id: r.id,
      workItemId: r.work_item_id,
      kind: r.kind,
      payload: r.payload,
      createdAt: r.created_at,
      error: r.error,
    }));
}

/**
 * A later try for this task went through, so whatever we noted down for it
 * earlier is settled. Called after a successful close.
 */
export function markPendingChangesApplied(workItemId: number): void {
  getDb()
    .prepare(`UPDATE pending_changes SET applied_at = ? WHERE work_item_id = ? AND applied_at IS NULL`)
    .run(new Date().toISOString(), workItemId);
}

/**
 * One plain sentence about changes that never reached the board, or null when
 * there are none. Written for the assistant to read out to the user, so it
 * says the ids and lets the assistant name the tasks by their titles.
 */
export function describeUnfinishedBoardChanges(): string | null {
  const open = listOpenPendingChanges();
  if (open.length === 0) return null;
  const ids = [...new Set(open.map(c => c.workItemId))];
  const idList = ids.map(id => `#${id}`).join(', ');
  const changeWord = open.length === 1 ? 'change' : 'changes';
  const taskWord = ids.length === 1 ? 'task' : 'tasks';
  return `${open.length} ${changeWord} never reached the board, on ${ids.length} ${taskWord}: ${idList}. Look those up, name them by their titles, and tell the user the board may be out of step with what the user thinks is saved.`;
}

/* ============================================================ */
/*  Settings helpers                                             */
/* ============================================================ */

export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
    .get(key);
  return row?.value;
}

/** Remove a setting, for per-task bookkeeping that is no longer needed. */
export function deleteSetting(key: string): void {
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
