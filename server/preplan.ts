/**
 * Pre-plan page — pure logic + payload builder + local state I/O.
 *
 * This page is the user's PRIVATE prep for the bi-weekly pre-plan meeting. Nothing
 * here writes to Azure DevOps. Calls/goals/links live in the settings table.
 * See docs/superpowers/specs/2026-06-25-preplan-page-design.md.
 */

import { getSetting, setSetting } from './timers';
import { buildDashboardCached } from './dashboard-cache';
import { displayNameFor } from './display-name';
import type { UserStoryGroup } from './dashboard';
import { isActiveState, isBlockedState, isDoneState } from './states';
import { getWorkingDays } from './user-config';

export type PrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface PrePlanGoal {
  text: string;
  owner: string | null;
  isMine: boolean;
}

export interface PrePlanCard {
  id: string;
  displayName: string;
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null;
  call: PrePlanCall;
  callIsSuggested: boolean;
  goalIndex: number | null;
}

export interface PrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;
  hasCapacity: boolean;
}

export interface PrePlanCoverageGoal {
  index: number;
  text: string;
  storyCount: number;
}

export interface PrePlanPayload {
  sprintName: string;
  goals: PrePlanGoal[];
  cards: PrePlanCard[];
  coverage: PrePlanCoverageGoal[];
  room: PrePlanRoomLine;
}

export interface PrePlanState {
  goals: PrePlanGoal[];
  stories: Record<string, { call?: PrePlanCall; goalIndex?: number | null }>;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const IDLE_WORKING_DAYS_THRESHOLD = 3;

/** Working days elapsed from `from` to `to`. Days off in the configured week are skipped. */
export function workingDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  const workingDays = getWorkingDays();
  let count = 0;
  // Walk whole days from the day after `from` through `to`.
  const cursor = new Date(from.getTime());
  while (cursor.getTime() < to.getTime()) {
    cursor.setTime(cursor.getTime() + MS_PER_DAY);
    if (workingDays.has(cursor.getDay())) count++;
  }
  return count;
}

/**
 * Suggest a call from facts the page can read honestly on ONE story. Never
 * returns 'carries-over' (a deliberate planning act, not a guess) and never
 * uses sprint-wide room (shared across stories — see the spec).
 */
export function suggestCall(opts: {
  blocked: boolean;
  lastActivityAt: string | null;
  remainingHours: number;
  now: Date;
  idleWorkingDaysThreshold?: number;
}): 'on-track' | 'at-risk' {
  const threshold = opts.idleWorkingDaysThreshold ?? IDLE_WORKING_DAYS_THRESHOLD;
  if (opts.blocked) return 'at-risk';
  if (opts.remainingHours <= 0) return 'on-track';
  if (opts.lastActivityAt == null) return 'at-risk'; // hours remain, nothing logged
  const idle = workingDaysBetween(new Date(opts.lastActivityAt), opts.now);
  return idle >= threshold ? 'at-risk' : 'on-track';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'from', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'we', 'our',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/**
 * Suggest which pasted goal a story serves, by token overlap. Returns null when
 * the best overlap is weak — a wrong link is worse than none (suggest-then-confirm).
 */
export function suggestGoalIndex(storyTitle: string, goals: PrePlanGoal[]): number | null {
  if (goals.length === 0) return null;
  const titleTokens = tokenize(storyTitle);
  if (titleTokens.size === 0) return null;
  let bestIdx = -1;
  let bestOverlap = 0;
  goals.forEach((g, i) => {
    const gTokens = tokenize(g.text);
    let overlap = 0;
    for (const t of gTokens) if (titleTokens.has(t)) overlap++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = i;
    }
  });
  // Require at least 2 shared meaningful words to call it a match.
  return bestOverlap >= 2 ? bestIdx : null;
}

/** Per-goal story counts, in goal order. Empty when there are no goals. */
export function summarizeCoverage(
  cards: Array<{ goalIndex: number | null }>,
  goals: PrePlanGoal[],
): PrePlanCoverageGoal[] {
  return goals.map((g, index) => ({
    index,
    text: g.text,
    storyCount: cards.filter(c => c.goalIndex === index).length,
  }));
}

export function prePlanSettingsKey(sprintName: string): string {
  return `preplan_${sprintName}`;
}

/**
 * Coerce stored goals into PrePlanGoal[]. Accepts the legacy `string[]` shape
 * (each string → {text, owner:null, isMine:false}) and partial/full records.
 * Drops entries with empty text. Anything not an array → [].
 */
