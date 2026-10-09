import { useEffect, useRef, useState } from 'react';

// Mirrors server/dashboard.ts → DashboardPayload exactly. Keep in sync manually
// until we extract a shared types package.
export interface ApiParent {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
}

export type SessionEventType = 'focus' | 'progress' | 'blocker' | 'decision' | 'note';

export interface ApiSessionEvent {
  id: number;
  sessionId: string;
  workItemId: number;
  type: SessionEventType;
  text: string;
  createdAt: string;
}

export interface ApiActiveSession {
  id: string;
  startedAt: string;
  /** True when this session's chat is stopped, waiting on the user's answer. */
  waiting?: boolean;
  /** Minutes since the session's last logged activity. */
  idleMinutes?: number;
  /** At-a-glance mark for a Focus panel. Absent on older payloads. */
  state?: 'working' | 'waiting' | 'stale';
}

export interface ApiNeedsYouWaiting {
  workItemId: number;
  displayName: string;
  question: string;
  waitingSince: string;
}

export interface ApiNeedsYouFinished {
  workItemId: number;
  displayName: string;
  summary: string | null;
  endedAt: string;
}

export interface ApiNeedsYou {
  waiting: ApiNeedsYouWaiting[];
  recentlyFinished: ApiNeedsYouFinished[];
}

export interface ApiWrapOpenSession {
  workItemId: number;
  /** Pre-formatted `**title** (#id)` — same shape as needs-you rows. */
  displayName: string;
  startedAt: string;
}

export interface ApiWrapFirstMove {
  workItemId: number;
  displayName: string;
  /** Hours left on the item; null = unknown, render without the hours part. */
  remainingHours: number | null;
}

export interface ApiWrap {
  isWorkingDay: boolean;
  /** Newest session activity today (ISO); null = nothing happened today. */
  lastActivityAt: string | null;
  stillOpen: ApiWrapOpenSession[];
  firstMove: ApiWrapFirstMove | null;
}

export interface ApiHelperNote {
  id: number;
  body: string;
  createdAt: string;
  pinnedAt: string | null;
  workItemId: number | null;
}

export interface ApiHelperNotes {
  notes: ApiHelperNote[];
}

/** Outlook-calendar derived capacity for the current sprint. */
export interface ApiOutlookCapacity {
  sprintStart: string;
  sprintEnd: string;
  workingDays: number;
  workingDaysRemaining: number;
  workdayHours: number;
  workingHoursTotal: number;
  /** Working hours left from today on (workingDaysRemaining × workdayHours). */
  workingHoursRemaining: number;
  meetingHours: { busy: number; tentative: number; oof: number; weighted: number };
  availableHours: number;
  /** Real desk time still ahead — counts down as the sprint progresses. */
  availableHoursRemaining: number;
  plannedHours: number;
  /** plannedHours - availableHours. Positive = planned over capacity. */
  difference: number;
  /** False when no calendar URL is configured. */
  hasUrl: boolean;
  /** Non-empty when the ICS fetch failed. */
  fetchError?: string;
}

export interface ApiWorkItem {
  id: string;
  title: string;
  type: string;
  state: string;
  story: string;
  parent?: ApiParent;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  descriptionPreview?: string;
  area?: string;
  /** Seconds tracked locally that ADO doesn't know about yet. */
  localUncapturedSeconds: number;
  /** Total seconds the timer ran across ALL sittings — the "LOGGED" value. */
  localLoggedSeconds: number;
  /** ISO timestamp of the currently-running timer's start, if any. */
  runningSince?: string;
  /** Live Claude Code session against this item, if one is open right now. */
  activeSession?: ApiActiveSession;
  /** Newest-first session events reported by Claude Code via MCP. */
  recentActivity: ApiSessionEvent[];
  /** Number of work sessions (open or closed) recorded against this item. */
  sessionCount: number;
  /** Parsed System.Tags. Contains "Blocked" when this task itself is tagged blocked. */
  tags?: string[];
  /** Parent story's tags — surfaced so a task can show its parent story is blocked. */
  parentTags?: string[];
  /** True when sprintomatic itself created this item via MCP. Local-only. */
  wasSHCreated?: boolean;
  url: string;
}

