import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every outside call is swapped for a fake, so these tests check only the
// order and the rules: what runs, what is skipped, what comes back.
const m = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  getCurrentIteration: vi.fn(),
  addWorkItemComment: vi.fn(),
  closeTaskOnBoard: vi.fn(),
  pause: vi.fn(),
  start: vi.fn(),
  listActiveSessions: vi.fn(),
  endSession: vi.fn(),
  startSession: vi.fn(),
  logEvent: vi.fn(),
  transitionToBlocked: vi.fn(),
  transitionFromBlocked: vi.fn(),
  updateTags: vi.fn(),
  markPendingChangesApplied: vi.fn(),
}));
vi.mock('./ado', () => ({
  getWorkItem: m.getWorkItem,
  getCurrentIteration: m.getCurrentIteration,
  addWorkItemComment: m.addWorkItemComment,
}));
vi.mock('./timer-service', () => ({ closeTaskOnBoard: m.closeTaskOnBoard, pause: m.pause, start: m.start }));
vi.mock('./sessions', () => ({
  listActiveSessions: m.listActiveSessions,
  endSession: m.endSession,
  startSession: m.startSession,
  logEvent: m.logEvent,
}));
vi.mock('./writes', () => ({
  transitionToBlocked: m.transitionToBlocked,
  transitionFromBlocked: m.transitionFromBlocked,
  updateTags: m.updateTags,
}));
vi.mock('./timers', () => ({ markPendingChangesApplied: m.markPendingChangesApplied }));
vi.mock('./dashboard-cache', () => ({ invalidateDashboardCache: vi.fn() }));
vi.mock('./backup', () => ({ checkpointWal: vi.fn() }));
vi.mock('./db', () => ({ getDb: vi.fn() }));

import { blockItem, blockText, closeTaskFromDashboard } from './item-actions';

const sprint = { name: 'Sprint 5', path: 'Proj\\Sprint 5' };
const task = (over: Record<string, unknown> = {}) => ({
  id: 100001,
  title: 'Example task',
  type: 'Task',
  state: 'Active',
  iterationPath: 'Proj\\Sprint 5',
  parent: { id: 100002 },
  children: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentIteration.mockResolvedValue(sprint);
  m.listActiveSessions.mockReturnValue([]);
  m.startSession.mockReturnValue({ id: 's1' });
});

describe('closeTaskFromDashboard', () => {
  it('stops before writing when the task is outside the current sprint', async () => {
    m.getWorkItem.mockResolvedValue(task({ iterationPath: 'Proj\\Sprint 3' }));
    const r = await closeTaskFromDashboard({ workItemId: 100001, completedHours: 2 });
    expect(r).toMatchObject({ ok: false, outsideSprint: true });
    expect(m.closeTaskOnBoard).not.toHaveBeenCalled();
  });

  it('closes there anyway when the user said so', async () => {
    m.closeTaskOnBoard.mockResolvedValue({ ok: true, newState: 'Closed' });
    m.getWorkItem.mockRejectedValue(new Error('no story'));
    const r = await closeTaskFromDashboard({ workItemId: 100001, completedHours: 2, outsideSprintOk: true });
    expect(r.ok).toBe(true);
  });

  it('writes the board, stops the timer, closes only this task\'s session, and offers the story', async () => {
    m.getWorkItem.mockImplementation(async (id: number) =>
      id === 100001
        ? task()
        : { id: 100002, title: 'Example story', type: 'User Story', state: 'Active', children: [{ state: 'Closed' }] },
    );
    m.closeTaskOnBoard.mockResolvedValue({ ok: true, newState: 'Closed' });
    m.listActiveSessions.mockReturnValue([
      { id: 'mine', workItemId: 100001 },
      { id: 'other', workItemId: 100003 },
    ]);
    const r = await closeTaskFromDashboard({ workItemId: 100001, completedHours: 3 });
    expect(m.closeTaskOnBoard).toHaveBeenCalledWith({ workItemId: 100001, completedHours: 3 });
    expect(m.pause).toHaveBeenCalledWith(100001);
    expect(m.endSession).toHaveBeenCalledTimes(1);
    expect(m.endSession.mock.calls[0][0].sessionId).toBe('mine');
    expect(r).toEqual({
      ok: true,
      newState: 'Closed',
      storyCloseSuggestion: { workItemId: 100002, displayName: '**Example story** (#100002)' },
    });
  });

  it('leaves the timer and session alone when the board refuses', async () => {
    m.getWorkItem.mockResolvedValue(task());
    m.closeTaskOnBoard.mockResolvedValue({ ok: false, error: 'board said no' });
    const r = await closeTaskFromDashboard({ workItemId: 100001, completedHours: 3 });
    expect(r).toMatchObject({ ok: false });
    expect(m.pause).not.toHaveBeenCalled();
    expect(m.endSession).not.toHaveBeenCalled();
  });
});

describe('blockItem', () => {
  it('saves the reason in the log and on the board, and stops the timer', async () => {
    m.transitionToBlocked.mockResolvedValue({ fromState: 'Active', toState: 'Blocked', alreadyBlocked: false, message: 'ok' });
    m.addWorkItemComment.mockResolvedValue(undefined);
    const r = await blockItem({ workItemId: 100001, reason: 'waiting for a fix' });
    const text = 'BLOCKED: waiting for a fix · (was Active)';
    expect(m.logEvent).toHaveBeenCalledWith({ sessionId: 's1', type: 'blocker', text });
    expect(m.addWorkItemComment).toHaveBeenCalledWith(100001, text);
    expect(m.pause).toHaveBeenCalledWith(100001);
    expect(r.stateChange.toState).toBe('Blocked');
  });

  it('does not post a second comment when it was already blocked', async () => {
    m.transitionToBlocked.mockResolvedValue({ fromState: 'Blocked', toState: 'Blocked', alreadyBlocked: true, message: 'already' });
    await blockItem({ workItemId: 100001, reason: 'again' });
    expect(m.addWorkItemComment).not.toHaveBeenCalled();
    expect(m.logEvent).not.toHaveBeenCalled();
  });
});

describe('blockText', () => {
  it('adds owner and the unblock condition when given', () => {
    expect(blockText({ reason: 'r', owner: 'the other team', unblockCondition: 'they ship', fromState: 'New' })).toBe(
      'BLOCKED: r · Owner: the other team · Unblock when: they ship · (was New)',
    );
  });
});
