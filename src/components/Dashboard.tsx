import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import MarkdownIt from 'markdown-it';
import {
  dismissHelperNote,
  pinHelperNote,
  unpinHelperNote,
  nameFromEmail,
  useDashboardData,
  type ApiDiscovery,
  type ApiHelperNote,
  type ApiHelperNotes,
  type ApiNeedsYou,
  type ApiOutlookCapacity,
  type ApiPayload,
  type ApiSessionEvent,
  type ApiUserStoryGroup,
  type ApiWorkItem,
  type ModeId,
} from '../lib/api';
import { boardStateClass } from '../lib/boardStateClass';
import { boldParts } from '../lib/boldParts';
import {
  fmtEstimate,
  fmtHM,
  formatClock,
  formatLongDate,
  greetingForHour,
  sprintDays,
  workingDayCount,
  useNow,
} from '../lib/time';
import { useMode } from '../lib/useMode';
import {
  loadFocusPicks,
  writeFocusPicks,
  reconcilePicks,
  MAX_FOCUS_PANELS,
} from '../lib/focusPicks';
import { focusPanelTasks } from '../lib/focusTasks';
import { buildNotePrompt } from '../lib/notePrompt';
import type { SprintContext } from '../lib/types';
import { CarryForwardBanner } from './CarryForwardBanner';
import { DnDView } from './DnDView';
import { dndPage } from '../lib/pages';
import { Dot } from './Dot';
import { Mono } from './Mono';
import { PlanView } from './PlanView';
import { RetroView } from './RetroView';
import { ScheduleModal } from './ScheduleModal';
import { SettingsModal } from './SettingsModal';
import { WorkItemDrawer } from './WorkItemDrawer';
import { WrapCard } from './WrapCard';
import { overEstimate, overEstimateText } from '../../server/over-estimate';

