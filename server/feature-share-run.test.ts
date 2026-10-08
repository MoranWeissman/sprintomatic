import { describe, it, expect } from 'vitest';
import { runFeatureShare, ShareRefused, type ShareDeps } from './feature-share-run';

/** An answer can be fixed text, an error to throw, or a function of how many
 *  times that same answer was already used (0 the first time). */
type Answer = string | Error | ((callIndex: number) => string);

/** A fake git that answers from a script; records every call. */
function fakeGit(answers: Record<string, Answer>) {
  const calls: string[][] = [];
  const used: Record<string, number> = {};
  const git = async (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    if (!hit) return '';
    const [k, answer] = hit;
    const n = used[k] ?? 0;
    used[k] = n + 1;
    if (typeof answer === 'function') return answer(n);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { git, calls };
}

/** git rejects with an Error carrying the exit code; 1 from `diff --cached
 *  --quiet` means "there ARE staged changes". */
const exit = (code: number, msg = `exit ${code}`) => Object.assign(new Error(msg), { code });

/** rev-parse says main first (before the switch), then the branch we asked for. */
const headThen = (name: string) => (n: number) => (n === 0 ? 'main' : name);

function deps(over: Partial<ShareDeps> & { git: ShareDeps['git'] }): ShareDeps {
  return {
    gh: async () => { throw new Error('no gh'); },
    listFilesRecursive: () => ['discovery/discovery.md', 'discovery/discovery.json', 'sources/x.vtt'],
    listDirs: () => ['github-cd-100901'],
    copyFile: () => 'updated',
    isDir: () => true,
    now: () => new Date('2026-08-17T10:00:00Z'),
    ...over,
  };
}

const input = { id: 100901, featureFolderPath: '/ws/100901-declarative-cd', docsRepoPath: '/docs', docsSubdir: 'docs/team', confirmPush: true };

describe('runFeatureShare guards', () => {
  it('refuses when the docs repo has uncommitted changes, before any write', async () => {
    const { git, calls } = fakeGit({ 'status --porcelain': ' M docs/x.md' });
    let copied = 0;
    await expect(runFeatureShare(input, deps({ git, copyFile: () => { copied++; return 'added'; } })))
      .rejects.toBeInstanceOf(ShareRefused);
    expect(copied).toBe(0);
    expect(calls.some(c => c[0] === 'checkout' || c[0] === 'commit' || c[0] === 'push')).toBe(false);
  });

  it('refuses if it would still be on main after the branch step', async () => {
    // current=main, no matching branches, and `checkout -b` silently "works" but
    // rev-parse still says main → the guard must catch it.
    const { git } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'main',
      'branch --format': 'main',
      'branch -r --format': 'origin/main',
    });
    await expect(runFeatureShare(input, deps({ git }))).rejects.toBeInstanceOf(ShareRefused);
  });

  it('refuses when the docs repo path is not a git repo', async () => {
    const { git } = fakeGit({});
    await expect(runFeatureShare(input, deps({ git, isDir: (p) => !p.endsWith('/.git') })))
      .rejects.toBeInstanceOf(ShareRefused);
  });
});

