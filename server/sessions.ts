/**
 * Claude Code session tracking. Each session is a stretch of work Claude Code
 * reports via the MCP plugin: started against a work item, accumulating events
 * (focus changes, summaries, blockers, decisions), closed when the user finishes.
 *
 * This is the storage + read layer. The MCP server (slice 2.1b) wraps these.
 */
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, normalize, relative, sep } from 'node:path';
import { getDb } from './db';

export type SessionEventType = 'focus' | 'progress' | 'blocker' | 'decision' | 'note';

const EVENT_TYPES: SessionEventType[] = ['focus', 'progress', 'blocker', 'decision', 'note'];

export function isSessionEventType(v: unknown): v is SessionEventType {
  return typeof v === 'string' && (EVENT_TYPES as string[]).includes(v);
}

export interface SessionRow {
  id: string;
  work_item_id: number;
  started_at: string;
  ended_at: string | null;
  client: string;
  summary: string | null;
  cwd: string | null;
  waiting_note: string | null;
  waiting_since: string | null;
}

export interface SessionEventRow {
  id: number;
  session_id: string;
  work_item_id: number;
  type: SessionEventType;
  text: string;
  created_at: string;
}

export interface Session {
  id: string;
  workItemId: number;
  startedAt: string;
  endedAt: string | null;
  client: string;
  summary: string | null;
  /** Repo folder name of the chat that started this session; null on old rows. */
  cwd: string | null;
  /** The question this session's chat is waiting on the user for; null = not waiting. */
  waitingNote: string | null;
  /** When the chat started waiting (ISO); null = not waiting. */
  waitingSince: string | null;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  workItemId: number;
  type: SessionEventType;
  text: string;
  createdAt: string;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    client: r.client,
    summary: r.summary,
    cwd: r.cwd ?? null,
    waitingNote: r.waiting_note ?? null,
    waitingSince: r.waiting_since ?? null,
  };
}

function toEvent(r: SessionEventRow): SessionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    workItemId: r.work_item_id,
    type: r.type,
    text: r.text,
    createdAt: r.created_at,
  };
}

/* ============================================================ */
/*  Mutations                                                    */
/* ============================================================ */

/**
 * The chat's folder, from a cwd the MODEL supplies (it reads its own working
 * directory from its environment — the same value it passes to `story_match`).
 * We CANNOT read it from `process.cwd()`: this server launches via
 * `npm --prefix <sprintomatic> run mcp`, so the server process's cwd is always
 * the sprintomatic repo, never the chat's folder.
 *
 * We keep the WHOLE path, not just the last folder name. A planning workspace
 * root and a feature folder inside it are one chat's work — but with only the
 * last name to go on, `sprintomatic` and `design` look like two different
 * repos, and the warning fired on every single message for a week.
 *
 * A bare name with no separator is kept as it is: resolving it would resolve
 * against the server's own folder, which is the wrong one. A relative path is
 * junk here for the same reason — null, so nothing is guessed.
 */
export function chatCwdKey(cwd: string | null | undefined): string | null {
  if (cwd == null) return null;
  const trimmed = cwd.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  try {
    if (!trimmed.includes('/') && !trimmed.includes(sep)) return trimmed; // bare folder name
    if (!isAbsolute(trimmed)) return null; // relative — we have nothing to resolve it against
    const abs = normalize(trimmed).replace(/\/+$/, '');
    return abs === '' ? null : abs;
  } catch {
    return null;
  }
}

export type SessionOwnership = 'mine' | 'other-repo' | 'unknown';

/** True when `child` sits inside `parent` (not the same folder). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Whose session is this, from THIS chat's point of view? 'unknown' must never
 * warn and never claim a match.
 *
 * Same work when the folders are the same OR when one sits inside the other.
 * That second case is the normal way of working here: the planning workspace
 * is the root and every feature gets its own folder under it.
 */
export function sessionOwnershipHint(
  sessionCwd: string | null,
  chatCwd: string | null,
): SessionOwnership {
  if (sessionCwd == null || chatCwd == null) return 'unknown';
  if (sessionCwd === chatCwd) return 'mine';

  const sessionIsPath = isAbsolute(sessionCwd);
  const chatIsPath = isAbsolute(chatCwd);

  // One side is an old row holding only a folder name. We can't tell whether it
  // sits inside the other, so say nothing rather than warn wrongly. Old rows
  // age out on their own as sessions close.
  if (sessionIsPath !== chatIsPath) {
    return basename(sessionCwd) === basename(chatCwd) ? 'mine' : 'unknown';
  }
  if (!sessionIsPath) return 'other-repo'; // two bare names, and they differ

  return isInside(sessionCwd, chatCwd) || isInside(chatCwd, sessionCwd) ? 'mine' : 'other-repo';
}

