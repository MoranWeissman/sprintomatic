import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRepoLink, writeRepoLink, findRepoRoot } from './repo-link';
import type { AtomicWriter } from './atomic-write';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'repo-link-'));
}

/** Make `<root>/.git/info` so exclude handling has somewhere to write. */
function makeGitRepo(root: string): void {
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
}

describe('readRepoLink', () => {
  it('returns null when there is no link file', () => {
    const root = tmp();
    expect(readRepoLink(root)).toBeNull();
  });

  it('reads a link file in the cwd itself', () => {
    const root = tmp();
    mkdirSync(join(root, '.sprintomatic'));
    writeFileSync(join(root, '.sprintomatic', 'link.json'),
      JSON.stringify({ features: [100901], stories: [] }));
    expect(readRepoLink(root)).toEqual({ features: [100901], stories: [], dir: root });
  });

  it('walks up from a subfolder to the repo root', () => {
    const root = tmp();
    makeGitRepo(root);
    mkdirSync(join(root, '.sprintomatic'));
    writeFileSync(join(root, '.sprintomatic', 'link.json'),
      JSON.stringify({ features: [1], stories: [2] }));
    const deep = join(root, 'src', 'components');
    mkdirSync(deep, { recursive: true });
    expect(readRepoLink(deep)).toEqual({ features: [1], stories: [2], dir: root });
  });

  it('stops at the git root — never picks up a parent link beyond .git', () => {
    const outer = tmp();
    mkdirSync(join(outer, '.sprintomatic'));
    writeFileSync(join(outer, '.sprintomatic', 'link.json'),
      JSON.stringify({ features: [99], stories: [] }));
    const inner = join(outer, 'child-repo');
    mkdirSync(inner, { recursive: true });
    makeGitRepo(inner);
    expect(readRepoLink(inner)).toBeNull();
  });

  it('rejects garbage: bad JSON, non-arrays, non-numbers', () => {
    const root = tmp();
    mkdirSync(join(root, '.sprintomatic'));
    const p = join(root, '.sprintomatic', 'link.json');
    writeFileSync(p, 'not json {');
    expect(readRepoLink(root)).toBeNull();
    writeFileSync(p, JSON.stringify({ features: 'x', stories: null }));
    expect(readRepoLink(root)).toEqual({ features: [], stories: [], dir: root });
    writeFileSync(p, JSON.stringify({ features: [1, 'two', -3, 4.5, 7], stories: [] }));
    expect(readRepoLink(root)!.features).toEqual([1, 7]);
  });

  it('drops zero and duplicate ids', () => {
    const root = tmp();
    mkdirSync(join(root, '.sprintomatic'));
    writeFileSync(join(root, '.sprintomatic', 'link.json'),
      JSON.stringify({ features: [0, 5, 5, 6], stories: [] }));
    expect(readRepoLink(root)!.features).toEqual([5, 6]);
  });

  it('returns null for a relative or empty path', () => {
    expect(readRepoLink('some/relative/path')).toBeNull();
    expect(readRepoLink('')).toBeNull();
  });

  it('terminates at the filesystem root and on trailing slashes', () => {
    expect(readRepoLink('/')).toBeNull();
    const root = tmp();
    mkdirSync(join(root, '.sprintomatic'));
    writeFileSync(join(root, '.sprintomatic', 'link.json'),
      JSON.stringify({ features: [8], stories: [] }));
    expect(readRepoLink(root + '///')!.features).toEqual([8]);
  });
});

describe('findRepoRoot', () => {
  it('finds the ancestor with .git', () => {
    const root = tmp();
    makeGitRepo(root);
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });

  it('falls back to the cwd itself when no .git anywhere', () => {
    const root = tmp();
    expect(findRepoRoot(root)).toBe(root);
  });

  it('refuses a relative or empty path instead of falling back to the server cwd', () => {
    expect(() => findRepoRoot('foo/bar')).toThrow(/full path/);
    expect(() => findRepoRoot('.')).toThrow(/full path/);
    expect(() => findRepoRoot('')).toThrow(/full path/);
  });
});

