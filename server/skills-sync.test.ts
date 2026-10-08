import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// skills-sync's drift check (Task 2) reads settings via ./timers and workspace
// state via ./workspace's use of ./timers — mock the settings store once here.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k),
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import {
  MANAGED_SKILLS,
  dirFingerprint,
  syncManagedSkills,
  formatSyncReport,
  checkSkillsDriftNudge,
  SKILLS_DRIFT_CHECKED_KEY,
  seedSkillsDir,
  managedDestinations,
} from './skills-sync';
import { SEED_KEY, WORKSPACE_PATHS_KEY } from './workspace';

let root: string;
beforeEach(() => {
  store.clear();
  root = mkdtempSync(join(tmpdir(), 'skills-sync-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Make a skill folder with given files: { 'SKILL.md': '...', 'sub/x.md': '...' } */
function makeSkill(base: string, name: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(base, name, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

describe('MANAGED_SKILLS', () => {
  it('is exactly the four workspace-craft skills', () => {
    expect([...MANAGED_SKILLS]).toEqual(['demo', 'design', 'discovery', 'walkthrough']);
  });
});

describe('dirFingerprint', () => {
  it('returns null for a missing dir', () => {
    expect(dirFingerprint(join(root, 'nope'))).toBeNull();
  });

  it('same content → same fingerprint; different content → different', () => {
    makeSkill(join(root, 'a'), 'demo', { 'SKILL.md': 'v1' });
    makeSkill(join(root, 'b'), 'demo', { 'SKILL.md': 'v1' });
    makeSkill(join(root, 'c'), 'demo', { 'SKILL.md': 'v2' });
    const a = dirFingerprint(join(root, 'a', 'demo'));
    const b = dirFingerprint(join(root, 'b', 'demo'));
    const c = dirFingerprint(join(root, 'c', 'demo'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('an extra file changes the fingerprint (so deletions sync too)', () => {
    makeSkill(join(root, 'a'), 'demo', { 'SKILL.md': 'v1' });
    makeSkill(join(root, 'b'), 'demo', { 'SKILL.md': 'v1', 'extra.md': 'x' });
    expect(dirFingerprint(join(root, 'a', 'demo'))).not.toBe(
      dirFingerprint(join(root, 'b', 'demo')),
    );
  });
});

describe('syncManagedSkills', () => {
  it('overwrites a stale copy and reports it updated', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'new' });
    makeSkill(dest, 'demo', { 'SKILL.md': 'old', 'stray.md': 'gone' });

    const out = syncManagedSkills(seed, [dest]);

    const demo = out.find(o => o.skill === 'demo')!;
    expect(demo.updated).toEqual([dest]);
    expect(demo.current).toEqual([]);
    expect(readFileSync(join(dest, 'demo', 'SKILL.md'), 'utf8')).toBe('new');
    // removed-in-seed file disappears at the destination (delete + copy)
    expect(existsSync(join(dest, 'demo', 'stray.md'))).toBe(false);
  });

  it('leaves a current copy untouched and reports it current', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    for (const s of MANAGED_SKILLS) {
      makeSkill(seed, s, { 'SKILL.md': 'same' });
      makeSkill(dest, s, { 'SKILL.md': 'same' });
    }
    const out = syncManagedSkills(seed, [dest]);
    for (const o of out) {
      expect(o.updated).toEqual([]);
      expect(o.current).toEqual([dest]);
    }
  });

  it('adds a skill folder missing at the destination', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills'); // dest dir doesn't even exist
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'v1' });

    const out = syncManagedSkills(seed, [dest]);

    expect(out.find(o => o.skill === 'walkthrough')!.updated).toEqual([dest]);
    expect(readFileSync(join(dest, 'walkthrough', 'SKILL.md'), 'utf8')).toBe('v1');
  });

  it('a skill absent from the seed is skipped and flagged, destination untouched', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    makeSkill(seed, 'demo', { 'SKILL.md': 'v1' }); // no discovery, no walkthrough in seed
    makeSkill(dest, 'discovery', { 'SKILL.md': 'keep me' });

    const out = syncManagedSkills(seed, [dest]);

    const disc = out.find(o => o.skill === 'discovery')!;
    expect(disc.missingSeed).toBe(true);
    expect(disc.updated).toEqual([]);
    expect(readFileSync(join(dest, 'discovery', 'SKILL.md'), 'utf8')).toBe('keep me');
  });

  it('fans out to several destinations independently', () => {
    const seed = join(root, 'seed');
    const d1 = join(root, 'ws1', '.claude', 'skills');
    const d2 = join(root, 'global');
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'v2' });
    makeSkill(d1, 'demo', { 'SKILL.md': 'v2' }); // current in d1
    makeSkill(d2, 'demo', { 'SKILL.md': 'v1' }); // stale in d2

    const demo = syncManagedSkills(seed, [d1, d2]).find(o => o.skill === 'demo')!;

    expect(demo.current).toEqual([d1]);
    expect(demo.updated).toEqual([d2]);
  });
});

