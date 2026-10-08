/**
 * Workspace state + feature-folder scaffolding.
 *
 * A "workspace" is a visible folder the user launches Claude Code in for non-code
 * work (discovery, design, small demos). BMAD + the planning CLAUDE.md + the
 * enforcement hook live once at its root; each feature gets a subfolder for its
 * design docs. Generalizes the older planning-home concept (see planning-home.ts).
 *
 * All state lives in the settings table as JSON arrays, parsed defensively.
 * Everything here is LOCAL — no Azure DevOps access.
 */
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { getSetting, setSetting } from './timers';
import { writeFileAtomicSync, type AtomicWriter } from './atomic-write';

export const WORKSPACE_PATHS_KEY = 'workspace_paths';
const WORKSPACE_DECLINED_KEY = 'workspace_declined_paths';
export const MANAGED_FEATURES_KEY = 'managed_feature_ids';

export interface WorkspaceState {
  paths: string[];
  declined: string[];
}

/** Parse a settings value expected to be a JSON array; garbage/unset → []. */
function readJsonArray<T>(key: string, guard: (v: unknown) => v is T): T[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function writeJsonArray(key: string, arr: unknown[]): void {
  setSetting(key, JSON.stringify(arr));
}

export function getWorkspaces(): WorkspaceState {
  return {
    paths: readJsonArray(WORKSPACE_PATHS_KEY, isString),
    declined: readJsonArray(WORKSPACE_DECLINED_KEY, isString),
  };
}

function underAny(cwd: string, bases: string[]): boolean {
  const abs = resolve(cwd);
  return bases.some(b => {
    const base = resolve(b);
    return abs === base || abs.startsWith(base + '/');
  });
}

export function isKnownWorkspace(cwd: string): boolean {
  return underAny(cwd, getWorkspaces().paths);
}

export function isDeclinedPath(cwd: string): boolean {
  const abs = resolve(cwd);
  return getWorkspaces().declined.some(d => resolve(d) === abs);
}

export function declineWorkspace(cwd: string): void {
  const abs = resolve(cwd);
  const declined = getWorkspaces().declined.map(d => resolve(d));
  if (!declined.includes(abs)) {
    declined.push(abs);
    writeJsonArray(WORKSPACE_DECLINED_KEY, declined);
  }
}

export function getManagedFeatureIds(): number[] {
  return readJsonArray(MANAGED_FEATURES_KEY, isNumber);
}

export function addManagedFeatureId(id: number): void {
  const ids = getManagedFeatureIds();
  if (!ids.includes(id)) {
    ids.push(id);
    writeJsonArray(MANAGED_FEATURES_KEY, ids);
  }
}

export function removeManagedFeatureId(id: number): void {
  const ids = getManagedFeatureIds().filter(x => x !== id);
  writeJsonArray(MANAGED_FEATURES_KEY, ids);
}

export const ACTIVE_FEATURE_KEY = 'active_feature';

/** The feature the user is actively working in the workspace right now. A pointer,
 *  not a source of truth — the title is a display convenience (ADO owns the
 *  real feature). Overwritten when the user names the next feature; that's the switch. */
export interface ActiveFeature {
  id: number;
  title: string;
  folderPath: string;
  setAt: string;
}

function isActiveFeature(v: unknown): v is ActiveFeature {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'number' && Number.isFinite(o.id) &&
    typeof o.title === 'string' &&
    typeof o.folderPath === 'string' &&
    typeof o.setAt === 'string'
  );
}

