import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AtomicWriter } from './atomic-write';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k),
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import {
  getWorkspaces, isKnownWorkspace, isDeclinedPath, declineWorkspace,
  getManagedFeatureIds, addManagedFeatureId, removeManagedFeatureId,
  WORKSPACE_PATHS_KEY, MANAGED_FEATURES_KEY,
  featureFolderName, createFeatureFolder,
  registerWorkspace, ensureWorkspaceScaffold, SEED_KEY,
  getActiveFeature, setActiveFeature, clearActiveFeature, ACTIVE_FEATURE_KEY,
  getFeatureKind, setFeatureKind, FEATURE_KINDS_KEY,
  workspaceSettingsJson, setMainWorkspace, mainWorkspace, workspaceForChat, claudeProjectDirName,
} from './workspace';

beforeEach(() => store.clear());

describe('feature kinds', () => {
  it('is null when nobody has said — never guessed', () => {
    expect(getFeatureKind(100905)).toBeNull();
  });

  it('round-trips both kinds', () => {
    setFeatureKind(100905, 'grouping');
    setFeatureKind(100901, 'handed');
    expect(getFeatureKind(100905)).toBe('grouping');
    expect(getFeatureKind(100901)).toBe('handed');
  });

  it('is null for an id nobody has said anything about', () => {
    setFeatureKind(100905, 'grouping');
    expect(getFeatureKind(999999)).toBeNull();
  });

  it('overwrites — a grouping feature can turn out to need a real design', () => {
    setFeatureKind(100905, 'grouping');
    setFeatureKind(100905, 'handed');
    expect(getFeatureKind(100905)).toBe('handed');
  });

  it('reads null from malformed JSON rather than throwing', () => {
    store.set(FEATURE_KINDS_KEY, '{not json');
    expect(() => getFeatureKind(100905)).not.toThrow();
    expect(getFeatureKind(100905)).toBeNull();
  });

  it('reads null when the stored value is not a kind we know', () => {
    store.set(FEATURE_KINDS_KEY, JSON.stringify({ 100905: 'whatever' }));
    expect(getFeatureKind(100905)).toBeNull();
  });

  it('reads null when the stored value is an array, not an object', () => {
    store.set(FEATURE_KINDS_KEY, JSON.stringify([100905]));
    expect(getFeatureKind(100905)).toBeNull();
  });

  it('keeps other features when one is written', () => {
    setFeatureKind(100901, 'handed');
    setFeatureKind(100905, 'grouping');
    expect(getFeatureKind(100901)).toBe('handed');
  });
});

describe('workspace settings state', () => {
  it('getWorkspaces returns empty arrays when unset', () => {
    expect(getWorkspaces()).toEqual({ paths: [], declined: [] });
  });

  it('getWorkspaces parses garbage as empty', () => {
    store.set(WORKSPACE_PATHS_KEY, 'not json');
    expect(getWorkspaces().paths).toEqual([]);
  });

  it('isKnownWorkspace matches exact path and sub-paths', () => {
    store.set(WORKSPACE_PATHS_KEY, JSON.stringify(['/w/space']));
    expect(isKnownWorkspace('/w/space')).toBe(true);
    expect(isKnownWorkspace('/w/space/100901-x')).toBe(true);
    expect(isKnownWorkspace('/w/other')).toBe(false);
  });

  it('declineWorkspace records path; isDeclinedPath matches; dedups', () => {
    declineWorkspace('/w/nope');
    declineWorkspace('/w/nope');
    expect(isDeclinedPath('/w/nope')).toBe(true);
    expect(getWorkspaces().declined).toEqual(['/w/nope']);
  });

  it('managed feature ids: add (dedup number), read, remove', () => {
    addManagedFeatureId(100901);
    addManagedFeatureId(100901);
    addManagedFeatureId(100909);
    expect(getManagedFeatureIds()).toEqual([100901, 100909]);
    removeManagedFeatureId(100901);
    expect(getManagedFeatureIds()).toEqual([100909]);
  });

  it('getManagedFeatureIds parses garbage as empty', () => {
    store.set(MANAGED_FEATURES_KEY, '{oops');
    expect(getManagedFeatureIds()).toEqual([]);
  });
});

