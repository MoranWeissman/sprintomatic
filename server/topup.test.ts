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

  it('canPullStory: only a never-started story moves whole, wherever it sits', () => {
    const past = 'MyProject\\2026\\Q2\\26_11';
    const stories = [
      wi({ id: 7, type: 'User Story', state: 'New', iterationPath: past }),
      wi({ id: 8, type: 'User Story', state: 'Active', iterationPath: past }),
      wi({ id: 9, type: 'User Story', state: 'Active', iterationPath: 'MyProject\\Backlog' }),
    ];
    const byId = Object.fromEntries(groupTopUp(stories, []).map(s => [s.id, s.canPullStory]));
    expect(byId[7]).toBe(true);
    expect(byId[8]).toBe(false); // started → only its tasks move
    expect(byId[9]).toBe(false); // started, even in the backlog
  });
});

describe('backlog rows carry canPull (the single truth the Plan page reads)', () => {
  it('a never-started backlog story can be pulled whole', () => {
    const r = groupBacklog([
      wi({ id: 100001, type: 'User Story', state: 'New', title: 'Backlog story', iterationPath: 'MyProject\\Backlog' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(100001);
    expect(r[0].canPull).toBe(true);
  });

  it('a started backlog story cannot be pulled whole', () => {
    const r = groupBacklog([
      wi({ id: 100002, type: 'User Story', state: 'Active', iterationPath: 'MyProject\\Backlog' }),
    ]);
    expect(r[0].canPull).toBe(false);
  });

  it('canPullWholeStory mirrors the one real move guard', () => {
    expect(canPullWholeStory('New')).toBe(true);
    expect(canPullWholeStory('Ready For Dev')).toBe(true);
    expect(canPullWholeStory('Active')).toBe(false);
    expect(canPullWholeStory('Blocked')).toBe(false);
  });
});
