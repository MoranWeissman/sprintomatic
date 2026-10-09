/**
 * Orientation packet (slice R4).
 *
 * Builds a short "where the user left off and what's waiting" read for the start
 * of every Claude Code session. The MCP `orient` tool returns this; the
 * assistant uses it to write a friendly 2-4 sentence greeting (time of day,
 * last task, day of sprint, any open helper notes) — not to dump the data.
 *
 * Reads from sources already in memory or local SQLite, plus the cached
 * Azure DevOps fetch. The one exception is `repoLinkFor` below: when this
 * chat's folder declares which features it serves, those few ids are read
 * from the board live (capped, and every failure turns into a note) so the
 * greeting never repeats a stale status.
 */
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { getWorkItem, getWorkItemsWithParents } from './ado';
import { getCalendarUrl, listAllDayInWindow } from './calendar';
import { candidateDayOffRanges, listDaysOff, toIsoDate } from './days-off';
import type { Capacity } from './capacity';
import { ceremonyTodayLine, getCeremonySchedule } from './ceremony';
import { buildDashboardCached } from './dashboard-cache';
import { readDesignDoc } from './design-store';
import { displayNameFor } from './display-name';
import { getDb } from './db';
import { listTouchedFeatureFolders } from './discovery-list';
import { discoveryStatus, discoveryStartedAt } from './discovery-store';
import { discoveryDayStage, discoveryDayNudge, discoveryStartNudge, discoveryNextStep } from './discovery';
import {
  clearedNotesLine,
  ensureCapacityNudge,
  getHelperNotes,
  reviewNotesAgainstBoard,
  scanStaleRemaining,
  type ClearedNote,
} from './helper-notes';
import { getPlanningHome } from './planning-home';
import { readRepoLink } from './repo-link';
import { repoLinkBlock, stageFor } from './repo-link-view';
import { factsForOrient } from './facts';
import type {
  FeatureStage,
  OrientRepoLink,
  RepoLinkFeatureInput,
  RepoLinkStoryInput,
} from './repo-link-view';
import { STALE_IDLE_MINUTES } from './session-activity';
import { getPages } from './user-config';
import {
  getLastEventTimestampMap,
  listActiveSessions,
  sessionOwnershipHint,
  type SessionRow,
} from './sessions';
import {
  expandHome,
  getActiveFeature,
  getFeatureKind,
  getWorkspaces,
  type ActiveFeature,
} from './workspace';

export interface OrientLiveSession {
  /**
   * The sessions-table id. REQUIRED for `session_end` / `session_log` calls
   * — without this, a session that came back into view after an MCP
   * reconnect would have no way to be stopped from this chat. See the
   * STALE LIVE SESSION block in SERVER_INSTRUCTIONS.
   */
  sessionId: string;
  workItemId: number;
  title: string;
  /** Pre-formatted `**title** (#id)` ready to echo verbatim. */
  displayName: string;
  startedAt: string;
  minutesOpen: number;
  /**
   * Minutes since the most recent `session_log` event against this session,
   * or `minutesOpen` if no events have been logged yet. R7c uses this to
   * surface sessions that may have been left open by accident.
   */
  idleMinutes: number;
  /**
   * `true` when `idleMinutes` crosses {@link STALE_IDLE_MINUTES}. The
   * assistant should gently ask the user whether the session is still going or
   * should be closed. Never act on this without confirming.
   */
  mayBeStale: boolean;
  /**
   * Id of the parent story (or feature) the live task hangs under, if any.
   * R7d uses this so the assistant can compare against `story_match.topMatch`
   * and ask once if the chat's cwd seems to be on a different story now.
   */
  parentStoryId: number | null;
  /**
   * Pre-formatted `**title** (#id)` for the parent story; null when the task
   * has no parent. Echo verbatim — don't assemble.
   */
  parentStoryDisplayName: string | null;
  /** Repo folder the session's chat was started in; null on older sessions. */
  cwd: string | null;
  /**
   * Pre-shipped plain-English read on whose session this is, compared against
   * THIS chat's repo. Echo verbatim — don't assemble your own phrasing. See
   * SERVER_INSTRUCTIONS → PARALLEL CHATS.
   */
  repoHint: string;
}