describe('runFeatureShare happy path (fake git)', () => {
  it('stays on the feature branch, copies only shareable files, commits, pushes, and returns a compare url when gh is missing', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'discovery-100901',
      'branch --format': 'main\ndiscovery-100901',
      'branch -r --format': 'origin/main\norigin/discovery-100901',
      'diff --cached --quiet': exit(1),   // = there ARE staged changes
      'commit -m': '',
      'rev-parse HEAD': 'abc1234',
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    const copied: string[] = [];
    const r = await runFeatureShare(input, deps({
      git,
      copyFile: (from, to) => { copied.push(to); return 'updated'; },
    }));
    expect(copied).toEqual(['/docs/docs/team/github-cd-100901/discovery/discovery.md']);
    expect(r.branch).toEqual({ name: 'discovery-100901', how: 'stayed' });
    expect(r.commit).toBe('abc1234');
    expect(r.pushed).toBe(true);
    expect(r.pr).toEqual({ compareUrl: 'https://github.com/o/r/compare/discovery-100901?expand=1' });
    expect(calls.some(c => c[0] === 'push' && c.includes('--force'))).toBe(false);
    expect(calls.some(c => c[0] === 'add' && c[1] === 'docs/team/github-cd-100901')).toBe(true);
    expect(calls.some(c => c[0] === 'commit')).toBe(true);
  });

  it('reports already up to date and does not commit or push when nothing changed', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'discovery-100901',
      'branch --format': 'discovery-100901',
      'branch -r --format': '',
      'diff --cached --quiet': '',           // exit 0 = nothing staged
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    const r = await runFeatureShare(input, deps({ git, copyFile: () => 'unchanged' }));
    expect(r.commit).toBeNull();
    expect(r.pushed).toBe(false);
    expect(calls.some(c => c[0] === 'commit' || c[0] === 'push')).toBe(false);
    expect(r.notes.join(' ')).toMatch(/already up to date/i);
  });

  it('the preview decides but writes nothing', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'main',
      'branch --format': 'main',
      'branch -r --format': 'origin/main',
    });
    let copied = 0;
    const r = await runFeatureShare({ ...input, confirmPush: false }, deps({ git, copyFile: () => { copied++; return 'added'; } }));
    expect(copied).toBe(0);
    expect(r.branch).toEqual({ name: 'feature-100901', how: 'would-use' });
    expect(r.commit).toBeNull();
    // A fetch is fine (it only refreshes the remote view); nothing else may run.
    expect(calls.some(c => ['checkout', 'add', 'commit', 'push'].includes(c[0]))).toBe(false);
  });

  it('writes nothing when nobody said yes at all (confirmPush left out)', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'main',
      'branch --format': 'main',
      'branch -r --format': 'origin/main',
    });
    let copied = 0;
    const { confirmPush: _drop, ...noAnswer } = input;
    const r = await runFeatureShare(noAnswer, deps({ git, copyFile: () => { copied++; return 'added'; } }));
    expect(copied).toBe(0);
    expect(r.commit).toBeNull();
    expect(r.pushed).toBe(false);
    expect(calls.some(c => ['checkout', 'add', 'commit', 'push'].includes(c[0]))).toBe(false);
  });

  it('fetches origin BEFORE listing branches so a teammate\'s new branch is seen', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'discovery-100901',
      'branch --format': 'discovery-100901',
      'branch -r --format': '',
      'diff --cached --quiet': '',
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    await runFeatureShare(input, deps({ git, copyFile: () => 'unchanged' }));
    const fetchAt = calls.findIndex(c => c[0] === 'fetch');
    const branchAt = calls.findIndex(c => c[0] === 'branch');
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(branchAt);
  });

  it('keeps going from the local view when the fetch fails (offline), and says so', async () => {
    const { git } = fakeGit({
      'status --porcelain': '',
      'fetch origin': new Error('could not resolve host'),
      'rev-parse --abbrev-ref HEAD': 'discovery-100901',
      'branch --format': 'discovery-100901',
      'branch -r --format': '',
      'diff --cached --quiet': '',
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    const r = await runFeatureShare(input, deps({ git, copyFile: () => 'unchanged' }));
    expect(r.notes.join(' ')).toMatch(/couldn't reach origin/i);
  });

  it('refuses when the feature folder has nothing shareable, before any git write', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'discovery-100901',
      'branch --format': 'discovery-100901',
      'branch -r --format': '',
    });
    await expect(runFeatureShare(input, deps({ git, listFilesRecursive: () => ['discovery/discovery.json', 'sources/x.vtt'] })))
      .rejects.toThrow(/nothing shareable/i);
    expect(calls.some(c => ['add', 'commit', 'push'].includes(c[0]))).toBe(false);
  });
});

