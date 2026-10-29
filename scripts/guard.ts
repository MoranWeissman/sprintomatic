/**
 * `sprintomatic guard <part>` — the session guard hook (server/session-guard)
 * and its installer.
 *
 *   guard pre-tool-use   Claude Code runs this before a file edit
 *   guard prompt         Claude Code runs this on every message the user sends
 *   guard install        add both hooks to ~/.claude/settings.json
 *   guard uninstall      take them out again
 *
 * Built on its own into dist-node/guard.js so the hook starts in plain Node
 * with no TypeScript step — it runs before every edit and has to be quick.
 *
 * The hook never stands in the way by accident: a missing store, a broken
 * input or any surprise means "say nothing, let it through".
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../server/data-dir';
import {
  EDIT_TOOLS, GUARD_MARK, decideEdit, promptLine, readGuardState, withGuardHooks, withoutGuardHooks,
  type ClaudeSettings, type GuardState,
} from '../server/session-guard';

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
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

function readInput(): HookInput | null {
  try {
    const v = JSON.parse(readFileSync(0, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as HookInput) : null;
  } catch {
    return null;
  }
}

function runHook(part: 'pre-tool-use' | 'prompt'): void {
  try {
    const input = readInput();
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

function install(): void {
  const file = hookFile();
  if (!existsSync(file)) {
    console.error(`The hook isn't built yet (${file} is missing). Run \`npm run build:cli\` first.`);
    process.exitCode = 1;
    return;
  }
  writeSettings(withGuardHooks(readSettings(), file));
  console.log(`Session guard added to ${SETTINGS}.`);
  console.log('From the next chat on, file edits in a git repo need an open sprintomatic session.');
  console.log(`The old settings file is saved next to it as settings.json.bak-${GUARD_MARK}.`);
}

function uninstall(): void {
  writeSettings(withoutGuardHooks(readSettings()));
  console.log(`Session guard taken out of ${SETTINGS}.`);
}

/* ============================================================ */

const part = process.argv[process.argv[2] === 'guard' ? 3 : 2];
switch (part) {
  case 'pre-tool-use':
  case 'prompt':
    runHook(part);
    break;
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  default:
    console.error('Use one of: pre-tool-use, prompt, install, uninstall.');
    process.exitCode = 1;
}
