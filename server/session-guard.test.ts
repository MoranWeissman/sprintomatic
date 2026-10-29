import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideEdit, promptLine, readGuardState, repoRootFor, withGuardHooks, withoutGuardHooks,
  GUARD_NOT_WORK_KEY, GUARD_SKIPS_KEY, QUIET_MINUTES, type GuardState,
} from './session-guard';

let root: string;
let repo: string;
let other: string;
let home: string;
let data: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
  repo = join(root, 'work-repo');
  other = join(root, 'other-repo');
  home = join(root, 'home');
  data = join(home, '.sprintomatic');
  for (const r of [repo, other]) mkdirSync(join(r, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(data, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const empty = (): GuardState => ({ openSessions: [], notWork: [], skippedChats: [] });
const at = (iso = new Date().toISOString()) => iso;
const edit = (target: string, state: GuardState, chatCwd = repo) =>
  decideEdit({ chatId: 'chat-1', chatCwd, target, state, homeDir: home, dataDir: data });

describe('repoRootFor', () => {
  it('finds the repo from a file deep inside, even one not written yet', () => {
    expect(repoRootFor(join(repo, 'src', 'new-file.ts'))).toBe(repo);
  });

  it('is null outside any repo', () => {
    expect(repoRootFor(home)).toBeNull();
  });

  it('counts a worktree as its main repo', () => {
    const wt = join(repo, '.claude', 'worktrees', 'x');
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(repo, '.git', 'worktrees', 'x'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'x')}\n`);
    expect(repoRootFor(join(wt, 'a.ts'))).toBe(repo);
  });
});

describe('decideEdit', () => {
  it('stops an edit in a repo with no session, and says how to get out', () => {
    const d = edit(join(repo, 'src', 'a.ts'), empty());
    expect(d.kind).toBe('block');
    if (d.kind !== 'block') return;
    expect(d.reason).toContain('session_start');
    expect(d.reason).toContain('chatId "chat-1"');
    expect(d.reason).toContain('guard_folder_set');
  });

  it('lets it through when a session is open from that repo', () => {
    const state = { ...empty(), openSessions: [{ workItemId: 100001, cwd: join(repo, 'src'), lastActivityAt: at() }] };
    expect(edit(join(repo, 'src', 'a.ts'), state).kind).toBe('allow');
  });

  it("lets a chat's session cover an edit it makes in a neighbour repo", () => {
    const state = { ...empty(), openSessions: [{ workItemId: 100001, cwd: repo, lastActivityAt: at() }] };
    expect(edit(join(other, 'a.ts'), state).kind).toBe('allow');
  });

  it("does not count another repo's session", () => {
    const state = { ...empty(), openSessions: [{ workItemId: 100001, cwd: other, lastActivityAt: at() }] };
    expect(edit(join(repo, 'a.ts'), state).kind).toBe('block');
  });

  it('does not count a session with no folder', () => {
    const state = { ...empty(), openSessions: [{ workItemId: 100001, cwd: null, lastActivityAt: at() }] };
    expect(edit(join(repo, 'a.ts'), state).kind).toBe('block');
  });

  it('leaves alone files outside a repo, Claude\'s own files and a not-work repo', () => {
    expect(edit(join(home, 'notes.md'), empty(), home).kind).toBe('allow');
    mkdirSync(join(home, '.claude', '.git'), { recursive: true });
    expect(edit(join(home, '.claude', 'memory', 'a.md'), empty()).kind).toBe('allow');
    expect(edit(join(repo, 'a.ts'), { ...empty(), notWork: [repo] }).kind).toBe('allow');
  });

  it('lets a "no story" chat through, and only that chat', () => {
    const state = { ...empty(), skippedChats: ['chat-1'] };
    expect(edit(join(repo, 'a.ts'), state).kind).toBe('allow');
    expect(
      decideEdit({ chatId: 'chat-2', chatCwd: repo, target: join(repo, 'a.ts'), state, homeDir: home, dataDir: data }).kind,
    ).toBe('block');
  });
});

describe('promptLine', () => {
  const now = new Date('2026-01-10T10:00:00Z');
  const line = (state: GuardState, chatCwd = repo) =>
    promptLine({ chatId: 'chat-1', chatCwd, state, homeDir: home, dataDir: data, now });

  it('reminds while no session is open in a work repo', () => {
    expect(line(empty())).toContain('no work session is open for work-repo');
  });

  it('stays quiet outside a repo, when skipped, and while the session is busy', () => {
    expect(line(empty(), home)).toBeNull();
    expect(line({ ...empty(), skippedChats: ['chat-1'] })).toBeNull();
    const fresh = new Date(now.getTime() - 5 * 60000).toISOString();
    expect(line({ ...empty(), openSessions: [{ workItemId: 100001, cwd: repo, lastActivityAt: fresh }] })).toBeNull();
  });

  it('asks for a log once the session has gone quiet', () => {
    const old = new Date(now.getTime() - (QUIET_MINUTES + 10) * 60000).toISOString();
    const msg = line({ ...empty(), openSessions: [{ workItemId: 100001, cwd: repo, lastActivityAt: old }] });
    expect(msg).toContain('#100001');
    expect(msg).toContain('session_log');
  });
});

describe('readGuardState', () => {
  it('reads open sessions with their newest activity, and the two ways out', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, work_item_id INTEGER, started_at TEXT, ended_at TEXT, cwd TEXT);
      CREATE TABLE session_events (id INTEGER PRIMARY KEY, session_id TEXT, created_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('s1', 100001, '2026-01-10T08:00:00Z', null, '/a');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('s2', 100002, '2026-01-10T08:00:00Z', '2026-01-10T09:00:00Z', '/b');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('s3', 100003, '2026-01-10T07:00:00Z', null, null);
    db.prepare('INSERT INTO session_events VALUES (?, ?, ?)').run(1, 's1', '2026-01-10T09:30:00Z');
    db.prepare('INSERT INTO settings VALUES (?, ?)').run(GUARD_NOT_WORK_KEY, JSON.stringify(['/c']));
    db.prepare('INSERT INTO settings VALUES (?, ?)').run(GUARD_SKIPS_KEY, JSON.stringify([{ chatId: 'chat-9', cwd: '/a', reason: 'x', at: '' }]));
    const state = readGuardState(db);
    expect(state.openSessions).toEqual([
      { workItemId: 100001, cwd: '/a', lastActivityAt: '2026-01-10T09:30:00Z' },
      { workItemId: 100003, cwd: null, lastActivityAt: '2026-01-10T07:00:00Z' },
    ]);
    expect(state.notWork).toEqual(['/c']);
    expect(state.skippedChats).toEqual(['chat-9']);
  });
});

describe('guard hook lines in the settings file', () => {
  const existing = {
    model: 'x',
    hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node other.js' }] }] },
  };

  it('adds both hooks once, keeping the others, and running it again changes nothing', () => {
    const once = withGuardHooks(existing, '/opt/guard.js');
    expect(withGuardHooks(once, '/opt/guard.js')).toEqual(once);
    expect(once.model).toBe('x');
    expect(once.hooks?.PostToolUse).toEqual(existing.hooks.PostToolUse);
    expect(once.hooks?.PreToolUse?.[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(once.hooks?.PreToolUse?.[0].hooks[0].command).toContain('"/opt/guard.js" pre-tool-use');
    expect(once.hooks?.UserPromptSubmit?.[0].hooks[0].command).toContain('prompt');
  });

  it('takes out only its own lines', () => {
    expect(withoutGuardHooks(withGuardHooks(existing, '/opt/guard.js'))).toEqual(existing);
  });
});