/**
 * Of the sessions handed in, the ones this chat's folder owns. Pure — the caller
 * passes the live list, so it's testable without the DB.
 *
 * Used before switching the active feature: hours must not keep landing on the
 * task of the feature the user just left. Only 'mine' counts. 'unknown' (an old row
 * holding a bare folder name, or a chat that didn't supply its cwd) must NOT
 * count — the same rule the cross-folder warning follows. Never block on a
 * guess. Sessions in other repos are somebody else's chat and are none of this
 * one's business, which is why the parallel-session cap (which counts every open
 * row on the machine) can't be reused here.
 */
export function sessionsOwnedByChat(activeSessions: Session[], chatCwd: string | null): Session[] {
  return activeSessions.filter(s => sessionOwnershipHint(s.cwd, chatCwd) === 'mine');
}

/**
 * Start a new session for a work item. If one is already active, returns it
 * unchanged (idempotent) — Claude Code can call this on every reconnect.
 */
export function startSession({
  workItemId,
  client = 'claude-code',
  cwd,
}: {
  workItemId: number;
  client?: string;
  /** Repo folder of the calling chat (basename), supplied by the MCP handler
   *  from the model's cwd. Omit or null when unknown — never auto-detected. */
  cwd?: string | null;
}): Session {
  const db = getDb();
  // The caller (MCP handler) supplies the chat folder from the model's cwd.
  // We can't auto-detect it — process.cwd() is always the sprintomatic repo
  // (npm --prefix launch). Unknown → null, never guessed.
  const chatCwd = cwd !== undefined ? cwd : null;
  const existing = db
    .prepare<[number], SessionRow>(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
  if (existing) {
    // Old (pre-migration) sessions learn their home on first touch. Never
    // overwrite a known cwd — the first chat to open the session owns it.
    if (existing.cwd == null && chatCwd != null) {
      db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(chatCwd, existing.id);
      return toSession({ ...existing, cwd: chatCwd });
    }
    return toSession(existing);
  }

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, started_at, client, cwd)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, workItemId, startedAt, client, chatCwd);
  return {
    id,
    workItemId,
    startedAt,
    endedAt: null,
    client,
    summary: null,
    cwd: chatCwd,
    waitingNote: null,
    waitingSince: null,
  };
}

/**
 * End a session. Optionally records a final summary. No-op if the session is
 * already ended or doesn't exist.
 */
export function endSession({
  sessionId,
  summary,
}: {
  sessionId: string;
  summary?: string;
}): Session | null {
  const db = getDb();
  const row = db
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!row || row.ended_at != null) return row ? toSession(row) : null;

  const endedAt = new Date().toISOString();
  const finalSummary = summary ?? row.summary;

  // Closing the session and logging its final summary must land together — if
  // the process dies between them, the session would read as closed with no
  // matching event, and the history would quietly disagree with itself.
  const closeAndLogSummary = db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET ended_at = ?, summary = ?, waiting_note = NULL, waiting_since = NULL WHERE id = ?`,
    ).run(endedAt, finalSummary, sessionId);
    if (summary && summary.trim().length > 0) {
      logEvent({ sessionId, type: 'progress', text: summary });
    }
  });
  closeAndLogSummary();

  return { ...toSession(row), endedAt, summary: finalSummary, waitingNote: null, waitingSince: null };
}

/**
 * Flag an open session as waiting on the user (the chat stopped mid-task to ask
 * them a question). The dashboard's "Needs you" card reads this. Returns null
 * for a missing or already-ended session — nothing is stored. Cleared
 * automatically by the session's next logEvent or endSession.
 */
export function setSessionWaiting({
  sessionId,
  question,
}: {
  sessionId: string;
  question: string;
}): Session | null {
  const db = getDb();
  const row = db
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!row || row.ended_at != null) return null;
  const since = new Date().toISOString();
  db.prepare(`UPDATE sessions SET waiting_note = ?, waiting_since = ? WHERE id = ?`).run(
    question,
    since,
    sessionId,
  );
  return toSession({ ...row, waiting_note: question, waiting_since: since });
}

export function getSession(sessionId: string): Session | null {
  const row = getDb()
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  return row ? toSession(row) : null;
}

/**
 * Sessions that ENDED within the last `hoursBack` hours, newest first. NOTE:
 * a pause also ends a session — callers deciding "finished" must additionally
 * check the work item's real state (see server/needs-you.ts).
 */
export function listRecentlyEnded(hoursBack: number, now: Date = new Date()): Session[] {
  const cutoff = new Date(now.getTime() - hoursBack * 3_600_000).toISOString();
  return getDb()
    .prepare<[string], SessionRow>(
      `SELECT * FROM sessions
       WHERE ended_at IS NOT NULL AND datetime(ended_at) >= datetime(?)
       ORDER BY datetime(ended_at) DESC`,
    )
    .all(cutoff)
    .map(toSession);
}

/**
 * Log an event against a session. `workItemId` is denormalized into the row so
 * we can query "recent activity for task X" without a join.
 *
 * If the event's `type` is "focus" and the text references a different work
 * item, callers should `startSession` against that item first — this function
 * trusts whatever it's given.
 */
export function logEvent({
  sessionId,
  type,
  text,
  standupSummary,
}: {
  sessionId: string;
  type: SessionEventType;
  text: string;
  /**
   * Optional 1-2 sentence blurb specifically for the standup card — what
   * the user reads on Yesterday/Today rows. Lets the AI write a concise
   * read-this-tomorrow version separate from the long-form `text`.
   */
  standupSummary?: string;
}): SessionEvent | null {
  const db = getDb();
  const session = db
    .prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId);
  if (!session) return null;

  const createdAt = new Date().toISOString();

  // The new event and the "no longer waiting" flag must land together — a
  // half-done write here would leave a session stuck showing as waiting on
  // the user even though a fresh event just came in.
  let eventId = 0;
  const insertEventAndClearWaiting = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO session_events (session_id, work_item_id, type, text, created_at, standup_summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, session.work_item_id, type, text, createdAt, standupSummary ?? null);
    eventId = Number(info.lastInsertRowid);
    db.prepare(`UPDATE sessions SET waiting_note = NULL, waiting_since = NULL WHERE id = ?`).run(sessionId);
  });
  insertEventAndClearWaiting();

  return {
    id: eventId,
    sessionId,
    workItemId: session.work_item_id,
    type,
    text,
    createdAt,
  };
}

/* ============================================================ */
/*  Reads                                                        */
/* ============================================================ */

/** All currently-active sessions (one per work item, in practice). */
export function listActiveSessions(): Session[] {
  return getDb()
    .prepare<[], SessionRow>(
      `SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`,
    )
    .all()
    .map(toSession);
}

/**
 * All sessions for a work item (open + closed), newest-started first.
 * Used by the markdown archive (R8) so each task's history mirrors fully.
 */
export function listSessionsForWorkItem(workItemId: number): Session[] {
  return getDb()
    .prepare<[number], SessionRow>(
      `SELECT * FROM sessions WHERE work_item_id = ? ORDER BY datetime(started_at) ASC`,
    )
    .all(workItemId)
    .map(toSession);
}

/** All events for a session, oldest-first. Used by the archive mirror. */
export function listEventsForSession(sessionId: string): SessionEvent[] {
  return getDb()
    .prepare<[string], SessionEventRow>(
      `SELECT * FROM session_events WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId)
    .map(toEvent);
}

