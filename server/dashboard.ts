/**
 * Dashboard read API — turns ADO data into the shape the React dashboard wants.
 *
 * Slice 1.5: real sprint context + real work items. Time tracking
 * (running/done-today/standup) is still mocked because we don't yet have
 * local persistence — that lands in slices 1.7 and 2.
 */
import {
  getCurrentIteration,
  getIterationByName,
  getMyWorkItems,
  getWorkItemsWithParents,
  listAllIterations,
  listMyOpenTasksNotInSprint,
  type Iteration,
  type WorkItem,
} from './ado';
import { computeCapacity, type Capacity } from './capacity';
import { buildFitsToday, type FitsToday } from './fits-today';
import {
  computeUpcomingCeremonies,
  modeForCeremony,
  type ModeId,
  type UpcomingCeremony,
} from './ceremony';
import { loadAdoConfig } from './config';
import { displayNameFor } from './display-name';
import { htmlPreview } from './html-preview';
import { getHelperNotes, type HelperNotes } from './helper-notes';
import { buildStandup, workedItemIdsForStandup, type StandupBlock } from './standup';
import {
  getActiveSessionMap,
  getLastEventTimestampMap,
  getRecentEventsMap,
  getSessionCountMap,
  listActiveSessions,
  listRecentlyEnded,
  type Session,
  type SessionEvent,
} from './sessions';
import { sessionActivityState, type SessionActivityState } from './session-activity';
import { isActiveState, isDoneState, isWaitingState } from './states';
import { buildNeedsYou, RECENTLY_FINISHED_HOURS, type NeedsYouBlock } from './needs-you';
import { buildWrap, todayActivityRows, isWorkingDayFor, type WrapBlock } from './wrap';
import {
  getLocalLoggedMap,
  getPendingChangesCount,
  getRunningStartsMap,
  getUncapturedSecondsMap,
} from './timers';
import { getSHCreatedIdSet } from './sh-created';
import { isSprintLevel } from './iteration-paths';
import { getPages, getWorkingDays } from './user-config';
import { getManagedFeatureIds, getActiveFeature, getWorkspaces, getFeatureKind, type ActiveFeature, type FeatureKind } from './workspace';

export type { SessionEvent, SessionEventType, Session } from './sessions';

export interface DashboardWorkItem {
  id: string;
  title: string;
  type: string;
  state: string;
  story: string;
  parent?: {
    id: string;
    title: string;
    type: string;
    state: string;
    url: string;
  };
  originalEstimate?: number;
  remainingWork?: number;
  /** ADO's CompletedWork — purely what the server has stored. */
  completedWork?: number;
  /** Short plain-text preview for the expand panel. */
  descriptionPreview?: string;
  /** Last segment of the area path. */
  area?: string;
  /**
   * Seconds tracked locally that aren't reflected in ADO yet (closed
   * unsynced entries + any currently-running session's elapsed at fetch time).
   */
  localUncapturedSeconds: number;
  /**
   * Total seconds the timer actually ran on this item across ALL sittings
   * (running + paused + synced). This is the "LOGGED" value — real session
   * time — and unlike localUncapturedSeconds it does NOT drop a sitting once
   * it's paused. Kept separate from capacity math so it can't reinflate it.
   */
  localLoggedSeconds: number;
  /** ISO timestamp of the running session's start, if a timer is currently running. */
  runningSince?: string;
  /**
   * Claude Code session against this item, if one is active right now. The MCP
   * plugin opens these via `session_start`; the Day dashboard surfaces them so
   * the user can see Claude Code is actively reporting in.
   */
  activeSession?: {
    id: string;
    startedAt: string;
    waiting: boolean;
    idleMinutes: number;
    state: SessionActivityState;
  };
  /** Newest-first session events (focus / summary / blocker / decision / note). */
  recentActivity: SessionEvent[];
  /** Number of work sessions (open or closed) recorded against this item. */
  sessionCount: number;
  /** Parsed System.Tags. Includes "Blocked" when this task itself is tagged blocked. */
  tags?: string[];
  /** Parent story's tags — used so a task can show its parent story is blocked. */
  parentTags?: string[];
  /**
   * True when this work item was created via the MCP `task_create` /
   * `story_create` tools. Local-only marker; the dashboard renders a
   * discreet "SH" pip so the user can see what sprintomatic is on the
   * hook for keeping honest.
   */
  wasSHCreated?: boolean;
  url: string;
}

export interface SprintOption {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  isCurrent: boolean;
}

export interface UserStoryGroup {
  /** Parent work item id. May be a User Story, Feature, or Bug depending on team setup. */
  id: string;
  title: string;
  type: string;            // typically "User Story" but could be "Feature", "Bug", etc.
  state: string;
  url: string;
  /** Short plain-text preview for the expand panel. */
  descriptionPreview?: string;
  area?: string;
  /** Direct effort fields on the parent itself (separate from rolled-up task hours). */
  parentEstimate?: number;
  parentRemaining?: number;
  /** Story-level planning fields the POM delivery manager watches. */
  storyPoints?: number;
  effort?: number;
  /** The Feature / Epic above this story, if there is one (or this item is itself a Feature/Epic). */
  feature?: { id: string; title: string; type: string };
  /** Tasks (or other child items) assigned to the user that belong to this parent. */
  tasks: DashboardWorkItem[];
  /** Aggregate effort across this group's tasks (in hours). */
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  /** Counts for quick glance. */
  counts: { inProgress: number; upNext: number; done: number };
  /**
   * Newest-first session events rolled up across the story's tasks. Capped at
   * 5 — full history is on individual tasks.
   */
  recentActivity: SessionEvent[];
  /** True if any child task has a live Claude Code session right now. */
  hasActiveSession: boolean;
  /** Parsed System.Tags on the story (or self-as-story) itself. Includes "Blocked" when tagged blocked. */
  tags?: string[];
  /** Same marker as DashboardWorkItem.wasSHCreated — surfaced on stories too. */
  wasSHCreated?: boolean;
  /**
   * Set when the story is still open but every open task it has sits outside
   * this sprint: the other sprint's name, "the backlog", or "other sprints"
   * when they are spread out. The Daily view then stops showing it as live work.
   */
  movedTo?: string | null;
}

