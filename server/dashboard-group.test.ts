import { describe, it, expect } from 'vitest';
import { groupByParent, type DashboardWorkItem } from './dashboard';
import type { WorkItem } from './ado';

// Regression test for the grouping bug the user hit: a User Story whose parent is
// a Feature was being filed UNDER the feature as a "task", and the feature
// showed up as a fake "story". Tasks roll up to their story; stories/bugs are
// their own row.

function raw(over: Partial<WorkItem> & { id: number; type: string; title: string; state: string }): WorkItem {
  return {
    rev: 1,
    areaPath: 'Area',
    iterationPath: 'Proj\\26_11',
    changedDate: '2026-06-07T00:00:00Z',
    url: `https://dev.azure.com/o/_apis/wit/workItems/${over.id}`,
    ...over,
  } as WorkItem;
}

function projected(id: number, type: string, state: string, over: Partial<DashboardWorkItem> = {}): DashboardWorkItem {
  return {
    id: String(id),
    title: `#${id}`,
    type,
    state,
    story: '',
    localUncapturedSeconds: 0,
    localLoggedSeconds: 0,
    recentActivity: [],
    sessionCount: 0,
    ...over,
  };
}

describe('groupByParent — stories vs tasks vs features', () => {
  // Feature 100 → Story 200 (Active) → Task 300 (Active); Story 200 is assigned
  // to the user and so is its task, exactly like the applicationsets case.
  const story = raw({
    id: 200,
    type: 'User Story',
    title: 'Design: ApplicationSets',
    state: 'Active',
    parentId: 100,
    parentTitle: 'GitOps: Phase 1',
    parentType: 'Feature',
    parentState: 'New',
  });
  const task = raw({
    id: 300,
    type: 'Task',
    title: 'Run the DR meeting',
    state: 'Active',
    parentId: 200,
    parentTitle: 'Design: ApplicationSets',
    parentType: 'User Story',
    parentState: 'Active',
    grandparentId: 100,
    grandparentTitle: 'GitOps: Phase 1',
    grandparentType: 'Feature',
  });
  const items = [story, task];
  const proj = [projected(200, 'User Story', 'Active'), projected(300, 'Task', 'Active')];

  it('keeps the user story as its own row, not a task under its feature', () => {
    const groups = groupByParent(items, proj);

    // Exactly one group, headed by the STORY (not the feature).
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.id).toBe('200');
    expect(g.type).toBe('User Story');

    // The feature is referenced as the group's feature, never as its own row.
    expect(g.feature).toEqual({ id: '100', title: 'GitOps: Phase 1', type: 'Feature' });
    expect(groups.some(x => x.id === '100')).toBe(false);
  });

  it('files the task under the story and never lists the story as its own task', () => {
    const groups = groupByParent(items, proj);
    const g = groups[0];
    expect(g.tasks.map(t => t.id)).toEqual(['300']); // only the task — not the story (#200) itself
    expect(g.counts).toEqual({ inProgress: 1, upNext: 0, done: 0 });
  });

  it('marks the story live when the session is on the story itself, not a child task', () => {
    const projWithStorySession = [
      projected(200, 'User Story', 'Active', { activeSession: { id: 's1', startedAt: '2026-06-07T09:00:00Z' } }),
      projected(300, 'Task', 'Active'),
    ];
    const groups = groupByParent(items, projWithStorySession);
    expect(groups[0].hasActiveSession).toBe(true);
  });

  it('shows an orphan task (no parent) as its own row', () => {
    const orphan = raw({ id: 400, type: 'Task', title: 'Loose task', state: 'New' });
    const groups = groupByParent([orphan], [projected(400, 'Task', 'New')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('400');
    expect(groups[0].tasks.map(t => t.id)).toEqual(['400']);
  });
});