describe('featureFolderName', () => {
  it('slugs the title: lowercase, punctuation to dashes, capped', () => {
    const name = featureFolderName(
      100901,
      'Declarative Continuous Deployment (CD) and Automated Testing Pipeline',
    );
    expect(name.startsWith('100901-')).toBe(true);
    expect(name).toMatch(/^100901-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(48); // id + '-' + <=40 slug
    expect(name).not.toContain('(');
    expect(name).not.toMatch(/--/);       // collapsed
    expect(name.endsWith('-')).toBe(false); // trimmed
  });

  it('handles an empty/symbol-only title with just the id', () => {
    expect(featureFolderName(12, '!!!')).toBe('12');
  });

  it('cuts a long title at the last whole word, never mid-word', () => {
    expect(featureFolderName(100901, 'Self-Service Board to Repo Code Migration Tooling'))
      .toBe('100901-self-service-board-to-repo-code');
  });

  it('keeps a hard cut when the title is one long word', () => {
    expect(featureFolderName(7, 'a'.repeat(50))).toBe(`7-${'a'.repeat(40)}`);
  });
});

describe('createFeatureFolder', () => {
  it('creates the folder and reports created, then false on repeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ws-'));
    try {
      const first = createFeatureFolder(root, 100901, 'Declarative CD');
      expect(existsSync(first.path)).toBe(true);
      expect(first.created).toBe(true);
      const second = createFeatureFolder(root, 100901, 'Declarative CD');
      expect(second.path).toBe(first.path);
      expect(second.created).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses the folder a feature already has, even under an older name', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-ws-'));
    try {
      mkdirSync(join(root, '100901-old-name-cut-mid-wor'));
      mkdirSync(join(root, '1009010-another-feature'));
      const r = createFeatureFolder(root, 100901, 'A new title on the board');
      expect(r).toEqual({ path: join(root, '100901-old-name-cut-mid-wor'), created: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the main workspace', () => {
  let base: string;
  let projects: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sh-move-')));
    projects = join(base, 'claude-projects');
    store.set(SEED_KEY, join(base, 'no-seed')); // never copy a real seed
  });
  const cleanup = () => rmSync(base, { recursive: true, force: true });

  it('is the first saved one; a chat inside another one uses that one', () => {
    try {
      store.set(WORKSPACE_PATHS_KEY, JSON.stringify([join(base, 'a'), join(base, 'b')]));
      expect(mainWorkspace()).toBe(join(base, 'a'));
      expect(workspaceForChat(join(base, 'b', '100901-x'))).toEqual({ path: join(base, 'b'), inside: true });
      expect(workspaceForChat(join(base, 'elsewhere'))).toEqual({ path: join(base, 'a'), inside: false });
      store.set(WORKSPACE_PATHS_KEY, '[]');
      expect(workspaceForChat(base)).toBeNull();
    } finally { cleanup(); }
  });

  it('moves the folder with its features and updates every saved path', () => {
    try {
      const from = join(base, 'old-name');
      const to = join(base, 'parent', 'features');
      mkdirSync(join(from, '100901-x'), { recursive: true });
      writeFileSync(join(from, '100901-x', 'notes.md'), 'hi');
      mkdirSync(join(from, '.claude'), { recursive: true });
      writeFileSync(join(from, '.claude', 'settings.json'), workspaceSettingsJson(from));
      mkdirSync(join(projects, claudeProjectDirName(from), 'memory'), { recursive: true });
      writeFileSync(join(projects, claudeProjectDirName(from), 'memory', 'MEMORY.md'), 'remember');
      store.set(WORKSPACE_PATHS_KEY, JSON.stringify([from]));
      setActiveFeature({ id: 100901, title: 'x', folderPath: join(from, '100901-x'), setAt: 't' });

      const r = setMainWorkspace(to, { claudeProjectsDir: projects });

      expect(r).toEqual({ from, to, how: 'moved' });
      expect(existsSync(from)).toBe(false);
      expect(readFileSync(join(to, '100901-x', 'notes.md'), 'utf8')).toBe('hi');
      expect(getWorkspaces().paths).toEqual([to]);
      expect(getActiveFeature()?.folderPath).toBe(join(to, '100901-x'));
      expect(readFileSync(join(to, '.claude', 'settings.json'), 'utf8')).toBe(workspaceSettingsJson(to));
      expect(readFileSync(join(projects, claudeProjectDirName(to), 'memory', 'MEMORY.md'), 'utf8')).toBe('remember');
    } finally { cleanup(); }
  });

  it('follows a folder the user already moved by hand', () => {
    try {
      const to = join(base, 'moved');
      mkdirSync(join(to, '100901-x'), { recursive: true });
      store.set(WORKSPACE_PATHS_KEY, JSON.stringify([join(base, 'gone')]));
      expect(setMainWorkspace(to, { claudeProjectsDir: projects }).how).toBe('repointed');
      expect(getWorkspaces().paths).toEqual([to]);
    } finally { cleanup(); }
  });

  it('refuses a folder that already has files, and changes nothing', () => {
    try {
      const from = join(base, 'ws');
      const to = join(base, 'busy');
      mkdirSync(from);
      mkdirSync(to);
      writeFileSync(join(to, 'x.txt'), 'x');
      store.set(WORKSPACE_PATHS_KEY, JSON.stringify([from]));
      expect(() => setMainWorkspace(to, { claudeProjectsDir: projects })).toThrow(/already has files/);
      expect(existsSync(from)).toBe(true);
      expect(getWorkspaces().paths).toEqual([from]);
    } finally { cleanup(); }
  });

  it('refuses a folder inside the workspace, and the home folder', () => {
    try {
      const from = join(base, 'ws');
      mkdirSync(from);
      store.set(WORKSPACE_PATHS_KEY, JSON.stringify([from]));
      expect(() => setMainWorkspace(join(from, 'inner'), { claudeProjectsDir: projects })).toThrow(/inside the workspace/);
      expect(() => setMainWorkspace('~', { claudeProjectsDir: projects })).toThrow(/home folder/);
    } finally { cleanup(); }
  });

  it('sets the first one when none is saved', () => {
    try {
      const to = join(base, 'first');
      expect(setMainWorkspace(to, { claudeProjectsDir: projects }).how).toBe('set');
      expect(existsSync(to)).toBe(true);
      expect(getWorkspaces().paths).toEqual([to]);
    } finally { cleanup(); }
  });
});

