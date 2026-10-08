/**
 * Repo ↔ feature link (spec: docs/superpowers/specs/2026-08-20-repo-feature-link-design.md).
 *
 * A work repo can hold `.sprintomatic/link.json` naming the board feature(s)
 * it serves. The file is a DECLARATION — ids only, never status. Everything
 * shown to the user is derived live at orient time by the caller.
 *
 * Local filesystem + settings table only. No ADO, no network.
 */
import {
  existsSync, mkdirSync, readFileSync, statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { writeFileAtomicSync, type AtomicWriter } from './atomic-write';

export interface RepoLink { features: number[]; stories: number[] }
export interface FoundRepoLink extends RepoLink {
  /** The folder that contains `.sprintomatic/` — usually the repo root. */
  dir: string;
}

const LINK_DIR = '.sprintomatic';
const LINK_FILE = 'link.json';
const EXCLUDE_LINE = '.sprintomatic/';

function idList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const n of v) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function linkPathIn(dir: string): string {
  return join(dir, LINK_DIR, LINK_FILE);
}

function hasGitDir(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Walk up from `cwd` (inclusive). Returns each dir until — and including —
 *  the first one that has `.git`, then stops. Filesystem root ends the walk. */
function* walkUp(cwd: string): Generator<string> {
  let dir = normalize(cwd).replace(/\/+$/, '') || '/';
  for (;;) {
    yield dir;
    if (hasGitDir(dir)) return; // repo boundary — never read a parent repo's link
    const parent = dirname(dir);
    if (parent === dir) return; // filesystem root
    dir = parent;
  }
}

/** The link file sitting in `dir` itself — no walking up. Missing file or
 *  garbage JSON → null (a broken file must never crash orient). */
function readLinkAt(dir: string): RepoLink | null {
  const p = linkPathIn(dir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      features: idList((parsed as Record<string, unknown>).features),
      stories: idList((parsed as Record<string, unknown>).stories),
    };
  } catch {
    return null;
  }
}

/** A relative path would be read against the folder the server happens to run
 *  in — which is always the sprintomatic repo, never the repo the user means. */
function requireFullPath(p: string): void {
  if (!p || !isAbsolute(p)) {
    throw new Error(
      'sprintomatic needs the full path to the folder, the kind that starts '
      + `at the top of the disk with "/". It got "${p}" instead, which could `
      + 'point anywhere, so nothing was written.',
    );
  }
}

/** A folder that isn't there yet must never be created. A small typo in the
 *  path would otherwise build a whole new tree of empty folders, write the
 *  link file into it, and say it worked — while the real repo stays unlinked. */
function requireExistingFolder(p: string): void {
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    throw new Error(
      `There is no folder at "${p}", so nothing was written. Check the path `
      + 'for a typo — sprintomatic never makes a new folder here.',
    );
  }
}

/** First `.sprintomatic/link.json` found walking up from `cwd`, parsed
 *  defensively. Garbage JSON → null (a broken file must never crash orient). */
export function readRepoLink(cwd: string): FoundRepoLink | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  for (const dir of walkUp(cwd)) {
    if (!existsSync(linkPathIn(dir))) continue;
    const link = readLinkAt(dir);
    return link ? { ...link, dir } : null;
  }
  return null;
}

/** First ancestor (incl. `cwd`) containing `.git`; else `cwd` itself. */
export function findRepoRoot(cwd: string): string {
  requireFullPath(cwd);
  let last = '';
  for (const dir of walkUp(cwd)) last = dir;
  return hasGitDir(last) ? last : normalize(cwd).replace(/\/+$/, '') || '/';
}

/** Keep the user's personal tooling out of shared repos: add the folder to the
 *  LOCAL ignore list (`.git/info/exclude`), never the committed `.gitignore`.
 *  `.git` as a plain file (worktree) → skip quietly.
 *
 *  This reads the whole file, adds the line, and writes the whole file back —
 *  that's an overwrite, not a true append, so it goes through the same
 *  temp-file-then-rename helper as the link file: a crash mid-write must
 *  never truncate a `.git/info/exclude` some other tool also writes to. */
function ensureGitExclude(repoRoot: string, writer?: AtomicWriter): boolean {
  const gitDir = join(repoRoot, '.git');
  try {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return false;
    const infoDir = join(gitDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, 'exclude');
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (current.split('\n').some(l => l.trim() === EXCLUDE_LINE)) return false;
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    writeFileAtomicSync(excludePath, `${current}${sep}${EXCLUDE_LINE}\n`, writer);
    return true;
  } catch {
    return false;
  }
}

/** Write (merge) the link file at `repoRoot`. Existing ids are kept — adding
 *  a second feature never drops the first.
 *
 *  Both the link file and the git exclude line go through a temp-file-then-
 *  rename write, so a crash or a full disk mid-write leaves the file exactly
 *  as it was before — never half-written. `writer` is only for tests that
 *  need a write to fail on purpose. */
export function writeRepoLink(
  repoRoot: string,
  add: Partial<RepoLink>,
  writer?: AtomicWriter,
): { link: RepoLink; dir: string; excludeAdded: boolean } {
  requireFullPath(repoRoot);
  requireExistingFolder(repoRoot);
  // Only this folder's own link file — a link in a parent folder belongs to a
  // different repo and must never leak its ids into this one.
  const existing = readLinkAt(repoRoot);
  const link: RepoLink = {
    features: idList([...(existing?.features ?? []), ...(add.features ?? [])]),
    stories: idList([...(existing?.stories ?? []), ...(add.stories ?? [])]),
  };
  mkdirSync(join(repoRoot, LINK_DIR), { recursive: true });
  writeFileAtomicSync(linkPathIn(repoRoot), JSON.stringify(link, null, 2) + '\n', writer);
  const excludeAdded = ensureGitExclude(repoRoot, writer);
  return { link, dir: repoRoot, excludeAdded };
}