export interface ApiSprint {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  totalDays: number;
  /** The user's working weekdays (0=Sun … 6=Sat). */
  workingDays: number[];
}

export interface ApiSprintOption {
  id: string;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  isCurrent: boolean;
}

export interface ApiUserStoryGroup {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
  descriptionPreview?: string;
  area?: string;
  parentEstimate?: number;
  parentRemaining?: number;
  /** Story-level planning fields the POM delivery manager watches. */
  storyPoints?: number;
  effort?: number;
  /** The Feature / Epic above this story, if any. The Daily view groups by this. */
  feature?: { id: string; title: string; type: string };
  tasks: ApiWorkItem[];
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  counts: { inProgress: number; upNext: number; done: number };
  /** Newest-first session events rolled up across child tasks. Capped at 5. */
  recentActivity: ApiSessionEvent[];
  /** True if any child task has a live Claude Code session right now. */
  hasActiveSession: boolean;
  /** Parsed System.Tags on the story. Contains "Blocked" when tagged blocked. */
  tags?: string[];
  /** True when sprintomatic itself created this story via MCP. Local-only. */
  wasSHCreated?: boolean;
  /** Set when every open task of this open story sits in another sprint: that sprint's name, or "other sprints". */
  movedTo?: string | null;
}

export type CeremonyId = 'daily' | 'preplan' | 'plan' | 'demo' | 'retro';
export type ModeId = 'day' | 'plan' | 'retro' | 'dnd';

export interface ApiUpcomingCeremony {
  id: CeremonyId;
  label: string;
  startsAt: string;        // ISO
  minutesUntil: number;
  isSuggested: boolean;
}

export interface ApiStandupTask {
  workItemId: number;
  title: string;
  /** Raw ADO state ("Active" / "Blocked" / "Done" / etc.). */
  adoState: string;
}

export interface ApiStandupEntry {
  /** The story this row is about. (Sessions on Tasks roll up to their parent Story.) */
  workItemId: number;
  /** Pre-formatted `**title** (#id)` ready to echo. */
  displayName: string;
  summary: string | null;
  minutesInWindow: number | null;
  state: 'live' | 'paused' | 'closed';
  /** The story's real Azure DevOps state — drives the status pill. */
  storyState?: string;
  /** Tasks under this story that had session activity in the window. */
  tasks: ApiStandupTask[];
}

export interface ApiStandupBlock {
  yesterdayDate: string;
  todayDate: string;
  yesterday: ApiStandupEntry[];
  today: ApiStandupEntry[];
}

export interface ApiDiscovery {
  activeFeature: { id: number; displayName: string; folderPath: string } | null;
  /** Managed features other than the active one — the active feature has its
   *  own "On now" spot on the card. */
  managed: { id: number; displayName: string }[];
  /** Total managed features (active one included). Optional: a dev server
   *  started before this field existed still serves the old payload shape. */
  managedCount?: number;
  hasWorkspace: boolean;
}

export type DndStatus = 'in-progress' | 'not-started' | 'closed';

export interface ApiFeatureListEntry {
  id: number;
  displayName: string;
  folderPath: string;
  dndStatus: DndStatus;
  boardState: string | null;
  dayLabel: string | null;
  /** In-progress + the discovery file is complete → show a "ready to close" hint. */
  readyToClose?: boolean;
}
export interface ApiFeatureSection { status: DndStatus; features: ApiFeatureListEntry[] }
export interface DiscoveryListPayload { sections: ApiFeatureSection[] }

