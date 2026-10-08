/**
 * feature_share — the runner. Sequences the steps against injected git/gh/fs
 * so the guards are testable with fakes. Every shell-out is array argv.
 *
 * Order (each stop is a ShareRefused with a plain-English reason):
 *   repo is a git repo → clean tree → pick + take the branch → never main →
 *   pick target folder → copy the shareable set → stage ONLY that folder →
 *   commit if anything changed → push (no force) → PR via gh or compare url.
 */
import { join } from 'node:path';
import {
  selectShareFiles, pickFeatureBranch, pickTargetFolder,
  commitMessage, compareUrl, isProtectedBranch,
} from './feature-share';

/** What a failed git/gh run rejects with. `code` is the process exit code when
 *  the caller knows it — some checks (`diff --cached --quiet`) mean different
 *  things for different codes, so 1 must not be read as "any failure". */
export interface GitError extends Error { code?: number }

export interface ShareDeps {
  /**
   * Run git with array argv in `cwd`; resolves raw stdout (callers trim); rejects on
   * non-zero exit with an Error that MAY carry `code` (the exit code).
   */
  git: (args: string[], cwd: string) => Promise<string>;
  /** Run gh the same way. Rejects if gh is missing or fails. */
  gh: (args: string[], cwd: string) => Promise<string>;
  /** List every file under `dir` recursively, as forward-slash paths relative to `dir`. */
  listFilesRecursive: (dir: string) => string[];
  /** Names of the immediate subdirectories of `dir` ([] if it doesn't exist). */
  listDirs: (dir: string) => string[];
  /** Copy one file, creating parent dirs. Returns 'added' | 'updated' | 'unchanged'. */
  copyFile: (from: string, to: string) => 'added' | 'updated' | 'unchanged';
  /** True if `path` exists and is a directory. */
  isDir: (path: string) => boolean;
  now: () => Date;
}

export interface ShareInput {
  id: number;
  featureFolderPath: string;
  docsRepoPath: string;
  /** Folder inside the docs repo that holds one folder per feature, like `docs/my-team`. */
  docsSubdir: string;
  /**
   * Real pushing is off unless this is exactly `true`. Anything else — false,
   * missing, undefined — only works out the plan and writes nothing. The
   * dangerous half needs an explicit yes here, not only at the tool call.
   */
  confirmPush?: boolean;
}

export interface ShareReport {
  repo: string;
  branch: { name: string; how: 'stayed' | 'checked-out' | 'tracked-remote' | 'created' | 'would-use' };
  targetFolder: { path: string; created: boolean };
  files: { added: string[]; updated: string[]; unchanged: string[] };
  commit: string | null;
  pushed: boolean;
  pr: { url: string; existed: boolean } | { compareUrl: string } | null;
  notes: string[];
}

export class ShareRefused extends Error {}

function lines(s: string): string[] {
  return s.split('\n').map(l => l.trim()).filter(Boolean);
}

/** The first line of whatever an error carries — git is chatty, one line is enough. */
function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0].trim() || 'no reason given';
}

