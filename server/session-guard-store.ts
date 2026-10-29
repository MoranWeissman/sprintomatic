/**
 * The two ways out of the session guard (./session-guard), written from the
 * MCP side. Kept apart from the guard itself because this file goes through
 * the normal settings helpers, and the hook process must not open the store
 * the normal way.
 */
import { resolve } from 'node:path';
import { getSetting, setSetting } from './timers';
import { GUARD_NOT_WORK_KEY, GUARD_SKIPS_KEY, repoRootFor, type GuardSkip } from './session-guard';

/** Old "no story" chats are kept for the retro, but not forever. */
const MAX_SKIPS = 200;

function readArray<T>(key: string): T[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** The folder the user means: its repo when it is in one, else the folder. */
function folderKey(cwd: string): string {
  return repoRootFor(cwd) ?? resolve(cwd);
}

/** Mark a folder as work (watched) or not work (left alone). Returns the folder saved. */
export function setGuardFolder(cwd: string, work: boolean): string {
  const key = folderKey(cwd);
  const list = readArray<string>(GUARD_NOT_WORK_KEY).filter(p => resolve(p) !== key);
  if (!work) list.push(key);
  setSetting(GUARD_NOT_WORK_KEY, JSON.stringify(list));
  return key;
}

export function guardNotWorkFolders(): string[] {
  return readArray<string>(GUARD_NOT_WORK_KEY);
}

/** Let one chat work with no session, for a quick fix the user said has no story. */
export function addGuardSkip(args: { chatId: string; cwd: string; reason: string; now?: Date }): GuardSkip {
  const skip: GuardSkip = {
    chatId: args.chatId.trim(),
    cwd: args.cwd,
    reason: args.reason.trim(),
    at: (args.now ?? new Date()).toISOString(),
  };
  const list = readArray<GuardSkip>(GUARD_SKIPS_KEY).filter(s => s?.chatId !== skip.chatId);
  list.push(skip);
  setSetting(GUARD_SKIPS_KEY, JSON.stringify(list.slice(-MAX_SKIPS)));
  return skip;
}

export function guardSkips(): GuardSkip[] {
  return readArray<GuardSkip>(GUARD_SKIPS_KEY);
}
