/**
 * feature_share — the pure decisions. No fs, no git, no ADO here: what to
 * copy, which branch, which folder, what to write in the commit. The runner
 * (feature-share-run.ts) does the side effects against these answers.
 */

/** Two leading digits + dash: the story docs at the feature folder root. */
const STORY_DOC = /^\d{2}-[^/]+\.(md|html)$/;

const INCLUDE: RegExp[] = [
  /^discovery\/[^/]+\.md$/,
  /^discovery\/images\/.+/,
  /^discovery\/meetings\/[^/]+\.md$/,
  /^design\/[^/]+\.md$/,
  /^design\/[^/]+\.html$/,   // the design walkthrough; the template is excluded below
  /^design\/meetings\/[^/]+\.md$/,
  /^design\/diagrams\/[^/]+\.(svg|drawio)$/,
  /^demo\/[^/]+\.html$/,
  STORY_DOC,
];

/** Never shared, even if an include rule would match. */
const EXCLUDE: RegExp[] = [
  /^sources\//,
  /\.json$/,
  /\.bak(\b|[.-])/,
  /(^|\/)\.DS_Store$/,
  /-preview\.png$/,
  /^design\/walkthrough-template\.html$/,
  /^design\/build-walkthrough\.py$/,
];

/** Which files from a feature folder go to the team repo. Paths are relative
 *  to the feature folder, forward slashes. Order preserved, no dedupe. */
export function selectShareFiles(relPaths: string[]): string[] {
  return relPaths.filter(p =>
    !EXCLUDE.some(rx => rx.test(p)) && INCLUDE.some(rx => rx.test(p)),
  );
}

export type BranchPlan = {
  action: 'stay' | 'checkout-local' | 'track-remote' | 'create';
  name: string;
};

/** A branch "belongs" to a feature when the id appears as a whole number in
 *  its name — not glued to other digits (100901 must not match 4266). */
function nameHasId(name: string, id: number): boolean {
  return new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(name);
}

/** Which branch to work on in the docs repo. Local beats remote; nothing
 *  matching → create feature-<id>. `remote` names come WITHOUT `origin/`. */
export function pickFeatureBranch(a: {
  id: number; current: string; local: string[]; remote: string[];
}): BranchPlan {
  if (nameHasId(a.current, a.id)) return { action: 'stay', name: a.current };
  const local = a.local.find(b => nameHasId(b, a.id));
  if (local) return { action: 'checkout-local', name: local };
  const remote = a.remote.find(b => nameHasId(b, a.id));
  if (remote) return { action: 'track-remote', name: remote };
  return { action: 'create', name: `feature-${a.id}` };
}

/** Which folder under the docs folder holds this feature. An existing folder whose
 *  name ends in -<id> wins (a human may have named it); else <slug>-<id>. */
export function pickTargetFolder(a: {
  id: number; existingDirNames: string[]; featureFolderName: string;
}): { name: string; created: boolean } {
  const suffix = new RegExp(`(^|-)${a.id}$`);
  const existing = a.existingDirNames.find(n => suffix.test(n));
  if (existing) return { name: existing, created: false };
  const slug = a.featureFolderName.replace(new RegExp(`^${a.id}-?`), '');
  return { name: slug ? `${slug}-${a.id}` : `feature-${a.id}`, created: true };
}

export function commitMessage(id: number, dateIso: string): string {
  return `Update #${id} discovery + design docs from sprintomatic (${dateIso.slice(0, 10)})`;
}

/** GitHub compare page for a branch, from the origin URL. Null when the
 *  origin isn't a github.com URL we understand. */
export function compareUrl(originUrl: string, branch: string): string | null {
  const m = originUrl.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(branch)}?expand=1`;
}

export function isProtectedBranch(name: string): boolean {
  return name === 'main' || name === 'master';
}