export interface DashboardPayload {
  user: string;
  sprint: {
    id: string;
    name: string;
    path: string;
    startDate: string;
    finishDate: string;
    totalDays: number;
    /** The user's working weekdays (0=Sun … 6=Sat), so the sprint rail greys out the rest. */
    workingDays: number[];
  } | null;
  sprintOptions: SprintOption[];
  workItems: {
    inProgress: DashboardWorkItem[];
    upNext: DashboardWorkItem[];
    done: DashboardWorkItem[];
  };
  /** Tasks grouped by parent user story (or other parent type) — for the
   *  story-centric focus view. Stories with no children are still included
   *  if they're themselves assigned to the user. */
  userStories: UserStoryGroup[];
  capacity: {
    remainingHours: number;
    completedHours: number;
    totalEstimateHours: number;
  };
  /**
   * Outlook-derived "hours available after meetings" for the sprint vs planned
   * task hours. Null when there's no sprint yet. When no calendar URL is set,
   * hasUrl=false and meeting subtractions are skipped (available = working
   * hours total).
   */
  outlookCapacity: Capacity | null;
  /** What can be finished today in today's free desk time. Null with no sprint. */
  fitsToday: FitsToday | null;
  /** Count of local edits that haven't reached ADO yet. */
  pendingChanges: number;
  /** Which halves of the Discovery & Design page are turned on. */
  pages: { discovery: boolean; design: boolean };
  /** Number of live Claude Code sessions reporting in right now. */
  activeSessions: number;
  /** The assistant's read on the sprint: a living summary + a few open nudges. */
  helperNotes: HelperNotes;
  /**
   * Upcoming ceremony occurrences within the next ~2 weeks, plus a
   * "suggested" mode if any is happening right now (15 min before → 60 min
   * after start). The dashboard uses this to highlight the right tab.
   */
  ceremonies: {
    upcoming: UpcomingCeremony[];
    next: UpcomingCeremony | null;
    suggestedModeId: ModeId | null;
  };
  /**
   * What the user did yesterday and what they're on today, pulled from the
   * sessions DB. Surfaced only in the Daily view (the morning-standup
   * card). Read-only summary — no edits in the dashboard.
   */
  standup: StandupBlock;
  /** Open tasks left behind in a previous sprint, for the Daily carry-forward banner. Null when none. */
  carryForward: CarryForwardSummary | null;
  /**
   * Which chats are waiting on the user + which tasks finished in the last few
   * hours. Drives the "Needs you" rail card. Always present (empty lists when
   * quiet).
   */
  needsYou: NeedsYouBlock;
  /** End-of-day wrap facts. Show/hide is decided client-side (WrapCard). */
  wrap: WrapBlock;
  /** Live sessions whose item isn't in the current sprint (e.g. a managed
   *  feature being worked in Discovery & Design). Surfaced so Focus shows them
   *  beside sprint work. NOT part of sprint capacity/counts/grouping. */
  liveOutsideSprint: DashboardWorkItem[];
  /** Discovery & Design rail card: active feature, managed features, workspace flag. */
  discovery: DiscoveryBlock;
  fetchedAt: string;
}

export interface BuildOptions {
  /** When set, fetches a specific sprint (by iteration name) instead of the current one. */
  sprintName?: string;
}

export interface TaskMetaEntry {
  title: string;
  parentId: number | null;
  parentTitle: string | null;
  type: string;
  state: string;
}

export interface CarryForwardTask {
  id: number;
  title: string;
}

export interface CarryForwardStoryGroup {
  /** Null when the task hangs under nothing on the board. */
  storyId: number | null;
  /** `**title** (#id)` ready to show. Falls back to a bare `#id` when the
   *  story's title couldn't be read, and is null when there is no story. */
  storyDisplayName: string | null;
  tasks: CarryForwardTask[];
}

export interface CarryForwardSummary {
  /** Open tasks stranded in a previous sprint, ready to pull into the current one. */
  taskIds: number[];
  /** The same tasks under the story they belong to. Every other part of the
   *  dashboard puts tasks under their story; a flat list left the user working
   *  out which story each line came from. */
  groups: CarryForwardStoryGroup[];
  /** taskIds.length — convenience for the banner copy. */
  count: number;
  /** Where they came from, ready to read after "N unfinished tasks from ":
   *  "26_16, last sprint". A bare sprint code says nothing on its own. */
  fromLabel: string;
}

export interface DiscoveryBlock {
  activeFeature: { id: number; displayName: string; folderPath: string } | null;
  /** Managed features OTHER than the active one, grouping features dropped.
   *  The card shows the active feature in its own "On now" block, so listing
   *  it here too would put the same feature on the card twice. */
  managed: { id: number; displayName: string }[];
  /** Managed features that belong on this card (active one included, grouping
   *  features excluded) — feeds the "managing N" label on the card head. */
  managedCount: number;
  hasWorkspace: boolean;
}

/** Pure: the "Discovery & Design" rail-card payload. Active feature + the
 *  other managed features (names before numbers) + whether a workspace is
 *  set. Two filters shape the list:
 *  - a 'grouping' feature is board-only — it has no discovery or design, so
 *    it never appears on a Discovery & Design surface, this card included;
 *  - the active feature is kept out of `managed` — it already has its own
 *    "On now" spot on the card.
 *  `managedCount` counts what the card stands for: every managed feature
 *  that isn't grouping, the active one included. */