describe('writeRepoLink', () => {
  it('creates the folder and file inside a repo that exists', () => {
    const root = tmp();
    const res = writeRepoLink(root, { features: [100901] });
    expect(res.link).toEqual({ features: [100901], stories: [] });
    const onDisk = JSON.parse(readFileSync(join(root, '.sprintomatic', 'link.json'), 'utf8'));
    expect(onDisk).toEqual({ features: [100901], stories: [] });
  });

  it('merges with an existing link — a second feature never drops the first', () => {
    const root = tmp();
    writeRepoLink(root, { features: [1] });
    const res = writeRepoLink(root, { features: [2], stories: [10] });
    expect(res.link).toEqual({ features: [1, 2], stories: [10] });
  });

  it('is idempotent — same id twice stays one entry', () => {
    const root = tmp();
    writeRepoLink(root, { features: [5] });
    const res = writeRepoLink(root, { features: [5] });
    expect(res.link.features).toEqual([5]);
  });

  it('appends .sprintomatic/ to .git/info/exclude exactly once', () => {
    const root = tmp();
    makeGitRepo(root);
    const r1 = writeRepoLink(root, { features: [1] });
    expect(r1.excludeAdded).toBe(true);
    const r2 = writeRepoLink(root, { features: [2] });
    expect(r2.excludeAdded).toBe(false);
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.sprintomatic\//g)).toHaveLength(1);
  });

  it('never touches a committed .gitignore', () => {
    const root = tmp();
    makeGitRepo(root);
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    writeRepoLink(root, { features: [1] });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  it('.git as a plain file (worktree): no exclude, no crash', () => {
    const root = tmp();
    writeFileSync(join(root, '.git'), 'gitdir: /somewhere/else\n');
    const res = writeRepoLink(root, { features: [4] });
    expect(res.excludeAdded).toBe(false);
    expect(existsSync(join(root, '.sprintomatic', 'link.json'))).toBe(true);
  });

  it('never picks up a parent folder\'s ids when the target is not a git repo', () => {
    const outer = tmp();
    mkdirSync(join(outer, '.sprintomatic'));
    writeFileSync(join(outer, '.sprintomatic', 'link.json'),
      JSON.stringify({ features: [99], stories: [77] }));
    const inner = join(outer, 'plain-folder');
    mkdirSync(inner, { recursive: true });
    const res = writeRepoLink(inner, { features: [1] });
    expect(res.link).toEqual({ features: [1], stories: [] });
    const onDisk = JSON.parse(readFileSync(join(inner, '.sprintomatic', 'link.json'), 'utf8'));
    expect(onDisk).toEqual({ features: [1], stories: [] });
  });

  it('refuses a relative or empty path — no file written anywhere', () => {
    expect(() => writeRepoLink('foo/bar', { features: [1] })).toThrow(/full path/);
    expect(() => writeRepoLink('', { features: [1] })).toThrow(/full path/);
    expect(existsSync(join('foo', 'bar', '.sprintomatic'))).toBe(false);
  });

  it('refuses a folder that is not there — a typo must not build a new tree', () => {
    const root = tmp();
    const typo = join(root, 'infra-rpeo');
    expect(() => writeRepoLink(typo, { features: [1] })).toThrow(/no folder at/);
    expect(existsSync(typo)).toBe(false);
    expect(existsSync(join(typo, '.sprintomatic'))).toBe(false);
  });

  it('refuses a path that is a file, not a folder', () => {
    const root = tmp();
    const file = join(root, 'README.md');
    writeFileSync(file, 'hello\n');
    expect(() => writeRepoLink(file, { features: [1] })).toThrow(/no folder at/);
    expect(existsSync(join(file, '.sprintomatic'))).toBe(false);
  });

  it('non-git folder: file still written, no exclude, no crash', () => {
    const root = tmp();
    const res = writeRepoLink(root, { features: [3] });
    expect(res.excludeAdded).toBe(false);
    expect(existsSync(join(root, '.sprintomatic', 'link.json'))).toBe(true);
  });
});

describe('writeRepoLink is safe against a crash mid-write', () => {
  /** A writer whose rename never lands — stands in for a crash or a full disk
   *  after the temp file was written. */
  const failingWriter: AtomicWriter = {
    writeFile: (path, content) => writeFileSync(path, content),
    rename: () => { throw new Error('rename failed on purpose'); },
  };

  it('a normal write produces exactly the same file content as before', () => {
    const root = tmp();
    const res = writeRepoLink(root, { features: [100901], stories: [7] });
    const onDisk = readFileSync(join(root, '.sprintomatic', 'link.json'), 'utf8');
    expect(onDisk).toBe(`${JSON.stringify(res.link, null, 2)}\n`);
  });

  it('leaves no temp file behind after a normal write', () => {
    const root = tmp();
    makeGitRepo(root);
    writeRepoLink(root, { features: [1] });
    expect(readdirSync(join(root, '.sprintomatic')).some(n => n.includes('.tmp'))).toBe(false);
    expect(readdirSync(join(root, '.git', 'info')).some(n => n.includes('.tmp'))).toBe(false);
  });

  it('a failed write leaves the link file already on disk exactly as it was', () => {
    const root = tmp();
    writeRepoLink(root, { features: [1] });
    const linkPath = join(root, '.sprintomatic', 'link.json');
    const before = readFileSync(linkPath, 'utf8');

    expect(() => writeRepoLink(root, { features: [2] }, failingWriter)).toThrow('on purpose');

    expect(readFileSync(linkPath, 'utf8')).toBe(before);
    expect(readRepoLink(root)!.features).toEqual([1]);
    expect(readdirSync(join(root, '.sprintomatic')).some(n => n.includes('.tmp'))).toBe(false);
  });

  it('a failed exclude write leaves .git/info/exclude already on disk exactly as it was', () => {
    const root = tmp();
    makeGitRepo(root);
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'node_modules\n');

    // Writes to link.json go through fine; only the rename onto the exclude
    // file fails, standing in for a crash right at that point. ensureGitExclude
    // swallows its own errors, so writeRepoLink must not throw either.
    const excludeOnlyFailingWriter: AtomicWriter = {
      writeFile: (path, content) => writeFileSync(path, content),
      rename: (from, to) => {
        if (to.endsWith(join('.git', 'info', 'exclude'))) throw new Error('exclude rename failed on purpose');
        renameSync(from, to);
      },
    };
    const res = writeRepoLink(root, { features: [1] }, excludeOnlyFailingWriter);

    expect(res.excludeAdded).toBe(false);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe('node_modules\n');
    expect(readdirSync(join(root, '.git', 'info')).some(n => n.includes('.tmp'))).toBe(false);
  });
});

describe('git exclude handling stays idempotent', () => {
  it('running writeRepoLink twice never adds the exclude line twice', () => {
    const root = tmp();
    makeGitRepo(root);
    writeRepoLink(root, { features: [1] });
    writeRepoLink(root, { features: [2] });
    writeRepoLink(root, { features: [3] });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.sprintomatic\//g)).toHaveLength(1);
  });
});