describe('a sync that goes wrong never destroys the copy that is already there', () => {
  it('a failed copy leaves the existing skill folder untouched and reports the error', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'new' });
    makeSkill(dest, 'demo', { 'SKILL.md': 'the copy already on disk' });

    const out = syncManagedSkills(seed, [dest], () => {
      throw new Error('copy failed on purpose');
    });

    const demo = out.find(o => o.skill === 'demo')!;
    expect(demo.updated).toEqual([]);
    expect(demo.failed).toEqual([{ destDir: dest, error: 'copy failed on purpose' }]);
    // the folder that was there is still there, with its own content
    expect(readFileSync(join(dest, 'demo', 'SKILL.md'), 'utf8')).toBe('the copy already on disk');
    // and no half-copied temp folder is left lying around
    expect(readdirSync(dest).some(n => n.includes('.tmp'))).toBe(false);
  });

  it('the report says which place failed instead of claiming success', () => {
    const text = formatSyncReport(
      [{
        skill: 'demo',
        missingSeed: false,
        updated: [],
        current: [],
        failed: [{ destDir: '/a/ws/.claude/skills', error: 'disk full' }],
      }],
      [],
    );
    expect(text).toContain('could not be copied to /a/ws/.claude/skills');
    expect(text).toContain('disk full');
    expect(text).not.toContain('already current everywhere');
  });

  it('a successful sync leaves no temp folders behind', () => {
    const seed = join(root, 'seed');
    const dest = join(root, 'ws', '.claude', 'skills');
    for (const s of MANAGED_SKILLS) makeSkill(seed, s, { 'SKILL.md': 'v1' });
    makeSkill(dest, 'demo', { 'SKILL.md': 'old' });

    syncManagedSkills(seed, [dest]);

    expect(readdirSync(dest).sort()).toEqual([...MANAGED_SKILLS].sort());
  });
});

describe('formatSyncReport', () => {
  it('names what changed, what was already current, and what the seed is missing', () => {
    const text = formatSyncReport(
      [
        { skill: 'demo', missingSeed: false, updated: ['/a', '/b'], current: [] },
        { skill: 'discovery', missingSeed: false, updated: [], current: ['/a', '/b'] },
        { skill: 'walkthrough', missingSeed: true, updated: [], current: [] },
      ],
      ['/dead/ws'],
    );
    expect(text).toContain('demo: updated in 2 places');
    expect(text).toContain('discovery: already current everywhere');
    expect(text).toContain('walkthrough: missing from the seed — skipped');
    expect(text).toContain('/dead/ws');
  });

  it('singular wording for one place', () => {
    const text = formatSyncReport(
      [{ skill: 'demo', missingSeed: false, updated: ['/a'], current: [] }],
      [],
    );
    expect(text).toContain('demo: updated in 1 place');
    expect(text).not.toContain('1 places');
  });

  it('omits the no-restart line when nothing was updated', () => {
    const text = formatSyncReport(
      [
        { skill: 'demo', missingSeed: false, updated: [], current: ['/a'] },
        { skill: 'discovery', missingSeed: true, updated: [], current: [] },
      ],
      [],
    );
    expect(text).not.toContain('no restart needed');
  });

  it('keeps the no-restart line when something was updated', () => {
    const text = formatSyncReport(
      [{ skill: 'demo', missingSeed: false, updated: ['/a'], current: [] }],
      [],
    );
    expect(text).toContain('no restart needed');
  });
});

