/**
 * Story matching (slice R7a).
 *
 * Given a chat's working-directory context (cwd, optional git remote, recent
 * commit subjects, recent files), score current-sprint stories by keyword
 * overlap and return ranked candidates plus a strong-match flag.
 *
 * Also persists learned cwd→story mappings per sprint so a repeat chat in
 * the same repo doesn't re-litigate the match.
 *
 * Pure logic + a thin settings-table wrapper. No ADO. No network.
 */
import { displayNameFor } from './display-name';
import { getSetting, setSetting } from './timers';

const STOPWORDS = new Set([
  'the','and','for','from','with','into','onto','that','this','these','those',
  'are','was','were','have','has','had','can','could','will','would','should',
  'add','use','run','get','set','put',
  'about','after','before','also','here','there','when','what','where','which',
  'over','under','out','off','any','all','some','one','two',
]);

const MIN_TOKEN_LEN = 3;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

function pathBasename(p: string): string {
  const parts = p.split(/[/\\]/).filter(s => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

function gitRemoteName(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const stripped = remote.replace(/\.git$/, '').replace(/\/$/, '');
  const parts = stripped.split(/[/:]/);
  return parts[parts.length - 1];
}

export interface MatchContext {
  /** Absolute cwd of the chat. Basename is the strongest signal. */
  cwd: string;
  /** Optional git remote URL or short name. */
  gitRemote?: string;
  /** Recent commit subject lines, newest first. Bounded to ~10. */
  recentCommits?: string[];
  /** Recent file paths the chat has touched. Basenames are used. */
  recentFiles?: string[];
}

export interface SprintStory {
  storyId: number;
  title: string;
  /** Parent feature title if any — used as an extra title signal. */
  featureTitle?: string;
  /** Parent feature id if any — lets a repo's declared feature link boost its stories. */
  featureId?: number;
}

export interface ScoredStory {
  storyId: number;
  title: string;
  /** Pre-formatted `**title** (#id)` for the assistant to echo verbatim. */
  displayName: string;
  score: number;
  /** Tokens that contributed to the score (for transparency). */
  hitTokens: string[];
}

export interface MatchResult {
  /** Persisted match for this cwd in this sprint, if any. */
  learnedMatch: ScoredStory | null;
  /** Highest-scoring candidate that clears the confidence threshold. */
  topMatch: ScoredStory | null;
  /** Every story scored, sorted descending. The assistant can show this as alternatives. */
  allStories: ScoredStory[];
}

/* ------------------------------------------------------------------------ *
 * Persistence: learned cwd → story mappings, scoped per sprint.
 * ------------------------------------------------------------------------ */

function cwdKey(cwd: string, sprintName: string): string {
  const encoded = Buffer.from(cwd).toString('base64').replace(/[+/=]/g, '');
  return `cwd_story_${sprintName}_${encoded}`;
}

function getLearnedStoryId(cwd: string, sprintName: string): number | null {
  const raw = getSetting(cwdKey(cwd, sprintName));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setLearnedStoryId(cwd: string, sprintName: string, storyId: number): void {
  setSetting(cwdKey(cwd, sprintName), String(storyId));
}

export function clearLearnedStoryId(cwd: string, sprintName: string): void {
  setSetting(cwdKey(cwd, sprintName), '');
}

/* ------------------------------------------------------------------------ *
 * Scoring.
 * ------------------------------------------------------------------------ */

/** Flat lift for a story under a feature this repo declared. Big enough to
 *  clear the confidence threshold on its own when nothing else scores. */
const REPO_LINK_BOOST = 6;
const REPO_LINK_TOKEN = '(repo-link)';

export function matchStoryToContext(
  ctx: MatchContext,
  stories: SprintStory[],
  linkedFeatureIds: number[] = [],
  linkedStoryIds: number[] = [],
): Omit<MatchResult, 'learnedMatch'> {
  // Build a token weight map from the context.
  const ctxTokens = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) {
      const prev = ctxTokens.get(t) ?? 0;
      if (weight > prev) ctxTokens.set(t, weight);
    }
  };

  add(pathBasename(ctx.cwd), 3);
  const remoteShort = gitRemoteName(ctx.gitRemote);
  if (remoteShort) add(remoteShort, 2);
  for (const c of ctx.recentCommits ?? []) add(c, 2);
  for (const f of ctx.recentFiles ?? []) add(pathBasename(f), 1);

  const scored: ScoredStory[] = stories.map(s => {
    const titleTokens = new Set<string>();
    for (const t of tokenize(s.title)) titleTokens.add(t);
    if (s.featureTitle) {
      for (const t of tokenize(s.featureTitle)) titleTokens.add(t);
    }
    let score = 0;
    const hits: string[] = [];
    for (const t of titleTokens) {
      const w = ctxTokens.get(t);
      if (w) {
        score += w;
        hits.push(t);
      }
    }
    // A repo that SAID which feature it serves (.sprintomatic/link.json)
    // beats guessing from words. The user told us; the words only hint.
    // Same for a story the repo named directly, when there is no feature
    // above it. One boost only — a story listed both ways isn't twice as sure.
    if (
      (s.featureId != null && linkedFeatureIds.includes(s.featureId))
      || linkedStoryIds.includes(s.storyId)
    ) {
      score += REPO_LINK_BOOST;
      hits.push(REPO_LINK_TOKEN);
    }
    return {
      storyId: s.storyId,
      title: s.title,
      displayName: displayNameFor(s.storyId, s.title),
      score,
      hitTokens: hits,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  // Confidence threshold — pick "topMatch" when one of:
  //   - top.score >= 5 AND top.score >= 1.5 × next.score   (clean ratio)
  //   - top.score >= 8 AND (top.score - next.score) >= 2   (large absolute gap)
  // The 1.5× rule alone misses cases like 18 vs 16 where the top is clearly
  // ahead in absolute terms but the ratio is small because both candidates
  // share many domain tokens (e.g. "checkout", "service", "prod"). Showing
  // alternatives is the user-side escape valve in either case.
  let topMatch: ScoredStory | null = null;
  const top = scored[0];
  const next = scored[1];
  if (top) {
    const nextScore = next?.score ?? 0;
    const cleanRatio = top.score >= 5 && (next == null || top.score >= nextScore * 1.5);
    const absoluteGap = top.score >= 8 && (top.score - nextScore) >= 2;
    if (cleanRatio || absoluteGap) topMatch = top;
  }

  return { topMatch, allStories: scored };
}

/* ------------------------------------------------------------------------ *
 * Public entry — combines learned lookup + heuristic match.
 * ------------------------------------------------------------------------ */

export function resolveStoryMatch(
  ctx: MatchContext,
  sprintName: string,
  stories: SprintStory[],
  linkedFeatureIds: number[] = [],
  linkedStoryIds: number[] = [],
): MatchResult {
  const learnedId = getLearnedStoryId(ctx.cwd, sprintName);
  const learnedMatch: ScoredStory | null = (() => {
    if (!learnedId) return null;
    const found = stories.find(s => s.storyId === learnedId);
    if (!found) return null;
    return {
      storyId: found.storyId,
      title: found.title,
      displayName: displayNameFor(found.storyId, found.title),
      score: 999,
      hitTokens: ['(learned)'],
    };
  })();

  const { topMatch, allStories } = matchStoryToContext(
    ctx, stories, linkedFeatureIds, linkedStoryIds,
  );
  return { learnedMatch, topMatch, allStories };
}