function makeSeed(): string {
  const seed = mkdtempSync(join(tmpdir(), 'sh-seed-'));
  mkdirSync(join(seed, '_bmad'), { recursive: true });
  writeFileSync(join(seed, '_bmad', 'config.yaml'), 'x');
  mkdirSync(join(seed, '.claude', 'skills', 'bmad-x'), { recursive: true });
  writeFileSync(join(seed, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'x');
  mkdirSync(join(seed, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(seed, '.claude', 'hooks', 'user-prompt-submit.sh'), '#!/bin/bash\n');
  writeFileSync(join(seed, 'CLAUDE.md'), '# rules');
  return seed;
}

describe('ensureWorkspaceScaffold', () => {
  it('copies bmad, claude-md, hook into an empty workspace; skips on repeat', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws2-'));
    try {
      store.set(SEED_KEY, seed);
      const first = ensureWorkspaceScaffold(ws);
      expect(first.seedMissing).toBe(false);
      expect(first.created.sort()).toEqual(['bmad', 'claude-md', 'hook'].sort());
      expect(existsSync(join(ws, '_bmad', 'config.yaml'))).toBe(true);
      expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(true);
      const second = ensureWorkspaceScaffold(ws);
      expect(second.created).toEqual([]); // nothing re-copied
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('syncs a NEW seed skill into an already-scaffolded workspace, without clobbering existing skills', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-sync-'));
    try {
      store.set(SEED_KEY, seed);
      // First scaffold: workspace gets bmad + the seed's bmad-x skill.
      ensureWorkspaceScaffold(ws);
      expect(existsSync(join(ws, '.claude', 'skills', 'bmad-x', 'SKILL.md'))).toBe(true);
      // User edits their copy of an existing skill.
      writeFileSync(join(ws, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'EDITED');
      // A new skill lands in the seed AFTER the workspace was created.
      mkdirSync(join(seed, '.claude', 'skills', 'discovery'), { recursive: true });
      writeFileSync(join(seed, '.claude', 'skills', 'discovery', 'SKILL.md'), 'discovery');
      // Re-scaffold: the new skill is delivered; the edited one is left alone.
      const r = ensureWorkspaceScaffold(ws);
      expect(r.created).toContain('skill:discovery');
      expect(existsSync(join(ws, '.claude', 'skills', 'discovery', 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(ws, '.claude', 'skills', 'bmad-x', 'SKILL.md'), 'utf8')).toBe('EDITED');
      // Idempotent: running again copies nothing new.
      const again = ensureWorkspaceScaffold(ws);
      expect(again.created).toEqual([]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('writes no settings file when the seed has no hook to run', () => {
    const seed = mkdtempSync(join(tmpdir(), 'sh-nohook-'));
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws4-'));
    try {
      mkdirSync(join(seed, '_bmad'), { recursive: true });
      store.set(SEED_KEY, seed);
      ensureWorkspaceScaffold(ws);
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(false);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports seedMissing when the seed has no _bmad', () => {
    const emptySeed = mkdtempSync(join(tmpdir(), 'sh-noseed-'));
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws3-'));
    try {
      store.set(SEED_KEY, emptySeed);
      const r = ensureWorkspaceScaffold(ws);
      expect(r.seedMissing).toBe(true);
      expect(r.created).toEqual([]);
    } finally {
      rmSync(emptySeed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('the hook command runs without $CLAUDE_PROJECT_DIR (GitHub Copilot CLI leaves it unset)', () => {
    const seed = makeSeed();
    const ws = join(mkdtempSync(join(tmpdir(), 'sh-ws-hook-')), 'my "odd" $folder');
    try {
      store.set(SEED_KEY, seed);
      writeFileSync(join(seed, '.claude', 'hooks', 'user-prompt-submit.sh'), '#!/bin/bash\necho hook-ran\n');
      chmodSync(join(seed, '.claude', 'hooks', 'user-prompt-submit.sh'), 0o755);
      ensureWorkspaceScaffold(ws);
      const settings = JSON.parse(readFileSync(join(ws, '.claude', 'settings.json'), 'utf8'));
      const command: string = settings.hooks.UserPromptSubmit[0].hooks[0].command;
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      // Run from somewhere else, the way a chat in a feature subfolder would.
      expect(execFileSync('bash', ['-c', command], { env, cwd: tmpdir() }).toString().trim()).toBe('hook-ran');
      // Claude Code's variable still wins when it is set.
      expect(command.startsWith('"${CLAUDE_PROJECT_DIR:-')).toBe(true);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(resolve(ws, '..'), { recursive: true, force: true });
    }
  });

  it('upgrades an untouched old settings.json, but never one the user edited', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-upgrade-'));
    const ws2 = mkdtempSync(join(tmpdir(), 'sh-ws-edited-'));
    try {
      store.set(SEED_KEY, seed);
      const old = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/user-prompt-submit.sh' }] }] } }, null, 2) + '\n';
      mkdirSync(join(ws, '.claude'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'settings.json'), old);
      ensureWorkspaceScaffold(ws);
      expect(readFileSync(join(ws, '.claude', 'settings.json'), 'utf8')).toBe(workspaceSettingsJson(resolve(ws)));

      mkdirSync(join(ws2, '.claude'), { recursive: true });
      writeFileSync(join(ws2, '.claude', 'settings.json'), '{"mine": true}\n');
      ensureWorkspaceScaffold(ws2);
      expect(readFileSync(join(ws2, '.claude', 'settings.json'), 'utf8')).toBe('{"mine": true}\n');
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
      rmSync(ws2, { recursive: true, force: true });
    }
  });

  it('writes settings.json even when hook already exists (FINDING A)', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-settings-'));
    try {
      store.set(SEED_KEY, seed);
      // Pre-populate workspace with hook but no settings.json
      mkdirSync(join(ws, '.claude', 'hooks'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'), '#!/bin/bash\n');
      const r = ensureWorkspaceScaffold(ws);
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(true);
      expect(r.created).not.toContain('hook'); // hook wasn't created this time
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('handles incomplete seed with _bmad but no hook (FINDING B)', () => {
    const incompleteSeed = mkdtempSync(join(tmpdir(), 'sh-incomplete-'));
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-incomplete-'));
    try {
      mkdirSync(join(incompleteSeed, '_bmad'), { recursive: true });
      writeFileSync(join(incompleteSeed, '_bmad', 'config.yaml'), 'x');
      // No hook in seed
      store.set(SEED_KEY, incompleteSeed);
      const r = ensureWorkspaceScaffold(ws);
      expect(r.seedMissing).toBe(false);
      expect(r.created).toContain('bmad');
      expect(r.created).not.toContain('hook'); // hook wasn't in seed, so not created
      expect(existsSync(join(ws, '_bmad', 'config.yaml'))).toBe(true);
      expect(existsSync(join(ws, '.claude', 'hooks', 'user-prompt-submit.sh'))).toBe(false);
    } finally {
      rmSync(incompleteSeed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('leaves no temp file behind after writing settings.json', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-tmp-'));
    try {
      store.set(SEED_KEY, seed);
      ensureWorkspaceScaffold(ws);
      expect(readdirSync(join(ws, '.claude')).some(n => n.includes('.tmp'))).toBe(false);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a failed settings.json write leaves nothing behind and throws', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws-fail-'));
    const failingWriter: AtomicWriter = {
      writeFile: (path, content) => writeFileSync(path, content),
      rename: () => { throw new Error('rename failed on purpose'); },
    };
    try {
      store.set(SEED_KEY, seed);
      expect(() => ensureWorkspaceScaffold(ws, failingWriter)).toThrow('on purpose');
      expect(existsSync(join(ws, '.claude', 'settings.json'))).toBe(false);
      expect(readdirSync(join(ws, '.claude')).some(n => n.includes('.tmp'))).toBe(false);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('registerWorkspace', () => {
  it('adds the path, dedups, and scaffolds', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws4-'));
    try {
      store.set(SEED_KEY, seed);
      const r = registerWorkspace(ws);
      expect(r.path).toBe(resolve(ws));
      expect(r.scaffolded.length).toBe(3);
      expect(getWorkspaces().paths).toContain(resolve(ws));
      registerWorkspace(ws); // dedup
      expect(getWorkspaces().paths.filter(p => p === resolve(ws)).length).toBe(1);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('un-declines a previously declined path', () => {
    const seed = makeSeed();
    const ws = mkdtempSync(join(tmpdir(), 'sh-ws5-'));
    try {
      store.set(SEED_KEY, seed);
      declineWorkspace(ws);
      expect(isDeclinedPath(ws)).toBe(true);
      registerWorkspace(ws);
      expect(getWorkspaces().declined).not.toContain(resolve(ws));
      expect(isDeclinedPath(ws)).toBe(false);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('active feature', () => {
  const sample = {
    id: 100901,
    title: 'Declarative CD',
    folderPath: '/w/space/100901-declarative-cd',
    setAt: '2026-07-16T10:00:00.000Z',
  };

  it('returns null when unset', () => {
    expect(getActiveFeature()).toBeNull();
  });

  it('set then get round-trips the record', () => {
    setActiveFeature(sample);
    expect(getActiveFeature()).toEqual(sample);
  });

  it('set overwrites the previous active feature (overwrite is the switch)', () => {
    setActiveFeature(sample);
    const next = { id: 100909, title: 'Other', folderPath: '/w/space/100909-other', setAt: '2026-07-16T11:00:00.000Z' };
    setActiveFeature(next);
    expect(getActiveFeature()).toEqual(next);
  });

  it('clear resets to null', () => {
    setActiveFeature(sample);
    clearActiveFeature();
    expect(getActiveFeature()).toBeNull();
  });

  it('parses garbage as null (never throws)', () => {
    store.set(ACTIVE_FEATURE_KEY, '{not json');
    expect(getActiveFeature()).toBeNull();
  });

  it('parses a non-object / wrong-shape value as null', () => {
    store.set(ACTIVE_FEATURE_KEY, JSON.stringify([1, 2, 3]));
    expect(getActiveFeature()).toBeNull();
    store.set(ACTIVE_FEATURE_KEY, JSON.stringify({ id: 'nope', title: 5 }));
    expect(getActiveFeature()).toBeNull();
  });
});