export type ApiDiscoveryTag = 'diff'|'risk'|'fact'|'option'|'dep'|'mitigation';
export interface ApiDiscoveryItem { text: string; tags: ApiDiscoveryTag[] }
export interface ApiDiscoveryGroup { name: string; items: ApiDiscoveryItem[] }
export interface ApiDiscoveryDoc {
  problem: string;
  flow: string[];
  groups: ApiDiscoveryGroup[];
  lanes: { ours: string; techLead: string };
  demo: { status: 'none'|'scheduled'|'built'; shape: string; date: string; notes: string };
  openQuestions: string[];
  /** "What we don't accept as-is" — pushback for the product talk. Older payloads omit it. */
  pushback?: string[];
  /** Parts USER agreed after a walk-through (keys like 'flow', 'group:<name>'). Older payloads omit it. */
  agreed?: string[];
}
export interface ApiDiscoveryChild {
  id: number;
  title: string;
  type: string;
  state: string;
}
/** One discovery-meeting summary (a dated markdown file the chat wrote). */
export interface ApiDiscoveryMeeting {
  file: string;
  /** YYYY-MM-DD from the filename; '' when the name has no date prefix. */
  date: string;
  title: string;
  /** Markdown body; headings pre-normalized to the house **bold** lines. */
  body: string;
}
/** Disk-backed part of a feature — reads instantly, never waits on the board. */
export interface DiscoveryDocPayload {
  folderPath: string;
  doc: ApiDiscoveryDoc | null;
  /** Whether the session has built each HTML artifact (shown in Discovery sub-tabs). */
  hasWalkthrough: boolean;
  hasDemoHtml: boolean;
  /** Meeting summaries from discovery/meetings/, newest first. */
  meetings: ApiDiscoveryMeeting[];
}

/** Board-backed part of a feature — a separate request so a slow ADO never
 *  stalls the disk-backed doc. `reachable` is false when ADO was down. */
export interface DiscoveryBoardPayload {
  reachable: boolean;
  /** The feature's own ADO state (Active / Closed / …). Absent if ADO was down. */
  featureState?: string;
  /** The feature's description as plain text (HTML stripped). Absent if empty/ADO down. */
  featureDescription?: string;
  /** The feature's child stories/tasks from the board. Empty if none / ADO down. */
  children: ApiDiscoveryChild[];
}

/** One story proposed by the design (mirrors server/design.ts DesignStory). */
export interface ApiDesignStory {
  title: string;
  covers: string;
  estimateHours: number;
  why: string;
}
/** The design source file's shape (mirrors server/design.ts DesignDoc). */
export interface ApiDesignDoc {
  approach: { lines: string[]; diagram: string };
  /** "Not in this design" — deliberate scope cuts. Optional: older servers omit it. */
  outOfScope?: string[];
  flows: { name: string; steps: string[]; diagram: string }[];
  stories: ApiDesignStory[];
  plan: { step: string; stories: string[]; note: string }[];
  decisions: { question: string; choice: string; decidedInMeeting: string }[];
  review: { status: 'none' | 'scheduled' | 'done'; date: string };
  pushed: { at: string; storyIds: number[] };
  /** Agree-per-part record. Keys: 'approach','flows','plan','decisions','story:<title>'. */
  agreed: string[];
}
/** Disk-backed design phase for a feature — reads instantly, never waits on the board. */
export interface DesignPayload {
  folderPath: string;
  doc: ApiDesignDoc | null;
  /** The discovery's problem line — the review's opening. Optional: older servers omit it. */
  problem?: string;
  meetings: ApiDiscoveryMeeting[];
  diagrams: string[];
  hasWalkthrough: boolean;
}

