import { describe, it, expect } from 'vitest';
import { sumTaskCapacity, groupByParent, type DashboardWorkItem } from './dashboard';
import type { WorkItem } from './ado';

// The hours math has one rule that must never drift: only TASK rows carry real
// hours. A User Story / Feature / Epic row carries a rollup of the tasks under
// it, so adding those rows to the same total counts the same work twice.
// The second rule: local timer seconds only count while a timer is running.
// Pausing a timer marks its time as already sent to the board, which drops it
// out of the uncaptured map — so it must not be added on top a second time.

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

function projected(
  id: number,
  type: string,
  state: string,
  over: Partial<DashboardWorkItem> = {},
): DashboardWorkItem {
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

const HOUR = 3600;

describe('sumTaskCapacity — sprint hours', () => {
  // One story with three tasks under it. The story row carries the rollup.
  const story = raw({
    id: 100001,
    type: 'User Story',
    title: 'Set up the deploy pipeline',
    state: 'Active',
    originalEstimate: 12,
    remainingWork: 5,
    completedWork: 7,
  });
  const tasks = [
    raw({ id: 100002, type: 'Task', title: 'Write the pipeline file', state: 'Active', parentId: 100001, parentTitle: 'Set up the deploy pipeline', originalEstimate: 4, remainingWork: 1, completedWork: 3 }),
    raw({ id: 100003, type: 'Task', title: 'Add the secrets', state: 'New', parentId: 100001, parentTitle: 'Set up the deploy pipeline', originalEstimate: 5, remainingWork: 3, completedWork: 2 }),
    raw({ id: 100004, type: 'Task', title: 'Run it once by hand', state: 'New', parentId: 100001, parentTitle: 'Set up the deploy pipeline', originalEstimate: 3, remainingWork: 1, completedWork: 2 }),
  ];

  it('counts the tasks and not the story they roll up into', () => {
    const withStory = sumTaskCapacity([story, ...tasks], new Map());
    const tasksAlone = sumTaskCapacity(tasks, new Map());
    expect(withStory).toEqual(tasksAlone);
    expect(withStory).toEqual({ totalEstimateHours: 12, remainingHours: 5, completedHours: 7 });
  });

  it('adds nothing for a feature or an epic row', () => {
    const feature = raw({ id: 100005, type: 'Feature', title: 'Deploys', state: 'Active', originalEstimate: 12, remainingWork: 5, completedWork: 7 });
    const epic = raw({ id: 100006, type: 'Epic', title: 'Platform', state: 'Active', originalEstimate: 12, remainingWork: 5, completedWork: 7 });
    expect(sumTaskCapacity([...tasks, feature, epic], new Map())).toEqual(
      sumTaskCapacity(tasks, new Map()),
    );
  });

  it('adds nothing for a bug row either, because only tasks carry hours here', () => {
    const bug = raw({ id: 100007, type: 'Bug', title: 'Login loops forever', state: 'Active', originalEstimate: 6, remainingWork: 6, completedWork: 0 });
    expect(sumTaskCapacity([...tasks, bug], new Map())).toEqual(sumTaskCapacity(tasks, new Map()));
  });

  it('counts seconds from a timer that is still running', () => {
    const running = new Map([[100002, 2 * HOUR]]);
    expect(sumTaskCapacity(tasks, running).completedHours).toBe(9);
  });

  it('counts nothing extra for a timer that was paused, because pausing already sent its time', () => {
    // A paused timer is marked as sent, so it never reaches this map. The item
    // is simply absent, and the totals match the no-timer case.
    const nothingUncaptured = new Map<number, number>();
    expect(sumTaskCapacity(tasks, nothingUncaptured)).toEqual({
      totalEstimateHours: 12,
      remainingHours: 5,
      completedHours: 7,
    });
  });

  it('ignores running seconds recorded against a story rather than a task', () => {
    const onTheStory = new Map([[100001, 3 * HOUR]]);
    expect(sumTaskCapacity([story, ...tasks], onTheStory)).toEqual(sumTaskCapacity(tasks, new Map()));
  });

  it('gives the real total for the shape that once read 316 hours against 82', () => {
    // Three stories of three tasks each, all under one feature, under one epic.
    // Task hours are the truth: 82 planned, 79 done. Every row above them
    // repeats the same 79 hours as a rollup, so counting the rows too gives
    // 79 x 4 = 316 — the number that showed up on the board that day.
    const plan = [
      { estimate: [10, 12, 9], done: [10, 12, 8] },
      { estimate: [9, 11, 6], done: [9, 11, 6] },
      { estimate: [7, 13, 5], done: [7, 13, 3] },
    ];
    const items: WorkItem[] = [];
    let nextId = 100010;
    plan.forEach((s, si) => {
      const storyId = nextId++;
      const storyEstimate = s.estimate.reduce((a, b) => a + b, 0);
      const storyDone = s.done.reduce((a, b) => a + b, 0);
      items.push(raw({ id: storyId, type: 'User Story', title: `Story ${si + 1}`, state: 'Active', originalEstimate: storyEstimate, remainingWork: 0, completedWork: storyDone }));
      s.estimate.forEach((estimate, ti) => {
        items.push(raw({
          id: nextId++,
          type: 'Task',
          title: `Step ${ti + 1}`,
          state: 'Done',
          parentId: storyId,
          parentTitle: `Story ${si + 1}`,
          originalEstimate: estimate,
          remainingWork: 0,
          completedWork: s.done[ti],
        }));
      });
    });
    items.push(raw({ id: 100050, type: 'Feature', title: 'The whole feature', state: 'Active', originalEstimate: 82, remainingWork: 0, completedWork: 79 }));
    items.push(raw({ id: 100051, type: 'Epic', title: 'The whole area', state: 'Active', originalEstimate: 82, remainingWork: 0, completedWork: 79 }));

    const totals = sumTaskCapacity(items, new Map());
    expect(totals.totalEstimateHours).toBe(82);
    expect(totals.completedHours).toBe(79);

    // What the broken version produced: every row added in.
    const everyRow = items.reduce((s, w) => s + (w.completedWork ?? 0), 0);
    expect(everyRow).toBe(316);
  });

  it('treats a task with no hours on it as zero, not as a gap', () => {
    const blank = raw({ id: 100060, type: 'Task', title: 'Nothing filled in yet', state: 'New' });
    expect(sumTaskCapacity([blank], new Map())).toEqual({
      totalEstimateHours: 0,
      remainingHours: 0,
      completedHours: 0,
    });
  });

  it('counts a task that has no parent story', () => {
    const orphan = raw({ id: 100061, type: 'Task', title: 'One-off chore', state: 'Active', originalEstimate: 2, remainingWork: 2, completedWork: 0 });
    expect(sumTaskCapacity([orphan], new Map())).toEqual({
      totalEstimateHours: 2,
      remainingHours: 2,
      completedHours: 0,
    });
  });

  it('gives zeroes when there are no tasks at all', () => {
    expect(sumTaskCapacity([story], new Map())).toEqual({
      totalEstimateHours: 0,
      remainingHours: 0,
      completedHours: 0,
    });
    expect(sumTaskCapacity([], new Map())).toEqual({
      totalEstimateHours: 0,
      remainingHours: 0,
      completedHours: 0,
    });
  });

  it('never leaves hours on a task whose timer already ran past them', () => {
    // A story row clips this the same way. The sprint total used to add the
    // running time to the hours done without taking it off the hours left, so
    // done plus left came to more than was ever planned.
    const one = raw({ id: 100062, type: 'Task', title: 'Small task', state: 'Active', originalEstimate: 1, remainingWork: 1, completedWork: 0 });
    const totals = sumTaskCapacity([one], new Map([[100062, 5 * HOUR]]));
    expect(totals.remainingHours).toBe(0);
    expect(totals.completedHours).toBe(5);
  });

  it('takes a running timer off the hours left as well as adding it to the hours done', () => {
    const one = raw({ id: 100063, type: 'Task', title: 'Bigger task', state: 'Active', originalEstimate: 8, remainingWork: 6, completedWork: 2 });
    const totals = sumTaskCapacity([one], new Map([[100063, 2 * HOUR]]));
    expect(totals.remainingHours).toBe(4);
    expect(totals.completedHours).toBe(4);
    // done plus left now matches what was planned
    expect(totals.completedHours + totals.remainingHours).toBe(totals.totalEstimateHours);
  });
});

describe('groupByParent — hours on a story row', () => {
  const storyRaw = raw({
    id: 100101,
    type: 'User Story',
    title: 'Move the cluster',
    state: 'Active',
    originalEstimate: 20,
    remainingWork: 9,
    completedWork: 11,
  });
  function taskRaw(id: number, over: Partial<WorkItem> = {}): WorkItem {
    return raw({
      id,
      type: 'Task',
      title: `Task ${id}`,
      state: 'Active',
      parentId: 100101,
      parentTitle: 'Move the cluster',
      parentType: 'User Story',
      parentState: 'Active',
      ...over,
    });
  }

  it("a story's hours are its tasks' hours, not the rollup on the story itself", () => {
    const rawItems = [
      storyRaw,
      taskRaw(100102, { originalEstimate: 8, remainingWork: 4, completedWork: 4 }),
      taskRaw(100103, { originalEstimate: 7, remainingWork: 3, completedWork: 4 }),
      taskRaw(100104, { originalEstimate: 5, remainingWork: 2, completedWork: 3 }),
    ];
    const projectedItems = [
      projected(100101, 'User Story', 'Active', { originalEstimate: 20, remainingWork: 9, completedWork: 11 }),
      projected(100102, 'Task', 'Active', { originalEstimate: 8, remainingWork: 4, completedWork: 4 }),
      projected(100103, 'Task', 'Active', { originalEstimate: 7, remainingWork: 3, completedWork: 4 }),
      projected(100104, 'Task', 'Active', { originalEstimate: 5, remainingWork: 2, completedWork: 3 }),
    ];
    const groups = groupByParent(rawItems, projectedItems);
    const story = groups.find(g => g.id === '100101')!;
    expect(story.totalEstimateHours).toBe(20);
    expect(story.completedHours).toBe(11);
    expect(story.remainingHours).toBe(9);
    // The story row's own numbers are carried separately, never added in.
    expect(story.parentEstimate).toBe(20);
    expect(story.parentRemaining).toBe(9);
  });

  it('a story sitting under a feature adds nothing to the feature row', () => {
    const feature = raw({ id: 100110, type: 'Feature', title: 'Cluster work', state: 'Active', originalEstimate: 20, remainingWork: 9, completedWork: 11 });
    const childStory = raw({
      id: 100111,
      type: 'User Story',
      title: 'Move the cluster',
      state: 'Active',
      parentId: 100110,
      parentTitle: 'Cluster work',
      parentType: 'Feature',
      originalEstimate: 20,
      remainingWork: 9,
      completedWork: 11,
    });
    const groups = groupByParent(
      [feature, childStory],
      [
        projected(100110, 'Feature', 'Active', { originalEstimate: 20, remainingWork: 9, completedWork: 11 }),
        projected(100111, 'User Story', 'Active', { originalEstimate: 20, remainingWork: 9, completedWork: 11 }),
      ],
    );
    const featureRow = groups.find(g => g.id === '100110')!;
    expect(featureRow.totalEstimateHours).toBe(0);
    expect(featureRow.completedHours).toBe(0);
    expect(featureRow.remainingHours).toBe(0);
    // And the story is its own row, not filed as a task under the feature.
    expect(featureRow.tasks).toHaveLength(0);
    expect(groups.find(g => g.id === '100111')).toBeTruthy();
  });

  it("adds a running timer's seconds to the hours done and takes them off what is left", () => {
    const groups = groupByParent(
      [storyRaw, taskRaw(100120, { originalEstimate: 8, remainingWork: 4, completedWork: 4 })],
      [
        projected(100101, 'User Story', 'Active'),
        projected(100120, 'Task', 'Active', {
          originalEstimate: 8,
          remainingWork: 4,
          completedWork: 4,
          localUncapturedSeconds: 90 * 60,
        }),
      ],
    );
    const story = groups.find(g => g.id === '100101')!;
    expect(story.completedHours).toBe(5.5);
    expect(story.remainingHours).toBe(2.5);
  });

  it('never adds time that was already sent to the board', () => {
    // localLoggedSeconds holds every second the user ever tracked here,
    // including paused sittings already pushed. It must stay out of the maths.
    const groups = groupByParent(
      [storyRaw, taskRaw(100130, { originalEstimate: 8, remainingWork: 4, completedWork: 4 })],
      [
        projected(100101, 'User Story', 'Active'),
        projected(100130, 'Task', 'Active', {
          originalEstimate: 8,
          remainingWork: 4,
          completedWork: 4,
          localUncapturedSeconds: 0,
          localLoggedSeconds: 6 * HOUR,
        }),
      ],
    );
    const story = groups.find(g => g.id === '100101')!;
    expect(story.completedHours).toBe(4);
    expect(story.remainingHours).toBe(4);
  });

  it('what is left never drops below zero when the timer ran past the hours planned', () => {
    const groups = groupByParent(
      [storyRaw, taskRaw(100140, { originalEstimate: 2, remainingWork: 1, completedWork: 1 })],
      [
        projected(100101, 'User Story', 'Active'),
        projected(100140, 'Task', 'Active', {
          originalEstimate: 2,
          remainingWork: 1,
          completedWork: 1,
          localUncapturedSeconds: 5 * HOUR,
        }),
      ],
    );
    const story = groups.find(g => g.id === '100101')!;
    expect(story.remainingHours).toBe(0);
    expect(story.completedHours).toBe(6);
  });

  it('a story with no tasks under it shows zero hours', () => {
    const groups = groupByParent([storyRaw], [projected(100101, 'User Story', 'Active', { originalEstimate: 20 })]);
    const story = groups.find(g => g.id === '100101')!;
    expect(story.totalEstimateHours).toBe(0);
    expect(story.completedHours).toBe(0);
    expect(story.remainingHours).toBe(0);
  });

  it('a task with no hours filled in counts as zero on its story', () => {
    const groups = groupByParent(
      [storyRaw, taskRaw(100150), taskRaw(100151, { originalEstimate: 3, remainingWork: 3, completedWork: 0 })],
      [
        projected(100101, 'User Story', 'Active'),
        projected(100150, 'Task', 'Active'),
        projected(100151, 'Task', 'Active', { originalEstimate: 3, remainingWork: 3, completedWork: 0 }),
      ],
    );
    const story = groups.find(g => g.id === '100101')!;
    expect(story.totalEstimateHours).toBe(3);
    expect(story.completedHours).toBe(0);
    expect(story.remainingHours).toBe(3);
  });

  it('the story rows and the sprint total agree on the same set of tasks', () => {
    const rawItems = [
      storyRaw,
      taskRaw(100160, { originalEstimate: 8, remainingWork: 4, completedWork: 4 }),
      taskRaw(100161, { originalEstimate: 7, remainingWork: 3, completedWork: 4 }),
    ];
    const projectedItems = [
      projected(100101, 'User Story', 'Active', { originalEstimate: 20, remainingWork: 9, completedWork: 11 }),
      projected(100160, 'Task', 'Active', { originalEstimate: 8, remainingWork: 4, completedWork: 4 }),
      projected(100161, 'Task', 'Active', { originalEstimate: 7, remainingWork: 3, completedWork: 4 }),
    ];
    const groups = groupByParent(rawItems, projectedItems);
    const acrossRows = groups.reduce(
      (acc, g) => ({
        totalEstimateHours: acc.totalEstimateHours + g.totalEstimateHours,
        remainingHours: acc.remainingHours + g.remainingHours,
        completedHours: acc.completedHours + g.completedHours,
      }),
      { totalEstimateHours: 0, remainingHours: 0, completedHours: 0 },
    );
    expect(acrossRows).toEqual(sumTaskCapacity(rawItems, new Map()));
  });
});