/**
 * Bulk variant for dashboard payloads. Returns a map keyed by workItemId,
 * each value the most recent `limit` events (newest first). Items with no
 * events are omitted from the map.
 */
export function getRecentEventsMap(
  workItemIds: number[],
  limit = 5,
): Map<number, SessionEvent[]> {
  const m = new Map<number, SessionEvent[]>();
  if (workItemIds.length === 0) return m;

  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<number[], SessionEventRow>(
      `SELECT * FROM session_events
       WHERE work_item_id IN (${placeholders})
       ORDER BY work_item_id ASC, id DESC`,
    )
    .all(...workItemIds);

  for (const r of rows) {
    const list = m.get(r.work_item_id);
    if (list) {
      if (list.length < limit) list.push(toEvent(r));
    } else {
      m.set(r.work_item_id, [toEvent(r)]);
    }
  }
  return m;
}

/**
 * For a list of session ids, return the timestamp of the most recent event
 * logged against each. Sessions with no events are omitted. Used by orient to
 * tell whether an open session has gone quiet for a long time (R7c).
 */
export function getLastEventTimestampMap(sessionIds: string[]): Map<string, string> {
  const m = new Map<string, string>();
  if (sessionIds.length === 0) return m;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<string[], { session_id: string; last_at: string }>(
      `SELECT session_id, MAX(created_at) AS last_at
       FROM session_events
       WHERE session_id IN (${placeholders})
       GROUP BY session_id`,
    )
    .all(...sessionIds);
  for (const r of rows) m.set(r.session_id, r.last_at);
  return m;
}

/** {workItemId → activeSession} map. Used by the dashboard payload. */
export function getActiveSessionMap(): Map<number, Session> {
  const m = new Map<number, Session>();
  for (const s of listActiveSessions()) m.set(s.workItemId, s);
  return m;
}

/**
 * {workItemId → number of sessions (open or closed)} for the given items.
 * Used by the dashboard to show a calm "N sittings" total. Items with no
 * sessions are omitted from the map.
 */
export function getSessionCountMap(workItemIds: number[]): Map<number, number> {
  const m = new Map<number, number>();
  if (workItemIds.length === 0) return m;
  const placeholders = workItemIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<number[], { work_item_id: number; n: number }>(
      `SELECT work_item_id, COUNT(*) AS n FROM sessions
       WHERE work_item_id IN (${placeholders})
       GROUP BY work_item_id`,
    )
    .all(...workItemIds);
  for (const r of rows) m.set(r.work_item_id, r.n);
  return m;
}