export interface OrientPlanningHome {
  /** Absolute path the user has configured (or the default). */
  configuredPath: string;
  /** True if the user explicitly set the path; false if it's the default. */
  isExplicitlyConfigured: boolean;
}

export interface OrientLastSession {
  workItemId: number;
  title: string;
  /** Pre-formatted `**title** (#id)` ready to echo verbatim. */
  displayName: string;
  endedAt: string;
  summary: string | null;
  minutesAgo: number;
}

export interface OrientPacket {
  greeting: string;
  fetchedAt: string;
  sprint: {
    name: string;
    dayOfSprint: number;
    totalDays: number;
    daysRemaining: number;
    startDate: string;
    finishDate: string;
  };
  liveNow: OrientLiveSession[];
  /**
   * One-line plain-English nudge to open a session, set ONLY when no session
   * is open (liveNow is empty). Null when a session is already open. The
   * assistant surfaces this in its greeting. See SERVER_INSTRUCTIONS →
   * OPENING GREETING.
   */
  sessionReminder: string | null;
  lastSession: OrientLastSession | null;
  helperNotes: {
    /**
     * Number of un-dismissed helper notes. Bodies are NOT included in this
     * packet — call `helper_notes_get` to fetch them on demand. Keeping
     * bodies out of the greeting prevents pasting them verbatim.
     */
    openNudgeCount: number;
    /**
     * Pre-formatted sentence set when this orient swept away notes whose
     * work the board says is finished (or gone). Echo verbatim in the
     * greeting — don't rephrase. Null when nothing was cleared.
     */
    clearedNotesLine: string | null;
  };
  gaps: {
    storiesMissingPlanning: number;
    tasksMissingEstimate: number;
  };
  /**
   * Pre-formatted plain-English sentence set when an enabled scheduled
   * meeting (Daily, Planning, …) falls on today's date; null when none does
   * (or the schedule couldn't be read). Echo verbatim in the greeting —
   * don't rephrase.
   */
  ceremonyToday: string | null;
  /**
   * Hours-available-after-meetings vs planned hours for the sprint (from
   * Outlook). Null when the dashboard couldn't compute it.
   */
  capacity: Capacity | null;
  /**
   * Pre-formatted plain-English sentence about capacity. Null when no
   * calendar is wired up. Echo verbatim in the greeting instead of
   * computing your own phrasing from `capacity` — that's where the
   * banned word "slack" used to slip in.
   */
  capacitySummary: string | null;
  /**
   * Pre-formatted plain sentence: what can really be finished today in
   * today's free desk time. Null when there's no sprint. Echo verbatim.
   */
  fitsTodaySummary: string | null;
  /**
   * Pre-formatted plain-English question about all-day calendar entries that
   * overlap this sprint and may be the user's days off. The feed can't tell
   * on its own — the user's days off are published as all-day FREE entries,
   * the same as colleagues' vacations in the same calendar — so the user has
   * to confirm. Ask it verbatim in the greeting; store the answer with the
   * days-off tools. Null when there is nothing to ask.
   */
  daysOffQuestion: string | null;
  /**
   * The exact all-day ranges `daysOffQuestion` asked about, machine-readable
   * (YYYY-MM-DD, end inclusive). The assistant copies these strings verbatim
   * into `days_off_dismiss` / expands them for `days_off_set` — never
   * rebuilding dates from the human wording, where a wrong year is born.
   * Empty when there is no question.
   */
  daysOffCandidates: { start: string; end: string }[];
  /**
   * Where the user's sprintomatic planning home folder lives. The model
   * compares this against the chat's cwd: when they match (or a
   * `.sprintomatic-home` marker file is in the cwd), the model skips the
   * story-anchor ritual and runs sprint-wide skills. See SERVER_INSTRUCTIONS
   * → PLANNING HOME.
   */
  planningHome: OrientPlanningHome;
  /**
   * The feature the user is actively working in their workspace, or null. Lets a
   * resumed/compacted session re-anchor on the right feature folder without
   * guessing. displayName is pre-formatted `**title** (#id)` — echo verbatim.
   */
  activeFeature: {
    id: number;
    displayName: string;
    folderPath: string;
  } | null;
  discovery: {
    activeFeatureDisplayName: string;
    hasDiscovery: boolean;
    finished: boolean;
    demoStatus: string;
    startNudge: string | null;
    dayNudge: string | null;
    /** After discovery is finished: the walkthrough → demo → close sequence.
     *  Null while unfinished (the day/start nudges own that phase). */
    nextStep: string | null;
  } | null;
  /**
   * Set to the feature's `displayName` when nobody has said which kind it is.
   * Ask the user once — was this handed to them to work out, or did the user make it to
   * group stories the user already wrote — then call `feature_kind_set`.
   */
  featureKindUnknown: string | null;
  /**
   * Present when this chat's folder (or a parent up to the git root) holds
   * `.sprintomatic/link.json` — the user declared what this repo serves.
   * Echo each feature's `whereWeStand` sentence verbatim in the greeting.
   * `folderPath` is where the feature's design and discovery documents live —
   * read them directly when the work needs that context. Null when no link
   * file. Read fresh every time; nothing here is stored.
   */
  repoLink: OrientRepoLink | null;
  /**
   * Long-lived facts the user taught the tool ("the team's repos live under
   * <folder>", "demos are every second Thursday"). Background knowledge for
   * the model — never recited in the greeting. Saved via `fact_remember`,
   * removed via `fact_forget`. Empty array when nothing is stored yet.
   */
  facts: { name: string; body: string }[];
}


