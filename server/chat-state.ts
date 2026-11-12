/**
 * Which chats are waiting for the user, told by Claude Code's own hooks.
 *
 * The model can say "I'm waiting" (session_waiting), but only when it
 * remembers. Claude Code fires a hook every time an answer ends (Stop), when
 * it needs a permission (Notification), after each tool (PostToolUse), on each
 * new message (UserPromptSubmit) and when the chat closes (SessionEnd). Those
 * never forget, so they decide whether a chat waits. The Mac app reads the
 * result for its menu bar count.
 *
 * The hook process writes here directly (scripts/guard.ts), so this file must
 * stay cheap: no import of ./db, no board calls. The table is made here too, so
 * the hook works even before the dashboard or the tool server ever opened the
 * store.
 */
import { basename } from 'node:path';

export const CHAT_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_state (
    chat_id    TEXT PRIMARY KEY,
    client     TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    tty        TEXT,
    state      TEXT NOT NULL,
    reason     TEXT,
    since      TEXT NOT NULL
  );
`;

/** How long a chat waits before it counts. A permission ask the user is
 *  looking at right now shouldn't light up the menu bar. */
export const WAIT_SHOW_SECONDS = 30;

/** A finished answer shows as "finished" this long, then the chat is just idle.
 *  Finished is not waiting: most answers end with "done", nothing to do. */
export const FINISHED_SHOW_MINUTES = 30;

/** Rows older than this are dropped: a chat killed without SessionEnd. */
export const STALE_HOURS = 12;

export type ChatHook = 'stop' | 'notification' | 'post-tool-use' | 'prompt' | 'session-end';

export type ChatChange =
  | { kind: 'set'; state: 'waiting' | 'working'; reason: string | null }
  | { kind: 'delete' }
  | { kind: 'none' };

/** What one hook event does to a chat's state. Pure. */
export function chatChangeFor(hook: ChatHook, message?: string): ChatChange {
  switch (hook) {
    case 'stop':
      return { kind: 'set', state: 'waiting', reason: 'finished' };
    case 'notification':
      // Claude Code also sends "waiting for your input" a minute after an answer
      // ends. The chat is already waiting then, so only a permission ask counts.
      return /permission/i.test(message ?? '')
        ? { kind: 'set', state: 'waiting', reason: 'permission' }
        : { kind: 'none' };
    case 'post-tool-use':
    case 'prompt':
      return { kind: 'set', state: 'working', reason: null };
    case 'session-end':
      return { kind: 'delete' };
  }
}

/** The bits of better-sqlite3 used here, so tests can use a real in-memory store. */
export interface ChatDb {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export function applyChatChange(
  db: ChatDb,
  args: { chatId: string; client: string; cwd: string; tty: string | null; change: ChatChange; now: Date },
): void {
  const { chatId, client, cwd, tty, change, now } = args;
  if (change.kind === 'none') return;
  db.exec(CHAT_STATE_SQL);
  if (change.kind === 'delete') {
    db.prepare('DELETE FROM chat_state WHERE chat_id = ?').run(chatId);
    return;
  }
  // `since` only moves when the state or reason really changes, so "waiting
  // 6 min" stays true while more hooks of the same kind arrive. The tty is
  // kept from the first hook that knew it.
  db.prepare(
    `INSERT INTO chat_state (chat_id, client, cwd, tty, state, reason, since)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       cwd = excluded.cwd,
       tty = COALESCE(excluded.tty, chat_state.tty),
       since = CASE WHEN chat_state.state = excluded.state AND chat_state.reason IS excluded.reason
                    THEN chat_state.since ELSE excluded.since END,
       state = excluded.state,
       reason = excluded.reason`,
  ).run(chatId, client, cwd, tty, change.state, change.reason, now.toISOString());
}

export interface ChatRow {
  chatId: string;
  client: string;
  cwd: string;
  tty: string | null;
  state: 'waiting' | 'working';
  reason: string | null;
  since: string;
}

export function readChatRows(db: ChatDb, now: Date): ChatRow[] {
  db.exec(CHAT_STATE_SQL);
  const cutoff = new Date(now.getTime() - STALE_HOURS * 3600_000).toISOString();
  db.prepare('DELETE FROM chat_state WHERE since < ?').run(cutoff);
  return db
    .prepare('SELECT chat_id AS chatId, client, cwd, tty, state, reason, since FROM chat_state ORDER BY since')
    .all() as ChatRow[];
}

/* ============================================================ */
/*  What the Mac app shows                                        */
/* ============================================================ */

export interface ChatStory {
  /** The story title: the session this chat opened, or the only one in its repo. */
  story: string | null;
  task: string | null;
  taskId?: string | null;
  /** What the model said it waits on (session_waiting), if it did. */
  question: string | null;
}

export interface ChatView {
  chatId: string;
  /** Repo folder name, e.g. "web-api". */
  repo: string;
  story: string | null;
  task: string | null;
  /** The task's id, so the dashboard can open it. */
  taskId: string | null;
  state: 'waiting' | 'working';
  /** Plain words for the menu: "asks for permission", "finished", or the model's own question. */
  why: string | null;
  since: string;
  minutes: number;
  tty: string | null;
}

export interface ChatsBlock {
  /** Really stuck on the user: a permission ask, or a question the model asked. */
  waiting: ChatView[];
  /** Ended an answer in the last 30 minutes. Shown quietly, never counted. */
  finished: ChatView[];
  working: ChatView[];
}

export function buildChatsBlock(opts: {
  rows: ChatRow[];
  now: Date;
  /** Chat ttys that still have a process; null = can't tell, keep them all. */
  liveTtys: Set<string> | null;
  storyFor: (cwd: string, tty: string | null) => ChatStory;
}): ChatsBlock {
  const out: ChatsBlock = { waiting: [], finished: [], working: [] };
  for (const r of opts.rows) {
    // An iTerm tab closed without Claude saying goodbye: no process left on it.
    if (r.tty && opts.liveTtys && !opts.liveTtys.has(r.tty)) continue;
    const seconds = (opts.now.getTime() - Date.parse(r.since)) / 1000;
    const s = opts.storyFor(r.cwd, r.tty);
    const view: ChatView = {
      chatId: r.chatId,
      repo: basename(r.cwd),
      story: s.story,
      task: s.task,
      taskId: s.taskId ?? null,
      state: r.state,
      why: null,
      since: r.since,
      minutes: Math.max(0, Math.floor(seconds / 60)),
      tty: r.tty,
    };
    if (r.state === 'working') {
      out.working.push(view);
      continue;
    }
    // The model's own question (session_waiting) counts even after the answer ended.
    const why = s.question ?? (r.reason === 'permission' ? 'asks for permission' : null);
    if (why) {
      if (seconds >= WAIT_SHOW_SECONDS) out.waiting.push({ ...view, why });
      else out.working.push(view);
    } else if (view.minutes < FINISHED_SHOW_MINUTES) {
      out.finished.push({ ...view, why: 'finished' });
    }
    // Finished longer ago: just an idle chat, not shown.
  }
  return out;
}