export function normalizeGoals(raw: unknown): PrePlanGoal[] {
  if (!Array.isArray(raw)) return [];
  const out: PrePlanGoal[] = [];
  for (const g of raw) {
    if (typeof g === 'string') {
      const text = g.trim();
      if (text) out.push({ text, owner: null, isMine: false });
    } else if (g && typeof g === 'object' && typeof (g as { text?: unknown }).text === 'string') {
      const text = (g as { text: string }).text.trim();
      if (!text) continue;
      const owner = (g as { owner?: unknown }).owner;
      out.push({
        text,
        owner: typeof owner === 'string' && owner.trim() ? owner.trim() : null,
        isMine: (g as { isMine?: unknown }).isMine === true,
      });
    }
  }
  return out;
}

export function getPrePlanState(sprintName: string): PrePlanState {
  const raw = getSetting(prePlanSettingsKey(sprintName));
  if (!raw) return { goals: [], stories: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<PrePlanState>;
    return {
      goals: normalizeGoals(parsed.goals),
      stories: parsed.stories && typeof parsed.stories === 'object' ? parsed.stories : {},
    };
  } catch {
    return { goals: [], stories: {} };
  }
}

export function savePrePlanState(sprintName: string, state: PrePlanState): void {
  setSetting(prePlanSettingsKey(sprintName), JSON.stringify(state));
}

/**
 * Replace a sprint's goals. Per-story call choices are untouched; a story's
 * goalIndex link is kept when it still points at a valid goal, else reset to
 * null (the goal set was replaced, so stale links drop). Pure — returns a new
 * state, does not mutate the input.
 */
export function setGoals(state: PrePlanState, goals: PrePlanGoal[]): PrePlanState {
  const stories: PrePlanState['stories'] = {};
  for (const [id, s] of Object.entries(state.stories)) {
    const entry: PrePlanState['stories'][string] = {};
    if (s.call !== undefined) entry.call = s.call;
    if (s.goalIndex !== undefined) {
      entry.goalIndex = s.goalIndex !== null && s.goalIndex < goals.length ? s.goalIndex : null;
    }
    stories[id] = entry;
  }
  return { goals, stories };
}

const STORY_TYPES = new Set(['user story', 'bug']);

function isStarted(s: UserStoryGroup): boolean {
  if (s.hasActiveSession) return true;
  if (isActiveState(s.state)) return true;
  return s.tasks.some(t => isActiveState(t.state));
}

export function selectCarriedStories(stories: UserStoryGroup[]): UserStoryGroup[] {
  return stories.filter(
    s => STORY_TYPES.has(s.type.toLowerCase()) && !isDoneState(s.state) && isStarted(s),
  );
}

function isBlocked(s: UserStoryGroup): boolean {
  if (isBlockedState(s.state)) return true;
  return (s.tags ?? []).some(t => t.toLowerCase() === 'blocked');
}

export function buildCards(
  stories: UserStoryGroup[],
  state: PrePlanState,
  now: Date,
): PrePlanCard[] {
  return stories.map(s => {
    const saved = state.stories[s.id] ?? {};
    const blocked = isBlocked(s);
    const lastActivityAt = s.recentActivity[0]?.createdAt ?? null;
    const remainingHours = s.remainingHours ?? 0;
    const suggestedCall = suggestCall({ blocked, lastActivityAt, remainingHours, now });
    const call: PrePlanCall = saved.call ?? suggestedCall;
    const suggestedGoal = suggestGoalIndex(s.title, state.goals);
    const goalIndex = saved.goalIndex !== undefined ? saved.goalIndex : suggestedGoal;
    return {
      id: s.id,
      displayName: displayNameFor(s.id, s.title),
      remainingHours,
      blocked,
      lastActivityAt,
      call,
      callIsSuggested: saved.call === undefined,
      goalIndex,
    };
  });
}

export async function buildPrePlanPayload(now: Date = new Date()): Promise<PrePlanPayload> {
  const { payload } = await buildDashboardCached();
  const sprintName = payload.sprint?.name ?? '';
  const state = getPrePlanState(sprintName);
  const carried = selectCarriedStories(payload.userStories);
  const cards = buildCards(carried, state, now);
  const coverage = summarizeCoverage(cards.map(c => ({ goalIndex: c.goalIndex })), state.goals);
  const openStoriesRemainingHours = Math.round(
    cards.reduce((acc, c) => acc + (c.remainingHours ?? 0), 0),
  );
  const cap = payload.outlookCapacity;
  const room: PrePlanRoomLine = {
    openStoriesRemainingHours,
    roomHours: cap ? Math.round(cap.availableHoursRemaining) : 0,
    hasCapacity: !!cap && cap.hasUrl,
  };
  return { sprintName, goals: state.goals, cards, coverage, room };
}
