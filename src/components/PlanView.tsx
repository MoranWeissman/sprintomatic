// src/components/PlanView.tsx — Plan v2 (header + meter + numbered steps + unified rows)
import { useEffect, useMemo, useState } from 'react';
import {
  fetchCockpit,
  fetchPlanningGaps,
  fetchPrePlan,
  markWorkItemDone,
  moveWorkItemToIteration,
  postCarryForward,
  type ApiCockpitBacklogStory,
  type ApiCockpitCapacity,
  type ApiCockpitIteration,
  type ApiCockpitOpenStory,
  type ApiCockpitOpenTask,
  type ApiCockpitPayload,
  type ApiCockpitTopUpStory,
  type ApiCockpitTopUpTask,
  type ApiPlanningGap,
  type ApiPlanningGapsResponse,
  type ApiPrePlanGoal,
} from '../lib/api';
import { boardStateClass } from '../lib/boardStateClass';

type ScanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: ApiPlanningGapsResponse }
  | { status: 'error'; error: string };

type CockpitState =
  | { status: 'loading' }
  | { status: 'ok'; data: ApiCockpitPayload }
  | { status: 'error'; error: string };

/** Which sprint the page plans into: the one running now, or the upcoming one. */
type PlanTarget = 'current' | 'next';

interface PlanViewProps {
  onOpenItem?: (id: string) => void;
  onScanComplete?: (gapCount: number) => void;
}

const LS_KEY = 'sh.plan.lastScan';
const LS_BACKLOG_COLLAPSED = 'sh.plan.backlogCollapsed';

function readCollapsedLevels(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_BACKLOG_COLLAPSED);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function writeCollapsedLevels(levels: Set<string>): void {
  try { localStorage.setItem(LS_BACKLOG_COLLAPSED, JSON.stringify([...levels])); } catch { /* ignore */ }
}

