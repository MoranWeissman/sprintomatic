/**
 * Planning-home detection (R12 Thread 1).
 *
 * A "planning home" is a cwd the user has designated for sprint-wide planning
 * work. When Claude Code opens a chat in that cwd, the assistant skips the
 * usual story-anchor ritual (no `story_match` prompt) and runs sprint-wide
 * skills instead.
 *
 * Two detection signals, either is sufficient:
 *  1. A marker file `.sprintomatic-home` exists inside the cwd. Strong,
 *     explicit signal — the user can `touch .sprintomatic-home` in any folder.
 *  2. The configured path in `settings.planning_home_path` equals (or is a
 *     prefix of) the cwd. Default value: `~/.sprintomatic/home/` — sits
 *     under the same hidden root as `data.db` and the markdown archive
 *     (consolidation 2026-06-03).
 *
 * The model receives both signals via `orient.planningHome` and decides.
 * Nothing here writes to Azure DevOps.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getSetting, setSetting } from './timers';
import { writeFileAtomicSync } from './atomic-write';

const SETTINGS_KEY = 'planning_home_path';
const MARKER_FILENAME = '.sprintomatic-home';
const DEFAULT_HOME_PATH = join(homedir(), '.sprintomatic', 'home');

export interface PlanningHomeStatus {
  /** Absolute path the user configured (or the default, if the user never set one). */
  configuredPath: string;
  /** True if the configured path was explicitly set via `setPlanningHome`. */
  isExplicitlyConfigured: boolean;
  /** The default location, exposed so callers can recommend it. */
  defaultPath: string;
}

export function getPlanningHome(): PlanningHomeStatus {
  const stored = getSetting(SETTINGS_KEY);
  return {
    configuredPath: stored ?? DEFAULT_HOME_PATH,
    isExplicitlyConfigured: stored != null,
    defaultPath: DEFAULT_HOME_PATH,
  };
}

/**
 * Sets the configured planning-home path. If `ensureFolder` is true (default),
 * creates the folder and drops a marker file inside so the cwd-based detector
 * picks it up immediately. Returns the resolved absolute path.
 */
export function setPlanningHome(path: string, opts: { ensureFolder?: boolean } = {}): string {
  const abs = resolve(expandHome(path));
  setSetting(SETTINGS_KEY, abs);
  if (opts.ensureFolder !== false) {
    mkdirSync(abs, { recursive: true });
    const markerPath = join(abs, MARKER_FILENAME);
    if (!existsSync(markerPath)) {
      writeFileAtomicSync(markerPath, `# sprintomatic planning home\n# Generated ${new Date().toISOString()}\n`);
    }
  }
  return abs;
}

/**
 * Returns true when `cwd` should be treated as a planning home. The cwd
 * matches when EITHER the marker file is present OR the configured path
 * equals the cwd OR is a parent of it.
 */
export function isPlanningHomeCwd(cwd: string): { match: boolean; reason: 'marker' | 'configured' | null } {
  const abs = resolve(cwd);
  if (existsSync(join(abs, MARKER_FILENAME))) {
    return { match: true, reason: 'marker' };
  }
  const home = getPlanningHome().configuredPath;
  if (abs === home || abs.startsWith(home + '/')) {
    return { match: true, reason: 'configured' };
  }
  return { match: false, reason: null };
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
