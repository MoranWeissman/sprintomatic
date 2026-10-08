/**
 * Managed-skill sync. The four workspace-craft skills (demo, design,
 * discovery, walkthrough) live as COPIES: seed → every registered workspace → the global
 * skills folder. The seed is the only place to EDIT them; the `skills_sync`
 * MCP tool fans the seed version out. A throttled drift check (Task 2) rides
 * the every-tool-response nudge pipe so hand-edited copies can't silently
 * diverge. Sessions read skill bodies from disk on use, so fixing the files
 * fixes every session at once — no restart.
 *
 * Sync semantics: destination folder is REPLACED, so files removed from the
 * seed disappear too. The replacement is copied into a temp folder next to it
 * FIRST and only swapped in once the copy is complete — a copy that dies
 * half-way leaves the old folder exactly where it was, and says so. A skill
 * missing from the seed is never deleted downstream — reported and skipped;
 * that needs a human look.
 */
import { join, dirname, resolve, relative, sep } from 'node:path';
import { existsSync, mkdirSync, cpSync, rmSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { getSetting, setSetting } from './timers';
import { getSeedPath, getWorkspaces, expandHome } from './workspace';

export const MANAGED_SKILLS: readonly string[] = ['demo', 'design', 'discovery', 'walkthrough'];

/** Where the always-on copies live (the `sprintomatic-plus` skill's subs). */
function globalSkillsDir(): string {
  return join(homedir(), '.claude', 'skills', 'sprintomatic-plus', 'skills');
}

/** The seed's skills folder — the single place managed skills get edited. */
export function seedSkillsDir(): string {
  return join(resolve(expandHome(getSeedPath())), '.claude', 'skills');
}

/** Destination skills dirs (live workspaces + global) and dead workspace roots. */
export function managedDestinations(): { destDirs: string[]; deadWorkspaces: string[] } {
  const paths = getWorkspaces().paths.map(p => resolve(expandHome(p)));
  const deadWorkspaces = paths.filter(p => !existsSync(p));
  const live = paths.filter(p => existsSync(p));
  return { destDirs: [...live.map(p => join(p, '.claude', 'skills')), globalSkillsDir()], deadWorkspaces };
}

/** Recursive list of a dir's file paths relative to it, sorted for stability. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Stable content fingerprint of a folder (names + bytes). Missing dir → null. */
export function dirFingerprint(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const h = createHash('sha1');
  for (const rel of listFiles(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export interface SkillSyncOutcome {
  skill: string;
  missingSeed: boolean;
  updated: string[]; // destination skills-dirs whose copy was replaced
  current: string[]; // destination skills-dirs that already matched
  /** Destinations the copy could not be finished for. The copy that was
   *  already there is still in place; the message says what went wrong. */
  failed?: { destDir: string; error: string }[];
}

/** Overwrite-sync each managed skill from `seedSkillsDir` into every dir in
 *  `destDirs` (each a `.../skills` folder). Pure fs over the given paths.
 *  `copyDir` is only for tests that need a copy to fail on purpose. */
export function syncManagedSkills(
  seedSkillsDir: string,
  destDirs: string[],
  copyDir: CopyDir = realCopyDir,
): SkillSyncOutcome[] {
  return MANAGED_SKILLS.map(skill => {
    const src = join(seedSkillsDir, skill);
    const srcFp = dirFingerprint(src);
    if (srcFp === null) return { skill, missingSeed: true, updated: [], current: [], failed: [] };
    const updated: string[] = [];
    const current: string[] = [];
    const failed: { destDir: string; error: string }[] = [];
    for (const destDir of destDirs) {
      const dest = join(destDir, skill);
      if (dirFingerprint(dest) === srcFp) {
        current.push(destDir);
        continue;
      }
      try {
        replaceFolder(src, dest, copyDir);
        updated.push(destDir);
      } catch (e) {
        failed.push({ destDir, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { skill, missingSeed: false, updated, current, failed };
  });
}

/** How a folder gets copied. Swappable so a test can make a copy fail. */
export type CopyDir = (src: string, dest: string) => void;

const realCopyDir: CopyDir = (src, dest) => cpSync(src, dest, { recursive: true });

/**
 * Put a fresh copy of `src` at `dest` without ever destroying what is at
 * `dest` before the new copy is complete. Copy into a temp folder beside it,
 * move the old one aside, move the new one in, then delete the old one. If
 * anything goes wrong the old folder is put back and the error is thrown on.
 */
function replaceFolder(src: string, dest: string, copyDir: CopyDir): void {
  const staging = `${dest}.tmp-new`;
  const previous = `${dest}.tmp-old`;
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });

  try {
    copyDir(src, staging);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e; // nothing at dest was touched
  }

  const hadOld = existsSync(dest);
  if (hadOld) renameSync(dest, previous);
  try {
    renameSync(staging, dest);
  } catch (e) {
    if (hadOld) renameSync(previous, dest); // put the old copy back
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  rmSync(previous, { recursive: true, force: true });
}

/** Plain-English report the tool ships verbatim (echo-API-strings rule). */
export function formatSyncReport(
  outcomes: SkillSyncOutcome[],
  deadWorkspaces: string[],
): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.missingSeed) {
      lines.push(`${o.skill}: missing from the seed — skipped (nothing was deleted)`);
    } else if (o.updated.length === 0 && (o.failed?.length ?? 0) === 0) {
      lines.push(`${o.skill}: already current everywhere`);
    } else if (o.updated.length > 0) {
      const n = o.updated.length;
      lines.push(`${o.skill}: updated in ${n} ${n === 1 ? 'place' : 'places'}`);
    }
    for (const f of o.failed ?? []) {
      lines.push(
        `${o.skill}: could not be copied to ${f.destDir} — ${f.error}. ` +
        'The copy that was already there is untouched, so nothing was lost.',
      );
    }
  }
  for (const w of deadWorkspaces) {
    lines.push(`Skipped a workspace folder that no longer exists on disk: ${w}`);
  }
  if (outcomes.some(o => o.updated.length > 0)) {
    lines.push('Every open chat picks the new skill text up on its next use — no restart needed.');
  }
  return lines.join('\n');
}

export const SKILLS_DRIFT_CHECKED_KEY = 'skills_drift_checked_at';
const DRIFT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // at most one check per hour

/**
 * Throttled drift check for the every-tool-response nudge pipe (same idea as
 * checkStaleLogNudge). Compares the seed's managed skills against every live
 * destination; when any copy differs, returns one plain-English line telling
 * the assistant to run `skills_sync`. Never throws — a broken fs read must
 * not break a tool response.
 */
export function checkSkillsDriftNudge(): string | null {
  try {
    const now = Date.now();
    const last = getSetting(SKILLS_DRIFT_CHECKED_KEY);
    if (last && now - Date.parse(last) < DRIFT_CHECK_INTERVAL_MS) return null;
    setSetting(SKILLS_DRIFT_CHECKED_KEY, new Date(now).toISOString());

    const seedSkills = seedSkillsDir();
    const { destDirs } = managedDestinations();

    const drifted: string[] = [];
    for (const skill of MANAGED_SKILLS) {
      const seedFp = dirFingerprint(join(seedSkills, skill));
      if (seedFp === null) continue; // seed missing → skills_sync reports it, not drift
      if (destDirs.some(d => dirFingerprint(join(d, skill)) !== seedFp)) drifted.push(skill);
    }
    if (drifted.length === 0) return null;

    const names = drifted.join(', ');
    return [
      '',
      `🧰 SKILL COPIES OUT OF SYNC — the ${names} skill${drifted.length === 1 ? "'s copies don't" : " copies don't"} all match the seed.`,
      'Run the `skills_sync` tool to fan the seed version out to every workspace and the global folder.',
      'This check runs at most once an hour.',
    ].join('\n');
  } catch {
    return null;
  }
}
