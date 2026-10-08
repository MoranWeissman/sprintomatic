/**
 * Stale-session log nudge. Detects open sessions that haven't seen a
 * session_event in a while and surfaces a one-line reminder the AI sees
 * inside its own tool-response context — so the rule "log at checkpoints"
 * gets active feedback instead of relying on the model remembering.
 *
 * Deduped per session per stale window via a settings key: once a nudge
 * fires for a session, it doesn't re-fire until either a session_event
 * lands (resetting the activity clock) OR the session closes.
 *
 * Threshold: 45 minutes of no activity = stale. Picked to avoid firing
 * during a normal stretch of code work + commit cycle, but catch the
 * "I delegated to four agents and forgot to log" failure mode within
 * one batch's typical runtime.
 */
import { getDb } from './db';

const STALE_THRESHOLD_MS = 45 * 60 * 1000;
const NUDGE_KEY_PREFIX = 'log_nudge';

interface OpenSession {
  id: string;
  work_item_id: number;
  started_at: string;
}

interface StaleSession {
  sessionId: string;
  workItemId: number;
  lastActivityAt: string;
  staleMinutes: number;
}

/**
 * Scan open sessions for staleness; fire nudges where needed; return the
 * formatted reminder text (or null if nothing to nudge).
 *
 * Marks each nudged session in `settings` so re-checks within the same
 * stale window don't re-fire. The marker is keyed by session id so
 * different sessions get independent dedup.
 */
export function checkStaleLogNudge(): string | null {
  const db = getDb();
  const now = Date.now();

  const openSessions = db
    .prepare<[], OpenSession>(
      `SELECT id, work_item_id, started_at FROM sessions WHERE ended_at IS NULL`,
    )
    .all();
  if (openSessions.length === 0) return null;

  const stale: StaleSession[] = [];

  for (const s of openSessions) {
    const lastRow = db
      .prepare<[string], { last_at: string | null }>(
        `SELECT MAX(created_at) AS last_at FROM session_events WHERE session_id = ?`,
      )
      .get(s.id);
    const lastActivity = lastRow?.last_at ?? s.started_at;
    const ageMs = now - Date.parse(lastActivity);
    if (ageMs < STALE_THRESHOLD_MS) continue;

    const nudgeKey = `${NUDGE_KEY_PREFIX}_${s.id}`;
    const nudgeRow = db
      .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
      .get(nudgeKey);
    if (nudgeRow) {
      // Quiet for one window after each nudge, then speak again. The old rule
      // re-armed only when a session_event landed, which meant a session that
      // was never logged got exactly ONE reminder and then silence for the
      // rest of the day — the opposite of what a reminder is for.
      const sinceNudgeMs = now - Date.parse(nudgeRow.value);
      if (sinceNudgeMs < STALE_THRESHOLD_MS) continue;
    }

    stale.push({
      sessionId: s.id,
      workItemId: s.work_item_id,
      lastActivityAt: lastActivity,
      staleMinutes: Math.floor(ageMs / 60_000),
    });

    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(nudgeKey, new Date(now).toISOString());
  }

  if (stale.length === 0) return null;
  return formatNudge(stale);
}

function formatNudge(stale: StaleSession[]): string {
  if (stale.length === 1) {
    const s = stale[0];
    return [
      '',
      '⏰ STALE SESSION — open session on work item #' +
        s.workItemId +
        ' has had no session_log activity in ' +
        s.staleMinutes +
        ' minutes.',
      'If you have been working (including dispatching sub-agents): log a `progress` entry now, naming what got done.',
      'If you have drifted off the task: call `session_end` to close it cleanly.',
      'Said again every 45 minutes while the session stays silent — logging or closing it stops that.',
    ].join('\n');
  }

  const lines = stale.map(
    s => `  - work item #${s.workItemId}: ${s.staleMinutes} min since last activity`,
  );
  return [
    '',
    '⏰ STALE SESSIONS — multiple open sessions have had no session_log activity:',
    ...lines,
    'Log a `progress` entry on each (or call `session_end` on the ones that have drifted).',
    'Said again every 45 minutes per session while they stay silent.',
  ].join('\n');
}

/* ============================================================ */
/*  No session open at all                                       */
/* ============================================================ */

const NO_SESSION_KEY = 'no_session_nudge_at';
/** How long the reminder stays quiet after it fires. */
const NO_SESSION_QUIET_MS = 20 * 60 * 1000;

/**
 * Tools that mean "a task is being worked on right now". Everything else —
 * planning, capacity, discovery, design, the ceremonies, the notes, the
 * facts — is legitimately done with no session open, so it never triggers
 * the reminder.
 *
 * `story_match` and `sprint_check_in` are in here on purpose: they are the
 * step right before a session should open, which makes them the best moment
 * to say so.
 */
const WORK_TOOLS = new Set([
  'story_match',
  'story_match_set',
  'sprint_check_in',
  'estimate_anchor',
  'task_create',
  'story_create',
  'bug_create',
  'story_close',
  'workitem_edit',
  'workitem_block',
  'workitem_unblock',
  'workitem_change_type',
  'workitem_reparent',
]);

/**
 * Remind the assistant that no session is open while work is going on.
 *
 * The stale-log nudge above only speaks about sessions that already exist, so
 * the case the user actually hit — working for hours with no session at all —
 * had nothing watching it. The greeting says it once at the start of a chat
 * and then nobody hears it again; this says it at the moment work shows up.
 *
 * Rate-limited to once per 20 minutes so a long stretch of board edits doesn't
 * turn into a wall of reminders. Returns null for every non-work tool, and for
 * every call where a session is already open.
 */
export function checkNoSessionNudge(toolName: string | null): string | null {
  if (!toolName || !WORK_TOOLS.has(toolName)) return null;

  const db = getDb();
  const open = db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL`)
    .get();
  if ((open?.n ?? 0) > 0) return null;

  const now = Date.now();
  const row = db
    .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
    .get(NO_SESSION_KEY);
  if (row && now - Date.parse(row.value) < NO_SESSION_QUIET_MS) return null;

  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(NO_SESSION_KEY, new Date(now).toISOString());

  return [
    '',
    '⏰ NO SESSION OPEN — work is happening and nothing is being recorded against a task.',
    'Open one now: pick the task (`story_match` if you need to find it) and call `session_start` on it.',
    "If this is planning, a quick look, or a ceremony — nothing to do, carry on.",
    'This is said at most once every 20 minutes.',
  ].join('\n');
}