export function plainCapacitySummary(c: Capacity | null): string | null {
  if (!c) return null;
  if (!c.hasUrl) return null;
  if (c.fetchError) return null;
  const planned = Math.round(c.plannedHours);
  const available = Math.round(c.availableHours);
  const diff = Math.round(c.difference);
  // When the user has confirmed days off inside this sprint, say so — the
  // available number already has those whole days taken out. (A cached
  // payload from before this field existed simply reads as 0.)
  const daysOffClause =
    c.daysOff > 0 ? ` and ${c.daysOff === 1 ? '1 day off' : `${c.daysOff} days off`}` : '';
  if (diff >= 8) {
    return `You've planned about ${planned} hours of work this sprint and your calendar leaves about ${available} hours available after meetings${daysOffClause}, so you're roughly ${diff} hours over what fits.`;
  }
  if (diff <= -8) {
    return `You've planned about ${planned} hours of work this sprint and your calendar leaves about ${available} hours available after meetings${daysOffClause}, so there's about ${Math.abs(diff)} hours of room left if you want to pull something in.`;
  }
  return `You've planned about ${planned} hours of work this sprint and your calendar leaves about ${available} hours available after meetings${daysOffClause} — close to balanced.`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function humanDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAY_NAMES[dt.getDay()]} ${d} ${MONTH_NAMES[m - 1]}`;
}

/** `Thu 27 Aug` for a single day, `Mon 31 Aug – Fri 4 Sep` for a range. */
export function formatDayRange(startIso: string, endIso: string): string {
  if (startIso === endIso) return humanDay(startIso);
  return `${humanDay(startIso)} – ${humanDay(endIso)}`;
}

/** `A`, `A and B`, `A, B and C` — reads like a spoken list. */
function joinNaturally(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The pre-formatted days-off question for the greeting. Pure so it's unit
 * tested; buildOrientPacket gathers the inputs and passes them here.
 *
 * `candidates` are all-day calendar ranges nobody has ruled on yet;
 * `unbackedStored` are stored FUTURE days off no longer backed by any
 * all-day entry in the feed (the vacation may have been canceled).
 */
export function daysOffQuestionFor(
  candidates: { start: string; end: string }[],
  unbackedStored: string[] = [],
): string | null {
  const parts: string[] = [];
  if (candidates.length === 1) {
    parts.push(
      `Your calendar has an all-day entry on ${formatDayRange(candidates[0].start, candidates[0].end)}. `
      + `Is that you being off? Say so and I'll count it out of the sprint.`,
    );
  } else if (candidates.length > 1) {
    const listed = joinNaturally(candidates.map(r => formatDayRange(r.start, r.end)));
    parts.push(
      `Your calendar has all-day entries on ${listed}. `
      + `Are any of those you being off? Say which and I'll count them out of the sprint.`,
    );
  }
  if (unbackedStored.length === 1) {
    parts.push(
      `You have ${humanDay(unbackedStored[0])} stored as a day off, but the calendar no longer `
      + `shows an all-day entry there — if that time off was canceled, tell me and I'll put the day back.`,
    );
  } else if (unbackedStored.length > 1) {
    const listed = joinNaturally(unbackedStored.map(humanDay));
    parts.push(
      `You have ${listed} stored as days off, but the calendar no longer shows all-day entries `
      + `there — if that time off was canceled, tell me and I'll put the days back.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Gather the calendar + stored inputs for {@link daysOffQuestionFor} over
 *  the current sprint window. Throws when no calendar URL is configured —
 *  buildOrientPacket wraps the call, so a throw just means no question. */
async function buildDaysOffQuestion(
  sprintStartISO: string,
  sprintFinishISO: string,
  now: Date,
): Promise<{ question: string | null; candidates: { start: string; end: string }[] }> {
  if (!getCalendarUrl()) return { question: null, candidates: [] };
  const winStart = new Date(sprintStartISO);
  const winEnd = new Date(sprintFinishISO);
  const allDay = await listAllDayInWindow(winStart, winEnd);
  const windowStart = toIsoDate(winStart);
  const windowEnd = toIsoDate(winEnd);
  const candidates = candidateDayOffRanges(allDay, windowStart, windowEnd);
  // A stored FUTURE day off inside the sprint that no all-day entry backs any
  // more: the vacation may have been canceled, so say so once.
  const todayIso = toIsoDate(now);
  const unbacked = listDaysOff().filter(
    d =>
      d >= todayIso &&
      d >= windowStart &&
      d <= windowEnd &&
      !allDay.some(r => r.start <= d && d <= r.end),
  );
  return { question: daysOffQuestionFor(candidates, unbacked), candidates };
}

/**
 * One-line nudge for the assistant when NO work session is open. Naming
 * `session_start` here is also what prompts the assistant to reach for that
 * (possibly deferred) tool. Returns null when a session is already open —
 * don't nag. See SERVER_INSTRUCTIONS → OPENING GREETING.
 */
export function sessionReminderFor(liveSessionCount: number): string | null {
  if (liveSessionCount > 0) return null;
  return "You don't have a work session open. When you start working a task, call session_start on it so your progress gets recorded.";
}

/**
 * Plain-English label for a live session's home repo, from this chat's point
 * of view. 'unknown' sides never warn and never claim a match.
 */
export function repoHintFor(sessionCwd: string | null, chatCwd: string | null): string {
  const ownership = sessionOwnershipHint(sessionCwd, chatCwd);
  // The stored value is a whole path. Show only the last folder name — the
  // greeting has to stay short and readable out loud.
  const shown = sessionCwd ? basename(sessionCwd) : null;
  if (ownership === 'mine') return `started from \`${shown}\` — matches this chat`;
  if (ownership === 'other-repo') return `started from \`${shown}\` — a different chat's work`;
  return shown ? `started from \`${shown}\`` : 'repo unknown (older session)';
}

/** Map the stored active feature to orient's packet field. Pure so it's unit
 *  tested; buildOrientPacket just calls getActiveFeature() and passes it here. */
export function activeFeatureField(
  af: ActiveFeature | null,
): { id: number; displayName: string; folderPath: string } | null {
  if (!af) return null;
  return { id: af.id, displayName: displayNameFor(af.id, af.title), folderPath: af.folderPath };
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MS_PER_MIN = 1000 * 60;

function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return 'Hey, still up';
  if (h < 12) return 'Good morning';
  if (h < 14) return 'Around noon';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function sprintProgress(
  startISO: string,
  finishISO: string,
  now: Date,
): { dayOfSprint: number; totalDays: number; daysRemaining: number } {
  const start = new Date(startISO);
  const finish = new Date(finishISO);
  const totalDays = Math.max(1, Math.round((finish.getTime() - start.getTime()) / MS_PER_DAY) + 1);
  const raw = Math.floor((now.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  const dayOfSprint = Math.max(1, Math.min(totalDays, raw));
  const daysRemaining = Math.max(0, totalDays - dayOfSprint);
  return { dayOfSprint, totalDays, daysRemaining };
}

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_MIN));
}

function getLastEndedSession(): SessionRow | null {
  return (
    getDb()
      .prepare<[], SessionRow>(
        `SELECT * FROM sessions
         WHERE ended_at IS NOT NULL
         ORDER BY datetime(ended_at) DESC, id DESC
         LIMIT 1`,
      )
      .get() ?? null
  );
}

/** Cap so a link file edited by hand can't turn one greeting into a long row
 *  of board calls. */
const REPO_LINK_MAX_IDS = 4;

/** The side-effecting bits of {@link repoLinkFor}, injected so the logic
 *  around them can be tested without a disk or the board. Same pattern as
 *  `listTouchedFeatureFolders` taking its `readdir`. */
export interface RepoLinkDeps {
  readLink: typeof readRepoLink;
  fetchWorkItem: typeof getWorkItem;
  featureFolders: () => Array<{ id: number; folderPath: string }>;
  folderStage: (folderPath: string) => { stage: FeatureStage; demoBuilt: boolean };
}

const REAL_REPO_LINK_DEPS: RepoLinkDeps = {
  readLink: readRepoLink,
  fetchWorkItem: getWorkItem,
  featureFolders: () => listTouchedFeatureFolders(
    getWorkspaces().paths.map(expandHome),
    dir => readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name),
  ),
  folderStage: (folderPath: string) => {
    const status = discoveryStatus(folderPath);
    const design = readDesignDoc(folderPath);
    return {
      stage: stageFor({
        hasDiscovery: status.hasDiscovery,
        discoveryFinished: status.finished,
        hasDesignDoc: design !== null,
        designPushed: (design?.pushed.storyIds.length ?? 0) > 0,
      }),
      demoBuilt: status.hasDemoHtml,
    };
  },
};

