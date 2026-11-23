/**
 * Block, unblock and close — one path for the chat tools and the dashboard.
 *
 * The MCP tools (workitem_block, workitem_unblock) and the dashboard's buttons
 * both call these, so a task blocked or closed from either door ends up the
 * same: state, tag, reason in the log and on the board, timer stopped,
 * session closed.
 */
import { addWorkItemComment, getCurrentIteration, getWorkItem } from './ado';
import { autoCloseParentStory } from './story-autoclose';
import { checkpointWal } from './backup';
import { invalidateDashboardCache } from './dashboard-cache';
import { getDb } from './db';
import { iterationShortName, sameIterationPath } from './iteration-paths';
import { planBlock, planUnblock } from './block-plan';
import { endSession, listActiveSessions, logEvent, startSession } from './sessions';
import * as timerService from './timer-service';
import { markPendingChangesApplied } from './timers';
import { transitionFromBlocked, transitionToBlocked, updateTags } from './writes';

async function postComment(workItemId: number, text: string): Promise<{ posted: boolean; error?: string }> {
  // The reason goes into the board's discussion so the team sees it. A failed
  // comment never fails the whole block — it shows up in the reply instead.
  try {
    await addWorkItemComment(workItemId, text);
    return { posted: true };
  } catch (err) {
    return { posted: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The text saved in the log and on the board for a block. */
export function blockText(a: { reason: string; owner?: string; unblockCondition?: string; fromState: string }): string {
  const parts = [`BLOCKED: ${a.reason}`];
  if (a.owner) parts.push(`Owner: ${a.owner}`);
  if (a.unblockCondition) parts.push(`Unblock when: ${a.unblockCondition}`);
  parts.push(`(was ${a.fromState})`);
  return parts.join(' · ');
}

export async function blockItem(a: {
  workItemId: number;
  reason: string;
  owner?: string;
  unblockCondition?: string;
  tty?: string | null;
}) {
  const { workItemId } = a;
  const stateChange = await transitionToBlocked(workItemId);
  const plan = planBlock(stateChange);
  const tags = plan.changeTag ? await updateTags(workItemId, { add: ['Blocked'] }) : null;
  // A block can come from any chat window (or the dashboard), not the one
  // working the task — so leave cwd unknown; the first working chat's
  // session_start backfills it.
  const session = plan.openSession ? startSession({ workItemId, cwd: null, tty: a.tty ?? null }) : null;
  if (plan.clock === 'stop') timerService.pause(workItemId);

  if (!plan.postComment) {
    invalidateDashboardCache();
    return {
      workItemId, stateChange, tags, session, event: null,
      adoComment: { posted: false, skipped: plan.commentSkipped },
      message: stateChange.message,
    };
  }

  const text = blockText({ ...a, fromState: stateChange.fromState });
  const event = logEvent({ sessionId: session!.id, type: 'blocker', text });
  const adoComment = await postComment(workItemId, text);
  invalidateDashboardCache();
  return { workItemId, stateChange, tags, session, event, adoComment, message: stateChange.message };
}

export async function unblockItem(a: { workItemId: number; summary: string; tty?: string | null }) {
  const { workItemId } = a;
  const stateChange = await transitionFromBlocked(workItemId);
  const plan = planUnblock(stateChange);

  if (!plan.postComment) {
    return {
      workItemId, stateChange, tags: null, session: null, event: null,
      adoComment: { posted: false, skipped: plan.commentSkipped },
      message: stateChange.message,
    };
  }

  const tags = plan.changeTag ? await updateTags(workItemId, { remove: ['Blocked'] }) : null;
  const session = plan.openSession ? startSession({ workItemId, cwd: null, tty: a.tty ?? null }) : null;
  if (plan.clock === 'start') timerService.start(workItemId);

  const text = `UNBLOCKED: ${a.summary} · (now ${stateChange.toState})`;
  const event = logEvent({ sessionId: session!.id, type: 'decision', text });
  const adoComment = await postComment(workItemId, text);
  invalidateDashboardCache();
  return { workItemId, stateChange, tags, session, event, adoComment, message: stateChange.message };
}

export type DashboardCloseResult =
  | { ok: true; newState?: string; storyClosedLine: string | null }
  | { ok: false; outsideSprint?: boolean; message: string };

/**
 * Close a task from the dashboard, the same way session_end done:true does:
 * check it sits in the current sprint, write the hours and Done to the board,
 * then stop the timer and close any open session on it, and close the story
 * too when that was its last open task. The board is written first; if that fails, nothing
 * local changes, so trying again is safe.
 */
export async function closeTaskFromDashboard(a: {
  workItemId: number;
  completedHours: number;
  outsideSprintOk?: boolean;
}): Promise<DashboardCloseResult> {
  const { workItemId, completedHours } = a;

  if (!a.outsideSprintOk) {
    const task = await getWorkItem(workItemId).catch(() => null);
    const sprint = await getCurrentIteration().catch(() => null);
    if (task && sprint && task.iterationPath && !sameIterationPath(task.iterationPath, sprint.path)) {
      return {
        ok: false,
        outsideSprint: true,
        message: `"${task.title}" is in ${iterationShortName(task.iterationPath)}, not in the current sprint ${sprint.name}. Its hours won't show on this sprint's board if you close it there.`,
      };
    }
  }

  const board = await timerService.closeTaskOnBoard({ workItemId, completedHours });
  if (!board.ok) {
    return { ok: false, message: `The task was not closed. ${board.error ?? ''}`.trim() };
  }
  markPendingChangesApplied(workItemId);

  timerService.pause(workItemId);
  for (const s of listActiveSessions().filter(s => s.workItemId === workItemId)) {
    endSession({ sessionId: s.id, summary: `Closed from the dashboard with ${completedHours}h.` });
  }
  invalidateDashboardCache();
  checkpointWal(getDb());

  return { ok: true, newState: board.newState, storyClosedLine: await autoCloseParentStory(workItemId) };
}
