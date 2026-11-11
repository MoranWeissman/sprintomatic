/**
 * `sprintomatic guard <part>` — the session guard hook (server/session-guard)
 * and its installer, for Claude Code and the GitHub Copilot CLI.
 *
 *   guard pre-tool-use   runs before a file edit
 *   guard prompt         runs on every message the user sends
 *   guard session-start  runs when a Copilot chat starts or is picked up again
 *   guard stop / notification / post-tool-use / session-end
 *                        Claude Code only: note whether the chat waits for the
 *                        user (server/chat-state.ts), for the Mac app's menu bar
 *   guard install        add the hooks to ~/.claude/settings.json, and to
 *                        ~/.copilot/hooks when Copilot is set up
 *                        (--claude-only / --copilot-only pick one)
 *   guard uninstall      take them out again
 *
 * Both clients send JSON on stdin. Claude's keys are snake_case
 * (`session_id`), Copilot's are camelCase (`sessionId`); the answer goes back
 * in the shape the client that asked expects.
 *
 * Built on its own into dist-node/guard.js so the hook starts in plain Node
 * with no TypeScript step — it runs before every edit and has to be quick.
 *
 * The hook never stands in the way by accident: a missing store, a broken
 * input or any surprise means "say nothing, let it through". It always ends
 * with exit code 0 — Copilot treats any other code as a refusal.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../server/data-dir';
import { applyChatChange, chatChangeFor, type ChatHook } from '../server/chat-state';
import {
  COPILOT_EDIT_TOOLS, COPILOT_HOOK_FILE, EDIT_TOOLS, GUARD_MARK, copilotEditTargets, copilotHooks, decideEdit,
  promptLine, readGuardState, sessionStartText, withGuardHooks, withoutGuardHooks,
  type ClaudeSettings, type GuardState,
} from '../server/session-guard';

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
  message?: string;
}

interface CopilotHookInput {
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  toolArgs?: unknown;
  source?: string;
}

function readState(): GuardState | null {
  const path = join(dataDir(), 'data.db');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return readGuardState(db);
  } finally {
    db.close();
  }
}

function readInput(): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(0, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type HookPart = 'pre-tool-use' | 'prompt' | 'session-start' | 'stop' | 'notification' | 'post-tool-use' | 'session-end';

/** The terminal this chat runs in ("ttys004"), so the Mac app can bring that
 *  iTerm tab forward. The hook shares the chat's terminal. */
function chatTty(): string | null {
  try {
    // Claude may start the hook without a terminal of its own; then the
    // nearest parent that has one (Claude itself) tells.
    let pid = process.pid;
    for (let i = 0; i < 4 && pid > 1; i++) {
      const [ppid, tty] = execFileSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
        .trim().split(/\s+/);
      if (tty && !tty.startsWith('?')) return tty;
      pid = Number(ppid);
    }
    return null;
  } catch {
    return null;
  }
}

/** Note the chat's new state. Writes, so it opens the store on its own; never
 *  creates it (no store = sprintomatic isn't set up). */
function noteChatState(hook: ChatHook, input: HookInput): void {
  try {
    if (!input.session_id || !input.cwd) return;
    const change = chatChangeFor(hook, input.message);
    if (change.kind === 'none') return;
    const path = join(dataDir(), 'data.db');
    if (!existsSync(path)) return;
    const db = new Database(path, { fileMustExist: true, timeout: 1000 });
    try {
      // The tty only matters for the jump; skip the extra process on the
      // busiest hook.
      const tty = hook === 'post-tool-use' ? null : chatTty();
      applyChatChange(db, { chatId: input.session_id, client: 'claude', cwd: input.cwd, tty, change, now: new Date() });
    } finally {
      db.close();
    }
  } catch {
    // Say nothing: the menu bar count is a nicety.
  }
}

function runHook(part: HookPart): void {
  try {
    const raw = readInput();
    if (!raw) return;
    if (typeof raw.sessionId === 'string') runCopilotHook(part, raw as CopilotHookInput);
    else runClaudeHook(part, raw as HookInput);
  } catch {
    // Say nothing: a guard that breaks is worse than no guard.
  }
}

function runClaudeHook(part: HookPart, input: HookInput): void {
  try {
    // These only note the chat's state and must print nothing: Stop reads
    // output as a reason to keep going.
    if (part === 'stop' || part === 'notification' || part === 'post-tool-use' || part === 'session-end') {
      noteChatState(part, input);
      return;
    }
    if (part === 'prompt') noteChatState('prompt', input);
    if (part === 'session-start') return;
    if (!input?.session_id || !input.cwd) return;
    const state = readState();
    if (!state) return;
    const common = { chatId: input.session_id, chatCwd: input.cwd, state, homeDir: homedir(), dataDir: dataDir() };

    if (part === 'pre-tool-use') {
      if (!(EDIT_TOOLS as readonly string[]).includes(input.tool_name ?? '')) return;
      const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      const target = file ? resolve(input.cwd, file) : input.cwd;
      const d = decideEdit({ ...common, target });
      if (d.kind === 'block') {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: d.reason,
            },
          }),
        );
      }
      return;
    }

    const line = promptLine({ ...common, now: new Date() });
    if (line) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } }),
      );
    }
  } catch {
    // Say nothing: a guard that breaks is worse than no guard.
  }
}