/** Say so when a hand-written link file names more ids than we read. Going
 *  quiet here would describe four features and drop the rest without a word. */
function overCapNote(ids: number[], kind: 'features' | 'stories', dir: string): string | null {
  const extra = ids.length - REPO_LINK_MAX_IDS;
  if (extra <= 0) return null;
  return `The link file at ${dir} names ${ids.length} ${kind}. Only the first `
    + `${REPO_LINK_MAX_IDS} are read here, so ${extra} ${extra === 1 ? 'is' : 'are'} `
    + 'left out of this greeting.';
}

/**
 * The read-time view of this folder's `.sprintomatic/link.json`. Derived
 * fresh on every call — nothing is stored. Every failure (bad id, board read
 * that fell over, no folder in any workspace) becomes a plain-English note, so
 * a broken link file can never stop the greeting.
 */
export async function repoLinkFor(
  chatCwd: string | null,
  deps: RepoLinkDeps = REAL_REPO_LINK_DEPS,
): Promise<OrientRepoLink | null> {
  if (!chatCwd) return null;
  // A bare folder name is not a full path, and readRepoLink says null to those.
  const link = deps.readLink(chatCwd);
  if (!link) return null;

  const notes: string[] = [];
  for (const note of [
    overCapNote(link.features, 'features', link.dir),
    overCapNote(link.stories, 'stories', link.dir),
  ]) {
    if (note) notes.push(note);
  }
  const folders = deps.featureFolders();

  const features: RepoLinkFeatureInput[] = [];
  for (const id of link.features.slice(0, REPO_LINK_MAX_IDS)) {
    try {
      const wi = await deps.fetchWorkItem(id);
      const folderPath = folders.find(f => f.id === id)?.folderPath ?? null;
      // No folder means the stage is UNKNOWN, not "no discovery yet" — the
      // sentence must not make a claim about the work just because a folder
      // was missed. Null drops the stage half, the way a closed feature does.
      let stage: FeatureStage | null = null;
      let demoBuilt = false;
      if (folderPath) {
        ({ stage, demoBuilt } = deps.folderStage(folderPath));
      } else {
        notes.push(
          `${displayNameFor(id, wi.title)} is linked from this repo but has no folder in any workspace, so its stage can't be read.`,
        );
      }
      features.push({
        id,
        title: wi.title,
        boardState: wi.state,
        folderPath,
        stage,
        demoBuilt,
        childStories: wi.children
          .filter(c => /user story/i.test(c.type))
          .map(c => ({ id: c.id, title: c.title, state: c.state })),
      });
    } catch {
      notes.push(
        `The linked feature #${id} couldn't be read from the board — check the id in .sprintomatic/link.json at ${link.dir}.`,
      );
    }
  }

  const stories: RepoLinkStoryInput[] = [];
  for (const id of link.stories.slice(0, REPO_LINK_MAX_IDS)) {
    try {
      const wi = await deps.fetchWorkItem(id);
      stories.push({ id, title: wi.title, state: wi.state });
    } catch {
      notes.push(
        `The linked story #${id} couldn't be read from the board — check the id in .sprintomatic/link.json at ${link.dir}.`,
      );
    }
  }

  return repoLinkBlock(features, stories, notes);
}