export function Dashboard() {
  const [selectedSprintName, setSelectedSprintName] = useState<string | undefined>(undefined);
  const { state, refresh } = useDashboardData(selectedSprintName);
  const now = useNow();

  if (state.status === 'loading') {
    return <LoadingShell now={now} />;
  }
  if (state.status === 'error') {
    return (
      <ErrorShell
        now={now}
        error={state.error}
        command={state.command}
        headline={state.headline}
        fix={state.fix}
        setupNeeded={state.setupNeeded}
        onRetry={refresh}
      />
    );
  }
  return (
    <DashboardLive
      data={state.data}
      now={now}
      onRefresh={refresh}
      selectedSprintName={selectedSprintName ?? state.data.sprint?.name}
      onSprintChange={setSelectedSprintName}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Live state                                                                */
/* -------------------------------------------------------------------------- */

function DashboardLive({
  data,
  now,
  onRefresh,
  selectedSprintName,
  onSprintChange,
}: {
  data: ApiPayload;
  now: Date;
  onRefresh: () => void;
  selectedSprintName?: string;
  onSprintChange: (name: string | undefined) => void;
}) {
  const sprintCtx: SprintContext | null = useMemo(() => {
    if (!data.sprint) return null;
    return {
      startDate: new Date(data.sprint.startDate),
      totalDays: data.sprint.totalDays,
      workingDays: data.sprint.workingDays,
    };
  }, [data.sprint]);

  const userName = nameFromEmail(data.user);
  const date = formatLongDate(now);
  const clock = formatClock(now);
  const railDays = sprintCtx ? sprintDays(sprintCtx, now) : [];
  const workDays = workingDayCount(railDays);
  const today = workDays.soFar;
  const daysRemaining = workDays.left;

  // Side-panel collapse state — persisted to localStorage so the choice
  // survives refresh. Each panel collapses independently; collapsing both
  // gives the main column the full width.
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('sh.side.collapsed') === '1';
  });
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('sh.rail.collapsed') === '1';
  });
  useEffect(() => {
    window.localStorage.setItem('sh.side.collapsed', sideCollapsed ? '1' : '0');
  }, [sideCollapsed]);
  useEffect(() => {
    window.localStorage.setItem('sh.rail.collapsed', railCollapsed ? '1' : '0');
  }, [railCollapsed]);

  const stories = data.userStories;
  // "My stories" surfaces shouldn't include parent groups that are actually
  // Features or Epics — those happen when tasks are linked directly to a
  // feature with no intermediate user story. Filter once at the top.
  const storyOnlyAll = stories.filter(s => {
    const t = s.type.toLowerCase();
    return t !== 'feature' && t !== 'epic';
  });
  const inProgress = data.workItems.inProgress;
  const upNext = data.workItems.upNext;
  const done = data.workItems.done;

  // Work item drawer state — null means closed.
  const [viewingItemId, setViewingItemId] = useState<string | null>(null);
  const openItem = (id: string) => setViewingItemId(id);
  const closeItem = () => setViewingItemId(null);

  // Mode shell + schedule editor state.
  const [mode, setMode] = useMode();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ceremonies = data.ceremonies;
  // Older payloads have no switches; they had the whole page.
  const pageOn = data.pages ?? { discovery: true, design: true };
  const dnd = useMemo(() => dndPage(pageOn), [pageOn.discovery, pageOn.design]); // eslint-disable-line react-hooks/exhaustive-deps
  const modes = useMemo(
    () => R21_MODES.flatMap(m => (m.id !== 'dnd' ? [m] : dnd ? [{ ...m, label: dnd.label === 'Discovery & Design' ? 'D&D' : dnd.label }] : [])),
    [dnd],
  );
  // The page was turned off while it was open.
  useEffect(() => {
    if (mode === 'dnd' && !dnd) setMode('day');
  }, [mode, dnd, setMode]);

  // Every work item with a live Claude Code session, newest session first.
  const allItems = useMemo(
    () => {
      const base = [...inProgress, ...upNext, ...done];
      const seen = new Set(base.map(w => w.id));
      const extra = (data.liveOutsideSprint ?? []).filter(w => !seen.has(w.id));
      return [...base, ...extra];
    },
    [inProgress, upNext, done, data.liveOutsideSprint],
  );
  const liveItems = useMemo(
    () =>
      allItems
        // Skip tasks that are Done in ADO even if the local session is still
        // open. Done has to beat the live-session signal — when another chat
        // (or ADO directly) flips a task to closed without calling
        // session_end, the ghost session shouldn't keep pinning Focus to a
        // closed task. The leftover session gets cleaned up via the
        // STALE LIVE SESSION prompt or a future auto-end nudge.
        .filter(w => !!w.activeSession && boardStateClass(w.state) !== 'done')
        .sort((a, b) => (a.activeSession!.startedAt < b.activeSession!.startedAt ? 1 : -1)),
    [allItems],
  );

  // R2 focus state: the Day screen morphs to the live task automatically.
  // Focus can now show 1–4 self-chosen panels (picks list). The pick survives
  // refreshes — Focus must never swap tasks on its own while the picked task
  // is still live (multi-session rule). MAX_FOCUS_PANELS is the upper limit;
  // Task 6 consumes it when building the panel grid UI.
  const [picks, setPicksState] = useState<string[]>(() => loadFocusPicks());
  const setPicks = (ids: string[]) => {
    setPicksState(ids);
    writeFocusPicks(ids);
  };
  const [showBoard, setShowBoard] = useState(false);
  // Day mode is now two-place: Daily (the board) and Focus (auto-morphs when
  // a session is live). The old "Overview" place was merged into Daily —
  // helper notes, capacity, and the stat strip all live at the top of Daily.
  const pickMode = (m: ModeId) => setMode(m);
  // Reconcile picks against live tasks — drop any that stopped being live.
  useEffect(() => {
    if (liveItems.length === 0) {
      setShowBoard(false);
      setPicks([]);
      return;
    }
    const liveIds = liveItems.map(w => w.id);
    const next = reconcilePicks(picks, liveIds);
    if (next.length !== picks.length) setPicks(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveItems]);
  // Derive what the panels show: the reconciled picks, or — when empty — an
  // auto-pick of the first live task (preserves today's "opens on one" behaviour).
  const panelIds = picks.length > 0 ? picks : liveItems.slice(0, 1).map(w => w.id);
  const panelTasks = panelIds.map(id => liveItems.find(w => w.id === id)).filter(Boolean) as ApiWorkItem[];
  // Backwards-compatible single-task focal view for isFocus check.
  const focalTask = panelTasks[0] ?? null;
  // Generalized story resolver: given a task, find its parent story (if any).
  const storyFor = (task: ApiWorkItem | null) => {
    if (!task) return null;
    const parentId = task.parent?.id;
    if (parentId == null) return null;
    const pid = String(parentId);
    return stories.find(s => String(s.id) === pid) ?? null;
  };
  // Focus has top precedence — if a session is live and the user hasn't asked to
  // see the whole board, the screen morphs to Focus.
  const isFocus = mode === 'day' && !!focalTask && !showBoard;

  const sprintLabel = data.sprint?.name ?? '—';

  return (
    <div className={`r21-app ${isFocus ? 'is-focus' : 'is-overview'}`} data-density="generous" data-focal="whisper" data-feed="ruled">
      <R21Rail
        modes={modes}
        active={mode}
        suggested={ceremonies.suggestedModeId}
        onPick={pickMode}
        onOpenSchedule={() => setScheduleOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {mode === 'day' && (
        <R21Sidebar
          dateLabel={date}
          greeting={greetingForHour(now)}
          userName={userName}
          sub={greetingCopy(inProgress.length, daysRemaining)}
          next={ceremonies.next}
          now={now}
          sprintLabel={sprintLabel}
          totalDays={sprintCtx?.totalDays ?? 0}
          railDays={railDays}
          view={isFocus ? 'focus' : 'daily'}
          hasLive={liveItems.length > 0}
          onPickDaily={() => setShowBoard(true)}
          onPickFocus={() => setShowBoard(false)}
          collapsed={sideCollapsed}
          onToggleCollapsed={() => setSideCollapsed(v => !v)}
        />
      )}

      <div className="r21-main">
        {data.refreshError && <RefreshWarning message={data.refreshError} />}
        <div className="r21-topwrap">
          {/* OVERVIEW top bar */}
          <div className="r21-top is-overview">
            <div className="r21-brand">
              <span className="r21-brand-mark" aria-hidden="true" />
              <span className="r21-brand-name">SPRINTOMATIC</span>
              <span className="r21-brand-meta"><Mono>{userName.toLowerCase()}</Mono></span>
            </div>
            <div className="r21-top-right">
              {/* The picker switches which sprint the Daily/board view shows.
                  The Plan page works on the live current → next sprint and the
                  Retro page always looks at the current sprint, so both ignore
                  this choice — hide it there rather than leave a control that
                  does nothing. */}
              {mode !== 'plan' && mode !== 'retro' && (
                <SprintPicker
                  options={data.sprintOptions}
                  currentName={selectedSprintName ?? sprintLabel}
                  onSelect={name => {
                    const sprint = data.sprintOptions.find(o => o.isCurrent);
                    onSprintChange(sprint && sprint.name === name ? undefined : name);
                  }}
                />
              )}
              <span className="r21-pill">day&nbsp;<span className="v">{today}/{workDays.total || '—'}</span></span>
              <span className="r21-pill"><span className="v">{clock}</span></span>
              <button className="ember-sync" onClick={onRefresh} title="This page updates by itself. Click to read the board again now.">
                <Dot size={5} color="var(--accent)" />
                <span className="dim-small">updates by itself</span>&nbsp;<span className="ember-sync-icon">↻</span>
              </button>
            </div>
          </div>
          {/* FOCUS top bar (collapsed strip) */}
          <div className="r21-top is-focus">
            <div className="r21-brand">
              <span className="r21-brand-mark" aria-hidden="true" />
              <span className="r21-brand-name">SPRINTOMATIC</span>
              <span className="r21-strip-meta">
                <span className="sep">·</span>
                <span>sprint <span className="v">{sprintLabel}</span></span>
                <span className="sep">·</span>
                <span>day <span className="v">{today}/{workDays.total || '—'}</span></span>
                <span className="sep">·</span>
                <span><span className="v">{Math.round(data.capacity.remainingHours)}h</span> remaining</span>
                <span className="sep">·</span>
                <span><span className="v">{clock}</span></span>
              </span>
            </div>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="ember-sync" onClick={onRefresh} title="This page updates by itself. Click to read the board again now.">
                <Dot size={5} color="var(--accent)" />
                <span className="dim-small">updates by itself</span>&nbsp;<span className="ember-sync-icon">↻</span>
              </button>
              <button className="r21-escape" onClick={() => setShowBoard(true)} title="Show the whole board — your work keeps logging">
                <span><span className="v">{Math.max(0, storyOnlyAll.length - 1)}</span> more in sprint</span>
                <span className="arr">↗</span>
              </button>
            </span>
          </div>
        </div>

        <div className="r21-bodywrap">
          {mode === 'plan' ? (
            <PlanView onOpenItem={openItem} />
          ) : mode === 'retro' ? (
            <RetroView />
          ) : mode === 'dnd' && dnd ? (
            <DnDView page={dnd} onOpenItem={openItem} />
          ) : isFocus ? (
            <div className="r21-body is-focus">
              <R21FocusGrid
                tasks={panelTasks}
                allLive={liveItems}
                storyFor={storyFor}
                onSetPicks={setPicks}
                maxPanels={MAX_FOCUS_PANELS}
                onOpenItem={openItem}
                helperNotes={data.helperNotes}
                onRefresh={onRefresh}
              />
            </div>
          ) : (
            <DailyView
              stories={stories}
              carryForward={data.carryForward}
              sprintName={sprintLabel}
              onOpenItem={openItem}
              outlookCapacity={data.outlookCapacity}
              helperNotes={data.helperNotes}
              needsYou={data.needsYou}
              wrap={data.wrap}
              now={now}
              standup={data.standup}
              today={today}
              totalDays={workDays.total}
              live={liveItems.length > 0}
              focalTitle={focalTask?.title}
              onRefresh={onRefresh}
              railCollapsed={railCollapsed}
              onToggleRailCollapsed={() => setRailCollapsed(v => !v)}
              data={data}
            />
          )}
        </div>
      </div>

      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onSaved={onRefresh}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={onRefresh}
      />

      <WorkItemDrawer
        itemId={viewingItemId}
        onClose={closeItem}
        onNavigate={openItem}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

const EVENT_LABELS: Record<string, string> = {
  focus: 'Focus',
  progress: 'Progress',
  blocker: 'Blocker',
  decision: 'Decision',
  note: 'Note',
};

/**
 * Discreet marker shown next to titles for items sprintomatic itself
 * created via MCP. Invisible to anyone else on the board.
 */
function SHPip({ shown }: { shown: boolean | undefined }) {
  if (!shown) return null;
  return (
    <span className="r12-sh-pip" title="Created by sprintomatic">
      SH
    </span>
  );
}

/**
 * Markdown renderer for activity body text. New entries SHOULD be written
 * as proper markdown (bullets, `code`, **bold**, paragraphs separated by
 * blank lines). `breaks: true` turns a lone newline into <br>, so legacy
 * entries that only got auto-prettified to single \n breaks still render
 * with their sentence-level line spacing. `html: false` blocks any raw
 * HTML from sneaking in.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

/**
 * Pre-pass for legacy session_log entries that are still one giant
 * paragraph. New entries SHOULD be written as real markdown
 * (paragraphs, bullets, code), but the DB has plenty of older
 * blob-style writes. We rescue them in two passes:
 *
 *   1. Convert "(1) ... (2) ... (3) ..." into a real markdown ordered
 *      list (`1. ... 2. ... 3. ...`). markdown-it renders these as an
 *      indented `<ol>` so they stand out from surrounding prose.
 *   2. Insert single `\n` at sentence boundaries. With markdown-it's
 *      `breaks: true` those render as `<br>` so prose-blob entries
 *      still read line by line instead of as a wall.
 *
 * Short entries (< 160 chars) and entries that already use markdown
 * (`\n\n` paragraphs, `- ` bullets, `# ` headings, code fences) are
 * left untouched — the writer either knew what they were doing or
 * doesn't need rescue.
 */
function prepEventBody(text: string): string {
  if (text.length < 160) return text;
  if (/(\n\n)|(^[\-*] )|(^#{1,6} )|(^```)|(\n[\-*] )/m.test(text)) return text;

  // Pass 1: sentence breaks (.!? + space + uppercase, "(", or backtick).
  // Backtick covers sentences starting with `code` spans.
  let out = text.replace(/([.!?])\s+(?=[A-Z(`])/g, '$1\n');
  // Pass 1b: colon/semicolon + " (N) " (intro-then-list pattern).
  out = out.replace(/([:;])\s+(?=\(\d+\)\s)/g, '$1\n');

  // Pass 2: turn "(N) " at start-of-line into a markdown ordered-list
  // item ("N. "). The first list item needs a blank line above it so
  // markdown-it starts a list; subsequent items just sit on their own
  // line. The list ends naturally on the first line that isn't "N. ".
  let inList = false;
  out = out
    .split('\n')
    .map(line => {
      const match = line.match(/^\((\d+)\)\s+(.*)$/);
      if (match) {
        const [, num, rest] = match;
        const prefix = inList ? '' : '\n';
        inList = true;
        return `${prefix}${num}. ${rest}`;
      }
      inList = false;
      return line;
    })
    .join('\n');

  return out;
}

/** First-sentence summary for collapsed activity rows; truncated at ~100 chars. */
function collapsedSummary(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]+[.!?]/);
  const firstSentence = (match ? match[0] : trimmed).trim();
  return firstSentence.length > 100
    ? firstSentence.slice(0, 97).trimEnd() + '…'
    : firstSentence;
}

/**
 * One row in the recent-activity feed. Collapsed by default — shows the
 * first sentence as a summary. Click to expand the full body. Entries whose
 * body equals their summary skip the chevron and aren't toggleable.
 */
function ActivityEntry({ event }: { event: ApiSessionEvent }) {
  const [open, setOpen] = useState(false);
  const summary = collapsedSummary(event.text);
  const hasMore = event.text.trim().length > summary.length + 1;

  return (
    <div className={`r21-ev t-${event.type} ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="r21-ev-head"
        onClick={() => hasMore && setOpen(o => !o)}
        aria-expanded={hasMore ? open : undefined}
        data-toggleable={hasMore ? 'true' : 'false'}
      >
        <span className="r21-ev-time">{fmtEventStamp(event.createdAt)}</span>
        <span className="r21-ev-type">{EVENT_LABELS[event.type] ?? event.type}</span>
        <span className="r21-ev-summary">{summary}</span>
        {hasMore && <span className="r21-ev-chev">{open ? '▾' : '▸'}</span>}
      </button>
      {hasMore && open && (
        <div
          className="r21-ev-body"
          dangerouslySetInnerHTML={{ __html: md.render(prepEventBody(event.text)) }}
        />
      )}
    </div>
  );
}

const R21_MODES: { id: ModeId; label: string; glyph: JSX.Element }[] = [
  { id: 'day', label: 'Day', glyph: <circle cx="7" cy="7" r="3" fill="currentColor" /> },
  { id: 'dnd', label: 'D&D', glyph: <><circle cx="7" cy="7" r="4" stroke="currentColor" fill="none" /><path d="M9 5 L7.5 7.5 L5 9 L6.5 6.5 Z" fill="currentColor" /></> },
  { id: 'plan', label: 'Plan', glyph: <><line x1="2" y1="4" x2="12" y2="4" stroke="currentColor" /><line x1="2" y1="7" x2="10" y2="7" stroke="currentColor" /><line x1="2" y1="10" x2="11" y2="10" stroke="currentColor" /></> },
  { id: 'retro', label: 'Retro', glyph: <path d="M 11 7 A 4 4 0 1 1 7 3" stroke="currentColor" fill="none" strokeWidth="1.2" /> },
];

function R21Rail({
  modes,
  active,
  suggested,
  onPick,
  onOpenSchedule,
  onOpenSettings,
}: {
  modes: typeof R21_MODES;
  active: ModeId;
  suggested: ModeId | null;
  onPick: (m: ModeId) => void;
  onOpenSchedule: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="r21-rail" aria-label="Mode">
      <span className="r21-rail-cap">Mode</span>
      {modes.map(m => (
        <button
          key={m.id}
          className={`r21-rail-tile ${active === m.id ? 'is-active' : ''} ${suggested === m.id && active !== m.id ? 'is-suggested' : ''}`}
          onClick={() => onPick(m.id)}
          title={m.label}
        >
          <span className="glyph" aria-hidden="true"><svg viewBox="0 0 14 14">{m.glyph}</svg></span>
          <span className="lbl">{m.label}</span>
        </button>
      ))}
      <button className="r21-rail-gear" onClick={onOpenSchedule} title="Schedule">
        <span className="glyph" aria-hidden="true">
          <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="3" stroke="currentColor" fill="none" /><circle cx="7" cy="7" r="1" fill="currentColor" /></svg>
        </span>
        <span className="lbl">Schedule</span>
      </button>
      <button className="r21-rail-gear" onClick={onOpenSettings} title="Settings">
        <span className="glyph" aria-hidden="true">
          <svg viewBox="0 0 14 14">
            <line x1="2" y1="4" x2="12" y2="4" stroke="currentColor" /><circle cx="5" cy="4" r="1.4" fill="currentColor" />
            <line x1="2" y1="10" x2="12" y2="10" stroke="currentColor" /><circle cx="9" cy="10" r="1.4" fill="currentColor" />
          </svg>
        </span>
        <span className="lbl">Settings</span>
      </button>
    </nav>
  );
}

function R21Sidebar({
  dateLabel,
  greeting,
  userName,
  sub,
  next,
  now,
  sprintLabel,
  totalDays,
  railDays,
  view,
  hasLive,
  onPickDaily,
  onPickFocus,
  collapsed,
  onToggleCollapsed,
}: {
  dateLabel: string;
  greeting: string;
  userName: string;
  sub: string;
  next: ApiPayload['ceremonies']['next'];
  /** Fresh client-side clock — recompute relative-time locally; don't trust the server's stale minutesUntil. */
  now: Date;
  sprintLabel: string;
  totalDays: number;
  railDays: Array<{ index: number; state: string; label: string; isOff: boolean }>;
  view: 'daily' | 'focus';
  hasLive: boolean;
  onPickDaily: () => void;
  onPickFocus: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className={`r21-sidewrap ${collapsed ? 'is-collapsed' : ''}`}>
      <button
        type="button"
        className="r21-sidewrap-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? 'Show the side panel' : 'Hide the side panel'}
        aria-label={collapsed ? 'Show the side panel' : 'Hide the side panel'}
      >
        {collapsed ? '›' : '‹'}
      </button>
      <aside className="r21-side">
        <div className="r21-side-date">{dateLabel}</div>
        <h1 className="r21-side-greet">{greeting}, <b>{userName}</b></h1>
        <p className="r21-side-sub">{sub}</p>

        <div className="r21-place" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'daily'}
            className={`r21-place-seg ${view === 'daily' ? 'is-active' : ''}`}
            onClick={onPickDaily}
            title="All your stories: yesterday, today and the notes"
          >
            Daily
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'focus'}
            disabled={!hasLive}
            className={`r21-place-seg ${view === 'focus' ? 'is-active' : ''}`}
            onClick={onPickFocus}
            title={hasLive ? 'Show only the task your timer is running on' : 'Focus opens when a timer is running on a task'}
          >
            Focus
          </button>
        </div>

        {next && (
          <div className="r21-side-card">
            <span className="cap">Up next · {next.label}</span>
            <div className="row">
              <span className="when"><Mono>{fmtClockISO(next.startsAt)}</Mono></span>
              <span className="rel">{whenLabel(next.startsAt, now)}</span>
            </div>
            <span className="name">{next.label}</span>
          </div>
        )}

        {totalDays > 0 && (() => {
          // Count in WORKING days, not calendar days — the user's days off
          // don't count. Working-day-of-N = working days up to & including today.
          const { total: workingTotal, soFar: workingSoFar } = workingDayCount(railDays);
          return (
            <div className="r21-side-week">
              <div className="r21-side-week-head">
                <span>Sprint <span className="day"><Mono>{sprintLabel}</Mono></span></span>
                <span>day <span className="day"><Mono>{workingSoFar}/{workingTotal}</Mono></span></span>
              </div>
              <div className="r21-side-week-grid">
                {railDays.map(d => (
                  <span
                    key={d.index}
                    className={`r21-side-week-cell ${d.isOff ? 'is-off' : ''} ${d.state === 'past' ? 'is-past' : d.state === 'today' ? 'is-today' : 'is-future'}`}
                  >
                    {d.label}
                  </span>
                ))}
              </div>
            </div>
          );
        })()}
      </aside>
    </div>
  );
}

/**
 * Recap card — shown only in the Daily view. Reads aloud well: yesterday's
 * tasks with a one-line summary, today's tasks with state. Empty side
 * collapses to a calm note instead of a stark gap. Lives at the top of Daily
 * so it's the first thing the user sees when the delivery manager opens the
 * board.
 */
function StandupCard({ standup }: { standup: ApiPayload['standup'] }) {
  const { yesterday, today } = standup;
  if (yesterday.length === 0 && today.length === 0) {
    // First-time empty state: don't waste real estate.
    return (
      <div className="r21-standup is-empty">
        <span className="r21-standup-empty">
          No sessions logged yet — open one with Claude Code to start populating this card.
        </span>
      </div>
    );
  }

  const yDate = formatStandupDate(standup.yesterdayDate);
  const tDate = formatStandupDate(standup.todayDate);
  // When the last working day isn't literally yesterday (e.g. Sunday looking
  // back to Thursday across the weekend), "Yesterday" is a lie — name the day.
  const priorLabel = priorColumnLabel(standup.yesterdayDate, standup.todayDate);

  return (
    <section className="r21-standup" aria-label="Recent work">
      <div className="r21-standup-cols">
        <div className="r21-standup-col">
          <h3 className="r21-standup-col-h">
            <span>{priorLabel}</span>
            <span className="r21-standup-col-meta">{yDate}</span>
          </h3>
          <StandupEntries entries={yesterday} emptyHint={`Nothing logged ${priorLabel === 'Yesterday' ? 'yesterday' : `on ${priorLabel}`}.`} />
        </div>
        <div className="r21-standup-col">
          <h3 className="r21-standup-col-h">
            <span>Today</span>
            <span className="r21-standup-col-meta">{tDate}</span>
          </h3>
          <StandupEntries entries={today} emptyHint="No session yet today." />
        </div>
      </div>
    </section>
  );
}

function StandupEntries({
  entries,
  emptyHint,
}: {
  entries: ApiPayload['standup']['yesterday'];
  emptyHint: string;
}) {
  if (entries.length === 0) {
    return <p className="r21-standup-empty">{emptyHint}</p>;
  }
  return (
    <ul className="r21-standup-list">
      {entries.map(e => (
        <StandupEntry key={e.workItemId} entry={e} />
      ))}
    </ul>
  );
}

/**
 * One story row in the today / previous-day recap. Collapsed by default: the
 * story title + summary read at a glance, and the active tasks under it drop
 * down when you click the row. Done/closed tasks are left out — this section
 * is for the work still in play, not a finished-list.
 */
function StandupEntry({ entry: e }: { entry: ApiPayload['standup']['yesterday'][number] }) {
  const activeTasks = e.tasks.filter(t => boardStateClass(t.adoState) !== 'done');
  const hasTasks = activeTasks.length > 0;
  // Status comes from the story's real Azure state so the recap agrees with the
  // stories list — not guessed from the worked-task list (which is empty when
  // the session was logged on the story itself). Older cached payloads without
  // storyState fall back to going, since a recapped story is one being worked.
  const status: 'going' | 'waiting' | 'blocked' | 'done' = e.storyState
    ? boardStateClass(e.storyState)
    : 'going';
  const [open, setOpen] = useState(false);

  const headInner = (
    <>
      <span className="r21-standup-item-kind">Story</span>
      <span className="r21-standup-item-title">
        {extractTitleFromDisplayName(e.displayName)}
      </span>
      {hasTasks && (
        <span className="r21-standup-item-count">
          {activeTasks.length} active
        </span>
      )}
      <span className={`r21-standup-task-state state-${status}`}>{e.storyState ?? 'in work'}</span>
      <StandupStateBadge state={e.state} minutes={e.minutesInWindow} />
    </>
  );

  return (
    <li className={`r21-standup-item is-${e.state}`}>
      {hasTasks ? (
        <button
          type="button"
          className="r21-standup-item-head is-toggle"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Hide tasks' : `Show ${activeTasks.length} active task${activeTasks.length === 1 ? '' : 's'}`}
        >
          <span className="r21-standup-item-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          {headInner}
        </button>
      ) : (
        <div className="r21-standup-item-head">{headInner}</div>
      )}

      {e.summary && <p className="r21-standup-item-summary">{e.summary}</p>}

      {open && hasTasks && (
        <ul className="r21-standup-tasks">
          {activeTasks.map(t => (
            <li key={t.workItemId} className={`r21-standup-task is-${boardStateClass(t.adoState)}`}>
              <span className={`r21-standup-task-state state-${boardStateClass(t.adoState)}`}>
                {t.adoState}
              </span>
              <span className="r21-standup-task-title">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function StandupStateBadge({ state }: { state: 'live' | 'paused' | 'closed'; minutes: number | null }) {
  if (state === 'live') return <span className="r21-standup-pill is-live">timer running</span>;
  // Closed/paused entries: don't show minutes here. Session-open duration is
  // a poor proxy for work time (sessions left open overnight bloat it),
  // and the summary line already says what got done.
  return null;
}

function extractTitleFromDisplayName(displayName: string): string {
  // displayName ships as `**title** (#id)` — strip the bold markers + id for
  // a clean visual line. The id is on the parent ADO link anyway.
  const m = displayName.match(/^\*\*(.+)\*\*\s*\(#(\d+)\)\s*$/);
  return m ? m[1] : displayName;
}


function formatStandupDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Label for the prior-work column. "Yesterday" only when it really is the
 * calendar day before today; otherwise the weekday name (e.g. "Thursday"),
 * so a Sunday standup reaching back over the weekend reads honestly.
 */
function priorColumnLabel(yesterdayISO: string, todayISO: string): string {
  const py = yesterdayISO.split('-').map(Number);
  const pt = todayISO.split('-').map(Number);
  if (py.length === 3 && pt.length === 3 && py.every(Boolean) && pt.every(Boolean)) {
    const yDate = new Date(py[0], py[1] - 1, py[2]);
    const tDate = new Date(pt[0], pt[1] - 1, pt[2]);
    const diffDays = Math.round((tDate.getTime() - yDate.getTime()) / 86_400_000);
    if (diffDays === 1) return 'Yesterday';
    return yDate.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return 'Yesterday';
}

/**
 * State mark: text label for working/waiting/stale. Never glyph/color alone
 * (accessibility + functional-color rule).
 */
function StateMark({ state }: { state?: 'working' | 'waiting' | 'stale' }) {
  if (state === 'waiting') {
    return <span className="r21-mark is-waiting">waiting for you</span>;
  }
  if (state === 'stale') {
    return (
      <span className="r21-mark is-stale" title="The timer is still running, but the chat has been quiet for over 2 hours.">
        <span aria-hidden="true">🌙</span> chat quiet for 2h+
      </span>
    );
  }
  return <span className="r21-mark is-working">working</span>;
}

/**
 * Multi-panel Focus grid: renders 1–4 self-chosen panels of running tasks.
 * Each panel shows a compact view of the task (story header, "currently
 * running", metrics, drill-in arrow). Tasks left out show in "Also running".
 */
function R21FocusGrid({
  tasks,
  allLive,
  storyFor,
  onSetPicks,
  maxPanels,
  onOpenItem,
  helperNotes,
  onRefresh,
}: {
  /** The tasks currently shown as panels (1–maxPanels). */
  tasks: ApiWorkItem[];
  /** Every live session's task — drives the split bar. */
  allLive: ApiWorkItem[];
  storyFor: (task: ApiWorkItem) => ApiUserStoryGroup | null;
  onSetPicks: (ids: string[]) => void;
  maxPanels: number;
  onOpenItem: (id: string) => void;
  helperNotes: ApiHelperNotes;
  onRefresh: () => void;
}) {
  const count = Math.max(1, tasks.length);
  const shownIds = new Set(tasks.map(t => t.id));

  // Toggle a running task in/out of the panels. Never drop below 1 panel;
  // never exceed maxPanels (a full grid ignores an add — the chip shows why).
  const toggle = (id: string) => {
    if (shownIds.has(id)) {
      if (tasks.length <= 1) return; // keep at least one panel
      onSetPicks(tasks.map(t => t.id).filter(x => x !== id));
    } else {
      if (tasks.length >= maxPanels) return; // grid full
      onSetPicks([...tasks.map(t => t.id), id].slice(0, maxPanels));
    }
  };

  return (
    <div className={`r21-focusgrid is-count-${count}`}>
      {/* Split bar — visible whenever more than one session runs. Each running
          task is a chip; click to show/hide it as a panel. This is the front
          door to splitting Focus (the old bottom "also running" strip hid it). */}
      {allLive.length > 1 && (
        <div className="r21-focusgrid-head">
          <span className="r21-focusgrid-label">Focus</span>
          <span className="r21-focusgrid-count">
            showing {count} of {allLive.length} running — tap to split
          </span>
          <div className="r21-splitbar">
            {allLive.map(w => {
              const on = shownIds.has(w.id);
              const full = !on && tasks.length >= maxPanels;
              return (
                <button
                  key={w.id}
                  type="button"
                  className={`r21-splitchip${on ? ' is-on' : ''}${full ? ' is-full' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(w.id)}
                  title={
                    on
                      ? tasks.length <= 1
                        ? 'The only panel — add another before hiding this'
                        : 'Hide this panel'
                      : full
                        ? `Focus is full (${maxPanels}) — hide one first`
                        : 'Show as a panel'
                  }
                >
                  <StateMark state={w.activeSession?.state} />
                  <span className="r21-splitchip-title">{w.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="r21-focusgrid-panels">
        {tasks.map(task => (
          <FocusPanel
            key={task.id}
            task={task}
            story={storyFor(task)}
            state={task.activeSession?.state}
            onOpenItem={onOpenItem}
            onRemove={tasks.length > 1 ? () => toggle(task.id) : undefined}
            helperNotes={helperNotes}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Single Focus panel: story header, "currently running" section with the
 * task, LOGGED/COMPLETED/ESTIMATE/REMAINING metrics, and drill-in arrow.
 * Refactored from the original R21Focus component body.
 */
function FocusPanel({
  task,
  story,
  state,
  onOpenItem,
  onRemove,
  helperNotes,
  onRefresh,
}: {
  task: ApiWorkItem;
  story: ApiUserStoryGroup | null;
  state?: 'working' | 'waiting' | 'stale';
  onOpenItem: (id: string) => void;
  onRemove?: () => void;
  helperNotes: ApiHelperNotes;
  onRefresh: () => void;
}) {
  // Drill-in state: null = story view (default); a task id = drilled into
  // that task's activity feed. Click a task in the list to drill in; click
  // "Back" to return.
  const [drilledTaskId, setDrilledTaskId] = useState<string | null>(null);

  // The live task is always in this list, even when the story group doesn't
  // carry it (story in the sprint, its tasks left in the backlog). Resolving
  // the drill-in against story.tasks alone made "Currently running" a dead
  // click in exactly that case.
  const panelTasks = focusPanelTasks(task, story?.tasks ?? []);

  const drilledTask = drilledTaskId
    ? panelTasks.find(t => String(t.id) === drilledTaskId) ?? null
    : null;

  if (drilledTask) {
    return (
      <FocusTaskDrill
        task={drilledTask}
        story={story}
        onBack={() => setDrilledTaskId(null)}
        onOpenItem={onOpenItem}
      />
    );
  }

  const focusNotes = helperNotes.notes.filter(
    n =>
      n.pinnedAt != null ||
      n.workItemId === Number(task.id) ||
      (story != null && n.workItemId === Number(story.id)),
  );

  const loggedSec = task.localLoggedSeconds;
  const logged = fmtHM(loggedSec, 0);
  const startedAt = task.activeSession ? fmtEventStamp(task.activeSession.startedAt) : '';
  const remaining = task.remainingWork != null ? `${Math.round(task.remainingWork)}h` : 'not set';
  const completed = task.completedWork != null ? `${Math.round(task.completedWork)}h` : 'not set';

  const storyDominant = story ? storyDominantState(story) : null;
  const taskIdStr = String(task.id);

  return (
    <div className="r21-focuspanel">
      {onRemove && (
        <button
          type="button"
          className="r21-focuspanel-remove"
          onClick={onRemove}
          title="Remove this panel"
        >
          ✕
        </button>
      )}

      <div className="r21-focuspanel-mark">
        <StateMark state={state} />
      </div>

      {story ? (
        <header className="r21-focal-story">
          <div className="r21-focal-story-meta">
            <span className={`r21-daily-kind kind-${kindSlug(story.type)}`}>{story.type}</span>
            <Mono className="r21-focal-story-id">#{story.id}</Mono>
            {storyDominant && (
              <span className={`r21-daily-state state-${storyDominant}`}>
                {storyStateLabel(storyDominant, story.movedTo)}
              </span>
            )}
          </div>
          <h1 className="r21-focal-story-title">
            <button type="button" onClick={() => onOpenItem(story.id)}>
              {story.title}
            </button>
          </h1>
        </header>
      ) : (
        <>
          <div className="r21-focal-id">
            <Mono>#{task.id}</Mono>
          </div>
          <h1 className="r21-focal-title">{task.title}</h1>
        </>
      )}

      {/* No separate "blocked" line here: the story header + the TASKS IN THIS
          STORY list below each carry their own blocked chip, so a line under
          the story title only repeated it (and read as if the STORY was the
          blocked task). Removed as noise. */}

      <section className="r21-focal-current">
        <div className="r21-focal-current-head">
          <span className="r21-focal-current-label">Currently running</span>
          <span className="r21-live-pill">timer running</span>
          {startedAt && (
            <span className="r21-since">
              started <span className="v">{startedAt}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className="r21-focal-current-task"
          onClick={() => setDrilledTaskId(String(task.id))}
          title="See this task's own activity feed"
        >
          <Mono className="r21-focal-current-id">#{task.id}</Mono>
          <span className="r21-focal-current-title">{task.title}</span>
          <span className="r21-focal-current-arr" aria-hidden="true">
            →
          </span>
        </button>
        <div className="r21-focal-meta">
          <span className="r21-num" title="Time the timer has counted on this task">
            <span className="cap">LOGGED</span>
            <span className="val">{logged}</span>
            {task.sessionCount > 0 && (
              <span className="sub">
                · {task.sessionCount} session{task.sessionCount === 1 ? '' : 's'}
              </span>
            )}
          </span>
          <span className="r21-num" title="Hours written on the board as done">
            <span className="cap">COMPLETED</span>
            <span className={`val ${task.completedWork == null ? 'is-missing' : ''}`}>
              {completed}
            </span>
          </span>
          <span className="r21-num" title="The first guess, set once">
            <span className="cap">ESTIMATE</span>
            <span className="val">{estimateFor(task)}</span>
          </span>
          <span className="r21-num" title="Hours the board says are left">
            <span className="cap">REMAINING</span>
            <span className={`val ${task.remainingWork == null ? 'is-missing' : ''}`}>
              {remaining}
            </span>
          </span>
        </div>
        <OverEstimateLine task={task} />
      </section>

      {/* Ask panelTasks, not story.tasks. A story can sit in the sprint while
          its tasks sit elsewhere, and then story.tasks is empty while
          panelTasks still holds the live task — the list showed panelTasks but
          this gate hid the whole section, so coming Back from a task landed on
          a story with no tasks under it. */}
      {panelTasks.length > 0 && (
        <section className="r21-focal-tasks">
          <div className="r21-focal-tasks-head">
            <span className="r21-focal-tasks-title">Tasks in this story</span>
            <span className="r21-focal-tasks-count">{panelTasks.length}</span>
          </div>
          <ul className="r21-focal-tasks-list">
            {panelTasks.map(t => {
              const isLive = String(t.id) === taskIdStr;
              const stateClass = boardStateClass(t.state);
              const tRem = t.remainingWork != null ? `${Math.round(t.remainingWork)}h` : '—';
              return (
                <li
                  key={t.id}
                  className={`r21-focal-task is-state-${stateClass} ${isLive ? 'is-live' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => setDrilledTaskId(String(t.id))}
                    title="See this task's activity feed"
                  >
                    <span className={`r21-focal-task-state state-${stateClass}`}>{t.state}</span>
                    <span className="r21-focal-task-title">{t.title}</span>
                    {isLive && <span className="r21-focal-task-live">timer running</span>}
                    <span className="r21-grow" />
                    <span className="r21-num is-compact">
                      <span className="cap">EST</span>
                      <span className="val">{estimateFor(t)}</span>
                    </span>
                    <span className="r21-num is-compact">
                      <span className="cap">REM</span>
                      <span className={`val ${t.remainingWork == null ? 'is-missing' : ''}`}>
                        {tRem}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {focusNotes.length > 0 && (
        <section className="r21-focus-notes" aria-label="Notes about this work">
          <div className="r21-focus-notes-head">Notes about this work</div>
          <ul className="list">
            {focusNotes.map(n => (
              <NoteRow key={n.id} note={n} onChange={onRefresh} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// Legacy R21Focus removed — Dashboard now calls R21FocusGrid directly.

function FocusTaskDrill({
  task,
  story,
  onBack,
  onOpenItem,
}: {
  task: ApiWorkItem;
  /** Null when the panel had no story group to sit under — the drill-in still
   *  works, the Back button just can't name where it goes back to. */
  story: ApiUserStoryGroup | null;
  onBack: () => void;
  onOpenItem: (id: string) => void;
}) {
  const loggedSec = task.localLoggedSeconds;
  const logged = fmtHM(loggedSec, 0);
  const startedAt = task.activeSession ? fmtEventStamp(task.activeSession.startedAt) : '';
  const remaining = task.remainingWork != null ? `${Math.round(task.remainingWork)}h` : 'not set';
  const completed = task.completedWork != null ? `${Math.round(task.completedWork)}h` : 'not set';
  const events = task.recentActivity;
  const taskBlocked = isBlockedState(task.state) || (task.type === 'Bug' && isBlocked(task.tags));
  const stateClass = boardStateClass(task.state);
  const isLive = !!task.activeSession;

  return (
    <div className="r21-focal">
      <button type="button" className="r21-focal-back" onClick={onBack} title="Back to the story view">
        <span className="arr" aria-hidden="true">←</span>
        <span className="lbl">{story ? 'Back to' : 'Back'}</span>
        {story && <span className="story">{story.title}</span>}
      </button>

      <div className="r21-focal-story-meta">
        <span className={`r21-focal-task-state state-${stateClass}`}>{task.state}</span>
        <Mono className="r21-focal-story-id">#{task.id}</Mono>
        {isLive && <span className="r21-live-pill">timer running</span>}
      </div>
      <h1 className="r21-focal-title">
        <button type="button" onClick={() => onOpenItem(task.id)} title="Open task details">
          {task.title}
        </button>
      </h1>

      {taskBlocked && (
        <div className="r21-focal-blocked">
          <span className="r21-blocked-pill">blocked</span>
          <span className="r21-focal-blocked-meta">this task is blocked</span>
        </div>
      )}

      <div className="r21-focal-meta">
        {startedAt && <span className="r21-since">started <span className="v">{startedAt}</span></span>}
        <span className="r21-grow" />
        <span className="r21-num">
          <span className="cap">LOGGED</span>
          <span className="val">{logged}</span>
          {task.sessionCount > 0 && <span className="sub">· {task.sessionCount} session{task.sessionCount === 1 ? '' : 's'}</span>}
        </span>
        <span className="r21-num">
          <span className="cap">COMPLETED</span>
          <span className={`val ${task.completedWork == null ? 'is-missing' : ''}`}>{completed}</span>
        </span>
        <span className="r21-num">
          <span className="cap">ESTIMATE</span>
          <span className="val">{estimateFor(task)}</span>
        </span>
        <span className="r21-num">
          <span className="cap">REMAINING</span>
          <span className={`val ${task.remainingWork == null ? 'is-missing' : ''}`}>{remaining}</span>
        </span>
      </div>
      <OverEstimateLine task={task} />

      <div className="r21-feed">
        <div className="r21-feed-head">
          <span className="r21-feed-title">Activity for this task</span>
          <span className="r21-feed-meta">
            {events.length} {events.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <div className="r21-feed-list">
          {events.length === 0 ? (
            <div className="r21-feed-empty">No activity logged for this task yet.</div>
          ) : (
            events.map(e => <ActivityEntry key={e.id} event={e} />)
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shown only when the server has stopped being able to refresh. Deliberately
 * NOT small-and-gray: stale numbers that look current are worse than no
 * numbers, so this has to be readable at a glance.
 */
function RefreshWarning({ message }: { message: string }) {
  return (
    <section className="r21-refreshwarn" role="status" aria-label="Dashboard is not refreshing">
      <strong>These numbers may be out of date.</strong>
      <span>{message}</span>
    </section>
  );
}


function DailyView({
  stories,
  carryForward,
  sprintName,
  onOpenItem,
  outlookCapacity,
  helperNotes,
  needsYou,
  wrap,
  now,
  standup,
  today,
  totalDays,
  live,
  focalTitle,
  onRefresh,
  railCollapsed,
  onToggleRailCollapsed,
  data,
}: {
  stories: ApiUserStoryGroup[];
  carryForward: ApiPayload['carryForward'];
  sprintName: string;
  onOpenItem: (id: string) => void;
  outlookCapacity: ApiOutlookCapacity | null;
  helperNotes: ApiHelperNotes;
  needsYou: ApiNeedsYou;
  wrap: ApiPayload['wrap'];
  now: Date;
  standup: ApiPayload['standup'];
  today: number;
  totalDays: number;
  live: boolean;
  focalTitle?: string;
  onRefresh: () => void;
  railCollapsed: boolean;
  onToggleRailCollapsed: () => void;
  data: ApiPayload;
}) {
  // The stories column is the scroller for the "Live on…" jump button in
  // the rail. Capture it via ref so RailSprintTime can scroll the right
  // element + flash the live card.
  const storiesColRef = useRef<HTMLDivElement>(null);

  // Which story cards are currently expanded (show per-task EST/REM). Default
  // is collapsed for every card — the user expands just the one they're diving into.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setExpanded(new Set(stories.map(s => s.id)));
  const collapseAll = () => setExpanded(new Set());
  const anyExpanded = expanded.size > 0;

  // Which feature sections are collapsed (hide all the story cards under them).
  // Default is expanded for every feature — the user collapses ones they're not
  // touching this sprint to reduce visual load.
  const [featuresCollapsed, setFeaturesCollapsed] = useState<Set<string>>(new Set());
  const toggleFeatureCollapsed = (id: string) =>
    setFeaturesCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Group stories by their parent Feature/Epic. Features with active work
  // float to the top; stories with no feature fall to the bottom.
  const featureGroups = useMemo(() => {
    const map = new Map<string, { feature: ApiUserStoryGroup['feature'] | null; stories: ApiUserStoryGroup[] }>();
    for (const s of stories) {
      const key = s.feature?.id ?? '__no_feature__';
      if (!map.has(key)) map.set(key, { feature: s.feature ?? null, stories: [] });
      map.get(key)!.stories.push(s);
    }
    const groups = Array.from(map.values());
    groups.sort((a, b) => {
      // "No feature" group is always last.
      if (a.feature == null) return 1;
      if (b.feature == null) return -1;
      const aGoing = a.stories.reduce((sum, s) => sum + s.counts.inProgress, 0);
      const bGoing = b.stories.reduce((sum, s) => sum + s.counts.inProgress, 0);
      if (aGoing !== bGoing) return bGoing - aGoing;
      return b.stories.length - a.stories.length;
    });
    return groups;
  }, [stories]);

  return (
    <>
    <div className="r21-daily" ref={storiesColRef}>
      <div className="r21-daily-head">
        <div>
          <span className="r21-daily-cap">DAILY · {sprintName}</span>
          <h1 className="r21-daily-title">Your stories</h1>
        </div>
        <div className="r21-daily-head-actions">
          {stories.length > 0 && (
            <button
              type="button"
              className="r21-daily-bulk"
              onClick={anyExpanded ? collapseAll : expandAll}
              title={anyExpanded ? 'Collapse every card' : 'Expand every card'}
            >
              {anyExpanded ? 'collapse all' : 'expand all'}
            </button>
          )}
        </div>
      </div>

      {/* End-of-day wrap — appears only after work goes quiet in the
          afternoon. The evening twin of the standup card below it. */}
      <WrapCard wrap={wrap} standupToday={standup.today} now={now} onOpenItem={onOpenItem} />

      {/* Standup card — Daily-only. The first thing the user wants on the screen
          when the delivery manager opens the board: yesterday's work + today's
          work, brief, optimized for speaking aloud. */}
      <StandupCard standup={standup} />

      {carryForward && (
        <CarryForwardBanner info={carryForward} onOpenItem={onOpenItem} onDone={onRefresh} />
      )}

      {/* Discovery & Design — the feature you're thinking through, its folder,
          and the features you're driving. In the main column (not the rail the user
          keeps closed) so it's always in view. */}
      <RailDiscovery discovery={data.discovery} />

      {stories.length === 0 ? (
        <p className="r21-daily-empty">No stories in this sprint yet.</p>
      ) : (
        <div className="r21-daily-features">
          {featureGroups.map((g, idx) => {
            // Drop any story that IS its own feature — the section header
            // already represents it; the duplicate card was noise.
            const childStories = g.feature
              ? g.stories.filter(s => s.id !== g.feature!.id)
              : g.stories;
            const featureId = g.feature?.id;
            // The orphan ("No feature") group collapses too — give it a stable
            // synthetic key (the same one the grouping uses) so it joins the
            // same collapse set as real features.
            const collapseKey = featureId ?? '__no_feature__';
            const featureState = featureDominantState(childStories);
            const isCollapsed = featuresCollapsed.has(collapseKey);
            const toggle = () => toggleFeatureCollapsed(collapseKey);
            return (
              <section
                className={`r21-daily-feature is-state-${featureState} ${isCollapsed ? 'is-collapsed' : ''}`}
                key={g.feature?.id ?? `none-${idx}`}
              >
                <header
                  className={`r21-daily-feature-head is-collapsible ${g.feature ? '' : 'is-orphan'} is-state-${featureState}`}
                  {...(toggle ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: toggle,
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle();
                      }
                    },
                    'aria-expanded': !isCollapsed,
                    title: isCollapsed ? 'Show stories under this feature' : 'Hide stories under this feature',
                  } : {})}
                >
                  <span className="r21-daily-feature-caret" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="r21-daily-feature-kind">{g.feature?.type ?? 'No feature'}</span>
                  {g.feature && <Mono className="r21-daily-feature-id">#{g.feature.id}</Mono>}
                  {g.feature && childStories.length > 0 && (
                    <span className={`r21-daily-feature-state state-${featureState}`}>
                      {featureStateLabel(featureState)}
                    </span>
                  )}
                  <h3 className="r21-daily-feature-title">
                    {g.feature?.title ?? 'Stories without a parent feature'}
                  </h3>
                  <span className="r21-daily-feature-meta">
                    <span className="r21-daily-feature-count">
                      {childStories.length} {childStories.length === 1 ? 'story' : 'stories'}
                    </span>
                    {featureId && (
                      <button
                        type="button"
                        className="r21-daily-feature-view"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenItem(featureId);
                        }}
                        title="Open this feature in the drawer"
                      >
                        <span>View</span>
                        <span className="arr" aria-hidden="true">↗</span>
                      </button>
                    )}
                  </span>
                </header>
                {!isCollapsed && childStories.length > 0 && (
                  <div className="r21-daily-list">
                    {[...childStories]
                      .sort((a, b) => STORY_STATE_ORDER[storyDominantState(a)] - STORY_STATE_ORDER[storyDominantState(b)])
                      .map(s => (
                        <DailyStoryCard
                          key={s.id}
                          story={s}
                          expanded={expanded.has(s.id)}
                          onOpenItem={onOpenItem}
                          onToggleExpanded={() => toggleExpanded(s.id)}
                        />
                      ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>

    <aside className={`r22-rail ${railCollapsed ? 'is-collapsed' : ''}`} aria-label="At a glance">
      <button
        type="button"
        className="r22-rail-toggle"
        onClick={onToggleRailCollapsed}
        title={railCollapsed ? 'Show the side panel' : 'Hide the side panel'}
        aria-label={railCollapsed ? 'Show the side panel' : 'Hide the side panel'}
      >
        {railCollapsed ? '‹' : '›'}
      </button>
      {!railCollapsed && (
        <>
          <RailSprintTime
            capacity={outlookCapacity}
            today={today}
            totalDays={totalDays}
            live={live}
            focalTitle={focalTitle}
            scrollerRef={storiesColRef}
          />
          <RailFitsToday
            fitsToday={data.fitsToday}
            hasCalendar={!!outlookCapacity?.hasUrl && !outlookCapacity.fetchError}
            onOpenItem={onOpenItem}
          />
          <RailNeedsYou needsYou={needsYou} now={now} />
          <RailNotes notes={helperNotes} onRefresh={onRefresh} />
        </>
      )}
    </aside>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Daily v2 rail cards (R22)                                                 */
/* -------------------------------------------------------------------------- */

function RailSprintTime({
  capacity,
  today,
  totalDays,
  live,
  focalTitle,
  scrollerRef,
}: {
  capacity: ApiOutlookCapacity | null;
  today: number;
  totalDays: number;
  live: boolean;
  focalTitle?: string;
  scrollerRef: React.RefObject<HTMLDivElement>;
}) {
  function jumpToLive() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const card = scroller.querySelector('.r21-daily-card.is-live') as HTMLElement | null;
    if (!card) return;
    const section = card.closest('.r21-daily-feature');
    if (section && section.classList.contains('is-collapsed')) {
      const head = section.querySelector('.r21-daily-feature-head') as HTMLElement | null;
      if (head) head.click();
    }
    const top = card.getBoundingClientRect().top
              - scroller.getBoundingClientRect().top
              + scroller.scrollTop - 28;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    card.classList.remove('r22-flash');
    void card.offsetWidth;
    card.classList.add('r22-flash');
    setTimeout(() => card.classList.remove('r22-flash'), 1600);
  }

  if (!capacity) {
    return (
      <section className="r22-rail-card r22-rail-sprint-time" aria-label="Sprint time">
        <div className="r22-rail-card-head">
          <span className="r22-rail-card-label">Sprint time</span>
          <span className="r22-rail-card-meta">day {today} / {totalDays || '—'}</span>
        </div>
        <p className="empty">Capacity data not available right now.</p>
      </section>
    );
  }

  const available = Math.round(capacity.availableHours);
  // Headline = real desk time STILL AHEAD, so it counts down through the
  // sprint. The whole-sprint figure is context inside the caption, not a
  // competing number on its own line.
  const availableLeft = Math.round(capacity.availableHoursRemaining);
  const hasCalendar = capacity.hasUrl && !capacity.fetchError;
  const workingDaysLeft = capacity.workingDaysRemaining;
  // The bar fills with HOURS USED, draining forward as the sprint burns down —
  // matching the universal "fuller = more spent" instinct. The headline still
  // reads the hours LEFT; bar and number tell complementary stories (one fills
  // up, one counts down) instead of competing. (A "left"-filling bar read as
  // "that much already gone" — the opposite of its meaning.)
  const pctUsed =
    available > 0
      ? Math.max(0, Math.min(100, Math.round(((available - availableLeft) / available) * 100)))
      : 0;

  return (
    <section className="r22-rail-card r22-rail-sprint-time" aria-label="Sprint time">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Sprint time</span>
        <span className="r22-rail-card-meta">day {today} / {totalDays || '—'}</span>
      </div>
      <div className="hero">
        <span className="num">{availableLeft}</span>
        <span className="unit">h</span>
        <span className="suffix">{hasCalendar ? 'left after meetings' : 'left'}</span>
      </div>
      <div className="bar" aria-hidden="true">
        <i style={{ width: `${pctUsed}%` }} />
      </div>
      <p className="caption">
        {workingDaysLeft <= 0
          ? `Last working day — ${availableLeft}h of ${available}h still open`
          : `${workingDaysLeft} working day${workingDaysLeft === 1 ? '' : 's'} left — ${availableLeft}h of ${available}h still open`}
      </p>
      {live && focalTitle ? (
        <button type="button" className="live" onClick={jumpToLive} title="Jump to the story you're working on">
          <span className="dot" aria-hidden="true" />
          Timer running on <b>{focalTitle}</b>
          <span className="arr" aria-hidden="true">↗</span>
        </button>
      ) : (
        <span className="live is-quiet">
          <span className="dot" aria-hidden="true" />
          No timer running right now
        </span>
      )}
    </section>
  );
}

/**
 * One helper note + its three actions, shared by the Daily rail and Focus.
 * - Act on it: opens a one-line box, copies a deal-with-this prompt.
 * - Keep: pins it (covers save + highlight); kept notes get an accent stripe.
 * - Done: clears it for good.
 * onChange refreshes the dashboard after a pin/unpin/dismiss write.
 */
function NoteRow({ note, onChange }: { note: ApiHelperNote; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [extra, setExtra] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = note.pinnedAt != null;

  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setBusy(false);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(buildNotePrompt(note.body, extra));
      setCopied(true);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — your browser blocked the clipboard.');
    }
  }

  return (
    <li className={`note${kept ? ' is-kept' : ''}`}>
      <div className="note-main">
        <p className="note-body">
          {boldParts(note.body).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}
        </p>
        <span className="note-age">{relAgo(note.createdAt)}</span>
      </div>
      <div className="note-actions">
        <button type="button" className="note-act" aria-expanded={composing} onClick={() => setComposing(v => !v)} disabled={busy}>
          Act on it
        </button>
        <button
          type="button"
          className={`note-keep${kept ? ' is-on' : ''}`}
          onClick={() => run(() => (kept ? unpinHelperNote(note.id) : pinHelperNote(note.id)))}
          disabled={busy}
        >
          {kept ? 'Kept' : 'Keep'}
        </button>
        <button type="button" className="note-done" onClick={() => run(() => dismissHelperNote(note.id))} disabled={busy}>
          Done
        </button>
      </div>
      {composing && (
        <div className="note-compose">
          <input
            type="text"
            value={extra}
            onChange={e => setExtra(e.target.value)}
            placeholder="Anything to add? (optional)"
            aria-label="Extra instructions for the prompt"
          />
          <button type="button" className="note-copy" onClick={copyPrompt}>
            {copied ? 'Copied ✓' : 'Copy prompt'}
          </button>
        </div>
      )}
      {error && <p className="note-error">{error}</p>}
    </li>
  );
}

function ageShort(iso: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// displayName arrives as **title** (#id) — render the title plain.
function plainTitle(displayName: string): string {
  return displayName.replace(/\*\*/g, '').replace(/\s*\(#\d+\)\s*$/, '');
}

/**
 * A quiet line when the logged time on a task has passed its estimate. No
 * colour that shouts, no motion — just the fact, where the numbers are.
 */
function OverEstimateLine({ task }: { task: ApiWorkItem }) {
  const over = overEstimate({
    originalEstimate: task.originalEstimate,
    completedWork: task.completedWork,
    loggedSeconds: task.localLoggedSeconds,
  });
  if (!over) return null;
  return <p className="r21-over">Past the estimate. {overEstimateText(over)}</p>;
}

/**
 * What can really be finished today, in today's free desk time. Tasks
 * already going come first. Calm on purpose: a short list, no colours that
 * shout, nothing that counts down.
 */
function RailFitsToday({
  fitsToday,
  hasCalendar,
  onOpenItem,
}: {
  fitsToday: ApiPayload['fitsToday'];
  hasCalendar: boolean;
  onOpenItem: (id: string) => void;
}) {
  // Older payloads have no fitsToday — render nothing, never crash.
  if (!fitsToday) return null;
  return (
    <section className="r22-rail-card r22-rail-fits" aria-label="What fits today">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">What fits today</span>
        {fitsToday.freeHours > 0 && <span className="r22-rail-card-meta">{fitsToday.freeHours}h free</span>}
      </div>
      {fitsToday.fits.length === 0 ? (
        <p className="fits-none">{fitsToday.summary}</p>
      ) : (
        <>
          <ul className="fits-list">
            {fitsToday.fits.map(f => (
              <li key={f.id}>
                <button type="button" className="fits-row" onClick={() => onOpenItem(String(f.id))}>
                  <span className="fits-title">{f.title}</span>
                  <span className="fits-hours">{f.remainingHours}h left</span>
                </button>
              </li>
            ))}
          </ul>
          {!hasCalendar && <p className="fits-none">No calendar is connected, so meetings are not counted.</p>}
        </>
      )}
    </section>
  );
}

function RailNeedsYou({ needsYou, now }: { needsYou: ApiNeedsYou | undefined; now: Date }) {
  // A long-running dev server can serve an older payload shape than the page
  // code expects (server modules bake at process start; page files load fresh
  // per request). Missing block → render nothing, never crash.
  if (!needsYou) return null;
  if (needsYou.waiting.length === 0 && needsYou.recentlyFinished.length === 0) return null;
  return (
    <section className="r22-rail-card r22-rail-needs-you" aria-label="Needs you">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Needs you</span>
        {needsYou.waiting.length > 0 && (
          <span className="r22-rail-card-meta">{needsYou.waiting.length} waiting</span>
        )}
      </div>
      <ul className="needsyou-list">
        {needsYou.waiting.map(w => (
          <li key={`w-${w.workItemId}-${w.waitingSince}`} className="needsyou-row is-waiting">
            <span className="needsyou-title">{plainTitle(w.displayName)}</span>
            <span className="needsyou-question">{w.question}</span>
            <span className="needsyou-age">waiting {ageShort(w.waitingSince, now)}</span>
          </li>
        ))}
        {needsYou.recentlyFinished.map(f => (
          <li key={`f-${f.workItemId}-${f.endedAt}`} className="needsyou-row is-finished">
            <span className="needsyou-title">{plainTitle(f.displayName)}</span>
            {f.summary && <span className="needsyou-summary">{f.summary}</span>}
            <span className="needsyou-age">finished {ageShort(f.endedAt, now)} ago</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Last path segment of a folder path, for compact display. */
function folderBase(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function RailDiscovery({ discovery }: { discovery: ApiDiscovery | undefined }) {
  // Version-skew guard: old payloads omit this → render nothing.
  if (!discovery) return null;
  // Only show once the user has a Discovery & Design workspace set.
  if (!discovery.hasWorkspace) return null;
  const { activeFeature, managed } = discovery;
  // Older server payloads have no managedCount — fall back to the list length.
  // Belt-and-suspenders: an old server also still lists the active feature in
  // `managed`, so drop it here too rather than show the same feature twice.
  const otherManaged = managed.filter(m => m.id !== activeFeature?.id);
  const managedCount = discovery.managedCount ?? managed.length;
  return (
    <section className="r22-rail-card r22-rail-discovery" aria-label="Discovery and Design">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Discovery &amp; Design</span>
        {managedCount > 0 && (
          <span className="r22-rail-card-meta">managing {managedCount}</span>
        )}
      </div>
      {activeFeature ? (
        <div className="disc-active">
          <span className="disc-on">On now</span>
          <span className="disc-title">{plainTitle(activeFeature.displayName)}</span>
          <span className="disc-folder">📁 {folderBase(activeFeature.folderPath)}</span>
        </div>
      ) : (
        <p className="empty">No feature open yet — name one in a chat to start.</p>
      )}
      {otherManaged.length > 0 && (
        <ul className="disc-managed">
          {otherManaged.map(m => (
            <li key={m.id} className="disc-managed-row">{plainTitle(m.displayName)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RailNotes({
  notes,
  onRefresh,
}: {
  notes: ApiHelperNotes;
  onRefresh: () => void;
}) {
  const empty = notes.notes.length === 0;

  return (
    <section className="r22-rail-card r22-rail-notes" aria-label="Notes from your helper">
      <div className="r22-rail-card-head">
        <span className="r22-rail-card-label">Notes from your helper</span>
      </div>
      {empty ? (
        <p className="empty">All quiet here — I'll jot notes as I notice things.</p>
      ) : (
        <>
          {notes.notes.length > 0 && (
            <ul className="list">
              {notes.notes.map(n => (
                <NoteRow key={n.id} note={n} onChange={onRefresh} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function DailyStoryCard({
  story,
  expanded,
  onOpenItem,
  onToggleExpanded,
}: {
  story: ApiUserStoryGroup;
  expanded: boolean;
  onOpenItem: (id: string) => void;
  onToggleExpanded: () => void;
}) {
  const sp = story.storyPoints != null ? `${fmtNum(story.storyPoints)}d` : '—';
  const eff = story.effort != null ? `${fmtNum(story.effort)}h` : '—';
  const taskCount = story.counts.inProgress + story.counts.upNext + story.counts.done;
  const dominant = storyDominantState(story);

  return (
    <article className={`r21-daily-card is-state-${dominant} ${expanded ? 'is-expanded' : ''} ${story.hasActiveSession ? 'is-live' : ''}`}>
      <button
        type="button"
        className="r21-daily-card-head"
        onClick={() => onOpenItem(story.id)}
      >
        <span className="r21-daily-card-headline">
          <span className="r21-daily-card-meta-row">
            <span className={`r21-daily-kind kind-${kindSlug(story.type)}`}>{story.type}</span>
            <Mono className="r21-daily-card-id">#{story.id}</Mono>
            <span className={`r21-daily-state state-${dominant}`}>{storyStateLabel(dominant, story.movedTo)}</span>
          </span>
          <h2 className="r21-daily-card-title">
            {story.title}
            <SHPip shown={story.wasSHCreated} />
          </h2>
        </span>
        <span className="r21-daily-card-numbers">
          <span className="r21-daily-num">
            <span className="cap">SP</span>
            <span className={`val ${story.storyPoints == null ? 'is-missing' : ''}`}>{sp}</span>
          </span>
          <span className="r21-daily-num">
            <span className="cap">EFFORT</span>
            <span className={`val ${story.effort == null ? 'is-missing' : ''}`}>{eff}</span>
          </span>
        </span>
      </button>

      <div className="r21-daily-card-body">
        {story.descriptionPreview && (
          <p className="r21-daily-desc">{story.descriptionPreview}</p>
        )}

        {story.url && (
          <a
            className="r21-daily-card-ext"
            href={story.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this story in Azure DevOps"
          >
            Open in Azure DevOps <span aria-hidden="true">↗</span>
          </a>
        )}

        <div className="r21-daily-counts">
          {story.counts.inProgress > 0 && (
            <span className="c-going"><span className="dot" /> {story.counts.inProgress} going</span>
          )}
          {story.counts.upNext > 0 && (
            <span className="c-waiting"><span className="dot" /> {story.counts.upNext} waiting</span>
          )}
          {story.counts.done > 0 && (
            <span className="c-done"><span className="dot" /> {story.counts.done} done</span>
          )}
          {taskCount === 0 && <span className="c-empty">no tasks under this story yet</span>}
        </div>

        {expanded && story.tasks.length > 0 && (
          <ul className="r21-daily-tasks">
            {story.tasks.map(t => {
              const sc = dailyStateClass(t.state, t.tags);
              const est = t.originalEstimate != null ? `${fmtNum(t.originalEstimate)}h` : '—';
              const rem = t.remainingWork != null ? `${fmtNum(t.remainingWork)}h` : '—';
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`r21-daily-task ${sc}`}
                    onClick={() => onOpenItem(t.id)}
                  >
                    <span className="r21-daily-task-dot" aria-hidden="true" />
                    <Mono className="r21-daily-task-id">#{t.id}</Mono>
                    <span className="r21-daily-task-title">
                      {t.title}
                      <SHPip shown={t.wasSHCreated} />
                    </span>
                    <span className="r21-daily-task-state">{dailyStateLabel(t.state, t.tags)}</span>
                    <span className="r21-daily-task-numbers">
                      <span className="r21-daily-task-num">
                        <span className="cap">EST</span>
                        <span className={`val ${t.originalEstimate == null ? 'is-missing' : ''}`}>{est}</span>
                      </span>
                      <span className="r21-daily-task-num">
                        <span className="cap">REM</span>
                        <span className={`val ${t.remainingWork == null ? 'is-missing' : ''}`}>{rem}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {story.tasks.length > 0 && (
          <button
            type="button"
            className="r21-daily-toggle"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
          >
            {expanded ? `▴  hide ${story.tasks.length} task${story.tasks.length === 1 ? '' : 's'}` : `▾  show ${story.tasks.length} task${story.tasks.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </article>
  );
}

function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(Math.round(r)) : r.toString();
}

type StoryState = 'going' | 'waiting' | 'done' | 'blocked' | 'empty' | 'moved';

const STORY_STATE_ORDER: Record<StoryState, number> = { going: 0, blocked: 1, waiting: 2, empty: 3, moved: 4, done: 5 };

function isBlockedState(state: string): boolean {
  const s = state.toLowerCase();
  return s === 'blocked' || s === 'on hold';
}

function isBlocked(tags: string[] | undefined): boolean {
  if (!tags) return false;
  return tags.some(t => t.trim().toLowerCase() === 'blocked');
}

function storyDominantState(s: ApiUserStoryGroup): StoryState {
  // State first — Blocked beats live session because we want to surface the block.
  const ownState = boardStateClass(s.state);
  if (ownState === 'blocked') return 'blocked';
  // Story itself closed → whole card is done regardless of leftover tags.
  // Done has to beat the legacy Blocked-tag fallback below, because stories
  // unblocked + closed before the workitem_unblock tag-verify fix
  // (60b9f21) still carry a stale `Blocked` tag and shouldn't read as
  // blocked when the work is over.
  if (ownState === 'done') return 'done';
  // Legacy fallback: tag without state still counts as blocked for
  // in-flight items (only reachable when state isn't Blocked AND isn't
  // Done — i.e. waiting/going/empty).
  if (isBlocked(s.tags)) return 'blocked';
  // Live session — you're literally working on it now.
  if (s.hasActiveSession) return 'going';
  // Every open task sits outside this sprint → not live work in this sprint.
  if (s.movedTo) return 'moved';
  // Story itself active → show going even if child tasks haven't been flipped yet.
  if (ownState === 'going') return 'going';
  // Otherwise fall back to child task counts.
  if (s.counts.inProgress > 0) return 'going';
  if (s.counts.done > 0 && s.counts.upNext === 0) return 'done';
  if (s.counts.upNext > 0) return 'waiting';
  return 'empty';
}

function storyStateLabel(d: StoryState, movedTo?: string | null): string {
  if (d === 'moved') return `moved to ${movedTo ?? 'another sprint'}`;
  if (d === 'going') return 'in work';
  if (d === 'blocked') return 'blocked';
  if (d === 'waiting') return 'not started';
  if (d === 'done') return 'closed';
  return 'no tasks';
}

/**
 * Bubble feature state up from its child stories. Surfacing priority:
 * blocked > going > waiting > done. A feature with mixed states reads as
 * "going" because work is in flight; only "all done" collapses to done.
 */
function featureDominantState(stories: ApiUserStoryGroup[]): StoryState {
  if (stories.length === 0) return 'empty';
  const dominants = stories.map(storyDominantState);
  if (dominants.some(d => d === 'blocked')) return 'blocked';
  if (dominants.some(d => d === 'going')) return 'going';
  if (dominants.every(d => d === 'done')) return 'done';
  // Nothing left in this sprint, but not all closed: some stories moved on.
  if (dominants.every(d => d === 'done' || d === 'moved')) return 'moved';
  if (dominants.some(d => d === 'waiting')) return 'waiting';
  return 'empty';
}

function featureStateLabel(d: StoryState): string {
  if (d === 'moved') return 'moved out of this sprint';
  if (d === 'going') return 'in work';
  if (d === 'blocked') return 'blocked';
  if (d === 'waiting') return 'not started';
  if (d === 'done') return 'closed';
  return 'no stories';
}

function dailyStateClass(state: string, tags?: string[]): string {
  if (isBlockedState(state)) return 'is-blocked';
  const s = state.toLowerCase();
  // Done has to beat the legacy Blocked-tag fallback — items closed before
  // the 60b9f21 tag-verify fix can carry a stale `Blocked` tag.
  if (s === 'done' || s === 'closed' || s === 'resolved' || s === 'completed' || s === 'removed') return 'is-done';
  if (isBlocked(tags)) return 'is-blocked';
  if (s === 'active' || s === 'in progress' || s === 'doing' || s === 'committed') return 'is-going';
  return 'is-waiting';
}

function dailyStateLabel(state: string, tags?: string[]): string {
  const sc = dailyStateClass(state, tags);
  if (sc === 'is-blocked') return 'blocked';
  if (sc === 'is-going') return 'going';
  if (sc === 'is-done') return 'done';
  return 'waiting';
}

function kindSlug(type: string): string {
  const s = type.toLowerCase();
  if (s.includes('feature')) return 'feature';
  if (s.includes('epic')) return 'epic';
  if (s.includes('bug') || s.includes('issue')) return 'bug';
  if (s.includes('story')) return 'story';
  return 'other';
}

function fmtClockISO(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Like fmtClockISO, but prepends the date when the timestamp isn't from today.
 * Same-day entries stay clean (`14:32`); older ones read `Jun 5 · 14:32` so a
 * task whose activity spans several days isn't ambiguous.
 */
function fmtEventStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${date} · ${time}`;
}

/** "in 2h 10m" when it is today; the day's name ("tomorrow", "Sunday") when it is not. */
function whenLabel(startsAt: string, now: Date): string {
  const at = new Date(startsAt);
  if (at.toDateString() === now.toDateString()) return relUntil(minutesUntilFresh(startsAt, now));
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return 'tomorrow';
  return at.toLocaleDateString(undefined, { weekday: 'long' });
}

function relUntil(min: number): string {
  if (min === 0) return 'now';
  if (min > 0) {
    if (min < 60) return `in ${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
  }
  // min < 0 — already started or already ended.
  const ago = -min;
  if (ago < 60) return `${ago}m ago`;
  const h = Math.floor(ago / 60);
  const m = ago % 60;
  return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
}

function minutesUntilFresh(startsAtISO: string, now: Date): number {
  return Math.round((new Date(startsAtISO).getTime() - now.getTime()) / 60000);
}

/** "just now" / "20m ago" / "3h ago" / "2d ago" — for the helper-notes timestamp. */
function relAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SprintPicker({
  options,
  currentName,
  onSelect,
}: {
  options: import('../lib/api').ApiSprintOption[];
  currentName: string;
  onSelect: (name: string) => void;
}) {
  const sorted = [...options].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const idx = sorted.findIndex(o => o.name === currentName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < sorted.length - 1;
  return (
    <div className="ember-sprint-pick" role="group" aria-label="Sprint navigation">
      <button
        disabled={!hasPrev}
        aria-disabled={!hasPrev}
        title={hasPrev ? `Previous sprint: ${sorted[idx - 1]?.name}` : 'No previous sprint'}
        onClick={() => hasPrev && onSelect(sorted[idx - 1]!.name)}
      >
        ←
      </button>
      <span className="ember-sprint-current" aria-current="true">
        {currentName}
      </span>
      <button
        disabled={!hasNext}
        aria-disabled={!hasNext}
        title={hasNext ? `Next sprint: ${sorted[idx + 1]?.name}` : 'No next sprint'}
        onClick={() => hasNext && onSelect(sorted[idx + 1]!.name)}
      >
        →
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading + error shells                                                    */
/* -------------------------------------------------------------------------- */

function LoadingShell({ now }: { now: Date }) {
  return (
    <div className="ember">
      <div className="ember-glow ember-glow-1" aria-hidden="true" />
      <div className="ember-glow ember-glow-2" aria-hidden="true" />
      <div className="ember-grain" aria-hidden="true" />
      <header className="ember-top">
        <div className="ember-brand">
          <span className="ember-brand-mark" aria-hidden="true" />
          <span className="ember-brand-name">SPRINTOMATIC</span>
        </div>
        <div className="ember-top-right">
          <span className="ember-chip"><Mono>{formatClock(now)}</Mono></span>
        </div>
      </header>
      <div className="ember-main">
        <aside className="ember-side">
          <p className="ember-date">{formatLongDate(now)}</p>
          <h1 className="ember-greeting" style={{ color: 'var(--ink-3)' }}>
            {greetingForHour(now)}.
            <br />Loading…
          </h1>
          <p className="ember-sub">Pulling your sprint from Azure DevOps. The first load after starting can take a moment — it's quick after that.</p>
        </aside>
        <div className="ember-content">
          <div className="ember-stats" style={{ opacity: 0.4 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="ember-stat">
                <div className="ember-stat-label">—</div>
                <div className="ember-stat-value"><Mono>…</Mono></div>
                <div className="ember-stat-sub">loading</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorShell({
  now,
  error,
  command,
  headline,
  fix,
  setupNeeded,
  onRetry,
}: {
  now: Date;
  error: string;
  command?: string;
  headline?: string;
  fix?: string;
  setupNeeded?: boolean;
  onRetry: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (setupNeeded) {
    // Not broken, just never filled in — usually a first run. Point at the
    // two ways in instead of showing an error.
    return (
      <div className="ember">
        <div className="ember-glow ember-glow-1" aria-hidden="true" />
        <div className="ember-glow ember-glow-2" aria-hidden="true" />
        <div className="ember-grain" aria-hidden="true" />
        <header className="ember-top">
          <div className="ember-brand">
            <span className="ember-brand-mark" aria-hidden="true" />
            <span className="ember-brand-name">SPRINTOMATIC</span>
          </div>
          <div className="ember-top-right">
            <span className="ember-chip"><Mono>{formatClock(now)}</Mono></span>
          </div>
        </header>
        <div className="ember-main">
          <aside className="ember-side">
            <p className="ember-date">{formatLongDate(now)}</p>
            <h1 className="ember-greeting">Not set up yet.</h1>
            <p className="ember-sub">{error}</p>
            <button className="ember-cta" onClick={() => setSettingsOpen(true)}>
              <span className="ember-cta-line1"><span className="dim-small">SETTINGS</span></span>
              <span className="ember-cta-line2">Fill it in</span>
              <span className="ember-cta-arrow" aria-hidden="true">→</span>
            </button>
          </aside>
          <div className="ember-content">
            <div className="ember-fix">
              <p className="ember-fix-label dim-small">OR, STEP BY STEP</p>
              <p className="ember-fix-line">{withCode('In the sprintomatic folder, run `npm run setup`. It asks a few questions and checks the connection.')}</p>
              <p className="ember-fix-after dim">Then click <em>Try again</em>, or reload this page.</p>
              <button className="schedule-btn-ghost" onClick={onRetry}>Try again ↻</button>
            </div>
          </div>
        </div>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={onRetry} />
      </div>
    );
  }
  return (
    <div className="ember">
      <div className="ember-glow ember-glow-1" aria-hidden="true" />
      <div className="ember-glow ember-glow-2" aria-hidden="true" />
      <div className="ember-grain" aria-hidden="true" />
      <header className="ember-top">
        <div className="ember-brand">
          <span className="ember-brand-mark" aria-hidden="true" />
          <span className="ember-brand-name">SPRINTOMATIC</span>
        </div>
        <div className="ember-top-right">
          <span className="ember-chip"><Mono>{formatClock(now)}</Mono></span>
        </div>
      </header>
      <div className="ember-main">
        <aside className="ember-side">
          <p className="ember-date">{formatLongDate(now)}</p>
          <h1 className="ember-greeting">{headline ? `${headline}.` : "Can't reach Azure DevOps."}</h1>
          <p className="ember-sub">{error}</p>

          {command && (
            <p className="ember-cta-foot">
              <span className="dim-small">FAILED COMMAND</span>
              <br />
              <Mono style={{ color: 'var(--ink-2)' }}>{command}</Mono>
            </p>
          )}
          <button className="ember-cta" onClick={onRetry}>
            <span className="ember-cta-line1"><span className="dim-small">RETRY</span></span>
            <span className="ember-cta-line2">Try again</span>
            <span className="ember-cta-arrow" aria-hidden="true">↻</span>
          </button>
        </aside>
        <div className="ember-content">
          {fix ? (
            <div className="ember-fix">
              <p className="ember-fix-label dim-small">WHAT TO DO</p>
              <p className="ember-fix-line">{withCode(fix)}</p>
              <p className="ember-fix-after dim">Then click <em>Try again</em>.</p>
            </div>
          ) : (
            <p className="dim">
              Nothing here says what went wrong. The full error is in{' '}
              <Mono>~/.sprintomatic/logs/error.log</Mono>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Render a sentence that carries `backticked` commands as real code. The server
 * writes these fixes for both a chat (markdown) and this page, so the page has
 * to turn the backticks into something instead of printing them.
 */
function withCode(text: string) {
  return text.split(/`([^`]+)`/g).map((part, i) =>
    i % 2 === 1 ? <Mono key={i}>{part}</Mono> : <span key={i}>{part}</span>,
  );
}


function estimateFor(w: ApiWorkItem): string {
  const h = w.originalEstimate ?? w.remainingWork ?? 0;
  return h === 0 ? '—' : fmtEstimate(Math.round(h * 60));
}

function greetingCopy(inProgressCount: number, daysRemaining: number): string {
  if (inProgressCount === 0 && daysRemaining > 0) {
    return `You've got ${daysRemaining} working day${daysRemaining === 1 ? '' : 's'} left in this sprint and nothing in progress. Pick something from up next when you're ready.`;
  }
  if (inProgressCount === 1) {
    return `One task in progress. ${daysRemaining} working day${daysRemaining === 1 ? '' : 's'} left in the sprint.`;
  }
  return `${inProgressCount} tasks in progress. ${daysRemaining} working day${daysRemaining === 1 ? '' : 's'} left in the sprint — start with whichever is most urgent.`;
}