function runCopilotHook(part: HookPart, input: CopilotHookInput): void {
  try {
    if (!input.sessionId || !input.cwd) return;
    if (part !== 'pre-tool-use' && part !== 'prompt' && part !== 'session-start') return;
    const reply = (out: Record<string, string>) => process.stdout.write(JSON.stringify(out));

    if (part === 'session-start') {
      reply({ additionalContext: sessionStartText({ chatId: input.sessionId, chatCwd: input.cwd, source: input.source }) });
      return;
    }
    if (part === 'pre-tool-use' && !(COPILOT_EDIT_TOOLS as readonly string[]).includes(input.toolName ?? '')) return;
    const state = readState();
    if (!state) return;
    const common = { chatId: input.sessionId, chatCwd: input.cwd, state, homeDir: homedir(), dataDir: dataDir() };

    if (part === 'pre-tool-use') {
      for (const target of copilotEditTargets(input.toolArgs, input.cwd)) {
        const d = decideEdit({ ...common, target });
        if (d.kind === 'block') {
          reply({ permissionDecision: 'deny', permissionDecisionReason: d.reason });
          return;
        }
      }
      return;
    }

    const line = promptLine({ ...common, now: new Date() });
    if (line) reply({ additionalContext: line });
  } catch {
    // Say nothing: a guard that breaks is worse than no guard.
  }
}

/* ============================================================ */
/*  Install / uninstall                                           */
/* ============================================================ */

const SETTINGS = join(homedir(), '.claude', 'settings.json');
/** The built hook file. From the source (tsx) that is the copy in dist-node. */
function hookFile(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith('.js') ? here : resolve(dirname(here), '..', 'dist-node', 'guard.js');
}

function readSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS)) return {};
  return JSON.parse(readFileSync(SETTINGS, 'utf8')) as ClaudeSettings;
}

function writeSettings(s: ClaudeSettings): void {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.bak-${GUARD_MARK}`);
  const tmp = `${SETTINGS}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, SETTINGS);
}

/** Copilot's home folder: $COPILOT_HOME, else ~/.copilot. */
function copilotHome(): string {
  return process.env.COPILOT_HOME || join(homedir(), '.copilot');
}

function copilotHookPath(): string {
  return join(copilotHome(), 'hooks', COPILOT_HOOK_FILE);
}

/** Only when the Copilot CLI is set up on this machine. */
function hasCopilot(): boolean {
  return !!process.env.COPILOT_HOME || existsSync(copilotHome());
}

function install(flags: string[]): void {
  const file = hookFile();
  if (!existsSync(file)) {
    console.error(`The hook isn't built yet (${file} is missing). Run \`npm run build:cli\` first.`);
    process.exitCode = 1;
    return;
  }
  if (!flags.includes('--copilot-only')) {
    writeSettings(withGuardHooks(readSettings(), file));
    console.log(`Session guard added to ${SETTINGS}.`);
    console.log(`The old settings file is saved next to it as settings.json.bak-${GUARD_MARK}.`);
  }
  if (!flags.includes('--claude-only')) {
    if (hasCopilot()) {
      const path = copilotHookPath();
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(copilotHooks(file), null, 2) + '\n');
      renameSync(tmp, path);
      console.log(`Session guard added for the Copilot CLI in ${path}.`);
    } else if (flags.includes('--copilot-only')) {
      console.error(`No Copilot CLI setup found at ${copilotHome()}, so nothing was added.`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('From the next chat on, file edits in a git repo need an open sprintomatic session.');
}

function uninstall(flags: string[]): void {
  if (!flags.includes('--copilot-only')) {
    writeSettings(withoutGuardHooks(readSettings()));
    console.log(`Session guard taken out of ${SETTINGS}.`);
  }
  if (!flags.includes('--claude-only') && existsSync(copilotHookPath())) {
    rmSync(copilotHookPath());
    console.log(`Session guard taken out of ${copilotHookPath()}.`);
  }
}

/* ============================================================ */

const at = process.argv[2] === 'guard' ? 3 : 2;
const part = process.argv[at];
const flags = process.argv.slice(at + 1);
switch (part) {
  case 'pre-tool-use':
  case 'prompt':
  case 'session-start':
  case 'stop':
  case 'notification':
  case 'post-tool-use':
  case 'session-end':
    runHook(part);
    break;
  case 'install':
    install(flags);
    break;
  case 'uninstall':
    uninstall(flags);
    break;
  default:
    console.error('Use one of: pre-tool-use, prompt, session-start, stop, notification, post-tool-use, session-end, install, uninstall.');
    process.exitCode = 1;
}