describe('runFeatureShare branch paths', () => {
  it('checks out an existing local branch, without fetching', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': headThen('feature-100901-x'),
      'branch --format': 'main\nfeature-100901-x',
      'branch -r --format': 'origin/main',
      'diff --cached --quiet': '',
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    await runFeatureShare(input, deps({ git, copyFile: () => 'unchanged' }));
    expect(calls.filter(c => c[0] === 'checkout')).toEqual([['checkout', 'feature-100901-x']]);
    // exactly one fetch — the up-front refresh — none inside the checkout arm
    expect(calls.filter(c => c[0] === 'fetch')).toEqual([['fetch', 'origin']]);
  });

  it('fetches then tracks a branch that only exists on origin', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': headThen('discovery-100901'),
      'branch --format': 'main',
      'branch -r --format': 'origin/main\norigin/discovery-100901',
      'diff --cached --quiet': '',
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    await runFeatureShare(input, deps({ git, copyFile: () => 'unchanged' }));
    const seq = calls.filter(c => c[0] === 'fetch' || c[0] === 'checkout');
    expect(seq).toEqual([['fetch', 'origin'], ['checkout', '--track', 'origin/discovery-100901']]);
  });

  it('fetches then creates a new branch off origin/main when nothing matches', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': headThen('feature-100901'),
      'branch --format': 'main',
      'branch -r --format': 'origin/main',
      'diff --cached --quiet': '',
      'remote get-url origin': 'git@github.com:o/r.git',
    });
    await runFeatureShare(input, deps({ git, copyFile: () => 'unchanged' }));
    const seq = calls.filter(c => c[0] === 'fetch' || c[0] === 'checkout');
    expect(seq).toEqual([['fetch', 'origin'], ['checkout', '-b', 'feature-100901', 'origin/main']]);
  });

  it('refuses when HEAD landed on some other branch than the one we planned', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'some-other-branch',
      'branch --format': 'main',
      'branch -r --format': 'origin/main',
    });
    await expect(runFeatureShare(input, deps({ git }))).rejects.toBeInstanceOf(ShareRefused);
    expect(calls.some(c => ['add', 'commit', 'push'].includes(c[0]))).toBe(false);
  });

  it('ignores branches on remotes other than origin', async () => {
    const { git } = fakeGit({
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'main',
      'branch --format': 'main',
      'branch -r --format': 'upstream/discovery-100901\norigin/main',
    });
    const r = await runFeatureShare({ ...input, confirmPush: false }, deps({ git }));
    expect(r.branch).toEqual({ name: 'feature-100901', how: 'would-use' });
  });
});

describe('runFeatureShare push and pull request', () => {
  const pushable = {
    'status --porcelain': '',
    'rev-parse --abbrev-ref HEAD': 'discovery-100901',
    'branch --format': 'discovery-100901',
    'branch -r --format': '',
    'diff --cached --quiet': exit(1),
    'commit -m': '',
    'rev-parse HEAD': 'abc1234',
    'remote get-url origin': 'git@github.com:o/r.git',
  } satisfies Record<string, Answer>;

  it('keeps the report when the push fails, and says the commit is still there', async () => {
    const { git } = fakeGit({ ...pushable, push: new Error('fatal: could not read Username\nmore noise') });
    const r = await runFeatureShare(input, deps({ git }));
    expect(r.pushed).toBe(false);
    expect(r.commit).toBe('abc1234');
    expect(r.notes.join(' ')).toMatch(/push failed/i);
    expect(r.pr).toEqual({ compareUrl: 'https://github.com/o/r/compare/discovery-100901?expand=1' });
  });

  it('returns the pull request that already exists and never tries to create one', async () => {
    const { git } = fakeGit(pushable);
    const ghCalls: string[][] = [];
    const r = await runFeatureShare(input, deps({
      git,
      gh: async (args) => {
        ghCalls.push(args);
        return args[1] === 'list' ? 'https://github.com/o/r/pull/7' : '';
      },
    }));
    expect(r.pr).toEqual({ url: 'https://github.com/o/r/pull/7', existed: true });
    expect(ghCalls.some(c => c[1] === 'create')).toBe(false);
  });

  it('pulls the url out of the gh pr create chatter', async () => {
    const { git } = fakeGit(pushable);
    const r = await runFeatureShare(input, deps({
      git,
      gh: async (args) => (args[1] === 'list' ? '' : 'Creating pull request…\nhttps://github.com/o/r/pull/12\n'),
    }));
    expect(r.pr).toEqual({ url: 'https://github.com/o/r/pull/12', existed: false });
  });

  it("treats gh's literal 'null' (no PR) as no PR and creates one", async () => {
    const { git } = fakeGit(pushable);
    const ghCalls: string[][] = [];
    const r = await runFeatureShare(input, deps({
      git,
      gh: async (args) => {
        ghCalls.push(args);
        return args[1] === 'list' ? 'null\n' : 'https://github.com/o/r/pull/13\n';
      },
    }));
    expect(r.pr).toEqual({ url: 'https://github.com/o/r/pull/13', existed: false });
    expect(ghCalls.some(c => c[1] === 'create')).toBe(true);
  });

  it('refuses with a cleanup hint when a copy fails half-way, before any add/commit/push', async () => {
    const { git, calls } = fakeGit(pushable);
    let n = 0;
    await expect(runFeatureShare(input, deps({
      git,
      listFilesRecursive: () => ['discovery/discovery.md', 'design/design.md'],
      copyFile: () => { if (++n === 2) throw new Error('disk full'); return 'added'; },
    }))).rejects.toThrow(/docs\/team\/github-cd-100901.*git checkout --/s);
    expect(calls.some(c => ['add', 'commit', 'push'].includes(c[0]))).toBe(false);
  });
});
