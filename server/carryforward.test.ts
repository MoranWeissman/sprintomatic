import { describe, it, expect } from 'vitest';
import { summarizeCarryForward } from './dashboard';
import type { WorkItem } from './ado';

function task(
  id: number,
  iterationPath: string,
  title = `Task ${id}`,
  parentId?: number,
): WorkItem {
  return {
    id, rev: 1, type: 'Task', title, state: 'New', parentId,
    assignedTo: 'me', iterationPath, areaPath: 'A',
    changedDate: '2026-06-23T00:00:00Z',
    url: `https://x/_apis/wit/workItems/${id}`,
  } as WorkItem;
}

/** All the stranded tasks in one flat list, for the assertions that don't
 *  care which story they sit under. */
function allTasks(r: { groups: { tasks: { id: number; title: string }[] }[] }) {
  return r.groups.flatMap(g => g.tasks);
}

// Past sprints, newest first — what buildDashboard passes in. Current is 26_13;
// 26_14 is a FUTURE sprint and is deliberately NOT in this set.
const PAST = [
  'MyProject\\2026\\Q2\\26_12',
  'MyProject\\2026\\Q1\\26_11',
];

describe('summarizeCarryForward', () => {
  it('returns null when no tasks are stranded', () => {
    expect(summarizeCarryForward([], PAST)).toBeNull();
  });

  it('keeps only tasks in a real previous sprint, not backlog/year/quarter', () => {
    const tasks = [
      task(1, 'MyProject\\2026\\Q2\\26_12', 'Fix the thing'),
      task(2, 'MyProject\\2026\\Q2\\26_12'),
      task(3, 'MyProject\\2026'),
      task(4, 'MyProject\\Backlog'),
    ];
    const r = summarizeCarryForward(tasks, PAST);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
    expect(r!.taskIds.sort()).toEqual([1, 2]);
    expect(r!.fromLabel).toBe('26_12, last sprint');
    // The summary carries names so the banner can list what it moves.
    expect(allTasks(r!)).toContainEqual({ id: 1, title: 'Fix the thing' });
    expect(allTasks(r!)).toHaveLength(2);
  });

  it('returns null when every stranded task is backlog-level', () => {
    expect(summarizeCarryForward([task(9, 'MyProject\\2026')], PAST)).toBeNull();
  });

  it('EXCLUDES tasks parked in a FUTURE sprint (not pulled backward)', () => {
    const tasks = [
      task(1, 'MyProject\\2026\\Q2\\26_12'),  // past — counts
      task(2, 'MyProject\\2026\\Q2\\26_14'),  // future — must be dropped
    ];
    const r = summarizeCarryForward(tasks, PAST);
    expect(r!.count).toBe(1);
    expect(r!.taskIds).toEqual([1]);
    expect(r!.fromLabel).toBe('26_12, last sprint');
  });

  it('returns null when the only stranded task is in a future sprint', () => {
    expect(summarizeCarryForward([task(5, 'MyProject\\2026\\Q2\\26_14')], PAST)).toBeNull();
  });

  it('names both sprints when the tasks straggle in from two', () => {
    const tasks = [
      task(1, 'MyProject\\2026\\Q1\\26_11'),
      task(2, 'MyProject\\2026\\Q2\\26_12'),
      task(3, 'MyProject\\2026\\Q1\\26_11'),
    ];
    const r = summarizeCarryForward(tasks, PAST);
    expect(r!.count).toBe(3);
    // Naming only the newest would have quietly hidden 26_11.
    expect(r!.fromLabel).toBe('26_12 and 26_11, the two sprints before this one');
  });

  it('says how far back a single older sprint is', () => {
    const r = summarizeCarryForward([task(1, 'MyProject\\2026\\Q1\\26_11')], PAST);
    expect(r!.fromLabel).toBe('26_11, 2 sprints back');
  });

  it('counts them instead of listing when more than two sprints are involved', () => {
    const past = [...PAST, 'MyProject\\2026\\Q1\\26_10'];
    const tasks = [
      task(1, 'MyProject\\2026\\Q2\\26_12'),
      task(2, 'MyProject\\2026\\Q1\\26_11'),
      task(3, 'MyProject\\2026\\Q1\\26_10'),
    ];
    expect(summarizeCarryForward(tasks, past)!.fromLabel).toBe('3 earlier sprints');
  });
});

describe('summarizeCarryForward grouping', () => {
  const SPRINT = 'MyProject\\2026\\Q2\\26_12';

  it('puts each task under its story, with the name leading', () => {
    const tasks = [
      task(1, SPRINT, 'Clone the skills repo', 900),
      task(2, SPRINT, 'Detect changed skills', 900),
      task(3, SPRINT, 'Verify the PR review', 901),
    ];
    const titles = new Map([[900, 'Skills sync'], [901, 'Copilot PR review']]);
    const r = summarizeCarryForward(tasks, PAST, titles);
    expect(r!.groups).toHaveLength(2);
    expect(r!.groups[0].storyDisplayName).toBe('**Skills sync** (#900)');
    expect(r!.groups[0].tasks.map(t => t.id)).toEqual([1, 2]);
    expect(r!.groups[1].storyDisplayName).toBe('**Copilot PR review** (#901)');
    expect(r!.groups[1].tasks.map(t => t.id)).toEqual([3]);
  });

  it('a task with no story gets its own group, marked as having none', () => {
    const r = summarizeCarryForward([task(1, SPRINT, 'Loose task')], PAST);
    expect(r!.groups).toHaveLength(1);
    expect(r!.groups[0].storyId).toBeNull();
    expect(r!.groups[0].storyDisplayName).toBeNull();
  });

  it('falls back to a bare id when the story title could not be read', () => {
    const r = summarizeCarryForward([task(1, SPRINT, 'Orphan', 900)], PAST, new Map());
    expect(r!.groups[0].storyId).toBe(900);
    expect(r!.groups[0].storyDisplayName).toBe('#900');
  });

  it('every stranded task lands in exactly one group', () => {
    const tasks = [
      task(1, SPRINT, 'a', 900), task(2, SPRINT, 'b'), task(3, SPRINT, 'c', 901),
      task(4, SPRINT, 'd', 900),
    ];
    const r = summarizeCarryForward(tasks, PAST, new Map([[900, 'S']]));
    expect(allTasks(r!).map(t => t.id).sort()).toEqual(r!.taskIds.sort());
    expect(allTasks(r!)).toHaveLength(4);
  });
});