export function buildDiscoveryBlock(args: {
  activeFeature: ActiveFeature | null;
  managedIds: number[];
  fetched: { id: number; title: string }[];
  hasWorkspace: boolean;
  /** The feature's kind, or null when the user hasn't said (see getFeatureKind). */
  kindOf: (id: number) => FeatureKind | null;
}): DiscoveryBlock {
  const { activeFeature, managedIds, fetched, hasWorkspace, kindOf } = args;
  const titleById = new Map(fetched.map(w => [w.id, w.title]));
  const dndIds = managedIds.filter(id => kindOf(id) !== 'grouping');
  const managed = dndIds
    .filter(id => id !== activeFeature?.id)
    .map(id => {
      const title = titleById.get(id);
      return { id, displayName: displayNameFor(id, title) };
    });
  return {
    activeFeature: activeFeature
      ? { id: activeFeature.id, displayName: displayNameFor(activeFeature.id, activeFeature.title), folderPath: activeFeature.folderPath }
      : null,
    managed,
    managedCount: dndIds.length,
    hasWorkspace,
  };
}

/**
 * Build the id→metadata map the standup recap uses to resolve each worked
 * item's title, type, parent and — crucially — its live Azure state.
 *
 * Two passes. The first records every sprint item the user owns. The second
 * fills in parent stories that aren't their own item row, using the parent
 * fields each child task already carries. That second pass matters because
 * sessions are usually logged on the child Tasks, so a worked Story shows up
 * only as `parentState` on its tasks. Without it the recap can't see a closed
 * parent story and falls back to showing it as "going" — the bug the user hit
 * with "Checkout service ready to start migration". A real item row is
 * authoritative; the parent-derived fallback only fills a gap, never
 * overwrites a story present in its own right.
 */
export function buildTaskMeta(items: WorkItem[]): Map<number, TaskMetaEntry> {
  const taskMeta = new Map<number, TaskMetaEntry>();
  mergeIntoTaskMeta(taskMeta, items);
  return taskMeta;
}

/**
 * Turn the raw "my open tasks not in the current sprint" list into the banner
 * summary. Keeps only tasks whose iteration path is a real PREVIOUS sprint —
 * backlog / year / quarter items are scheduling, not carry-over, and stay on
 * the Plan page. Returns null when nothing qualifies (banner renders nothing).
 */
/** The last segment of an iteration path — "26_16" out of the full path. */
function sprintLeaf(path: string): string {
  return path.split('\\').filter(Boolean).pop() ?? path;
}

/** Plain-English "where they came from", ready to drop straight after
 *  "N unfinished tasks from ". A bare sprint code tells the user nothing, so this
 *  also says how far back it is — and never claims "last sprint" when the
 *  tasks actually straggle in from several. */
function carryForwardFromLabel(
  strandedPaths: string[],
  pastSprintPaths: string[],
): string {
  const ordered = pastSprintPaths.filter(p => strandedPaths.includes(p));
  const paths = ordered.length > 0 ? ordered : [...new Set(strandedPaths)];
  if (paths.length === 1) {
    const label = sprintLeaf(paths[0]);
    const back = pastSprintPaths.indexOf(paths[0]);
    if (back === 0) return `${label}, last sprint`;
    if (back > 0) return `${label}, ${back + 1} sprints back`;
    return label;
  }
  if (paths.length === 2) {
    return `${sprintLeaf(paths[0])} and ${sprintLeaf(paths[1])}, the two sprints before this one`;
  }
  return `${paths.length} earlier sprints`;
}

export function summarizeCarryForward(
  outOfSprintTasks: WorkItem[],
  pastSprintPaths: string[],
  storyTitleById: Map<number, string> = new Map(),
): CarryForwardSummary | null {
  // Only tasks in a real named sprint that started BEFORE the current one.
  // The `pastSprintPaths` membership is what keeps FUTURE sprints out — a task
  // the user parked in a not-yet-started sprint during planning must never be
  // pulled backward into the current sprint by this banner. `isSprintLevel`
  // additionally drops any backlog/year/quarter path that slipped into the set.
  const past = new Set(pastSprintPaths);
  const stranded = outOfSprintTasks.filter(
    t => isSprintLevel(t.iterationPath) && past.has(t.iterationPath),
  );
  if (stranded.length === 0) return null;

  // Under their story, in the order the tasks arrive. A story with no title —
  // the lookup failed — falls back to a bare id, the one case where a number
  // is allowed to stand alone because there is no name to show.
  const byStory = new Map<number | null, CarryForwardStoryGroup>();
  const groups: CarryForwardStoryGroup[] = [];
  for (const t of stranded) {
    const storyId = t.parentId ?? null;
    let group = byStory.get(storyId);
    if (!group) {
      const title = storyId != null ? storyTitleById.get(storyId) : undefined;
      group = {
        storyId,
        storyDisplayName:
          storyId == null ? null : displayNameFor(storyId, title),
        tasks: [],
      };
      byStory.set(storyId, group);
      groups.push(group);
    }
    group.tasks.push({ id: t.id, title: t.title });
  }

  return {
    taskIds: stranded.map(t => t.id),
    groups,
    count: stranded.length,
    fromLabel: carryForwardFromLabel(stranded.map(t => t.iterationPath), pastSprintPaths),
  };
}

/**
 * Mark the stories whose open tasks all live outside this sprint. A story
 * counts when it is not done itself, none of its tasks in this sprint is still
 * open, and at least one of its open tasks sits somewhere else. Sets `movedTo`
 * on every group: the other sprint's name, "the backlog" for a backlog / year /
 * quarter path, "other sprints" when the tasks are spread over several places,
 * or null.
 */
