/**
 * Local SQLite store at ~/.sprintomatic/data.db.
 *
 * Holds state that doesn't belong in Azure DevOps:
 *  - time_entries: every start/stop session per work item (multiple per item).
 *  - pending_changes: changes we tried to push to ADO and failed; retry queue.
 *  - settings: misc key/value config.
 *  - sessions / session_events: Claude Code sessions reported via MCP — what
 *    the user is working on right now, plus summaries, blockers, decisions.
 *  - helper_notes: the assistant's plain-English nudges (R3); soft-dismissed.
 *  - sh_created_items: items the MCP itself created (Task / Story); local
 *    marker only, never reaches Azure DevOps.
 *  - facts: long-lived facts about the user (paths, preferences, process
 *    rules) saved once from chat and carried into every orient packet.
 *
 * Connection is opened lazily and cached for the life of the process.
 */
import Database, { type Database as DB } from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase } from './backup';
import { logError } from './log';

let cached: DB | null = null;

export function getDb(): DB {
  if (cached) return cached;
  const dir = join(homedir(), '.sprintomatic');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = join(dir, 'data.db');
  const db = new Database(dbPath);
  lockToOwner(dir, dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  cached = db;
  // One copy of the store per day, kept for 30 days. Wrapped so a full disk or
  // a folder we can't write never stops the tool from starting.
  try {
    // backupDatabase reports a failure in its result rather than throwing, and
    // nothing here acts on it — so write it down before it disappears.
    const result = backupDatabase(db);
    if (result.status === 'failed') {
      logError('db.getDb.backup', result.error ?? 'backup failed', { store: dbPath });
    }
  } catch (err) {
    // backupDatabase already swallows its own errors; this is the last net.
    // Still ignored on purpose — a backup must never stop the tool starting —
    // but now there is a line to show someone.
    logError('db.getDb.backup', err, { store: dbPath });
  }
  return db;
}

/**
 * Only the user may open the folder or the store. Without the Keychain the
 * token sits in the store as plain text, and the default file mode lets anyone
 * else on the computer read it. chmod (not just the mkdir mode) so an install
 * made before this rule gets fixed too.
 */
function lockToOwner(dir: string, dbPath: string): void {
  try {
    chmodSync(dir, 0o700);
    chmodSync(dbPath, 0o600);
  } catch (err) {
    logError('db.lockToOwner', err, { store: dbPath });
  }
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id  INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      note          TEXT,
      synced_to_ado INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_time_entries_wi
      ON time_entries(work_item_id);

    CREATE TABLE IF NOT EXISTS pending_changes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      applied_at   TEXT,
      error        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_open
      ON pending_changes(work_item_id) WHERE applied_at IS NULL;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Per-task bookkeeping used to be "cleared" by writing an empty value, so
    -- the rows piled up forever. They are deleted now; drop the old empty ones.
    DELETE FROM settings WHERE value = ''
      AND (key LIKE 'completed_auto_filled_%' OR key LIKE 'blocked_prior_state_%'
           OR key LIKE 'remaining_prior_to_close_%');

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      work_item_id INTEGER NOT NULL,
      started_at   TEXT NOT NULL,
      ended_at     TEXT,
      client       TEXT NOT NULL DEFAULT 'claude-code',
      summary      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_wi
      ON sessions(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_active
      ON sessions(work_item_id) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      work_item_id INTEGER NOT NULL,
      type         TEXT NOT NULL,
      text         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_wi
      ON session_events(work_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id);

    CREATE TABLE IF NOT EXISTS helper_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      dismissed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_helper_notes_open
      ON helper_notes(created_at DESC) WHERE dismissed_at IS NULL;

    CREATE TABLE IF NOT EXISTS sh_created_items (
      work_item_id INTEGER PRIMARY KEY,
      kind         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sh_created_kind
      ON sh_created_items(kind);

    CREATE TABLE IF NOT EXISTS facts (
      name       TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Idempotent ADD COLUMN for session_events.standup_summary (R22, 2026-06-04).
  // Optional AI-written 1-2 sentence read-this-tomorrow blurb for the standup
  // card. Long-form progress text stays in `text`; this is the concise version
  // the user reads on their Yesterday/Today rows.
  const hasStandupSummary = db
    .prepare("SELECT 1 FROM pragma_table_info('session_events') WHERE name = 'standup_summary'")
    .get();
  if (!hasStandupSummary) {
    db.exec('ALTER TABLE session_events ADD COLUMN standup_summary TEXT');
  }

  // Idempotent ADD COLUMN for helper_notes.pinned_at (2026-06-09). Null = not
  // kept; an ISO timestamp = the user pinned it ("Keep"), so it sorts first and
  // can't get buried under newer notes.
  const hasPinnedAt = db
    .prepare("SELECT 1 FROM pragma_table_info('helper_notes') WHERE name = 'pinned_at'")
    .get();
  if (!hasPinnedAt) {
    db.exec('ALTER TABLE helper_notes ADD COLUMN pinned_at TEXT');
  }

  // Idempotent ADD COLUMN for helper_notes.work_item_id (2026-06-09). Null =
  // the note isn't about a specific work item (capacity / free-form notes);
  // otherwise the Azure DevOps id it refers to, so Focus mode can show the
  // notes about the task in front of them.
  const hasWorkItemId = db
    .prepare("SELECT 1 FROM pragma_table_info('helper_notes') WHERE name = 'work_item_id'")
    .get();
  if (!hasWorkItemId) {
    db.exec('ALTER TABLE helper_notes ADD COLUMN work_item_id INTEGER');
  }

  // Idempotent ADD COLUMNs for multi-session work (2026-07-01).
  // cwd: the whole folder path of the chat that started the session — with
  //   several chats running in parallel, this is how each chat recognizes its
  //   OWN session instead of adopting another chat's. Rows written before
  //   2026-08-07 hold only the last folder name; see sessionOwnershipHint,
  //   which stays quiet on those instead of warning wrongly.
  // waiting_note / waiting_since: set (via session_waiting) when a chat stops
  //   mid-task to ask the user a question; the dashboard's "Needs you" card reads
  //   them. Cleared automatically by the session's next log or end.
  const hasSessionCwd = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'cwd'")
    .get();
  if (!hasSessionCwd) {
    db.exec('ALTER TABLE sessions ADD COLUMN cwd TEXT');
  }
  const hasWaitingNote = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'waiting_note'")
    .get();
  if (!hasWaitingNote) {
    db.exec('ALTER TABLE sessions ADD COLUMN waiting_note TEXT');
  }
  const hasWaitingSince = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'waiting_since'")
    .get();
  if (!hasWaitingSince) {
    db.exec('ALTER TABLE sessions ADD COLUMN waiting_since TEXT');
  }
}