export async function buildOrientPacket(chatCwd: string | null = null): Promise<OrientPacket> {
  const { payload } = await buildDashboardCached();
  if (!payload.sprint) {
    throw new Error('No current sprint — set a sprint first.');
  }
  const sprint = payload.sprint;
  const now = new Date();

  const titleById = new Map<number, string>();
  const parentByTaskId = new Map<number, { id: number; title: string }>();
  for (const list of [payload.workItems.inProgress, payload.workItems.upNext, payload.workItems.done]) {
    for (const w of list) {
      titleById.set(Number(w.id), w.title);
      if (w.parent) {
        parentByTaskId.set(Number(w.id), {
          id: Number(w.parent.id),
          title: w.parent.title,
        });
      }
    }
  }
  for (const g of payload.userStories) {
    titleById.set(Number(g.id), g.title);
  }

  const activeSessions = listActiveSessions();
  const lastEventBySession = getLastEventTimestampMap(activeSessions.map(s => s.id));
  // chatCwd is the caller-supplied chat folder (from the model's cwd). It stays
  // a full path when the model had one, and is only a bare folder name when
  // that is all it had. Null when unknown → no repo match.
  const liveNow: OrientLiveSession[] = activeSessions.map(s => {
    const title = titleById.get(s.workItemId) ?? `#${s.workItemId}`;
    const lastActivity = lastEventBySession.get(s.id) ?? s.startedAt;
    const idleMinutes = minutesSince(lastActivity, now);
    const parent = parentByTaskId.get(s.workItemId) ?? null;
    return {
      sessionId: s.id,
      workItemId: s.workItemId,
      title,
      displayName: displayNameFor(s.workItemId, title),
      startedAt: s.startedAt,
      minutesOpen: minutesSince(s.startedAt, now),
      idleMinutes,
      mayBeStale: idleMinutes >= STALE_IDLE_MINUTES,
      parentStoryId: parent?.id ?? null,
      parentStoryDisplayName: parent ? displayNameFor(parent.id, parent.title) : null,
      cwd: s.cwd,
      repoHint: repoHintFor(s.cwd, chatCwd),
    };
  });

  const lastRow = getLastEndedSession();
  const lastSession: OrientLastSession | null = lastRow
    ? (() => {
        const title = titleById.get(lastRow.work_item_id) ?? `#${lastRow.work_item_id}`;
        return {
          workItemId: lastRow.work_item_id,
          title,
          displayName: displayNameFor(lastRow.work_item_id, title),
          endedAt: lastRow.ended_at as string,
          summary: lastRow.summary,
          minutesAgo: minutesSince(lastRow.ended_at as string, now),
        };
      })()
    : null;

  let storiesMissingPlanning = 0;
  for (const g of payload.userStories) {
    if (g.storyPoints == null || g.effort == null) storiesMissingPlanning++;
  }
  let tasksMissingEstimate = 0;
  for (const w of [...payload.workItems.inProgress, ...payload.workItems.upNext]) {
    if (w.originalEstimate == null) tasksMissingEstimate++;
  }

  // Surface capacity from the dashboard payload; fire a once-per-sprint nudge
  // if the gap is big and we actually have calendar data to back it.
  const capacity = payload.outlookCapacity;
  if (capacity && capacity.hasUrl && !capacity.fetchError) {
    ensureCapacityNudge({
      sprintName: sprint.name,
      difference: capacity.difference,
      availableHours: capacity.availableHours,
      plannedHours: capacity.plannedHours,
    });
  }

  // Stale-Remaining scan: tasks in 'going' state with no session activity in
  // 2+ days get a helper note naming the task. Deduped per task per sprint.
  const staleCandidates = payload.workItems.inProgress
    .filter(w => w.type.toLowerCase() === 'task')
    .map(w => ({
      workItemId: Number(w.id),
      title: w.title,
      remainingWork: w.remainingWork ?? null,
    }));
  scanStaleRemaining({ sprintName: sprint.name, candidates: staleCandidates });

  // Sweep the open notes against the board, then read what's left. A note
  // pointing at work the board says is finished (or that's gone from the
  // board) is cleared here — the board is proof, so no asking — and the
  // greeting reports it in one pre-formatted line. Anything with doubt
  // (pinned, no linked item, item still open) stays for the assistant to
  // raise with the user. Runs AFTER the nudges above so a just-added nudge
  // shows in this same orient response. Belt and braces: a board surprise
  // must not cost the greeting — on failure nothing is cleared and we fall
  // back to the plain read.
  let notesCleared: ClearedNote[] = [];
  let openNoteCount: number;
  try {
    const review = await reviewNotesAgainstBoard(ids =>
      getWorkItemsWithParents(ids, { errorPolicy: 'omit' }),
    );
    notesCleared = review.cleared;
    openNoteCount = review.notes.length;
  } catch {
    openNoteCount = getHelperNotes().notes.length;
  }

  const planningHome = getPlanningHome();

  // With Discovery and Design both turned off there is no feature work to
  // anchor on, so no feature, no kind question and no discovery nudge.
  const pages = getPages();
  const af = pages.discovery || pages.design ? getActiveFeature() : null;
  const activeFeature = activeFeatureField(af);

  // A feature arrives one of two ways, and they need opposite things from
  // orient. 'handed' → the discovery/design path. 'grouping' → the user wrote the
  // stories first; there is nothing to discover, so every discovery nudge is a
  // lie. Unknown → say so and ask, never guess.
  const featureKind = af ? getFeatureKind(af.id) : null;

  let discovery: OrientPacket['discovery'] = null;
  if (af && featureKind === 'handed' && pages.discovery) {
    const status = discoveryStatus(af.folderPath);
    // No discovery file → no day count at all. The old code passed `af.setAt`
    // unconditionally, so a feature with no discovery still got told its
    // discovery had run past three days. When there IS one, count from when the
    // file appeared, not from when the folder was opened.
    const startedAt = status.hasDiscovery
      ? discoveryStartedAt(af.folderPath) ?? af.setAt
      : null;
    const { stage } = discoveryDayStage({ firstSessionAt: startedAt, now });
    discovery = {
      activeFeatureDisplayName: displayNameFor(af.id, af.title),
      hasDiscovery: status.hasDiscovery,
      finished: status.finished,
      demoStatus: status.demoStatus,
      startNudge: discoveryStartNudge(status),
      dayNudge: discoveryDayNudge(stage),
      nextStep: discoveryNextStep(status),
    };
  }


  // Only when nobody has said which kind this feature is. The
  // workspace_feature_folder gate normally stops this happening, but a kind
  // cleared by hand must not silently fall back to the wrong path.
  const featureKindUnknown =
    af && featureKind === null ? displayNameFor(af.id, af.title) : null;

  // Belt and braces: orient runs at the start of every chat, so even a
  // surprise from the filesystem or the settings table must not cost the
  // greeting. No link block is better than no greeting.
  let repoLink: OrientRepoLink | null = null;
  try {
    repoLink = await repoLinkFor(chatCwd);
  } catch {
    repoLink = null;
  }

  // Belt and braces: the days-off question needs the calendar feed AND the
  // settings table, and a surprise from either must not cost the greeting.
  // No question is better than no greeting.
  let daysOffQuestion: string | null = null;
  let daysOffCandidates: { start: string; end: string }[] = [];
  try {
    const d = await buildDaysOffQuestion(sprint.startDate, sprint.finishDate, now);
    daysOffQuestion = d.question;
    daysOffCandidates = d.candidates;
  } catch {
    daysOffQuestion = null;
    daysOffCandidates = [];
  }

  // Belt and braces again: the ceremony schedule lives in the settings table,
  // and a surprise there must not cost the greeting. No today-line is better
  // than no greeting.
  let ceremonyToday: string | null = null;
  try {
    ceremonyToday = ceremonyTodayLine(
      getCeremonySchedule(),
      new Date(sprint.startDate),
      new Date(sprint.finishDate),
      now,
    );
  } catch {
    ceremonyToday = null;
  }

  // Same belt and braces: a surprise from the facts table must not cost the
  // greeting. An empty list reads exactly like "nothing stored yet".
  let facts: { name: string; body: string }[] = [];
  try {
    facts = factsForOrient();
  } catch {
    facts = [];
  }

  return {
    greeting: greetingFor(now),
    fetchedAt: now.toISOString(),
    sprint: {
      name: sprint.name,
      ...sprintProgress(sprint.startDate, sprint.finishDate, now),
      startDate: sprint.startDate,
      finishDate: sprint.finishDate,
    },
    liveNow,
    sessionReminder: sessionReminderFor(liveNow.length),
    lastSession,
    helperNotes: {
      openNudgeCount: openNoteCount,
      clearedNotesLine: clearedNotesLine(notesCleared),
    },
    gaps: {
      storiesMissingPlanning,
      tasksMissingEstimate,
    },
    ceremonyToday,
    capacity,
    capacitySummary: plainCapacitySummary(capacity),
    fitsTodaySummary: payload.fitsToday?.summary ?? null,
    daysOffQuestion,
    daysOffCandidates,
    planningHome: {
      configuredPath: planningHome.configuredPath,
      isExplicitlyConfigured: planningHome.isExplicitlyConfigured,
    },
    activeFeature,
    discovery,
    featureKindUnknown,
    repoLink,
    facts,
  };
}