export async function runFeatureShare(input: ShareInput, deps: ShareDeps): Promise<ShareReport> {
  const { id, featureFolderPath, docsRepoPath, docsSubdir } = input;
  // One place decides it, and it decides "no" unless told otherwise.
  const preview = input.confirmPush !== true;
  const git = (args: string[]) => deps.git(args, docsRepoPath);
  const notes: string[] = [];

  // 1. It must be a git repo.
  if (!deps.isDir(docsRepoPath) || !deps.isDir(join(docsRepoPath, '.git'))) {
    throw new ShareRefused(`${docsRepoPath} isn't a git repo (no .git folder). Check the docs repo path.`);
  }

  // 2. Clean tree — never sweep someone else's half-done work into our commit.
  const dirty = await git(['status', '--porcelain']);
  if (dirty.trim()) {
    throw new ShareRefused(
      `The docs repo at ${docsRepoPath} has uncommitted changes that aren't ours. Commit or stash them first, then ask again.`,
    );
  }

  // 3. Pick the branch.
  // Refresh the remote view first so a branch a teammate pushed is seen — and
  // so the preview and the real run that follows it can't disagree. Offline is
  // not fatal: fall back to what's on disk and say so.
  try { await git(['fetch', 'origin']); }
  catch { notes.push("Couldn't reach origin to refresh branches — decided from the local view."); }
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const local = lines(await git(['branch', '--format=%(refname:short)']));
  // Only origin counts. A branch on someone else's remote isn't ours to track.
  const remote = lines(await git(['branch', '-r', '--format=%(refname:short)']))
    .filter(b => b.startsWith('origin/'))
    .map(b => b.slice('origin/'.length))
    .filter(b => b !== 'HEAD');
  const plan = pickFeatureBranch({ id, current, local, remote });

  let how: ShareReport['branch']['how'];
  if (preview) {
    how = 'would-use';
  } else if (plan.action === 'stay') {
    how = 'stayed';
  } else if (plan.action === 'checkout-local') {
    await git(['checkout', plan.name]);
    how = 'checked-out';
  } else if (plan.action === 'track-remote') {
    await git(['checkout', '--track', `origin/${plan.name}`]);
    how = 'tracked-remote';
  } else {
    await git(['checkout', '-b', plan.name, 'origin/main']);
    how = 'created';
  }

  // 4. Never write on main/master. (Re-read HEAD — trust git, not our plan.)
  if (!preview) {
    const onNow = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (isProtectedBranch(onNow)) {
      throw new ShareRefused(`Still on ${onNow} after trying to switch to ${plan.name} — refusing to write straight on it.`);
    }
    if (onNow !== plan.name) {
      throw new ShareRefused(`Ended up on ${onNow} instead of ${plan.name} — refusing to write.`);
    }
  } else if (isProtectedBranch(plan.name)) {
    throw new ShareRefused(`Would end up on ${plan.name} — refusing.`);
  }

  // 5. Target folder.
  const subdirAbs = join(docsRepoPath, docsSubdir);
  const featureFolderName = featureFolderPath.split('/').filter(Boolean).pop() ?? String(id);
  const target = pickTargetFolder({ id, existingDirNames: deps.listDirs(subdirAbs), featureFolderName });
  const targetRel = `${docsSubdir}/${target.name}`;
  const targetAbs = join(docsRepoPath, targetRel);
  if (target.created) notes.push(`Created a new folder ${targetRel} — rename it once in the repo if you'd like a nicer name; next time it's found by the -${id} ending.`);

  // 6. Copy the shareable set.
  const wanted = selectShareFiles(deps.listFilesRecursive(featureFolderPath));
  if (wanted.length === 0) {
    throw new ShareRefused(
      `Nothing shareable in ${featureFolderPath} yet — no discovery/design markdown, diagrams, demo or walkthrough files. Write the docs first, then ask again.`,
    );
  }
  const files: ShareReport['files'] = { added: [], updated: [], unchanged: [] };
  if (preview) {
    files.added = wanted; // "would copy" — we don't know added vs updated without touching disk
    notes.push('This was the preview — nothing was written, checked out, committed, or pushed.');
    return {
      repo: docsRepoPath,
      branch: { name: plan.name, how },
      targetFolder: { path: targetAbs, created: target.created },
      files, commit: null, pushed: false, pr: null, notes,
    };
  }
  for (const rel of wanted) {
    try {
      const outcome = deps.copyFile(join(featureFolderPath, rel), join(targetAbs, rel));
      files[outcome].push(rel);
    } catch (e) {
      throw new ShareRefused(
        `Copying stopped at ${rel}: ${firstLine(e)}. The folder ${targetRel} in the docs repo may have some new files — `
        + `run \`git checkout -- ${targetRel}\` and \`git clean -fd ${targetRel}\` there, then ask again.`,
      );
    }
  }

  // 7. Stage ONLY our folder, commit if anything changed.
  await git(['add', targetRel]);
  // `diff --cached --quiet` exits 1 when something is staged. Any other
  // non-zero exit is a real git problem and must not read as "there's work".
  let staged = false;
  try {
    await git(['diff', '--cached', '--quiet']);
  } catch (e) {
    if ((e as GitError).code === 1) staged = true;
    else throw e;
  }
  let commit: string | null = null;
  let pushed = false;
  if (!staged) {
    notes.push('Already up to date — nothing new to share.');
  } else {
    await git(['commit', '-m', commitMessage(id, deps.now().toISOString())]);
    commit = (await git(['rev-parse', 'HEAD'])).trim();
    // A push can fail for reasons that have nothing to do with us (no network,
    // login expired). The commit is already safe on disk, so say so and carry
    // on — losing the whole report here would hide that work.
    try {
      await git(['push', '-u', 'origin', plan.name]);
      pushed = true;
    } catch (e) {
      notes.push(
        `The commit ${commit.slice(0, 7)} is made on branch ${plan.name} but the push failed: ${firstLine(e)}. `
        + 'Push it by hand or ask again once the connection/login is fixed.',
      );
    }
  }

  // 8. PR: gh if it works, else the compare link.
  // A failing origin lookup must not throw away a report that already says
  // "committed + pushed" — degrade to "no link" instead.
  let origin = '';
  try { origin = (await git(['remote', 'get-url', 'origin'])).trim(); } catch { /* no link, note below */ }
  const fallback = (): ShareReport['pr'] => {
    const cu = compareUrl(origin, plan.name);
    if (cu) return { compareUrl: cu };
    notes.push("Couldn't open a pull request and couldn't build a compare link from the origin URL.");
    return null;
  };
  let pr: ShareReport['pr'];
  try {
    const listed = (await deps.gh(['pr', 'list', '--head', plan.name, '--json', 'url', '--jq', '.[0].url'], docsRepoPath)).trim();
    // `--jq '.[0].url'` prints the literal text "null" when there's no PR.
    if (listed.startsWith('http')) {
      pr = { url: listed, existed: true };
    } else if (pushed) {
      const created = await deps.gh([
        'pr', 'create', '--head', plan.name,
        '--title', `#${id} — discovery + design docs`,
        '--body', `Discovery, design and demo docs for feature #${id}, in ${targetRel}. Pushed by sprintomatic.`,
      ], docsRepoPath);
      const url = created.match(/https:\/\/\S+/)?.[0];
      pr = url ? { url, existed: false } : fallback();
    } else {
      pr = fallback();
    }
  } catch {
    pr = fallback();
  }

  return {
    repo: docsRepoPath,
    branch: { name: plan.name, how },
    targetFolder: { path: targetAbs, created: target.created },
    files, commit, pushed, pr, notes,
  };
}