describe('seedSkillsDir / managedDestinations', () => {
  it('point at the seed and every live destination, skipping dead workspaces', () => {
    const seedRoot = join(root, 'seed-root');
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    const deadWs = join(root, 'gone');
    store.set(SEED_KEY, seedRoot);
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify([ws, deadWs]));

    expect(seedSkillsDir()).toBe(join(seedRoot, '.claude', 'skills'));

    const { destDirs, deadWorkspaces } = managedDestinations();
    expect(destDirs).toContain(join(ws, '.claude', 'skills'));
    expect(destDirs.some(d => d.endsWith(join('sprintomatic-plus', 'skills')))).toBe(true);
    expect(deadWorkspaces).toEqual([deadWs]);
  });
});

describe('checkSkillsDriftNudge', () => {
  // The global skills dir is under the real home folder — tests must never
  // touch it. Point HOME at a temp dir for the whole describe block.
  let home: string;
  let seedRoot: string;
  let ws: string;
  const OLD_HOME = process.env.HOME;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z'));
    home = mkdtempSync(join(tmpdir(), 'skills-home-'));
    process.env.HOME = home;
    seedRoot = join(root, 'seed-root');
    ws = join(root, 'ws');
    store.set(SEED_KEY, seedRoot);
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify([ws]));
    mkdirSync(ws, { recursive: true });
    for (const s of MANAGED_SKILLS) {
      makeSkill(join(seedRoot, '.claude', 'skills'), s, { 'SKILL.md': 'v1' });
      makeSkill(join(ws, '.claude', 'skills'), s, { 'SKILL.md': 'v1' });
      makeSkill(join(home, '.claude', 'skills', 'sprintomatic-plus', 'skills'), s, {
        'SKILL.md': 'v1',
      });
    }
  });

  afterEach(() => {
    process.env.HOME = OLD_HOME;
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when every copy matches the seed', () => {
    expect(checkSkillsDriftNudge()).toBeNull();
  });

  it('names the drifted skill when a workspace copy differs', () => {
    writeFileSync(join(ws, '.claude', 'skills', 'demo', 'SKILL.md'), 'hand-edited');
    const nudge = checkSkillsDriftNudge();
    expect(nudge).toContain('demo');
    expect(nudge).toContain('skills_sync');
  });

  it('throttles: second call within the hour returns null even with drift', () => {
    writeFileSync(join(ws, '.claude', 'skills', 'demo', 'SKILL.md'), 'hand-edited');
    expect(checkSkillsDriftNudge()).not.toBeNull();
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(checkSkillsDriftNudge()).toBeNull();
    vi.advanceTimersByTime(2 * 60 * 1000); // past the hour
    expect(checkSkillsDriftNudge()).not.toBeNull();
  });

  it('a missing destination copy counts as drift', () => {
    rmSync(join(ws, '.claude', 'skills', 'walkthrough'), { recursive: true, force: true });
    expect(checkSkillsDriftNudge()).toContain('walkthrough');
  });

  it('a skill missing from the seed is NOT drift (sync reports it instead)', () => {
    rmSync(join(seedRoot, '.claude', 'skills', 'discovery'), { recursive: true, force: true });
    expect(checkSkillsDriftNudge()).toBeNull();
  });

  it('never throws when the seed root is gone entirely', () => {
    rmSync(seedRoot, { recursive: true, force: true });
    expect(checkSkillsDriftNudge()).toBeNull();
  });

  it('a dead workspace path is ignored, not drift', () => {
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify([ws, join(root, 'gone')]));
    expect(checkSkillsDriftNudge()).toBeNull();
  });
});