/** The disk-backed design doc — instant, no board dependency. */
export async function fetchDesign(id: number): Promise<DesignPayload> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}/design`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`design doc failed: ${r.status}`);
  return r.json() as Promise<DesignPayload>;
}

export async function fetchDiscoveryList(): Promise<DiscoveryListPayload> {
  const r = await fetch('/api/discovery', { cache: 'no-store' });
  if (!r.ok) throw new Error(`discovery list failed: ${r.status}`);
  return r.json() as Promise<DiscoveryListPayload>;
}

/** The disk-backed doc — instant, no board dependency. */
export async function fetchDiscoveryDoc(id: number): Promise<DiscoveryDocPayload> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`discovery doc failed: ${r.status}`);
  return r.json() as Promise<DiscoveryDocPayload>;
}

/** The board-backed part — Overview only. Own request so a slow ADO can't stall the doc. */
export async function fetchDiscoveryBoard(id: number): Promise<DiscoveryBoardPayload> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}/board`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`discovery board failed: ${r.status}`);
  return r.json() as Promise<DiscoveryBoardPayload>;
}

export async function markDiscoveryDemo(
  id: number, body: { status: 'none'|'scheduled'|'built'; date: string },
): Promise<{ demo: ApiDiscoveryDoc['demo'] }> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}/demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`mark demo failed: ${r.status}`);
  return r.json() as Promise<{ demo: ApiDiscoveryDoc['demo'] }>;
}

export async function openDiscoveryFolder(id: number): Promise<{ ok: boolean }> {
  const r = await fetch(`/api/discovery/${encodeURIComponent(id)}/open-folder`, { method: 'POST' });
  if (!r.ok) throw new Error(`open folder failed: ${r.status}`);
  return r.json() as Promise<{ ok: boolean }>;
}

export interface ApiPayload {
  /**
   * Set only when the server's background refresh has failed several times in a
   * row — the numbers on screen are frozen and won't fix themselves. Absent in
   * the normal case. Before this existed a failing refresh was silent, so the
   * dashboard could show old data indefinitely with nothing to see.
   */
  refreshError?: string | null;
  user: string;
  sprint: ApiSprint | null;
  sprintOptions: ApiSprintOption[];
  workItems: {
    inProgress: ApiWorkItem[];
    upNext: ApiWorkItem[];
    done: ApiWorkItem[];
  };
  userStories: ApiUserStoryGroup[];
  capacity: {
    remainingHours: number;
    completedHours: number;
    totalEstimateHours: number;
  };
  /** Outlook-calendar derived capacity, null when there's no sprint. */
  outlookCapacity: ApiOutlookCapacity | null;
  pendingChanges: number;
  /** Which halves of the Discovery & Design page are turned on. Older payloads omit it. */
  pages?: { discovery: boolean; design: boolean };
  /** Number of live Claude Code sessions reporting in right now. */
  activeSessions: number;
  /** The assistant's read on the sprint: a living summary + a few open nudges. */
  helperNotes: ApiHelperNotes;
  /** What got worked yesterday + what's open today, for the morning standup. */
  standup: ApiStandupBlock;
  /** Unfinished tasks left behind in a previous sprint, offered to pull in. Null when none. */
  carryForward: {
    taskIds: number[];
    /** Tasks under the story they belong to — same story-first shape as Focus
     *  and the standup card. */
    groups: {
      storyId: number | null;
      /** Ready to show. Null when the task hangs under no story. */
      storyDisplayName: string | null;
      tasks: { id: number; title: string }[];
    }[];
    count: number;
    /** Reads straight after "N unfinished tasks from ": "26_16, last sprint". */
    fromLabel: string;
  } | null;
  needsYou: ApiNeedsYou;
  /** End-of-day wrap facts; absent on older server payloads. */
  wrap?: ApiWrap;
  ceremonies: {
    upcoming: ApiUpcomingCeremony[];
    next: ApiUpcomingCeremony | null;
    suggestedModeId: ModeId | null;
  };
  /** Live sessions on items outside the current sprint (Discovery & Design work). Optional. */
  liveOutsideSprint?: ApiWorkItem[];
  /** Discovery & Design rail card data. Optional (older payloads omit it). */
  discovery?: ApiDiscovery;
  fetchedAt: string;
}