/** The active feature, or null when unset/malformed. Never throws. */
export function getActiveFeature(): ActiveFeature | null {
  const raw = getSetting(ACTIVE_FEATURE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isActiveFeature(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setActiveFeature(f: ActiveFeature): void {
  setSetting(ACTIVE_FEATURE_KEY, JSON.stringify(f));
}

export function clearActiveFeature(): void {
  setSetting(ACTIVE_FEATURE_KEY, JSON.stringify(null));
}

export const FEATURE_KINDS_KEY = 'feature_kinds';

/**
 * Which of the two ways this feature arrived.
 *
 * 'handed'   — somebody gave the user the problem to work out. Discovery, then
 *              design, then the stories. A real feature went this way.
 * 'grouping' — the user wrote the stories first and made the feature to gather
 *              them. There is nothing to discover and nothing to design; it
 *              isn't missing, it was never needed. A real feature went this way.
 *
 * Kept here rather than in the feature folder on disk: a grouping feature has
 * no discovery.json to put it in, and that's exactly the case we're supporting.
 */
export type FeatureKind = 'handed' | 'grouping';

const FEATURE_KINDS: FeatureKind[] = ['handed', 'grouping'];

function isFeatureKind(v: unknown): v is FeatureKind {
  return typeof v === 'string' && (FEATURE_KINDS as string[]).includes(v);
}

/** Read the whole map; garbage/unset → {}. Never throws. */
function readFeatureKinds(): Record<string, FeatureKind> {
  const raw = getSetting(FEATURE_KINDS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, FeatureKind> = {};
    for (const [id, kind] of Object.entries(parsed as Record<string, unknown>)) {
      if (isFeatureKind(kind)) out[id] = kind;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * This feature's kind, or null when nobody has said.
 *
 * null is a real answer, not a default. Guessing is the whole thing we're
 * avoiding: a wrong guess means either nagging about a discovery that was never
 * needed, or silently skipping one that was. The caller asks the user.
 */
export function getFeatureKind(featureId: number): FeatureKind | null {
  return readFeatureKinds()[String(featureId)] ?? null;
}

/** Set or change it. A day-one answer isn't binding — a grouping feature can
 *  turn out to need a real design. */
export function setFeatureKind(featureId: number, kind: FeatureKind): void {
  const all = readFeatureKinds();
  all[String(featureId)] = kind;
  setSetting(FEATURE_KINDS_KEY, JSON.stringify(all));
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

const SLUG_MAX = 40;

/** `<id>-<slug>` where slug = lowercased title, non-alphanumerics → '-',
 *  collapsed, trimmed, capped. Symbol-only title → just the id. */
export function featureFolderName(id: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, ''); // re-trim after slice may leave a trailing dash
  return slug ? `${id}-${slug}` : `${id}`;
}

export function createFeatureFolder(
  workspacePath: string,
  id: number,
  title: string,
): { path: string; created: boolean } {
  const abs = join(resolve(expandHome(workspacePath)), featureFolderName(id, title));
  const existed = existsSync(abs);
  mkdirSync(abs, { recursive: true });
  return { path: abs, created: !existed };
}

export const SEED_KEY = 'workspace_seed_path';
/** Where the managed skills, the planning CLAUDE.md and the hook are copied from. */
const DEFAULT_SEED = join(homedir(), '.sprintomatic', 'seed');

export function getSeedPath(): string {
  return getSetting(SEED_KEY) ?? DEFAULT_SEED;
}

const SETTINGS_JSON = JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/user-prompt-submit.sh' }] },
      ],
    },
  },
  null,
  2,
) + '\n';

/** Copy seed skill folders the workspace doesn't have yet. Never overwrites an
 *  existing skill (the user may have edited it). Returns `skill:<name>` for each
 *  one added. Pure fs over two paths; safe when either skills dir is absent. */
function syncSeedSkills(seed: string, ws: string): string[] {
  const seedSkills = join(seed, '.claude', 'skills');
  if (!existsSync(seedSkills)) return [];
  const wsSkills = join(ws, '.claude', 'skills');
  const added: string[] = [];
  for (const name of readdirSync(seedSkills, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const dest = join(wsSkills, name.name);
    if (existsSync(dest)) continue; // already present — leave it alone
    mkdirSync(wsSkills, { recursive: true });
    cpSync(join(seedSkills, name.name), dest, { recursive: true });
    added.push(`skill:${name.name}`);
  }
  return added;
}

export function ensureWorkspaceScaffold(
  workspacePath: string,
  writer?: AtomicWriter,
): { created: string[]; seedMissing: boolean } {
  const ws = resolve(expandHome(workspacePath));
  mkdirSync(ws, { recursive: true });
  const seed = resolve(expandHome(getSeedPath()));
  const created: string[] = [];

  // Seed must have _bmad to be usable.
  if (!existsSync(join(seed, '_bmad'))) {
    return { created, seedMissing: true };
  }

  if (!existsSync(join(ws, '_bmad'))) {
    cpSync(join(seed, '_bmad'), join(ws, '_bmad'), { recursive: true });
    if (existsSync(join(seed, '.claude', 'skills'))) {
      cpSync(join(seed, '.claude', 'skills'), join(ws, '.claude', 'skills'), { recursive: true });
    }
    created.push('bmad');
  } else {
    // Workspace already scaffolded: sync any NEW seed skills that landed after
    // it was created. Copy per-skill-folder, never overwriting an existing one,
    // so a workspace picks up skills we add later (e.g. `discovery`) without
    // clobbering the user's own edits. This is the seed-update path.
    created.push(...syncSeedSkills(seed, ws));
  }
  if (!existsSync(join(ws, 'CLAUDE.md')) && existsSync(join(seed, 'CLAUDE.md'))) {
    cpSync(join(seed, 'CLAUDE.md'), join(ws, 'CLAUDE.md'));
    created.push('claude-md');
  }
  const hookPath = join(ws, '.claude', 'hooks', 'user-prompt-submit.sh');
  const seedHookPath = join(seed, '.claude', 'hooks', 'user-prompt-submit.sh');
  if (!existsSync(hookPath) && existsSync(seedHookPath)) {
    mkdirSync(join(ws, '.claude', 'hooks'), { recursive: true });
    cpSync(seedHookPath, hookPath);
    created.push('hook');
  }
  // FINDING A FIX: Write settings.json whenever absent, independent of hook status
  const settingsPath = join(ws, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    mkdirSync(join(ws, '.claude'), { recursive: true });
    writeFileAtomicSync(settingsPath, SETTINGS_JSON, writer);
  }
  return { created, seedMissing: false };
}

export function registerWorkspace(
  path: string,
): { path: string; scaffolded: string[]; seedMissing: boolean } {
  const abs = resolve(expandHome(path));
  const state = getWorkspaces();
  if (!state.paths.map(p => resolve(p)).includes(abs)) {
    writeJsonArray(WORKSPACE_PATHS_KEY, [...state.paths, abs]);
  }
  // Un-decline if it was previously declined.
  const declined = state.declined.map(d => resolve(d)).filter(d => d !== abs);
  if (declined.length !== state.declined.length) writeJsonArray(WORKSPACE_DECLINED_KEY, declined);
  const scaffold = ensureWorkspaceScaffold(abs);
  return { path: abs, scaffolded: scaffold.created, seedMissing: scaffold.seedMissing };
}

export interface OrientWorkspaceOffer {
  shouldOffer: boolean;
  cwd: string | null;
  reason: 'empty-unknown' | null;
}

const WORKSPACE_EMPTY_ALLOWLIST = new Set(['.git', '.DS_Store', '.sprintomatic-home']);

/** Pure: decide whether to offer making this cwd a workspace. Offer when the
 *  folder is empty (ignoring harmless dotfiles), unknown, and not declined. */
export function workspaceOfferFor(args: {
  cwd: string | null;
  entries: string[];
  known: boolean;
  declined: boolean;
}): OrientWorkspaceOffer {
  const { cwd, entries, known, declined } = args;
  if (!cwd || known || declined) return { shouldOffer: false, cwd, reason: null };
  const realEntries = entries.filter(e => !WORKSPACE_EMPTY_ALLOWLIST.has(e));
  if (realEntries.length > 0) return { shouldOffer: false, cwd, reason: null };
  return { shouldOffer: true, cwd, reason: 'empty-unknown' };
}