export function markMovedStories(groups: UserStoryGroup[], outOfSprintTasks: WorkItem[]): void {
  const sprintsByStory = new Map<string, Set<string>>();
  for (const t of outOfSprintTasks) {
    if (t.parentId == null || isDoneState(t.state)) continue;
    const key = String(t.parentId);
    let set = sprintsByStory.get(key);
    if (!set) sprintsByStory.set(key, (set = new Set()));
    set.add(isSprintLevel(t.iterationPath) ? sprintLeaf(t.iterationPath) : 'the backlog');
  }
  for (const g of groups) {
    const sprints = sprintsByStory.get(g.id);
    const openHere = g.tasks.some(t => !isDoneState(t.state));
    if (!sprints || openHere || isDoneState(g.state)) {
      g.movedTo = null;
      continue;
    }
    g.movedTo = sprints.size === 1 ? [...sprints][0] : 'other sprints';
  }
}

/**
 * Add `items` (and their parent stories) into an existing taskMeta map, using
 * the same two-pass rule as buildTaskMeta. Shared so the dashboard can fold in
 * extra items worked outside the current sprint without duplicating the logic.
 * An item already present is NOT overwritten — the first writer (current-sprint
 * data) stays authoritative over a later best-effort fetch.
 */
export function mergeIntoTaskMeta(taskMeta: Map<number, TaskMetaEntry>, items: WorkItem[]): void {
  for (const w of items) {
    if (taskMeta.has(w.id)) continue;
    taskMeta.set(w.id, {
      title: w.title,
      parentId: w.parentId ?? null,
      parentTitle: w.parentTitle ?? null,
      type: w.type,
      state: w.state,
    });
  }
  for (const w of items) {
    if (w.parentId == null || taskMeta.has(w.parentId)) continue;
    taskMeta.set(w.parentId, {
      title: w.parentTitle ?? `#${w.parentId}`,
      parentId: w.grandparentId ?? null,
      parentTitle: w.grandparentTitle ?? null,
      type: w.parentType ?? 'User Story',
      state: w.parentState ?? '',
    });
  }
}

/** Live-session work-item ids that are NOT in the current sprint. Deduped.
 *  These get fetched + projected so a session on an out-of-sprint item (a
 *  managed feature, or a previous-sprint task) is still visible in Focus. */
