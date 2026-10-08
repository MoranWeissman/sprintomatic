import { describe, it, expect } from 'vitest';
import { markMovedStories, type DashboardWorkItem, type UserStoryGroup } from './dashboard';
import type { WorkItem } from './ado';

// A story whose open tasks all sit in another sprint stops reading as live
// work on the Daily view. These tests pin when the mark is set and what it says.

function task(id: string, state: string): DashboardWorkItem {
  return {
    id, title: `#${id}`, type: 'Task', state, story: '',
    localUncapturedSeconds: 0, localLoggedSeconds: 0, recentActivity: [], sessionCount: 0,
  };
}

function story(id: string, state: string, tasks: DashboardWorkItem[]): UserStoryGroup {
  return {
    id, title: `#${id}`, type: 'User Story', state, url: '', tasks,
    totalEstimateHours: 0, completedHours: 0, remainingHours: 0,
    counts: { inProgress: 0, upNext: 0, done: 0 },
    recentActivity: [], hasActiveSession: false,
  };
}

function elsewhere(id: number, parentId: number, iterationPath: string, state = 'New'): WorkItem {
  return {
    id, rev: 1, type: 'Task', title: `#${id}`, state, parentId,
    areaPath: 'Area', iterationPath, changedDate: '2026-10-01T00:00:00Z', url: '',
  } as WorkItem;
}

const NEXT = 'Proj\\2026\\26_21';
const LATER = 'Proj\\2026\\26_22';

describe('markMovedStories', () => {
  it('names the sprint when every open task moved to one other sprint', () => {
    const g = story('100001', 'Active', [task('100002', 'Closed')]);
    markMovedStories([g], [elsewhere(100003, 100001, NEXT)]);
    expect(g.movedTo).toBe('26_21');
  });

  it('marks a story with no tasks left in this sprint at all', () => {
    const g = story('100001', 'Active', []);
    markMovedStories([g], [elsewhere(100003, 100001, NEXT)]);
    expect(g.movedTo).toBe('26_21');
  });

  it('says "other sprints" when the open tasks are spread over several', () => {
    const g = story('100001', 'Active', []);
    markMovedStories([g], [elsewhere(100003, 100001, NEXT), elsewhere(100004, 100001, LATER)]);
    expect(g.movedTo).toBe('other sprints');
  });

  it('leaves the story alone while it still has an open task in this sprint', () => {
    const g = story('100001', 'Active', [task('100002', 'Active')]);
    markMovedStories([g], [elsewhere(100003, 100001, NEXT)]);
    expect(g.movedTo).toBeNull();
  });

  it('leaves a closed story alone', () => {
    const g = story('100001', 'Closed', []);
    markMovedStories([g], [elsewhere(100003, 100001, NEXT)]);
    expect(g.movedTo).toBeNull();
  });

  it('says "the backlog" when the open tasks sit on a backlog path', () => {
    const g = story('100001', 'Active', []);
    markMovedStories([g], [elsewhere(100003, 100001, 'Proj')]);
    expect(g.movedTo).toBe('the backlog');
  });

  it('ignores tasks of other stories', () => {
    const g = story('100001', 'Active', []);
    markMovedStories([g], [elsewhere(100003, 100009, NEXT)]);
    expect(g.movedTo).toBeNull();
  });

  it('marks nothing when the out-of-sprint lookup gave nothing', () => {
    const g = story('100001', 'Active', [task('100002', 'Closed')]);
    markMovedStories([g], []);
    expect(g.movedTo).toBeNull();
  });
});
