/**
 * The session guard: a Claude Code hook that stops file edits in a work repo
 * while no sprintomatic session is open there.
 *
 * Every other reminder sprintomatic has rides inside its own tool answers, so
 * a chat that never calls sprintomatic never sees one — it can work for days
 * and the board never hears. A hook runs on Claude Code's side whether the
 * chat remembers or not, so that is where the rule has to live.
 *
 * Two hook events use this:
 *  - PreToolUse on file edits: no session for this repo → the edit is refused
 *    with the steps to open one.
 *  - UserPromptSubmit: a short line for the assistant on every message while
 *    no session is open, or while the open one has gone quiet.
 *
 * The hook runs before every edit, so this file must stay cheap: no import of
 * ./db (that one migrates and takes a backup on open), no board calls. It
 * reads the store read-only and decides. Everything that decides is pure and
 * takes its inputs as arguments, so tests need no store.
 *
 * Two ways out, both written down:
 *  - a folder marked "not work" (guard_folder_set) is never watched;
 *  - a chat whose user said "no story for this one" (session_skip) is let
 *    through until it ends. The chat id comes from the hook input, and the
 *    refusal message hands it to the assistant to pass back.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const GUARD_NOT_WORK_KEY = 'guard_not_work_paths';
export const GUARD_SKIPS_KEY = 'guard_skips';

/** Minutes of nothing logged before the prompt line asks for a session_log. */
export const QUIET_MINUTES = 60;

/** The tools that change files. Commands are left alone on purpose — reading
 *  git history or running tests must never need a session. */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

export interface GuardSkip {
  chatId: string;
  cwd: string;
  reason: string;
  at: string;
}

export interface GuardSession {
  workItemId: number;
  cwd: string | null;
  /** The newest of the session start and its last logged event. */
  lastActivityAt: string;
}

export interface GuardState {
  openSessions: GuardSession[];
  /** Repo roots the user said are not work. */
  notWork: string[];
  /** Chat ids the user let through with "no story". */
  skippedChats: string[];
}

/**
 * The repo a path belongs to, or null when it is not inside a git repo.
 *
 * A worktree has a `.git` FILE pointing into the main repo's
 * `.git/worktrees/<name>`; it counts as the main repo, so a session opened in
 * the main folder covers edits made from a worktree of it (and back).
 */
export function repoRootFor(path: string): string | null {
  let dir = resolve(path);
  // A file path that doesn't exist yet (a Write of a new file): start from
  // the nearest folder that does.
  while (!isDir(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      if (isDir(dotGit)) return dir;
      const main = mainRepoFromGitFile(dotGit);
      return main ?? dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mainRepoFromGitFile(gitFile: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitFile, 'utf8'));
    if (!m) return null;
    const gitdir = isAbsolute(m[1]) ? m[1] : resolve(dirname(gitFile), m[1]);
    const marker = `${sep}.git${sep}worktrees${sep}`;
    const at = gitdir.indexOf(marker);
    return at > 0 ? gitdir.slice(0, at) : null;
  } catch {
    return null;
  }
}

function isUnder(path: string, folder: string): boolean {
  const p = resolve(path);
  const f = resolve(folder);
  return p === f || p.startsWith(f + sep);
}

/** The repo the edit lands in, or null when the guard has nothing to say. */
function watchedRepo(args: {
  target: string;
  state: GuardState;
  homeDir: string;
  dataDir: string;
}): string | null {
  const { target, state, homeDir, dataDir } = args;
  // Claude's own files (memory, plans) and sprintomatic's own folder are
  // never work, even when they happen to sit in a repo.
  if (isUnder(target, join(homeDir, '.claude')) || isUnder(target, dataDir)) return null;
  const repo = repoRootFor(target);
  if (!repo) return null;
  if (state.notWork.some(p => resolve(p) === repo)) return null;
  return repo;
}

function sessionsFor(repos: string[], sessions: GuardSession[]): GuardSession[] {
  return sessions.filter(s => {
    if (!s.cwd) return false;
    const root = repoRootFor(s.cwd);
    return root != null && repos.includes(root);
  });
}

export type EditDecision = { kind: 'allow' } | { kind: 'block'; reason: string };

/** PreToolUse on a file edit: let it through, or refuse with the way out. */
export function decideEdit(args: {
  chatId: string;
  chatCwd: string;
  /** The file being changed; the chat folder when the tool names none. */
  target: string;
  state: GuardState;
  homeDir: string;
  dataDir: string;
}): EditDecision {
  const { chatId, chatCwd, state } = args;
  if (state.skippedChats.includes(chatId)) return { kind: 'allow' };
  const repo = watchedRepo(args);
  if (!repo) return { kind: 'allow' };
  // A session opened from this chat's own repo covers an edit it makes in a
  // neighbour repo for the same task.
  const repos = [repo];
  const chatRepo = repoRootFor(chatCwd);
  if (chatRepo && !repos.includes(chatRepo)) repos.push(chatRepo);
  if (sessionsFor(repos, state.openSessions).length > 0) return { kind: 'allow' };
  return { kind: 'block', reason: blockReason({ repo, chatId, chatCwd }) };
}