export function selectLiveOutsideSprintIds(
  activeSessionItemIds: number[],
  sprintItemIds: number[],
): number[] {
  const inSprint = new Set(sprintItemIds);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of activeSessionItemIds) {
    if (inSprint.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Sum sprint hours across TASKS only.
 *
 * User Stories / Features / Epics carry aggregate effort fields that are
 * rollups of their child tasks; counting them alongside the tasks themselves
 * double-counts everything underneath. (Caught 2026-06-02 when a sprint
 * summary showed 316h logged against 82h estimated — the Story rows
 * contributed 91h of already-counted time.)
 *
 * `uncapturedSeconds` is time tracked locally that ADO doesn't know about yet.
 * Pausing a timer marks its time as synced, which drops it out of that map —
 * so only a running timer's seconds land here, and nothing is counted twice.
 */
export function sumTaskCapacity(
  items: WorkItem[],
  uncapturedSeconds: Map<number, number>,
): { remainingHours: number; completedHours: number; totalEstimateHours: number } {
  return items.reduce(
    (acc, w) => {
      if (w.type !== 'Task') return acc;
      const localHours = (uncapturedSeconds.get(w.id) ?? 0) / 3600;
      // Time on a running timer counts as done even though it has not been sent
      // to the board yet, so it has to come off the hours left as well. Adding it
      // to one side only made done plus left add up to more than was planned.
      // A story row already did this; the sprint total did not, and the two
      // disagreed about the same tasks.
      acc.remainingHours += Math.max(0, (w.remainingWork ?? 0) - localHours);
      acc.completedHours += (w.completedWork ?? 0) + localHours;
      acc.totalEstimateHours += w.originalEstimate ?? 0;
      return acc;
    },
    { remainingHours: 0, completedHours: 0, totalEstimateHours: 0 },
  );
}

export async function buildDashboard(opts: BuildOptions = {}): Promise<DashboardPayload> {
  const cfg = await loadAdoConfig();

  // Resolve the iteration we want. If a name is given, pull that one; else current.
  const [requestedIteration, currentIteration, allIterations] = await Promise.all([
    opts.sprintName ? getIterationByName(opts.sprintName) : Promise.resolve(null as Iteration | null),
    getCurrentIteration(),
    listAllIterations().catch(() => []),
  ]);
  const iteration: Iteration | null = requestedIteration ?? currentIteration;

  const sprintOptions: SprintOption[] = allIterations.map(it => ({
    id: it.id,
    name: it.name,
    path: it.path,
    startDate: it.startDate,
    finishDate: it.finishDate,
    isCurrent: currentIteration?.id === it.id,
  }));

  if (!iteration) {
    return {
      user: cfg.user,
      sprint: null,
      sprintOptions,
      workItems: { inProgress: [], upNext: [], done: [] },
      userStories: [],
      capacity: { remainingHours: 0, completedHours: 0, totalEstimateHours: 0 },
      outlookCapacity: null,
      fitsToday: null,
      pendingChanges: getPendingChangesCount(),
      pages: getPages(),
      activeSessions: 0,
      helperNotes: getHelperNotes(),
      ceremonies: buildCeremonyBlock(null, null),
      standup: buildStandup({ taskMeta: new Map() }),
      carryForward: null,
      needsYou: { waiting: [], recentlyFinished: [] },
      wrap: {
        isWorkingDay: isWorkingDayFor(new Date()),
        lastActivityAt: null,
        stillOpen: [],
        firstMove: null,
      },
      liveOutsideSprint: [],
      discovery: { activeFeature: null, managed: [], managedCount: 0, hasWorkspace: getWorkspaces().paths.length > 0 },
      fetchedAt: new Date().toISOString(),
    };
  }

  const items = await getMyWorkItems(iteration.path);

  // Pull local timer state. Each map is keyed by numeric work item id.
  const uncaptured = getUncapturedSecondsMap();
  const localLogged = getLocalLoggedMap();
  const running = getRunningStartsMap();
  const shCreatedIds = getSHCreatedIdSet();

  // Pull MCP session state — active sessions + recent events per work item.
  const itemIds = items.map(w => w.id);
  const activeSessions = getActiveSessionMap();
  const recentEvents = getRecentEventsMap(itemIds, 5);
  const sessionCounts = getSessionCountMap(itemIds);

  // Build last-activity map for computing session state (working / waiting / stale).
  const activeSessionList = [...activeSessions.values()];
  const lastEventBySession = getLastEventTimestampMap(activeSessionList.map(s => s.id));
  const now = new Date();

  const inProgress: DashboardWorkItem[] = [];
  const upNext: DashboardWorkItem[] = [];
  const done: DashboardWorkItem[] = [];

  for (const w of items) {
    const projected = projectWorkItem(w, uncaptured, localLogged, running, activeSessions, recentEvents, sessionCounts, lastEventBySession, now);
    if (shCreatedIds.has(w.id)) projected.wasSHCreated = true;
    if (isDoneState(w.state)) done.push(projected);
    else if (isActiveState(w.state)) inProgress.push(projected);
    else upNext.push(projected);
  }

  const capacity = sumTaskCapacity(items, uncaptured);

  const totalDays = sprintDays(iteration.startDate, iteration.finishDate);

  const userStories = groupByParent(items, [...inProgress, ...upNext, ...done]);

  // R12: project SH-created marker onto story groups, same source of truth as
  // the per-task projection above.
  for (const g of userStories) {
    if (shCreatedIds.has(Number(g.id))) g.wasSHCreated = true;
  }

  // R10b: when a non-Task item (User Story / Feature / Epic) is itself in
  // one of the flat workItems lists — typically because the user opened a
  // session on the Story directly — its own effort fields are usually
  // blank (the user's process tracks hours on child tasks, not stories).
  // Fill in a rollup from the matching userStories[] bucket so the Focus
  // view shows meaningful Estimate / Logged / Remaining instead of blanks.
  const rollupByParentId = new Map<
    string,
    { totalEstimateHours: number; completedHours: number; remainingHours: number }
  >();
  for (const g of userStories) {
    rollupByParentId.set(g.id, {
      totalEstimateHours: g.totalEstimateHours,
      completedHours: g.completedHours,
      remainingHours: g.remainingHours,
    });
  }
  for (const slim of [...inProgress, ...upNext, ...done]) {
    if (slim.type === 'Task') continue;
    const rollup = rollupByParentId.get(slim.id);
    if (!rollup) continue;
    if (slim.originalEstimate == null && rollup.totalEstimateHours > 0) {
      slim.originalEstimate = rollup.totalEstimateHours;
    }
    if (slim.completedWork == null && rollup.completedHours > 0) {
      slim.completedWork = rollup.completedHours;
    }
    if (slim.remainingWork == null && rollup.remainingHours > 0) {
      slim.remainingWork = rollup.remainingHours;
    }
  }

  // Out-of-sprint live sessions → visible in Focus (managed features, stray
  // previous-sprint work). Best-effort; a fetch failure just yields none.
  let liveOutsideSprint: DashboardWorkItem[] = [];
  try {
    const sprintIds = items.map(w => w.id);
    const liveIds = [...activeSessions.keys()];
    const outsideIds = selectLiveOutsideSprintIds(liveIds, sprintIds);
    if (outsideIds.length > 0) {
      const fetched = await getWorkItemsWithParents(outsideIds, { errorPolicy: 'omit' });
      const extraEvents = getRecentEventsMap(outsideIds, 5);
      const extraCounts = getSessionCountMap(outsideIds);
      liveOutsideSprint = fetched
        .filter(w => !isDoneState(w.state)) // a done item isn't "live work"
        .map(w => projectWorkItem(w, uncaptured, localLogged, running, activeSessions, extraEvents, extraCounts, lastEventBySession, now));
    }
  } catch {
    liveOutsideSprint = [];
  }

  // Discovery & Design card. Managed-feature titles fetched best-effort.
  let discovery: DiscoveryBlock = { activeFeature: null, managed: [], managedCount: 0, hasWorkspace: false };
  try {
    const activeFeature = getActiveFeature();
    const managedIds = getManagedFeatureIds();
    const hasWorkspace = getWorkspaces().paths.length > 0;
    let fetchedForTitles: { id: number; title: string }[] = [];
    if (managedIds.length > 0) {
      fetchedForTitles = await getWorkItemsWithParents(managedIds, { errorPolicy: 'omit' });
    }
    discovery = buildDiscoveryBlock({ activeFeature, managedIds, fetched: fetchedForTitles, hasWorkspace, kindOf: getFeatureKind });
  } catch {
    discovery = { activeFeature: null, managed: [], managedCount: 0, hasWorkspace: getWorkspaces().paths.length > 0 };
  }


  // Outlook capacity is best-effort: never break the dashboard if the calendar
  // fetch hiccups. computeCapacity catches its own fetch errors and surfaces
  // them via `fetchError`; this outer try is belt-and-suspenders.
  let outlookCapacity: Capacity | null = null;
  try {
    outlookCapacity = await computeCapacity({
      sprintStart: new Date(iteration.startDate),
      sprintEnd: new Date(iteration.finishDate),
      plannedHours: capacity.remainingHours,
    });
  } catch {
    outlookCapacity = null;
  }

  // Remaining hours net of timer time not yet on the board, same as capacity.
  const toFitsTask = (w: DashboardWorkItem) => ({
    id: Number(w.id),
    title: w.title,
    remainingHours: Math.round(Math.max(0, (w.remainingWork ?? 0) - w.localUncapturedSeconds / 3600) * 10) / 10,
  });
  const isTask = (w: DashboardWorkItem) => w.type.toLowerCase() === 'task';
  const fitsToday = outlookCapacity
    ? buildFitsToday({
        freeHours: outlookCapacity.freeHoursToday,
        isWorkToday: outlookCapacity.isWorkToday,
        going: inProgress.filter(isTask).map(toFitsTask),
        waiting: upNext.filter(w => isTask(w) && isWaitingState(w.state)).map(toFitsTask),
        hasCalendar: outlookCapacity.hasUrl && !outlookCapacity.fetchError,
      })
    : null;

  // Build the standup block — pulls yesterday + today entries from the
  // sessions DB, joined to task titles + parent story titles for display.
  const taskMeta = buildTaskMeta(items);
  // The recap can surface work logged against items NOT in the current sprint
  // (e.g. a task still sitting in last sprint, not yet pulled forward). Those
  // are absent from `taskMeta`, so without help the recap shows a bare `#id`.
  // Fetch just the missing worked items (+ their parents) and fold them in so
  // the recap reads real names regardless of which sprint the work lives in.
  // RemainingWork lookup for the wrap card's "first move" line. Sprint items
  // first; out-of-sprint worked items are folded in below, best-effort.
  const remainingById = new Map<number, number>();
  for (const w of items) {
    if (w.remainingWork != null) remainingById.set(w.id, w.remainingWork);
  }
  const missingWorkedIds = workedItemIdsForStandup().filter(id => !taskMeta.has(id));
  if (missingWorkedIds.length > 0) {
    try {
      const extra = await getWorkItemsWithParents(missingWorkedIds);
      mergeIntoTaskMeta(taskMeta, extra);
      for (const w of extra) {
        if (w.remainingWork != null && !remainingById.has(w.id)) {
          remainingById.set(w.id, w.remainingWork);
        }
      }
    } catch {
      // Best-effort enrichment — if the fetch fails the recap still renders
      // with bare ids rather than breaking the whole dashboard.
    }
  }
  const standup = buildStandup({ taskMeta });

  // My open tasks outside this sprint — fetched once, used for the carry-forward
  // banner and for marking stories whose open tasks all moved to another
  // sprint. Best-effort: a query failure means no banner and no marks.
  const outOfSprintTasks: WorkItem[] | null = await listMyOpenTasksNotInSprint(iteration.path).catch(() => null);
  markMovedStories(userStories, outOfSprintTasks ?? []);

  let carryForward: CarryForwardSummary | null = null;
  if (outOfSprintTasks) {
    try {
      // Paths of sprints that started strictly before the viewed sprint, newest
      // first — so the banner only ever offers genuinely PAST work, never tasks
      // parked in a future sprint during planning.
      const pastSprintPaths = allIterations
        .filter(it => it.startDate && iteration.startDate && it.startDate < iteration.startDate)
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .map(it => it.path);
      // Parent story titles for the banner headings. These stories usually sit
      // OUTSIDE the current sprint (the tasks move, the story stays), so the
      // sprint query never returns them — one extra batch is the only way to
      // name them. Best-effort: without titles the groups still form.
      const storyTitleById = new Map<number, string>();
      const parentIds = [...new Set(outOfSprintTasks.map(t => t.parentId).filter((x): x is number => x != null))];
      if (parentIds.length > 0) {
        try {
          for (const p of await getWorkItemsWithParents(parentIds, { errorPolicy: 'omit' })) {
            storyTitleById.set(p.id, p.title);
          }
        } catch { /* names are a nicety — the banner still works without them */ }
      }
      carryForward = summarizeCarryForward(outOfSprintTasks, pastSprintPaths, storyTitleById);
    } catch {
      carryForward = null;
    }
  }

  // "Needs you": waiting chats + recently finished tasks. Titles/states come
  // from the taskMeta map built above (already covers every sprint item plus
  // any worked items merged in from outside the sprint) — reused here instead
  // of building a duplicate lookup. A session on an item outside taskMeta
  // falls back to a bare #id (waiting still shows; finished is dropped since
  // we can't confirm it's done).
  const liveSessions = listActiveSessions();
  const needsYou = buildNeedsYou({
    activeSessions: liveSessions,
    recentlyEnded: listRecentlyEnded(RECENTLY_FINISHED_HOURS),
    titleFor: id => taskMeta.get(id)?.title ?? null,
    isDone: id => isDoneState(taskMeta.get(id)?.state),
  });

  // End-of-day wrap facts. Local SQLite only — no ADO calls, nothing to
  // swallow; titles/states reuse the enriched taskMeta like needsYou does.
  const wrap = buildWrap({
    activityRows: todayActivityRows(),
    activeSessions: liveSessions,
    titleFor: id => taskMeta.get(id)?.title ?? null,
    isDone: id => isDoneState(taskMeta.get(id)?.state),
    remainingFor: id => remainingById.get(id) ?? null,
    isWorkingDay: isWorkingDayFor(new Date()),
  });

  return {
    user: cfg.user,
    sprint: {
      id: iteration.id,
      name: iteration.name,
      path: iteration.path,
      startDate: iteration.startDate,
      finishDate: iteration.finishDate,
      totalDays,
      workingDays: [...getWorkingDays()].sort((a, b) => a - b),
    },
    sprintOptions,
    workItems: { inProgress, upNext, done },
    userStories,
    capacity,
    outlookCapacity,
    fitsToday,
    pendingChanges: getPendingChangesCount(),
    pages: getPages(),
    activeSessions: activeSessions.size,
    helperNotes: getHelperNotes(),
    ceremonies: buildCeremonyBlock(
      new Date(iteration.startDate),
      new Date(iteration.finishDate),
    ),
    standup,
    carryForward,
    needsYou,
    wrap,
    liveOutsideSprint,
    discovery,
    fetchedAt: new Date().toISOString(),
  };
}

function buildCeremonyBlock(
  sprintStart: Date | null,
  sprintFinish: Date | null,
): DashboardPayload['ceremonies'] {
  const now = new Date();
  const upcoming = computeUpcomingCeremonies({ sprintStart, sprintFinish, now });
  const suggested = upcoming.find(u => u.isSuggested) ?? null;
  // "next" is either the suggested one (so the UI surfaces what's happening
  // right now), or the first non-elapsed future occurrence.
  const next = suggested ?? upcoming.find(u => u.minutesUntil >= 0) ?? null;
  return {
    upcoming,
    next,
    suggestedModeId: suggested ? modeForCeremony(suggested.id) : null,
  };
}

/**
 * Group tasks by their parent user story. Items without a parent become their
 * own group (so a User Story assigned directly to the user without sub-tasks
 * still shows up). Stories are sorted: those with in-progress tasks first,
 * then by descending in-progress count.
 */
export function groupByParent(rawItems: WorkItem[], projected: DashboardWorkItem[]): UserStoryGroup[] {
  // Index projected items by id for easy lookup with effort numbers.
  const byId = new Map(projected.map(p => [p.id, p]));

  // A bucket = one story row. `header` is the story/bug/feature item itself
  // (when it's in the payload), `tasks` are its child Tasks. Keeping them
  // separate is what stops a User Story being filed as a "task" under its
  // Feature — only Tasks roll up; everything else heads its own row.
  interface Bucket {
    parent: ParentInfo;
    /** True once parent came from the item itself (richer) vs synthesized from a child task. */
    parentResolved: boolean;
    /** The story/bug item itself, if present in the payload (drives its own session/activity). */
    header: DashboardWorkItem | null;
    tasks: DashboardWorkItem[];
  }
  const buckets = new Map<string, Bucket>();

  for (const raw of rawItems) {
    const projectedItem = byId.get(String(raw.id));
    if (!projectedItem) continue;

    const typeLower = raw.type.toLowerCase();
    const hasParent = !!(raw.parentId && raw.parentTitle);
    // Only a Task rolls up under its parent story. A User Story / Bug / Feature
    // is its own row even when it has a parent (the parent is its Feature, not
    // a story it belongs to).
    const rollsUpToParent = typeLower === 'task' && hasParent;

    if (rollsUpToParent) {
      const parentTypeLower = (raw.parentType ?? '').toLowerCase();
      // If the parent IS a Feature/Epic, treat the parent itself as the feature.
      // Otherwise, the feature is the grandparent (if any).
      const feature = FEATURE_LIKE_TYPES.has(parentTypeLower)
        ? { id: String(raw.parentId), title: raw.parentTitle!, type: raw.parentType ?? 'Feature' }
        : raw.grandparentId
          ? {
              id: String(raw.grandparentId),
              title: raw.grandparentTitle ?? '',
              type: raw.grandparentType ?? 'Feature',
            }
          : undefined;
      const parent: ParentInfo = {
        id: String(raw.parentId),
        title: raw.parentTitle!,
        type: raw.parentType ?? 'User Story',
        state: raw.parentState ?? '',
        url: raw.parentUrl ?? '',
        descriptionPreview: htmlPreview(raw.parentDescription),
        area: lastPathSegment(raw.parentAreaPath ?? ''),
        parentEstimate: raw.parentOriginalEstimate,
        parentRemaining: raw.parentRemainingWork,
        storyPoints: raw.parentStoryPoints,
        effort: raw.parentEffort,
        feature,
        tags: raw.parentTags,
      };
      const existing = buckets.get(parent.id);
      if (existing) existing.tasks.push(projectedItem);
      else buckets.set(parent.id, { parent, parentResolved: false, header: null, tasks: [projectedItem] });
    } else {
      // The item heads its own row. If it's itself a Feature it heads a feature
      // section; otherwise its feature is its parent (so stories still group
      // under features in the daily view).
      const parentTypeLower = (raw.parentType ?? '').toLowerCase();
      const feature = FEATURE_LIKE_TYPES.has(typeLower)
        ? { id: String(raw.id), title: raw.title, type: raw.type }
        : hasParent && FEATURE_LIKE_TYPES.has(parentTypeLower)
          ? { id: String(raw.parentId), title: raw.parentTitle!, type: raw.parentType ?? 'Feature' }
          : undefined;
      const parent: ParentInfo = {
        id: String(raw.id),
        title: raw.title,
        type: raw.type,
        state: raw.state,
        url: humanUrl(raw.url),
        descriptionPreview: htmlPreview(raw.description),
        area: lastPathSegment(raw.areaPath),
        parentEstimate: raw.originalEstimate,
        parentRemaining: raw.remainingWork,
        storyPoints: raw.storyPoints,
        effort: raw.effort,
        feature,
        tags: raw.tags,
      };
      const existing = buckets.get(parent.id);
      if (existing) {
        // A child task created this bucket first; now fill in the real header.
        existing.parent = parent;
        existing.parentResolved = true;
        existing.header = projectedItem;
      } else if (typeLower === 'task') {
        // Orphan Task (no parent): it IS the row's single task, like before.
        buckets.set(parent.id, { parent, parentResolved: true, header: null, tasks: [projectedItem] });
      } else {
        // Story / Bug / Feature: the header, not a task under itself.
        buckets.set(parent.id, { parent, parentResolved: true, header: projectedItem, tasks: [] });
      }
    }
  }

  // Roll up effort + counts per bucket. Local-uncaptured time is added
  // into completedHours and subtracted from remainingHours so the story
  // reflects reality even before changes are pushed to ADO. Hours sum
  // over TASK-type children only — Story / Feature / Epic children carry
  // rollup numbers that double-count if added in (see capacity reducer
  // above).
  const groups: UserStoryGroup[] = Array.from(buckets.values()).map(({ parent, header, tasks }) => {
    const taskOnly = tasks.filter(t => t.type === 'Task');
    const totalEstimateHours = taskOnly.reduce((s, t) => s + (t.originalEstimate ?? 0), 0);
    const completedHours = taskOnly.reduce(
      (s, t) => s + (t.completedWork ?? 0) + t.localUncapturedSeconds / 3600,
      0,
    );
    const remainingHours = taskOnly.reduce(
      (s, t) => s + Math.max(0, (t.remainingWork ?? 0) - t.localUncapturedSeconds / 3600),
      0,
    );
    const counts = {
      inProgress: tasks.filter(t => isActiveState(t.state)).length,
      upNext: tasks.filter(t => !isActiveState(t.state) && !isDoneState(t.state)).length,
      done: tasks.filter(t => isDoneState(t.state)).length,
    };
    // Session + activity also reflect work logged on the story itself (the
    // header), not just its child tasks — so a session opened directly on a
    // story still marks it live and shows in its feed.
    const signalItems = header ? [header, ...tasks] : tasks;
    const recentActivity = signalItems
      .flatMap(t => t.recentActivity)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 5);
    const hasActiveSession = signalItems.some(t => t.activeSession != null);
    return {
      id: parent.id,
      title: parent.title,
      type: parent.type,
      state: parent.state,
      url: parent.url,
      descriptionPreview: parent.descriptionPreview,
      area: parent.area,
      parentEstimate: parent.parentEstimate,
      parentRemaining: parent.parentRemaining,
      storyPoints: parent.storyPoints,
      effort: parent.effort,
      feature: parent.feature,
      tasks,
      totalEstimateHours,
      completedHours,
      remainingHours,
      counts,
      recentActivity,
      hasActiveSession,
      tags: parent.tags,
    };
  });

  // Sort: stories with in-progress tasks first, more in-progress → higher;
  // ties broken by tasks-remaining (more work → earlier).
  groups.sort((a, b) => {
    if (b.counts.inProgress !== a.counts.inProgress) return b.counts.inProgress - a.counts.inProgress;
    return b.remainingHours - a.remainingHours;
  });

  return groups;
}

interface ParentInfo {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
  descriptionPreview?: string;
  area?: string;
  parentEstimate?: number;
  parentRemaining?: number;
  storyPoints?: number;
  effort?: number;
  feature?: { id: string; title: string; type: string };
  tags?: string[];
}

const FEATURE_LIKE_TYPES = new Set(['feature', 'epic']);

function projectWorkItem(
  w: WorkItem,
  uncaptured: Map<number, number>,
  localLogged: Map<number, number>,
  running: Map<number, string>,
  activeSessions: Map<number, Session>,
  recentEvents: Map<number, SessionEvent[]>,
  sessionCounts: Map<number, number>,
  lastEventBySession: Map<string, string>,
  now: Date,
): DashboardWorkItem {
  const lastIterSegment = w.iterationPath.split('\\').pop() ?? w.iterationPath;
  const story = w.parentTitle
    ? `${w.parentTitle} · ${lastIterSegment}`
    : `${w.type} · ${lastIterSegment}`;
  const session = activeSessions.get(w.id);
  return {
    id: String(w.id),
    title: w.title,
    type: w.type,
    state: w.state,
    story,
    parent: w.parentId && w.parentTitle
      ? {
          id: String(w.parentId),
          title: w.parentTitle,
          type: w.parentType ?? 'User Story',
          state: w.parentState ?? '',
          url: w.parentUrl ?? '',
        }
      : undefined,
    originalEstimate: w.originalEstimate,
    remainingWork: w.remainingWork,
    completedWork: w.completedWork,
    descriptionPreview: htmlPreview(w.description),
    area: lastPathSegment(w.areaPath),
    localUncapturedSeconds: uncaptured.get(w.id) ?? 0,
    localLoggedSeconds: localLogged.get(w.id) ?? 0,
    runningSince: running.get(w.id),
    activeSession: session
      ? (() => {
          const waiting = session.waitingSince != null;
          const lastActivity = lastEventBySession.get(session.id) ?? session.startedAt;
          const idleMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(lastActivity)) / 60000));
          return {
            id: session.id,
            startedAt: session.startedAt,
            waiting,
            idleMinutes,
            state: sessionActivityState({ idleMinutes, waiting }),
          };
        })()
      : undefined,
    recentActivity: recentEvents.get(w.id) ?? [],
    sessionCount: sessionCounts.get(w.id) ?? 0,
    tags: w.tags,
    parentTags: w.parentTags,
    url: humanUrl(w.url),
  };
}

function lastPathSegment(path: string): string | undefined {
  if (!path) return undefined;
  const seg = path.split('\\').pop();
  return seg && seg !== path ? seg : undefined;
}

/** ADO `url` field points at the REST API; convert to the human-facing URL. */
function humanUrl(restUrl: string): string {
  // restUrl looks like https://dev.azure.com/<org>/_apis/wit/workItems/<id>
  const m = restUrl.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/_apis\/wit\/workItems\/(\d+)/);
  if (!m) return restUrl;
  return `${m[1]}/_workitems/edit/${m[2]}`;
}

function sprintDays(startISO: string, finishISO: string): number {
  const start = new Date(startISO);
  const finish = new Date(finishISO);
  const ms = finish.getTime() - start.getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)) + 1);
}