/** Schedule API — same vocabulary as the mode ids, with `daily` for the Daily event. */
export type CeremonyRecurrence =
  | { kind: 'weekdays'; time: string }
  | { kind: 'sprint_relative'; weekOfSprint: 1 | 2; dayOfWeek: number; time: string };

export interface CeremonyConfig {
  id: CeremonyId;
  label: string;
  enabled: boolean;
  recurrence: CeremonyRecurrence;
}

export interface CeremonySchedule {
  version: 1;
  ceremonies: CeremonyConfig[];
}

export async function getSchedule(): Promise<CeremonySchedule> {
  const r = await fetch('/api/schedule', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load schedule');
  return body as CeremonySchedule;
}

export async function putSchedule(schedule: CeremonySchedule): Promise<CeremonySchedule> {
  const r = await fetch('/api/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not save schedule');
  return body as CeremonySchedule;
}

/* -------------------------------------------------------------------------- */
/*  Settings (server/settings-registry.ts)                                    */
/* -------------------------------------------------------------------------- */

export interface ApiSetting {
  key: string;
  env: string;
  group: 'week' | 'board' | 'pages' | 'other';
  label: string;
  help: string;
  kind: 'days' | 'hour' | 'number' | 'text' | 'choice' | 'secret';
  choices?: { value: string; label: string }[];
  defaultLabel: string;
  defaultValue?: string;
  /** Always null for the token. */
  value: string | null;
  source: 'env' | 'setting' | 'default' | 'keychain';
  locked: boolean;
}

export interface ApiSettings {
  settings: ApiSetting[];
  keychain: boolean;
  tokenCanMoveToKeychain: boolean;
}

export interface ApiBoardCheck {
  ok: boolean;
  states?: Record<'waiting' | 'going' | 'blocked' | 'done', string | null>;
  error?: string;
  fix?: string;
  setupNeeded?: boolean;
}

async function settingsCall<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/settings${path}`, { cache: 'no-store', ...init });
  const body = (await r.json()) as T & { error?: string; key?: string };
  // `key` names the field a refused save is about, so the screen can point at it.
  if (!r.ok) throw Object.assign(new Error(body.error ?? `Request failed (${r.status})`), { key: body.key });
  return body;
}

export function getSettings(): Promise<ApiSettings> {
  return settingsCall<ApiSettings>('');
}

export function putSettings(values: Record<string, string>): Promise<ApiSettings> {
  return settingsCall<ApiSettings>('', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
}

export function checkBoard(): Promise<ApiBoardCheck> {
  return settingsCall<ApiBoardCheck>('/check', { method: 'POST' });
}

export function moveTokenToKeychain(): Promise<ApiSettings> {
  return settingsCall<ApiSettings>('/move-token', { method: 'POST' });
}

export interface ApiError {
  error: string;
  command?: string;
  /** Short headline for the failure, when the server could name one. */
  headline?: string;
  /** The one thing to do about it, when there is one. */
  fix?: string;
  /** Something was never filled in — show "not set up yet", not an error. */
  setupNeeded?: boolean;
}

export type FetchState =
  | { status: 'loading' }
  | { status: 'ok'; data: ApiPayload }
  | { status: 'error'; error: string; command?: string; headline?: string; fix?: string; setupNeeded?: boolean };

// How often the live board re-fetches on its own. Tuned for "feels live"
// without hammering: the read is served from the server's cache.
const DASHBOARD_AUTO_REFRESH_MS = 15_000;

export function useDashboardData(sprintName?: string): { state: FetchState; refresh: () => void } {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  // True once we've scheduled a follow-up refetch for the current stale chain,
  // so a chain of stale responses can't spin into an infinite refetch loop.
  const staleRetryRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Keep the rendered dashboard while a refresh is in flight; only flash the
    // loading shell on the initial mount or after an error.
    setState(prev => (prev.status === 'ok' ? prev : { status: 'loading' }));
    const url = sprintName
      ? `/api/dashboard?sprint=${encodeURIComponent(sprintName)}`
      : '/api/dashboard';
    fetch(url, { cache: 'no-store' })
      .then(async r => {
        const body = (await r.json()) as ApiPayload | ApiError;
        const stale = r.headers.get('X-Cache') === 'stale';
        if (cancelled) return;
        if ('error' in body) {
          setState({
            status: 'error', error: body.error, command: body.command, headline: body.headline, fix: body.fix,
            setupNeeded: body.setupNeeded,
          });
          return;
        }
        setState({ status: 'ok', data: body });
        if (stale) {
          // The server is refreshing in the background — pick up the fresh
          // data after it lands. Only retry once per stale chain.
          if (!staleRetryRef.current) {
            staleRetryRef.current = true;
            retryTimer = setTimeout(() => {
              if (!cancelled) setNonce(n => n + 1);
            }, 3000);
          }
        } else {
          staleRetryRef.current = false;
        }
      })
      .catch(err => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [nonce, sprintName]);

  // Quiet auto-refresh so the live board (Daily + Focus) keeps itself current
  // without a manual reload. Reads the server's short-lived cache, so it's
  // cheap. Pauses while the tab is hidden, and refreshes once on return so a
  // tab you come back to is never stale.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNonce(n => n + 1);
    };
    const id = setInterval(tick, DASHBOARD_AUTO_REFRESH_MS);
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) setNonce(n => n + 1);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, []);

  return { state, refresh: () => setNonce(n => n + 1) };
}

/* -------------------------------------------------------------------------- */
/*  Work item detail                                                          */
/* -------------------------------------------------------------------------- */

export interface ApiWorkItemRef {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  rel?: string;
}

export interface ApiWorkItemDetail {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  iterationPath: string;
  areaPath: string;
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  tags?: string;
  priority?: number;
  createdDate: string;
  createdBy?: string;
  changedDate: string;
  changedBy?: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  parent?: ApiWorkItemRef;
  children: ApiWorkItemRef[];
  related: ApiWorkItemRef[];
  webUrl: string;
}

export interface ApiWorkItemComment {
  id: number;
  text: string;
  createdBy?: string;
  createdDate: string;
}

export interface ApiWorkItemDetailResponse {
  item: ApiWorkItemDetail;
  comments: ApiWorkItemComment[];
}

export type WorkItemFetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: ApiWorkItemDetailResponse }
  | { status: 'error'; error: string };

export function useWorkItem(id: string | null): { state: WorkItemFetchState; refresh: () => void } {
  const [state, setState] = useState<WorkItemFetchState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!id) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    // Keep the rendered item while a refresh is in flight; only show the
    // loading shell on first open or after an error.
    setState(prev => (prev.status === 'ok' ? prev : { status: 'loading' }));
    fetch(`/api/workitem/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async r => {
        const body = await r.json();
        if (cancelled) return;
        if ('error' in body) setState({ status: 'error', error: body.error });
        else setState({ status: 'ok', data: body });
      })
      .catch(err => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);
  return { state, refresh: () => setNonce(n => n + 1) };
}