export function blockReason(args: { repo: string; chatId: string; chatCwd: string }): string {
  const { repo, chatId, chatCwd } = args;
  return [
    `sprintomatic: no work session is open for ${basename(repo)}, so this change was stopped. Nothing was written.`,
    'Before changing files here:',
    `1. Find the task: call story_match, then session_start on the task, both with cwd "${chatCwd}".`,
    '2. If the story has no tasks, suggest a task name and hours to the user. Create it with task_create only after they say yes, then call session_start on it.',
    `3. If the user says this is a quick fix with no story, call session_skip with chatId "${chatId}" and cwd "${chatCwd}".`,
    '4. If this folder is not work at all, ask the user, then call guard_folder_set with work: false.',
    'Then make the change again. Ask the user if you are not sure which task this is.',
  ].join('\n');
}

/** UserPromptSubmit: a line for the assistant, or null to stay quiet. */
export function promptLine(args: {
  chatId: string;
  chatCwd: string;
  state: GuardState;
  homeDir: string;
  dataDir: string;
  now: Date;
}): string | null {
  const { chatId, chatCwd, state, now } = args;
  if (state.skippedChats.includes(chatId)) return null;
  const repo = watchedRepo({ ...args, target: chatCwd });
  if (!repo) return null;
  const mine = sessionsFor([repo], state.openSessions);
  if (mine.length === 0) {
    return `sprintomatic: no work session is open for ${basename(repo)}. Before you change any file, open one: story_match, then session_start on the task, with cwd "${chatCwd}". Edits are stopped until then. If the user says there is no story for this, call session_skip with chatId "${chatId}".`;
  }
  const newest = Math.max(...mine.map(s => Date.parse(s.lastActivityAt)).filter(Number.isFinite));
  if (!Number.isFinite(newest)) return null;
  const quiet = Math.floor((now.getTime() - newest) / 60000);
  if (quiet < QUIET_MINUTES) return null;
  const ids = mine.map(s => `#${s.workItemId}`).join(', ');
  return `sprintomatic: nothing has been logged on ${ids} for ${quiet} minutes. Call session_log with what got done. If the work only waits on someone else, call session_end without done to pause it.`;
}

/* ============================================================ */
/*  Reading the store — read-only, for the hook process           */
/* ============================================================ */

/** The bits of better-sqlite3 the reader uses, so tests can hand in a fake. */
export interface ReadOnlyDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

function jsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function readGuardState(db: ReadOnlyDb): GuardState {
  const rows = db
    .prepare(
      `SELECT s.work_item_id AS workItemId, s.cwd AS cwd,
              MAX(s.started_at, COALESCE(MAX(e.created_at), s.started_at)) AS lastActivityAt
         FROM sessions s
         LEFT JOIN session_events e ON e.session_id = s.id
        WHERE s.ended_at IS NULL
        GROUP BY s.id`,
    )
    .all() as GuardSession[];
  const setting = (key: string): unknown =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
  return {
    openSessions: rows,
    notWork: jsonArray<unknown>(setting(GUARD_NOT_WORK_KEY)).filter((x): x is string => typeof x === 'string'),
    skippedChats: jsonArray<GuardSkip>(setting(GUARD_SKIPS_KEY))
      .map(s => s?.chatId)
      .filter((x): x is string => typeof x === 'string'),
  };
}

/* ============================================================ */
/*  The hook lines in ~/.claude/settings.json                     */
/* ============================================================ */

/** Written into every hook line, so install and uninstall find their own. */
export const GUARD_MARK = 'sprintomatic-guard';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}
export type ClaudeSettings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

function isGuardEntry(e: HookEntry): boolean {
  return e?.hooks?.some(h => typeof h?.command === 'string' && h.command.includes(GUARD_MARK)) ?? false;
}

/** The settings with every guard line taken out; other hooks stay as they are. */
export function withoutGuardHooks(s: ClaudeSettings): ClaudeSettings {
  const hooks = { ...(s.hooks ?? {}) };
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter(e => !isGuardEntry(e));
    if (kept.length > 0 || list.length === 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...s, hooks };
}

/** The settings with the guard lines added once, pointing at `file`. Safe to run again. */
export function withGuardHooks(s: ClaudeSettings, file: string): ClaudeSettings {
  const base = withoutGuardHooks(s);
  const cmd = (part: string) => `node "${file}" ${part} # ${GUARD_MARK}`;
  const hooks = { ...(base.hooks ?? {}) };
  hooks.PreToolUse = [
    ...(hooks.PreToolUse ?? []),
    { matcher: EDIT_TOOLS.join('|'), hooks: [{ type: 'command', command: cmd('pre-tool-use') }] },
  ];
  hooks.UserPromptSubmit = [
    ...(hooks.UserPromptSubmit ?? []),
    { hooks: [{ type: 'command', command: cmd('prompt') }] },
  ];
  return { ...base, hooks };
}
