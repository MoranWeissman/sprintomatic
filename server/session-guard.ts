/**
 * The session guard: a Claude Code and GitHub Copilot CLI hook that stops
 * file edits in a work repo while no sprintomatic session is open there.
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
 *  - sessionStart (Copilot CLI only): a line asking the assistant to call
 *    orient first, since Copilot has no other way to get that nudge.
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

/** The same, by the names the Copilot CLI uses. */
export const COPILOT_EDIT_TOOLS = ['edit', 'create', 'str_replace_editor', 'apply_patch', 'write'] as const;

export interface GuardSkip {
  chatId: string;
  cwd: string;
  reason: string;
  at: string;
}

export interface GuardSession {
  workItemId: number;
  cwd: string | null;
  /** The terminal of the chat that opened it; null on old rows and GUI clients. */
  tty?: string | null;
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
  // Claude's and Copilot's own files (memory, plans) and sprintomatic's own
  // folder are never work, even when they happen to sit in a repo.
  if (
    isUnder(target, join(homeDir, '.claude')) ||
    isUnder(target, join(homeDir, '.copilot')) ||
    isUnder(target, dataDir)
  ) {
    return null;
  }
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

/**
 * Of the sessions in these repos, the ones this chat may use. When both sides
 * know their terminal, only the chat that opened a session owns it: a second
 * chat in the same repo needs its own. A session with no terminal (an old row,
 * a GUI client) still covers every chat in the repo, as before.
 */
export function sessionsForChat(repos: string[], sessions: GuardSession[], chatTty: string | null): GuardSession[] {
  const here = sessionsFor(repos, sessions);
  if (!chatTty) return here;
  return here.filter(s => !s.tty || s.tty === chatTty);
}

export type EditDecision = { kind: 'allow' } | { kind: 'block'; reason: string };

/** PreToolUse on a file edit: let it through, or refuse with the way out. */
export function decideEdit(args: {
  chatId: string;
  chatCwd: string;
  /** This chat's terminal, when known. */
  chatTty?: string | null;
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
  if (sessionsForChat(repos, state.openSessions, args.chatTty ?? null).length > 0) return { kind: 'allow' };
  const otherChat = sessionsFor(repos, state.openSessions).length > 0;
  return { kind: 'block', reason: blockReason({ repo, chatId, chatCwd, otherChat }) };
}

export function blockReason(args: { repo: string; chatId: string; chatCwd: string; otherChat?: boolean }): string {
  const { repo, chatId, chatCwd, otherChat } = args;
  return [
    otherChat
      ? `sprintomatic: another chat has the work session open for ${basename(repo)}, not this one, so this change was stopped. Nothing was written. Each chat needs its own session, so its time and notes land on the right task.`
      : `sprintomatic: no work session is open for ${basename(repo)}, so this change was stopped. Nothing was written.`,
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
  chatTty?: string | null;
  state: GuardState;
  homeDir: string;
  dataDir: string;
  now: Date;
}): string | null {
  const { chatId, chatCwd, state, now } = args;
  if (state.skippedChats.includes(chatId)) return null;
  const repo = watchedRepo({ ...args, target: chatCwd });
  if (!repo) return null;
  const mine = sessionsForChat([repo], state.openSessions, args.chatTty ?? null);
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
/*  Copilot CLI input                                             */
/* ============================================================ */

/**
 * Every file a Copilot edit tool is about to change, as full paths.
 *
 * `toolArgs` comes as an object, as that object JSON-encoded, or (for
 * apply_patch) as the raw patch text, which can name several files. When
 * no file can be found the chat folder stands in, the same as for Claude.
 */
export function copilotEditTargets(toolArgs: unknown, cwd: string): string[] {
  let args = toolArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      // Not JSON: a raw patch.
    }
  }
  const found: string[] = [];
  if (typeof args === 'string') {
    found.push(...patchPaths(args));
  } else if (args && typeof args === 'object') {
    const o = args as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath']) {
      if (typeof o[key] === 'string' && o[key]) found.push(o[key]);
    }
    // An apply_patch that came wrapped in an object: the patch is one of its values.
    if (found.length === 0) {
      for (const v of Object.values(o)) {
        if (typeof v === 'string') found.push(...patchPaths(v));
      }
    }
  }
  const paths = [...new Set(found.map(p => resolve(cwd, p)))];
  return paths.length > 0 ? paths : [cwd];
}

function patchPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)) out.push(m[1]);
  return out;
}

/**
 * What Copilot's sessionStart hook hands the assistant. It needs no store:
 * orient is about the day, not the folder, so it is asked for everywhere.
 */
export function sessionStartText(args: { chatId: string; chatCwd: string; source?: string }): string {
  const { chatId, chatCwd, source } = args;
  const first =
    source === 'resume'
      ? 'sprintomatic: this chat was picked up again. Before you reply, call the sprintomatic orient tool again, so you work from where the sprint is now and not from older messages.'
      : "sprintomatic: before you reply to the user's first message, call the sprintomatic orient tool and use what it tells you.";
  return [
    first,
    `Your working folder is "${chatCwd}". Pass it as cwd wherever a sprintomatic tool asks for one.`,
    `This chat's id is "${chatId}". If the user says some work here has no story, call session_skip with chatId "${chatId}".`,
  ].join('\n');
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
  // The hook can run against a store the newer server hasn't migrated yet.
  const hasTty = db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'tty'").get() != null;
  const rows = db
    .prepare(
      `SELECT s.work_item_id AS workItemId, s.cwd AS cwd, ${hasTty ? 's.tty' : 'NULL'} AS tty,
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
  // Which chats wait for the user (server/chat-state.ts). Every tool, not only
  // edits: after a permission yes, the next tool result is the sign it works again.
  for (const [event, part] of [
    ['Stop', 'stop'],
    ['Notification', 'notification'],
    ['PostToolUse', 'post-tool-use'],
    ['SessionEnd', 'session-end'],
  ] as const) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command: cmd(part) }] }];
  }
  return { ...base, hooks };
}

/* ============================================================ */
/*  The hook file in ~/.copilot/hooks                             */
/* ============================================================ */

/** The name of our own hook file in the Copilot hooks folder. */
export const COPILOT_HOOK_FILE = `${GUARD_MARK}.json`;

/** The whole Copilot hook file, pointing at `file`. */
export function copilotHooks(file: string): Record<string, unknown> {
  const entry = (part: string, extra: Record<string, unknown> = {}) => {
    // Copilot denies the edit when a preToolUse hook exits non-zero. If the
    // hook can't even start (node missing, file gone), let the edit through.
    const cmd = `node "${file}" ${part}`;
    return {
      type: 'command',
      bash: `${cmd} || true`,
      powershell: `${cmd}; exit 0`,
      timeoutSec: 10,
      ...extra,
    };
  };
  return {
    version: 1,
    hooks: {
      sessionStart: [entry('session-start')],
      userPromptSubmitted: [entry('prompt')],
      preToolUse: [entry('pre-tool-use', { matcher: COPILOT_EDIT_TOOLS.join('|') })],
    },
  };
}