/** Friendly first-name extracted from an email (jane.doe@x → "Jane"). */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const first = local.split(/[._-]/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Work item edits                                                           */
/* -------------------------------------------------------------------------- */

/** Block a work item (Task / User Story). Returns the new ADO state. */
export async function postWorkItemBlock(workItemId: string): Promise<{ state: string }> {
  return postBlockAction(workItemId, 'block');
}

/** Clear a block on a work item. Returns the new ADO state. */
export async function postWorkItemUnblock(workItemId: string): Promise<{ state: string }> {
  return postBlockAction(workItemId, 'unblock');
}

async function postBlockAction(
  workItemId: string,
  action: 'block' | 'unblock',
): Promise<{ state: string }> {
  const r = await fetch(`/api/workitem/${encodeURIComponent(workItemId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await r.json();
  if (!r.ok || 'error' in body) {
    throw new Error(body.error ?? `${action} failed`);
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/*  Planning gaps                                                             */
/* -------------------------------------------------------------------------- */

export interface ApiPlanningGapAnchor {
  isColdStart: boolean;
  siblingMedianActual: number | null;
  siblingSampleCount: number;
  calibrationOverallRatio: number | null;
  summary: string;
}

export interface ApiPlanningGapRef {
  workItemId: number;
  title: string;
  displayName: string;
  type: string;
}

export interface ApiPlanningGap {
  kind: 'task' | 'story' | 'feature' | 'epic';
  workItemId: number;
  title: string;
  displayName: string;
  missing: string[];
  parent: ApiPlanningGapRef | null;
  feature: ApiPlanningGapRef | null;
  anchor: ApiPlanningGapAnchor;
}

export interface ApiPlanningGapsResponse {
  fetchedAt: string;
  totalGaps: number;
  gaps: ApiPlanningGap[];
  /** Gaps in the CURRENT sprint, for planning after the sprint started. Older servers don't send it. */
  gapsCurrent?: ApiPlanningGap[];
  prompt: string;
}

export async function fetchPlanningGaps(): Promise<ApiPlanningGapsResponse> {
  const r = await fetch('/api/planning/gaps', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load planning gaps');
  return body as ApiPlanningGapsResponse;
}

/* -------------------------------------------------------------------------- */
/*  Planning cockpit                                                          */
/* -------------------------------------------------------------------------- */

export interface ApiCockpitIteration {
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
}

export interface ApiCockpitOpenTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  originalEstimate?: number;
  remainingWork?: number;
}

export interface ApiCockpitOpenStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  totalEstimateHours: number;
  completedHours: number;
  remainingHours: number;
  storyPoints?: number;
  effort?: number;
  feature?: { id: number; title: string; displayName: string };
  doneTaskCount: number;
  totalTaskCount: number;
  openTasks: ApiCockpitOpenTask[];
}

export type ApiBacklogLevel = 'year' | 'quarter' | 'backlog';

export interface ApiCockpitBacklogStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  iterationPath: string;
  level: ApiBacklogLevel;
  storyPoints?: number;
  effort?: number;
  originalEstimate?: number;
  remainingWork?: number;
  /** Server's verdict: may this story move into a sprint right now? Older servers don't send it. */
  canPull?: boolean;
  feature?: { id: number; title: string; displayName: string };
}

export interface ApiCockpitCapacity {
  workingHoursTotal: number;
  availableHours: number;
  meetingHours: number;
  hasUrl: boolean;
}

export interface ApiCockpitTopUpTask {
  id: number;
  title: string;
  displayName: string;
  state: string;
  type: string;
  remainingWork?: number;
  originalEstimate?: number;
}

export interface ApiCockpitTopUpStory {
  id: number;
  title: string;
  displayName: string;
  type: string;
  state: string;
  /** Where the story lives now: a sprint name (e.g. "26_12") or "Backlog". */
  locationLabel: string;
  /** Sum of open-task hours — what a full pull adds to the current sprint. */
  pullableHours: number;
  /** True when the whole story (not just its tasks) may be pulled into the current sprint. */
  canPullStory: boolean;
  openTasks: ApiCockpitTopUpTask[];
}

export interface ApiCockpitPayload {
  currentSprint: ApiCockpitIteration | null;
  nextSprint: ApiCockpitIteration | null;
  nextSprintCapacity: ApiCockpitCapacity | null;
  currentSprintCapacity: ApiCockpitCapacity | null;
  currentSprintCommittedHours: number;
  openStories: ApiCockpitOpenStory[];
  backlogStories: ApiCockpitBacklogStory[];
  topUpStories: ApiCockpitTopUpStory[];
}

export async function fetchCockpit(): Promise<ApiCockpitPayload> {
  const r = await fetch('/api/planning/cockpit', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load planning cockpit');
  return body as ApiCockpitPayload;
}

/* ----------------------------- Pre-plan page ----------------------------- */

export type ApiPrePlanCall = 'on-track' | 'at-risk' | 'carries-over';

export interface ApiPrePlanCard {
  id: string;
  displayName: string;
  remainingHours: number;
  blocked: boolean;
  lastActivityAt: string | null;
  call: ApiPrePlanCall;
  callIsSuggested: boolean;
  goalIndex: number | null;
}

export interface ApiPrePlanRoomLine {
  openStoriesRemainingHours: number;
  roomHours: number;
  hasCapacity: boolean;
}

export interface ApiPrePlanGoal {
  text: string;
  owner: string | null;
  isMine: boolean;
}

export interface ApiPrePlanCoverageGoal {
  index: number;
  text: string;
  storyCount: number;
}

export interface ApiPrePlanPayload {
  sprintName: string;
  goals: ApiPrePlanGoal[];
  cards: ApiPrePlanCard[];
  coverage: ApiPrePlanCoverageGoal[];
  room: ApiPrePlanRoomLine;
}

export async function fetchPrePlan(): Promise<ApiPrePlanPayload> {
  const r = await fetch('/api/preplan', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load the pre-plan page');
  return body as ApiPrePlanPayload;
}


export async function moveWorkItemToIteration(workItemId: number, iterationPath: string): Promise<void> {
  const r = await fetch(`/api/workitem/${workItemId}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ iterationPath }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || 'Could not move the work item');
  }
}