function readPersistedScan(): ApiPlanningGapsResponse | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ApiPlanningGapsResponse;
  } catch {
    return null;
  }
}
function writePersistedScan(data: ApiPlanningGapsResponse): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}
function clearPersistedScan(): void {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

/**
 * The default planning target: the current sprint while it is less than half
 * over (the planning meeting often lands after the sprint starts), the next
 * sprint after that. With no next sprint there is only one possible target.
 */
function defaultTarget(data: ApiCockpitPayload): PlanTarget {
  if (!data.nextSprint) return 'current';
  const cur = data.currentSprint;
  if (!cur) return 'next';
  const start = new Date(cur.startDate).getTime();
  const finish = new Date(cur.finishDate).getTime();
  if (Number.isFinite(start) && Number.isFinite(finish) && finish > start) {
    const mid = start + (finish - start) / 2;
    if (Date.now() < mid) return 'current';
  }
  return 'next';
}

export function PlanView({ onOpenItem, onScanComplete }: PlanViewProps) {
  const [cockpit, setCockpit] = useState<CockpitState>({ status: 'loading' });
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Session-local tally of effort/hours pulled into the next sprint via the
  // pull buttons. Resets when Plan re-mounts. The meter reads this against
  // the next-sprint capacity to show "how much of your time you've spent."
  const [pulledHoursThisSession, setPulledHoursThisSession] = useState(0);
  // Which sprint the page plans into. Null until the user picks one — the
  // default follows the sprint clock (see defaultTarget above).
  const [target, setTarget] = useState<PlanTarget | null>(null);

  const toggleExpanded = (id: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refreshCockpit = async () => {
    setCockpit({ status: 'loading' });
    try {
      const data = await fetchCockpit();
      setCockpit({ status: 'ok', data });
    } catch (err) {
      setCockpit({ status: 'error', error: err instanceof Error ? err.message : 'unknown error' });
    }
  };

  useEffect(() => { void refreshCockpit(); }, []);

  const data = cockpit.status === 'ok' ? cockpit.data : null;
  const hasNext = data?.nextSprint != null;
  // With no next sprint there is only one possible target.
  const effTarget: PlanTarget = data == null
    ? 'next'
    : !hasNext
      ? 'current'
      : target ?? defaultTarget(data);
  const targetSprint: ApiCockpitIteration | null =
    data == null ? null : effTarget === 'current' ? data.currentSprint : data.nextSprint;
  const targetCapacity: ApiCockpitCapacity | null =
    data == null ? null : effTarget === 'current' ? data.currentSprintCapacity : data.nextSprintCapacity;

  const targetCap = useMemo(() => {
    if (!targetSprint) return 0;
    // Real desk time after Outlook meetings. The server sends it whenever it
    // sends the sprint (with no calendar it equals raw working hours).
    return targetCapacity ? Math.round(targetCapacity.availableHours) : 0;
  }, [targetSprint, targetCapacity]);

  const onMoveTask = async (task: ApiCockpitOpenTask, nextSprintPath: string) => {
    setActingOn(task.id);
    setActionError(null);
    try {
      await moveWorkItemToIteration(task.id, nextSprintPath);
      const credit = task.remainingWork ?? task.originalEstimate ?? 0;
      if (credit > 0) setPulledHoursThisSession(h => h + credit);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setActingOn(null);
    }
  };

  const onCloseTask = async (taskId: number, completedHours: number) => {
    setActingOn(taskId);
    setActionError(null);
    try {
      await markWorkItemDone(taskId, completedHours);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Close failed');
    } finally {
      setActingOn(null);
    }
  };

  const onPullBacklog = async (story: ApiCockpitBacklogStory, nextSprintPath: string) => {
    setActingOn(story.id);
    setActionError(null);
    try {
      await moveWorkItemToIteration(story.id, nextSprintPath);
      const credit = story.effort ?? 0;
      if (credit > 0) setPulledHoursThisSession(h => h + credit);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setActingOn(null);
    }
  };

  const onTopUp = async (key: number, taskIds: number[], creditHours: number) => {
    if (taskIds.length === 0) return;
    setActingOn(key);
    setActionError(null);
    try {
      // Reuses the carry-forward endpoint: it resolves the current sprint
      // server-side and moves only the tasks (the story stays put).
      await postCarryForward(taskIds);
      if (creditHours > 0) setPulledHoursThisSession(h => h + creditHours);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setActingOn(null);
    }
  };

  // Pull the whole story (and its tasks) into the CURRENT sprint. The server's
  // setIterationPath enforces the move-rule, so a disallowed move surfaces as
  // an error rather than going through.
  const onPullStoryWhole = async (story: ApiCockpitTopUpStory) => {
    setActingOn(story.id);
    setActionError(null);
    try {
      const cur = cockpit.status === 'ok' ? cockpit.data.currentSprint : null;
      if (!cur) throw new Error('No current sprint to pull into.');
      await moveWorkItemToIteration(story.id, cur.path);
      if (story.pullableHours > 0) setPulledHoursThisSession(h => h + story.pullableHours);
      await refreshCockpit();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="r12-plan">
      <PlanHeader
        cockpit={cockpit}
        target={effTarget}
        onTarget={setTarget}
        filledHours={effTarget === 'current'
          ? Math.round(data?.currentSprintCommittedHours ?? 0)
          : pulledHoursThisSession}
        filledWord={effTarget === 'current' ? 'committed' : 'pulled'}
        capHours={targetCap}
        capacity={targetCapacity}
        onRefresh={() => { void refreshCockpit(); }}
      />

      <PlanGoalsStrip />

      {actionError && (
        <div className="plan2-error" role="alert">
          {actionError}
          <button onClick={() => setActionError(null)}>dismiss</button>
        </div>
      )}

      <CloseOutSection
        cockpit={cockpit}
        actingOn={actingOn}
        expanded={expanded}
        onToggleExpanded={toggleExpanded}
        onMoveTask={onMoveTask}
        onCloseTask={onCloseTask}
        onOpenItem={onOpenItem}
      />

      <PullBacklogSection
        cockpit={cockpit}
        actingOn={actingOn}
        targetSprint={targetSprint}
        onPullStory={onPullBacklog}
        onOpenItem={onOpenItem}
      />

      <SanityCheckSection target={effTarget} onScanComplete={onScanComplete} />

      <TopUpSection
        cockpit={cockpit}
        actingOn={actingOn}
        pulledHours={pulledHoursThisSession}
        onTopUp={onTopUp}
        onPullStoryWhole={onPullStoryWhole}
        onOpenItem={onOpenItem}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  HEADER + METER                                                            */
/* -------------------------------------------------------------------------- */

function PlanHeader({
  cockpit,
  target,
  onTarget,
  filledHours,
  filledWord,
  capHours,
  capacity,
  onRefresh,
}: {
  cockpit: CockpitState;
  target: PlanTarget;
  onTarget: (t: PlanTarget) => void;
  filledHours: number;
  filledWord: 'pulled' | 'committed';
  capHours: number;
  capacity: ApiCockpitCapacity | null;
  onRefresh: () => void;
}) {
  const current = cockpit.status === 'ok' ? cockpit.data.currentSprint : null;
  const next = cockpit.status === 'ok' ? cockpit.data.nextSprint : null;
  const targetIt = target === 'current' ? current : next;

  const titleCap = current && next
    ? `Planning · ${current.name} → ${next.name}`
    : current
      ? `Planning · ${current.name}`
      : 'Planning';

  // Say nothing about sprints until the board has answered — a claim like
  // "no next sprint scheduled" must be backed by real data, not by loading.
  const subText = cockpit.status !== 'ok'
    ? <>Loading the plan from Azure DevOps…</>
    : target === 'current'
      ? (targetIt
          ? <>This sprint is already running — pulling from the backlog goes straight into <b>{targetIt.name}</b>.</>
          : <>No sprint is running right now.</>)
      : (next
          ? <>Close out what's open, then pull from the backlog into <b>{next.name}</b>.</>
          : <>No next sprint scheduled yet — schedule one in Azure DevOps, or plan into the current sprint.</>);

  const cap = Math.max(0, Math.round(capHours));
  const filled = Math.max(0, Math.round(filledHours));
  const left = cap - filled;

  let verdictText = `0h ${filledWord}`;
  let verdictClass: 'is-room' | 'is-near' | 'is-over' = 'is-room';
  let fillOver = false;
  if (cap > 0) {
    if (filled > cap) { verdictText = `${filled - cap}h over`; verdictClass = 'is-over'; fillOver = true; }
    else if (left <= 8) { verdictText = `${left}h left`; verdictClass = 'is-near'; }
    else { verdictText = `${left}h to spare`; verdictClass = 'is-room'; }
  } else {
    verdictText = '— no cap yet';
    verdictClass = 'is-room';
  }
  const pct = cap > 0 ? Math.min(100, Math.round((filled / cap) * 100)) : 0;

  return (
    <div className="plan2-head">
      <div className="plan2-head-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span className="plan2-cap">{titleCap}</span>
          <button className="ember-sync" onClick={onRefresh} title="Refresh the plan from Azure DevOps">
            <span className="ember-sync-icon">↻</span>
          </button>
        </div>
        <h1 className="plan2-h">{target === 'current' ? 'Plan this sprint' : 'Plan the next sprint'}</h1>
        {(current || next) && (
          <div className="r21-place plan2-target" role="tablist" aria-label="Planning into">
            {current && (
              <button
                type="button"
                role="tab"
                aria-selected={target === 'current'}
                className={`r21-place-seg ${target === 'current' ? 'is-active' : ''}`}
                onClick={() => onTarget('current')}
                title={`Plan into the sprint running now (${current.name})`}
              >
                This sprint · {current.name}
              </button>
            )}
            {next && (
              <button
                type="button"
                role="tab"
                aria-selected={target === 'next'}
                className={`r21-place-seg ${target === 'next' ? 'is-active' : ''}`}
                onClick={() => onTarget('next')}
                title={`Plan into the upcoming sprint (${next.name})`}
              >
                Next · {next.name}
              </button>
            )}
          </div>
        )}
        <p className="plan2-sub">{subText}</p>
      </div>
      <div className="plan2-meter">
        <div className="plan2-meter-top">
          <span className="plan2-meter-label">
            {targetIt
              ? `${targetIt.name} ${target === 'current' ? 'load' : 'commitment'}`
              : 'Sprint commitment'}
          </span>
          <span className={`plan2-meter-verdict ${verdictClass}`}>{verdictText}</span>
        </div>
        <div className="plan2-meter-bar">
          <span className={`plan2-meter-fill ${fillOver ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="plan2-meter-foot">
          <span>{filledWord} <span className="n big">{filled}h</span></span>
          <span>
            of <span className="n">{cap}h</span> available
            {capacity && capacity.hasUrl && capacity.meetingHours > 0 && (
              <span className="dim-small">
                &nbsp;· {Math.round(capacity.workingHoursTotal)}h − {Math.round(capacity.meetingHours)}h meetings
              </span>
            )}
            {capacity && !capacity.hasUrl && (
              <span className="dim-small">&nbsp;· connect Outlook to subtract meetings</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  STEP 1 — CLOSE OUT current sprint                                         */
/* -------------------------------------------------------------------------- */

function CloseOutSection({
  cockpit,
  actingOn,
  expanded,
  onToggleExpanded,
  onMoveTask,
  onCloseTask,
  onOpenItem,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  expanded: Set<number>;
  onToggleExpanded: (id: number) => void;
  onMoveTask: (task: ApiCockpitOpenTask, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number, completedHours: number) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  if (cockpit.status === 'loading') {
    return (
      <section className="plan2-section">
        <SectionHead step={1} title="Close out current sprint" />
        <div className="plan2-empty">Loading…</div>
      </section>
    );
  }
  if (cockpit.status === 'error') {
    return (
      <section className="plan2-section">
        <SectionHead step={1} title="Close out current sprint" />
        <div className="plan2-empty">Couldn't load — {cockpit.error}</div>
      </section>
    );
  }
  const { currentSprint, nextSprint, openStories } = cockpit.data;
  const taskRemaining = openStories.reduce((s, st) => s + st.openTasks.length, 0);

  return (
    <section className="plan2-section">
      <SectionHead
        step={1}
        title={currentSprint ? `Close out ${currentSprint.name}` : 'Close out current sprint'}
        note={openStories.length > 0
          ? <><span className="n">{openStories.length}</span> {openStories.length === 1 ? 'story' : 'stories'} open · <span className="n">{taskRemaining}</span> {taskRemaining === 1 ? 'task' : 'tasks'} remaining</>
          : null}
      />
      {openStories.length === 0 ? (
        <div className="plan2-empty">Nothing open — everything in this sprint is done.</div>
      ) : (
        <ul className="plan2-rows">
          {openStories.map(story => (
            <CloseOutStoryRow
              key={story.id}
              story={story}
              isExpanded={expanded.has(story.id)}
              onToggle={() => onToggleExpanded(story.id)}
              actingOn={actingOn}
              nextSprintPath={nextSprint?.path ?? null}
              nextSprintName={nextSprint?.name ?? null}
              onMoveTask={onMoveTask}
              onCloseTask={onCloseTask}
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CloseOutStoryRow({
  story,
  isExpanded,
  onToggle,
  actingOn,
  nextSprintPath,
  nextSprintName,
  onMoveTask,
  onCloseTask,
  onOpenItem,
}: {
  story: ApiCockpitOpenStory;
  isExpanded: boolean;
  onToggle: () => void;
  actingOn: number | null;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  onMoveTask: (task: ApiCockpitOpenTask, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number, completedHours: number) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const stateClass = boardStateClass(story.state);
  const tasksLabel = `${story.doneTaskCount}/${story.totalTaskCount}`;
  return (
    <li className={`plan2-row is-story is-${stateClass} ${isExpanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="plan2-row-main"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <span className="plan2-chevron" aria-hidden="true">▸</span>
        <KindBadge kind={kindFromType(story.type)} />
        <StateChip state={story.state} />
        <span className="plan2-title">
          <span className="t">{story.title}</span>
          <span className="id">#{story.id}</span>
        </span>
        <span className="plan2-meta">
          <span className="plan2-stat">
            <span className="l">tasks</span>
            <span className="v">{tasksLabel}</span>
          </span>
          {story.effort != null && story.effort > 0 && (
            <span className="plan2-stat is-secondary">
              <span className="l">effort</span>
              <span className="v">{Math.round(story.effort)}h</span>
            </span>
          )}
        </span>
        {story.feature && (
          <span className="plan2-feature">
            {story.feature.title} <span className="id">#{story.feature.id}</span>
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="plan2-children">
          <ul className="plan2-subrows">
            {story.openTasks.length === 0 ? (
              <li className="plan2-subrow-empty">No open tasks — story is waiting on something else.</li>
            ) : (
              story.openTasks.map(task => (
                <CloseOutTaskRow
                  key={task.id}
                  task={task}
                  busy={actingOn === task.id}
                  nextSprintPath={nextSprintPath}
                  nextSprintName={nextSprintName}
                  onMoveTask={onMoveTask}
                  onCloseTask={onCloseTask}
                  onOpenItem={onOpenItem}
                />
              ))
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

function CloseOutTaskRow({
  task,
  busy,
  nextSprintPath,
  nextSprintName,
  onMoveTask,
  onCloseTask,
  onOpenItem,
}: {
  task: ApiCockpitOpenTask;
  busy: boolean;
  nextSprintPath: string | null;
  nextSprintName: string | null;
  onMoveTask: (task: ApiCockpitOpenTask, nextSprintPath: string) => Promise<void>;
  onCloseTask: (taskId: number, completedHours: number) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const stateClass = boardStateClass(task.state);
  const rem = task.remainingWork != null ? `${Math.round(task.remainingWork)}h` : '—';
  const remMissing = task.remainingWork == null;
  return (
    <li className={`plan2-subrow plan2-row is-${stateClass}`}>
      <KindBadge kind={kindFromType(task.type)} />
      <StateChip state={task.state} />
      <button
        type="button"
        className="plan2-title plan2-title-btn"
        onClick={() => onOpenItem?.(String(task.id))}
        disabled={!onOpenItem}
        title="Open task details"
      >
        <span className="t">{task.title}</span>
        <span className="id">#{task.id}</span>
      </button>
      <span className="plan2-meta">
        <span className="plan2-stat">
          <span className="l">remaining</span>
          <span className={`v ${remMissing ? 'is-missing' : ''}`}>{rem}</span>
        </span>
      </span>
      <span className="plan2-actions">
        {nextSprintPath ? (
          <button
            type="button"
            className="plan2-act plan2-act-pull"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Move "${task.title}" to ${nextSprintName ?? 'next sprint'}?`)) return;
              void onMoveTask(task, nextSprintPath);
            }}
          >
            → {nextSprintName ?? 'next'}
          </button>
        ) : (
          <button type="button" className="plan2-act" disabled title="No next sprint scheduled.">
            → next (n/a)
          </button>
        )}
        <button
          type="button"
          className="plan2-act plan2-act-done"
          disabled={busy}
          onClick={() => {
            const def = task.originalEstimate ?? task.remainingWork ?? null;
            const raw = window.prompt(
              `Mark "${task.title}" done.\nHow many hours did it actually take? Saved to Azure DevOps as Completed.`,
              def != null ? String(def) : '',
            );
            if (raw == null) return; // cancelled
            const hours = Number(raw.trim());
            if (!Number.isFinite(hours) || hours <= 0 || hours > 999) {
              window.alert('Enter the hours it took as a number greater than 0 (max 999).');
              return;
            }
            void onCloseTask(task.id, hours);
          }}
        >
          ✓ done
        </button>
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  STEP 2 — PULL from backlog                                                */
/* -------------------------------------------------------------------------- */

function PullBacklogSection({
  cockpit,
  actingOn,
  targetSprint,
  onPullStory,
  onOpenItem,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  targetSprint: ApiCockpitIteration | null;
  onPullStory: (story: ApiCockpitBacklogStory, targetPath: string) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsedLevels());
  const toggleLevel = (level: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      writeCollapsedLevels(next);
      return next;
    });

  if (cockpit.status !== 'ok') return null;
  const { backlogStories } = cockpit.data;
  const targetName = targetSprint?.name ?? 'the sprint';

  if (backlogStories.length === 0) {
    return (
      <section className="plan2-section">
        <SectionHead step={2} title={`Pull into ${targetName}`} note="meter updates as you pull" />
        <div className="plan2-empty">Nothing in your backlog — clean slate.</div>
      </section>
    );
  }

  const groups = [
    { level: 'backlog' as const, label: 'Unscheduled', stories: backlogStories.filter(s => s.level === 'backlog') },
    { level: 'quarter' as const, label: 'Quarter shelf', stories: backlogStories.filter(s => s.level === 'quarter') },
    { level: 'year' as const, label: 'Year shelf', stories: backlogStories.filter(s => s.level === 'year') },
  ].filter(g => g.stories.length > 0);

  return (
    <section className="plan2-section">
      <SectionHead step={2} title={`Pull into ${targetName}`} note="meter updates as you pull" />
      {groups.map(group => {
        const isCollapsed = collapsed.has(group.level);
        return (
          <div key={group.level} className={`plan2-level-group ${isCollapsed ? 'is-collapsed' : ''}`}>
            <button
              type="button"
              className="plan2-level"
              onClick={() => toggleLevel(group.level)}
              aria-expanded={!isCollapsed}
            >
              <span className="plan2-chevron" aria-hidden="true">▸</span>
              <span className="plan2-level-name">{group.label}</span>
              <span className="plan2-level-line" />
              <span className="plan2-level-count">{group.stories.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="plan2-rows">
                {group.stories.map(story => (
                  <PullBacklogRow
                    key={story.id}
                    story={story}
                    busy={actingOn === story.id}
                    targetPath={targetSprint?.path ?? null}
                    targetName={targetSprint?.name ?? null}
                    onPull={onPullStory}
                    onOpenItem={onOpenItem}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

function PullBacklogRow({
  story,
  busy,
  targetPath,
  targetName,
  onPull,
  onOpenItem,
}: {
  story: ApiCockpitBacklogStory;
  busy: boolean;
  targetPath: string | null;
  targetName: string | null;
  onPull: (story: ApiCockpitBacklogStory, targetPath: string) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const stateClass = boardStateClass(story.state);
  // The server says whether this story may move. Older servers don't send the
  // field — then allow, since the server refuses an illegal move with a clear
  // error anyway.
  const pullAllowed = story.canPull !== false;
  const kind = story.type.toLowerCase() === 'bug' ? 'bug' : 'story';
  const points = story.storyPoints;
  const effort = story.effort;
  const pointsMissing = points == null || points === 0;
  const effortMissing = effort == null || effort === 0;

  return (
    <li className={`plan2-row is-${stateClass}`}>
      <div className="plan2-row-main">
        <span className="plan2-chevron is-spacer" aria-hidden="true">▸</span>
        <KindBadge kind={kind} />
        <StateChip state={story.state} />
        <button
          type="button"
          className="plan2-title plan2-title-btn"
          onClick={() => onOpenItem?.(String(story.id))}
          disabled={!onOpenItem}
          title="Open story details"
        >
          <span className="t">{story.title}</span>
          <span className="id">#{story.id}</span>
        </button>
        <span className="plan2-meta">
          <span className="plan2-stat">
            <span className="l">points</span>
            <span className={`v ${pointsMissing ? 'is-missing' : ''}`}>{pointsMissing ? '—' : points}</span>
          </span>
          <span className="plan2-stat is-secondary">
            <span className="l">effort</span>
            <span className={`v ${effortMissing ? 'is-missing' : ''}`}>{effortMissing ? '—' : `${Math.round(effort!)}h`}</span>
          </span>
        </span>
        {story.feature && (
          <span className="plan2-feature">
            {story.feature.title} <span className="id">#{story.feature.id}</span>
          </span>
        )}
        <span className="plan2-actions">
          {stateClass !== 'waiting' && (
            <span
              className="plan2-act-blocked"
              title="This story is already started — pulling moves it, open tasks and all."
            >
              underway
            </span>
          )}
          {!pullAllowed ? (
            stateClass === 'waiting' && (
              <span className="plan2-act-blocked" title="The board won't allow moving this story right now.">
                can't move
              </span>
            )
          ) : targetPath ? (
            <button
              type="button"
              className="plan2-act plan2-act-pull"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Pull "${story.title}" into ${targetName ?? 'the sprint'}?`)) return;
                void onPull(story, targetPath);
              }}
            >
              → {targetName ?? 'sprint'}
            </button>
          ) : (
            <button type="button" className="plan2-act" disabled title="No sprint to pull into.">
              → (n/a)
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  STEP 3 — SANITY CHECK (gaps + prompt panel)                                */
/* -------------------------------------------------------------------------- */

function SanityCheckSection({
  target,
  onScanComplete,
}: {
  target: PlanTarget;
  onScanComplete?: (n: number) => void;
}) {
  const [state, setState] = useState<ScanState>(() => {
    const persisted = readPersistedScan();
    return persisted ? { status: 'ok', data: persisted } : { status: 'idle' };
  });
  const [copied, setCopied] = useState(false);

  const runScan = async () => {
    setState({ status: 'loading' });
    try {
      const data = await fetchPlanningGaps();
      setState({ status: 'ok', data });
      writePersistedScan(data);
      onScanComplete?.(data.totalGaps);
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : 'unknown error' });
    }
  };

  const onClear = () => {
    clearPersistedScan();
    setState({ status: 'idle' });
    setCopied(false);
  };

  useEffect(() => {
    if (state.status !== 'ok' || !copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied, state.status]);

  const onCopy = async () => {
    if (state.status !== 'ok') return;
    try {
      await navigator.clipboard.writeText(state.data.prompt);
      setCopied(true);
    } catch {
      const pre = document.getElementById('plan2-prompt-pre');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  // Gaps for the sprint being planned. Older servers don't send gapsCurrent —
  // then the next-sprint list stands in, and nothing breaks.
  const shownGaps = state.status === 'ok'
    ? (target === 'current' ? state.data.gapsCurrent ?? state.data.gaps : state.data.gaps)
    : null;
  const total = shownGaps ? shownGaps.length : null;

  return (
    <section className="plan2-section">
      <div className="plan2-sec-head">
        <span className="plan2-step">3</span>
        <h2 className="plan2-sec-title">
          Sanity-check estimates
          {total != null && total > 0 && <span className="plan2-badge">{total}</span>}
        </h2>
        <button
          className="plan2-scan"
          onClick={runScan}
          disabled={state.status === 'loading'}
        >
          {state.status === 'loading' ? 'Scanning…' : 'Scan for gaps'}
        </button>
      </div>
      <p className="plan2-gap-intro">
        Sprint items missing an estimate. The dashboard finds them; the conversation in Claude Code fills them in.
      </p>

      {state.status === 'error' && (
        <div className="plan2-error" role="alert">
          Couldn't load the gap list — {state.error}.
          <button onClick={runScan}>Try again</button>
        </div>
      )}

      {state.status === 'ok' && shownGaps != null && shownGaps.length === 0 && (
        <div className="plan2-empty">
          Every Task and Story in the sprint you're planning has its planning fields filled in.
          <button className="plan2-prompt-btn" onClick={onClear} style={{ marginLeft: 12 }}>Clear scan</button>
        </div>
      )}

      {state.status === 'ok' && shownGaps != null && shownGaps.length > 0 && (
        <>
          <GapGroups gaps={shownGaps} />
          <section className="plan2-prompt" aria-label="Generated prompt for Claude Code">
            <header className="plan2-prompt-head">
              <span className="plan2-prompt-cap">Prompt for Claude Code</span>
              <div className="plan2-prompt-actions">
                <button className="plan2-prompt-btn is-primary" onClick={onCopy}>
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
                <button className="plan2-prompt-btn" onClick={onClear} title="Clear the saved scan — next scan starts fresh">
                  Clear
                </button>
              </div>
            </header>
            <pre id="plan2-prompt-pre" className="plan2-prompt-pre">{state.data.prompt}</pre>
            <p className="plan2-prompt-hint">
              Stays here until you clear it — copy the prompt, hand it over, come back to verify.
            </p>
          </section>
        </>
      )}
    </section>
  );
}

function GapGroups({ gaps }: { gaps: ApiPlanningGap[] }) {
  const groups = new Map<string, { label: string; featureId: number | null; gaps: ApiPlanningGap[] }>();
  for (const g of gaps) {
    const featureId = g.kind === 'story' ? g.feature?.workItemId ?? null : g.parent?.workItemId ?? null;
    const label = g.kind === 'story'
      ? (g.feature?.title ?? 'Stories (no feature)')
      : (g.parent?.title ?? 'Tasks (no parent story)');
    const key = `${label}#${featureId ?? 'none'}`;
    const bucket = groups.get(key) ?? { label, featureId, gaps: [] };
    bucket.gaps.push(g);
    groups.set(key, bucket);
  }
  return (
    <>
      {[...groups.values()].map(group => (
        <div className="plan2-gap-group" key={`${group.label}-${group.featureId ?? 'none'}`}>
          <h3 className="plan2-gap-group-h">
            {group.label}
            {group.featureId != null && <> <span className="id">#{group.featureId}</span></>}
          </h3>
          <ul className="plan2-gaps">
            {group.gaps.map(g => (
              <li className="plan2-gap" key={`${g.kind}-${g.workItemId}`}>
                <div className="plan2-gap-top">
                  <span className={`plan2-gap-kind k-${g.kind}`}>{g.kind}</span>
                  <span className="plan2-gap-name">
                    {g.title} <span className="id">#{g.workItemId}</span>
                  </span>
                </div>
                <div className="plan2-gap-missing">
                  Missing <b>{g.missing.join(', ')}</b>
                </div>
                <div className={`plan2-gap-anchor ${g.anchor.isColdStart ? 'is-cold' : ''}`}>
                  {g.anchor.summary}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sprint goals strip — read-only, carried over from the pre-plan meeting     */
/* -------------------------------------------------------------------------- */

function PlanGoalsStrip() {
  const [goals, setGoals] = useState<ApiPrePlanGoal[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPrePlan()
      .then(d => { if (alive) setGoals(d.goals); })
      // Nothing to show on failure — the strip simply stays hidden.
      .catch(() => { if (alive) setGoals([]); });
    return () => { alive = false; };
  }, []);

  if (!goals || goals.length === 0) return null;

  return (
    <div className="plan2-goals" aria-label="Sprint goals">
      <span className="plan2-goals-cap">Sprint goals</span>
      <ul className="plan2-goals-list">
        {goals.map((g, i) => (
          <li key={i} className={`plan2-goal ${g.isMine ? 'is-mine' : ''}`}>
            <span className="plan2-goal-n">{i + 1}.</span>
            <span className="plan2-goal-text">{g.text}</span>
            {g.owner && <span className="plan2-goal-owner">{g.owner}</span>}
            {g.isMine && <span className="plan2-goal-mine">mine</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function SectionHead({ step, title, note }: { step?: number; title: string; note?: React.ReactNode }) {
  return (
    <div className="plan2-sec-head">
      {step != null && <span className="plan2-step">{step}</span>}
      <h2 className="plan2-sec-title">{title}</h2>
      {note && <span className="plan2-sec-note">{note}</span>}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  return <span className="plan2-state">{state}</span>;
}

function KindBadge({ kind }: { kind: 'story' | 'task' | 'bug' }) {
  if (kind === 'task') {
    return (
      <span className="plan2-kind k-task" title="Task">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <rect x="2.5" y="2.5" width="9" height="9" rx="2" />
          <path d="M4.6 7.2l1.6 1.6 3-3.4" />
        </svg>
        Task
      </span>
    );
  }
  if (kind === 'bug') {
    return (
      <span className="plan2-kind k-bug" title="Bug">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <ellipse cx="7" cy="7.8" rx="2.8" ry="3.2" />
          <line x1="7" y1="4.6" x2="7" y2="7" />
          <line x1="4.3" y1="3.6" x2="5.4" y2="5" />
          <line x1="9.7" y1="3.6" x2="8.6" y2="5" />
          <line x1="3.9" y1="7.4" x2="2.4" y2="7" />
          <line x1="10.1" y1="7.4" x2="11.6" y2="7" />
          <line x1="3.9" y1="9.4" x2="2.6" y2="10.4" />
          <line x1="10.1" y1="9.4" x2="11.4" y2="10.4" />
        </svg>
        Bug
      </span>
    );
  }
  return (
    <span className="plan2-kind k-story" title="User Story">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="2.2" y="2.5" width="9.6" height="9" rx="1.5" />
        <line x1="4.4" y1="5.4" x2="9.6" y2="5.4" />
        <line x1="4.4" y1="7.6" x2="8.2" y2="7.6" />
      </svg>
      Story
    </span>
  );
}

/** Map a raw Azure work-item type to the badge kind. */
function kindFromType(type: string): 'story' | 'task' | 'bug' {
  const t = type.toLowerCase();
  if (t === 'task') return 'task';
  if (t === 'bug') return 'bug';
  return 'story';
}

/* -------------------------------------------------------------------------- */
/*  Top up the current sprint — an any-time tool below the numbered steps     */
/* -------------------------------------------------------------------------- */

function TopUpSection({
  cockpit,
  actingOn,
  pulledHours,
  onTopUp,
  onPullStoryWhole,
  onOpenItem,
}: {
  cockpit: CockpitState;
  actingOn: number | null;
  pulledHours: number;
  onTopUp: (key: number, taskIds: number[], creditHours: number) => Promise<void>;
  onPullStoryWhole: (story: ApiCockpitTopUpStory) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  if (cockpit.status !== 'ok') return null;
  const { currentSprint, topUpStories, currentSprintCapacity, currentSprintCommittedHours } = cockpit.data;
  const here = currentSprint?.name ?? 'this sprint';

  return (
    <section className="plan2-section plan2-topup">
      <SectionHead title="Top up this sprint" note={`pull tasks from your other stories into ${here}`} />
      <TopUpMeter
        committed={currentSprintCommittedHours}
        pulled={pulledHours}
        capacity={currentSprintCapacity}
        sprintName={here}
      />
      {topUpStories.length === 0 ? (
        <div className="plan2-empty">No other open stories — nothing to pull in.</div>
      ) : (
        <ul className="plan2-rows">
          {topUpStories.map(story => (
            <TopUpRow
              key={story.id}
              story={story}
              actingOn={actingOn}
              onTopUp={onTopUp}
              onPullStoryWhole={onPullStoryWhole}
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TopUpMeter({
  committed,
  pulled,
  capacity,
  sprintName,
}: {
  committed: number;
  pulled: number;
  capacity: ApiCockpitCapacity | null;
  sprintName: string;
}) {
  const cap = Math.max(0, Math.round(capacity?.availableHours ?? 0));
  const filled = Math.max(0, Math.round(committed + pulled));
  const left = cap - filled;
  let verdict = '— no capacity yet';
  let vClass: 'is-room' | 'is-near' | 'is-over' = 'is-room';
  let over = false;
  if (cap > 0) {
    if (filled > cap) { verdict = `${filled - cap}h over`; vClass = 'is-over'; over = true; }
    else if (left <= 8) { verdict = `${left}h left`; vClass = 'is-near'; }
    else { verdict = `${left}h to spare`; vClass = 'is-room'; }
  }
  const pct = cap > 0 ? Math.min(100, Math.round((filled / cap) * 100)) : 0;
  return (
    <div className="plan2-meter plan2-topup-meter">
      <div className="plan2-meter-top">
        <span className="plan2-meter-label">{sprintName} load</span>
        <span className={`plan2-meter-verdict ${vClass}`}>{verdict}</span>
      </div>
      <div className="plan2-meter-bar">
        <span className={`plan2-meter-fill ${over ? 'is-over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="plan2-meter-foot">
        <span>filled <span className="n big">{filled}h</span></span>
        <span>of <span className="n">{cap}h</span> {capacity?.hasUrl ? 'after meetings' : 'available'}</span>
      </div>
    </div>
  );
}

function TopUpRow({
  story,
  actingOn,
  onTopUp,
  onPullStoryWhole,
  onOpenItem,
}: {
  story: ApiCockpitTopUpStory;
  actingOn: number | null;
  onTopUp: (key: number, taskIds: number[], creditHours: number) => Promise<void>;
  onPullStoryWhole: (story: ApiCockpitTopUpStory) => Promise<void>;
  onOpenItem?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const stateClass = boardStateClass(story.state);
  const kind = story.type.toLowerCase() === 'bug' ? 'bug' : 'story';
  const hasTasks = story.openTasks.length > 0;
  const allTaskIds = story.openTasks.map(t => t.id);
  // The whole story's controls disable while ANY of its rows is in flight.
  const rowBusy = actingOn === story.id || story.openTasks.some(t => t.id === actingOn);

  return (
    <li className={`plan2-row is-${stateClass} ${hasTasks ? '' : 'plan2-topup-empty'}`}>
      <div className="plan2-row-main">
        <button
          type="button"
          className={`plan2-chevron-btn ${hasTasks ? '' : 'is-hidden'}`}
          onClick={() => hasTasks && setOpen(o => !o)}
          aria-expanded={open}
          aria-label={open ? 'Hide tasks' : 'Show tasks'}
          disabled={!hasTasks}
        >
          <span className={`plan2-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">▸</span>
        </button>
        <KindBadge kind={kind} />
        <StateChip state={story.state} />
        <button
          type="button"
          className="plan2-title plan2-title-btn"
          onClick={() => onOpenItem?.(String(story.id))}
          disabled={!onOpenItem}
          title="Open story details"
        >
          <span className="t">{story.title}</span>
          <span className="id">#{story.id}</span>
        </button>
        <span className="plan2-topup-loc" title="Where this story lives now">{story.locationLabel}</span>
        <span className="plan2-actions">
          {story.canPullStory && (
            <button
              type="button"
              className="plan2-act plan2-topup-storypull"
              disabled={rowBusy}
              onClick={() => void onPullStoryWhole(story)}
              title="Move the whole story (and its open tasks) into the current sprint"
            >
              Pull story in
            </button>
          )}
          {hasTasks ? (
            <button
              type="button"
              className="plan2-act plan2-act-pull plan2-topup-pull"
              disabled={rowBusy}
              onClick={() => void onTopUp(story.id, allTaskIds, story.pullableHours)}
              title={`Move this story's ${story.openTasks.length} open task${story.openTasks.length === 1 ? '' : 's'} into the current sprint`}
            >
              {rowBusy ? '…' : <>Pull <b>{story.pullableHours}h</b> in →</>}
            </button>
          ) : (
            !story.canPullStory && (
              <span className="plan2-topup-notasks" title="No open tasks to pull — hours live on tasks.">
                no tasks yet
              </span>
            )
          )}
        </span>
      </div>
      {open && hasTasks && (
        <ul className="plan2-rows plan2-subrows">
          {story.openTasks.map(task => (
            <TopUpTaskRow
              key={task.id}
              task={task}
              busy={rowBusy}
              onPull={() => void onTopUp(task.id, [task.id], task.remainingWork ?? task.originalEstimate ?? 0)}
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TopUpTaskRow({
  task,
  busy,
  onPull,
  onOpenItem,
}: {
  task: ApiCockpitTopUpTask;
  busy: boolean;
  onPull: () => void;
  onOpenItem?: (id: string) => void;
}) {
  const rem = task.remainingWork ?? task.originalEstimate;
  const remText = rem != null ? `${Math.round(rem)}h` : '—';
  return (
    <li className="plan2-subrow plan2-row">
      <span className="plan2-chevron is-spacer" aria-hidden="true">▸</span>
      <KindBadge kind={kindFromType(task.type)} />
      <StateChip state={task.state} />
      <button
        type="button"
        className="plan2-title plan2-title-btn"
        onClick={() => onOpenItem?.(String(task.id))}
        disabled={!onOpenItem}
        title="Open task details"
      >
        <span className="t">{task.title}</span>
        <span className="id">#{task.id}</span>
      </button>
      <span className="plan2-meta">
        <span className="plan2-stat"><span className="l">remaining</span><span className="v">{remText}</span></span>
      </span>
      <span className="plan2-actions">
        <button type="button" className="plan2-act plan2-act-pull" disabled={busy} onClick={onPull}>
          + pull
        </button>
      </span>
    </li>
  );
}
