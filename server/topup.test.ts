import { describe, it, expect } from 'vitest';
import { canPullWholeStory, groupBacklog, groupTopUp } from './planning-cockpit';
import type { WorkItem } from './ado';

function wi(p: Partial<WorkItem> & { id: number }): WorkItem {
  return {
    id: p.id, rev: 1, type: p.type ?? 'Task', title: p.title ?? `Item ${p.id}`,
    state: p.state ?? 'New', assignedTo: 'me',
    iterationPath: p.iterationPath ?? 'MyProject\\Backlog', areaPath: 'A',
    changedDate: '2026-06-20T00:00:00Z', url: `https://x/${p.id}`,
    parentId: p.parentId, remainingWork: p.remainingWork, originalEstimate: p.originalEstimate,
  } as WorkItem;
}

describe('groupTopUp', () => {
  it('groups open tasks under their parent story and sums pullable hours', () => {
    const stories = [wi({ id: 1, type: 'User Story', title: 'Story one', iterationPath: 'MyProject\\2026\\Q2\\26_12' })];
    const tasks = [
      wi({ id: 11, parentId: 1, remainingWork: 5 }),
      wi({ id: 12, parentId: 1, remainingWork: 3 }),
    ];
    const r = groupTopUp(stories, tasks);
    expect(r).toHaveLength(1);
    expect(r[0].openTasks).toHaveLength(2);
    expect(r[0].pullableHours).toBe(8);
    expect(r[0].locationLabel).toBe('26_12');
  });

  it('falls back to originalEstimate when remaining is blank, and labels backlog', () => {
    const stories = [wi({ id: 2, type: 'User Story', iterationPath: 'MyProject\\Backlog' })];
    const tasks = [wi({ id: 21, parentId: 2, originalEstimate: 4 })];
    const r = groupTopUp(stories, tasks);
    expect(r[0].pullableHours).toBe(4);
    expect(r[0].locationLabel).toBe('Backlog');
  });

  it('drops dead stories and dead tasks', () => {
    const stories = [
      wi({ id: 3, type: 'User Story', state: 'Closed' }),
      wi({ id: 4, type: 'User Story', state: 'Active' }),
    ];
    const tasks = [
      wi({ id: 41, parentId: 4, state: 'Removed', remainingWork: 9 }),
      wi({ id: 42, parentId: 4, state: 'Active', remainingWork: 2 }),
    ];
    const r = groupTopUp(stories, tasks);
    expect(r.map(s => s.id)).toEqual([4]);
    expect(r[0].pullableHours).toBe(2); // removed task excluded
  });

  it('shows a story with no open tasks (pullableHours 0), sorted last', () => {
    const stories = [
      wi({ id: 5, type: 'User Story', state: 'New' }),                 // no tasks
      wi({ id: 6, type: 'User Story', state: 'Active' }),              // has tasks
    ];
    const tasks = [wi({ id: 61, parentId: 6, remainingWork: 7 })];
    const r = groupTopUp(stories, tasks);
    expect(r.map(s => s.id)).toEqual([6, 5]); // hours-bearing first, task-less last
    expect(r[1].pullableHours).toBe(0);
    expect(r[1].openTasks).toHaveLength(0);
  });

  it('canPullStory: New story in a past sprint CAN be pulled; started one CANNOT', () => {
    const past = 'MyProject\\2026\\Q2\\26_11';
    const stories = [
      wi({ id: 7, type: 'User Story', state: 'New', iterationPath: past }),    // never started
      wi({ id: 8, type: 'User Story', state: 'Active', iterationPath: past }), // started, in past sprint
    ];
    // pastSprintOf returns true only for the past path.
    const r = groupTopUp(stories, [], (p) => p === past);
    const byId = Object.fromEntries(r.map(s => [s.id, s.canPullStory]));
    expect(byId[7]).toBe(true);  // New always pullable
    expect(byId[8]).toBe(false); // started + past sprint → tasks only
  });

  it('canPullStory: started story NOT in a past sprint can be pulled whole', () => {
    const r = groupTopUp(
      [wi({ id: 9, type: 'User Story', state: 'Active', iterationPath: 'MyProject\\Backlog' })],
      [],
      () => false, // not a past sprint
    );
    expect(r[0].canPullStory).toBe(true);
  });
});

describe('backlog rows carry canPull (the single truth the Plan page reads)', () => {
  it('a genuine backlog story can always be pulled whole', () => {
    const r = groupBacklog(
      [wi({ id: 100001, type: 'User Story', state: 'Active', title: 'Backlog story', iterationPath: 'MyProject\\Backlog' })],
      () => false,
    );
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(100001);
    expect(r[0].canPull).toBe(true);
  });

  it('a New story can be pulled even off a path claimed to be a finished sprint', () => {
    const r = groupBacklog(
      [wi({ id: 100002, type: 'User Story', state: 'New', iterationPath: 'MyProject\\Backlog' })],
      () => true, // even then: never-started stories always move whole
    );
    expect(r[0].canPull).toBe(true);
  });

  it('canPullWholeStory mirrors the one real move guard', () => {
    // The only "no": a started story sitting in a finished sprint.
    expect(canPullWholeStory('Active', 'MyProject\\2026\\Q2\\26_11', () => true)).toBe(false);
    expect(canPullWholeStory('New', 'MyProject\\2026\\Q2\\26_11', () => true)).toBe(true);
    expect(canPullWholeStory('Active', 'MyProject\\Backlog', () => false)).toBe(true);
  });
});