export async function markWorkItemDone(workItemId: number, completedHours: number): Promise<void> {
  const r = await fetch(`/api/workitem/${workItemId}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'done', completedHours }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || 'Could not close the work item');
  }
}

/* -------------------------------------------------------------------------- */
/*  Helper's notes                                                            */
/* -------------------------------------------------------------------------- */

async function postNoteAction(id: number, action: 'dismiss' | 'pin' | 'unpin'): Promise<void> {
  const r = await fetch(`/api/helper-note/${id}/${action}`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) {
    throw new Error((body && body.error) || `Could not ${action} that note`);
  }
}

export async function dismissHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'dismiss');
}

export async function pinHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'pin');
}

export async function unpinHelperNote(id: number): Promise<void> {
  await postNoteAction(id, 'unpin');
}

/* -------------------------------------------------------------------------- */
/*  Carry-forward                                                             */
/* -------------------------------------------------------------------------- */

export async function postCarryForward(taskIds: number[]): Promise<{ moved: number; failed: number[] }> {
  const res = await fetch('/api/carry-forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!res.ok) throw new Error(`carry-forward failed: ${res.status}`);
  return (await res.json()) as { moved: number; failed: number[] };
}

/* ------------------------------ Retro ------------------------------ */

export type RetroBucket = 'well' | 'way' | 'talk';

export interface ApiRetroItem {
  key: string;
  bucket: RetroBucket;
  text: string;
  evidence: string;
  decision: 'keep' | 'drop';
}

export interface ApiRetroPayload {
  sprintName: string;
  sprintLine: string;
  items: ApiRetroItem[];
  savedAt: string | null;
  previous: { sprintName: string; kept: { bucket: RetroBucket; text: string }[] } | null;
  estimateHabit?: string | null;
}

export async function fetchRetro(): Promise<ApiRetroPayload> {
  const r = await fetch('/api/retro', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok || 'error' in body) throw new Error(body.error ?? 'Could not load the retro');
  return body as ApiRetroPayload;
}

export async function saveRetroChoices(
  sprintName: string,
  items: { key: string; bucket: RetroBucket; text: string; decision: 'keep' | 'drop' }[],
): Promise<void> {
  const r = await fetch('/api/retro/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sprintName, items }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && 'error' in body)) throw new Error((body && body.error) || 'Could not save the retro');
}
