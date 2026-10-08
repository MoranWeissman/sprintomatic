import { describe, it, expect } from 'vitest';
import { buildTaskMeta, mergeIntoTaskMeta, type TaskMetaEntry } from './dashboard';
import type { WorkItem } from './ado';

// Regression test for the bug the user hit: a closed User Story
// ("Checkout service ready to start migration") still showed as "going" in
// the morning recap. The recap reads each story's live state from taskMeta,
// but taskMeta was built only from the user's own sprint items — and a story
// worked through its child Tasks isn't its own row, so its state went missing
// and the UI fell back to "going". taskMeta must also reach the parent story's
// state via the parent fields every child task carries.

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

describe('buildTaskMeta — parent story state is reachable for the recap', () => {
  it('seeds a parent story (absent from items) from its child task parentState', () => {
    // Only the closed child Task is in the sprint item list; the Story itself
    // is present only as the task's parent fields.
    const task = raw({
      id: 300,
      type: 'Task',
      title: 'Deploy hello-world',
      state: 'Closed',
      parentId: 200,
      parentTitle: 'Checkout service ready to start migration',
      parentType: 'User Story',
      parentState: 'Closed',
    });

    const meta = buildTaskMeta([task]);

    expect(meta.get(200)?.state).toBe('Closed');
    expect(meta.get(200)?.type).toBe('User Story');
    expect(meta.get(200)?.title).toBe('Checkout service ready to start migration');
  });

  it('lets a real story item row win over the parent-derived fallback', () => {
    const story = raw({ id: 200, type: 'User Story', title: 'Story', state: 'Active' });
    const task = raw({
      id: 300,
      type: 'Task',
      title: 'T',
      state: 'Closed',
      parentId: 200,
      parentTitle: 'Story',
      parentType: 'User Story',
      parentState: 'StaleValue',
    });

    const meta = buildTaskMeta([story, task]);

    expect(meta.get(200)?.state).toBe('Active');
  });
});

describe('mergeIntoTaskMeta — fold in work from a previous sprint', () => {
  it('resolves a previous-sprint task title + its parent story (both absent from current sprint)', () => {
    // Current sprint has one unrelated story; nothing about the old work.
    const meta = buildTaskMeta([
      raw({ id: 100, type: 'User Story', title: 'This sprint story', state: 'Active' }),
    ]);

    // The recap touched a task still living in last sprint, parented to a story
    // also still in last sprint — fetched best-effort and merged in.
    const oldTask = raw({
      id: 100903,
      type: 'Task',
      title: 'Login rate limit',
      state: 'Closed',
      parentId: 100904,
      parentTitle: 'Discovery: Access & Guardrails',
      parentType: 'User Story',
      parentState: 'Closed',
    });

    mergeIntoTaskMeta(meta, [oldTask]);

    // The worked task now has a real title (no more bare #id in the recap)...
    expect(meta.get(100903)?.title).toBe('Login rate limit');
    // ...and the parent story it rolls up to is reachable with its real state.
    expect(meta.get(100904)?.title).toBe('Discovery: Access & Guardrails');
    expect(meta.get(100904)?.state).toBe('Closed');
  });

  it('never overwrites an entry already present (current-sprint data wins)', () => {
    const meta: Map<number, TaskMetaEntry> = buildTaskMeta([
      raw({ id: 100, type: 'User Story', title: 'Authoritative', state: 'Active' }),
    ]);

    mergeIntoTaskMeta(meta, [
      raw({ id: 100, type: 'User Story', title: 'Stale duplicate', state: 'Closed' }),
    ]);

    expect(meta.get(100)?.title).toBe('Authoritative');
    expect(meta.get(100)?.state).toBe('Active');
  });
});
