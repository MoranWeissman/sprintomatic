/**
 * Sprint guardrail — keeps the user aligned with their sprint by checking each new
 * stretch of work against the current sprint's backlog.
 *
 * Flow:
 *   1. Claude Code starts working on something and calls `sprintCheckIn(desc)`.
 *   2. We fuzzy-match `desc` against the user's current-sprint titles + parent
 *      titles.
 *   3. Return matches sorted by confidence + a `nextStep` instruction the LLM
 *      can act on:
 *        - 'confirm_match': one strong candidate, ask the user to confirm.
 *        - 'choose_match': multiple plausible candidates, ask which.
 *        - 'no_match': nothing in the sprint — ask if it's ad-hoc or needs a
 *          new story, then call task_create.
 *
 * The actual task creation is in writes.ts (`createTask`). This module is
 * pure: it never writes.
 */
import { getCurrentIteration, getMyWorkItems, type WorkItem } from './ado';

export interface CheckInMatch {
  workItemId: number;
  title: string;
  type: string;
  state: string;
  parentTitle?: string;
  /** 0-1, higher is better. */
  score: number;
}

export interface CheckInResult {
  description: string;
  matches: CheckInMatch[];
  /** What the LLM should do next. */
  nextStep: 'confirm_match' | 'choose_match' | 'no_match';
  guidance: string;
}

/**
 * Threshold tuning. These were picked by eye against a few sprint backlogs;
 * adjust if matches feel too loose or too strict.
 */
const STRONG_MATCH = 0.6;
const PLAUSIBLE_MATCH = 0.25;

/** Common English words we strip before scoring — pure noise for matching. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'have', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'over', 'so',
  'than', 'that', 'the', 'this', 'to', 'too', 'was', 'were', 'will',
  'with', 'do', 'doing', 'work', 'working', 'task', 'story', 'm', 's',
  'about', 'into', 'now', 'today', 'just', 'need', 'want', 'wanna',
]);

export async function sprintCheckIn(description: string): Promise<CheckInResult> {
  const trimmed = description.trim();
  if (!trimmed) {
    return {
      description: trimmed,
      matches: [],
      nextStep: 'no_match',
      guidance: 'Empty description — ask the user what they want to work on.',
    };
  }

  const iteration = await getCurrentIteration();
  if (!iteration) {
    return {
      description: trimmed,
      matches: [],
      nextStep: 'no_match',
      guidance:
        'No active sprint found. Ask the user whether to wait for the next sprint to start or create an ad-hoc task anyway.',
    };
  }

  const items = await getMyWorkItems(iteration.path);
  const descTokens = tokenize(trimmed);
  if (descTokens.size === 0) {
    return {
      description: trimmed,
      matches: [],
      nextStep: 'no_match',
      guidance: 'Description had only stopwords — ask the user for a few more specific words.',
    };
  }

  const scored = items
    .map(w => ({ item: w, score: scoreMatch(descTokens, trimmed, w) }))
    .filter(({ score }) => score >= PLAUSIBLE_MATCH)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const matches: CheckInMatch[] = scored.map(({ item, score }) => ({
    workItemId: item.id,
    title: item.title,
    type: item.type,
    state: item.state,
    parentTitle: item.parentTitle,
    score: round3(score),
  }));

  if (matches.length === 0) {
    return {
      description: trimmed,
      matches,
      nextStep: 'no_match',
      guidance:
        'Nothing in the current sprint looks like this. Ask the user: (a) is this a quick 1–2 hour thing (call `task_create` with `adHoc=true`), or (b) does it need a proper story they should think about first? Either way, get their input before creating.',
    };
  }

  if (matches[0].score >= STRONG_MATCH && (matches.length === 1 || matches[0].score - matches[1].score >= 0.15)) {
    const m = matches[0];
    return {
      description: trimmed,
      matches,
      nextStep: 'confirm_match',
      guidance: `Looks like task #${m.workItemId} "${m.title}". Confirm with the user this is what they're working on, then call \`session_start\` with workItemId=${m.workItemId}.`,
    };
  }

  const guidance =
    matches.length === 1
      ? `Possible match: #${matches[0].workItemId} "${matches[0].title}" — but the description isn't a clean fit. Ask the user if this is what they mean, or if it's actually something else. If none, call \`task_create\`.`
      : 'Multiple plausible matches in the current sprint. List them to the user and ask which one — or whether this is something else entirely. If none fit, call `task_create`.';
  return {
    description: trimmed,
    matches,
    nextStep: 'choose_match',
    guidance,
  };
}

/* ============================================================ */
/*  Scoring                                                      */
/* ============================================================ */

function scoreMatch(descTokens: Set<string>, descRaw: string, w: WorkItem): number {
  const titleTokens = tokenize(w.title);
  const parentTokens = w.parentTitle ? tokenize(w.parentTitle) : new Set<string>();

  // Token overlap, weighted: title is the primary signal, parent is supplementary.
  const titleOverlap = intersectionSize(descTokens, titleTokens);
  const parentOverlap = intersectionSize(descTokens, parentTokens);
  const overlap = titleOverlap + parentOverlap * 0.5;

  // Coverage: fraction of the description's significant tokens that appeared.
  const coverage = overlap / Math.max(descTokens.size, 1);

  // Title coverage: fraction of the title's tokens that the description hit.
  // This catches "short query against long title" cases.
  const titleCoverage = titleTokens.size > 0
    ? titleOverlap / titleTokens.size
    : 0;

  let score = coverage * 0.55 + titleCoverage * 0.45;

  // Substring boosts — exact phrase appearance is a strong signal.
  const titleLc = w.title.toLowerCase();
  const descLc = descRaw.toLowerCase();
  if (descLc.includes(titleLc) || titleLc.includes(descLc)) score += 0.3;

  return Math.min(1, score);
}

function tokenize(s: string): Set<string> {
  const tokens = s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
