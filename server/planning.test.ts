import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * findGaps scans TWO targets in one call: the sprint being planned (`gaps`)
 * and the current sprint (`gapsCurrent`) — the user's planning meeting often
 * lands after the sprint already started, so the Plan page shows either.
 * Board reads are mocked; ids are made up (#100001 range).
 */
const { buildDashboardCached, resolveNextSprint } = vi.hoisted(() => ({
  buildDashboardCached: vi.fn(),
  resolveNextSprint: vi.fn(),
}));

vi.mock('./dashboard-cache', () => ({ buildDashboardCached }));
vi.mock('./planning-cockpit', () => ({ resolveNextSprint }));
vi.mock('./estimate-anchor', () => ({
  buildEstimateAnchor: vi.fn(async () => {
    throw new Error('no history in these tests — anchors fall back to cold start');
  }),
}));

import { findGaps } from './planning';

/** A story-level group missing Effort — one planning gap. */
function storyGroup(id: number, title: string) {
  return { id, title, type: 'User Story', state: 'New', effort: undefined, feature: null };
}

/** A task missing both estimate fields — one planning gap. */
function task(id: number, title: string) {
  return {
    id,
    title,
    type: 'Task',
    originalEstimate: undefined,
    remainingWork: undefined,
    parent: null,
  };
}

function payloadFor(
  sprintName: string,
  opts: { tasks?: unknown[]; stories?: unknown[] } = {},
) {
  return {
    payload: {
      sprint: { name: sprintName, startDate: '2026-08-16', finishDate: '2026-08-27' },
      workItems: { inProgress: opts.tasks ?? [], upNext: [], done: [] },
      userStories: opts.stories ?? [],
    },
  };
}

beforeEach(() => {
  buildDashboardCached.mockReset();
  resolveNextSprint.mockReset();
});

describe('findGaps ships both targets', () => {
  it('gaps = next sprint, gapsCurrent = current sprint', async () => {
    resolveNextSprint.mockResolvedValue({
      name: '26_18',
      path: 'Proj\\2026\\Q3\\26_18',
      startDate: '2026-08-30',
      finishDate: '2026-09-10',
    });
    buildDashboardCached.mockImplementation(async (opts: { sprintName?: string } = {}) =>
      opts.sprintName === '26_18'
        ? payloadFor('26_18', { stories: [storyGroup(100002, 'Story planned for next sprint')] })
        : payloadFor('26_17', { tasks: [task(100001, 'Task running this sprint')] }),
    );

    const r = await findGaps();

    expect(r.gaps.map(g => g.workItemId)).toEqual([100002]);
    expect(r.totalGaps).toBe(1);
    expect(r.gapsCurrent.map(g => g.workItemId)).toEqual([100001]);
    // The prompt talks about the sprint being planned, not the current one.
    expect(r.prompt).toContain('Story planned for next sprint');
    expect(r.prompt).not.toContain('Task running this sprint');
  });

  it('no next sprint: one scan serves both, and the board is read once', async () => {
    resolveNextSprint.mockResolvedValue(null);
    buildDashboardCached.mockResolvedValue(
      payloadFor('26_17', { tasks: [task(100001, 'Task running this sprint')] }),
    );

    const r = await findGaps();

    expect(r.gaps.map(g => g.workItemId)).toEqual([100001]);
    expect(r.gapsCurrent).toBe(r.gaps); // same scan reused, not a second read
    expect(buildDashboardCached).toHaveBeenCalledTimes(1);
  });

  it('a caller-named sprint still gets current-sprint gaps alongside', async () => {
    buildDashboardCached.mockImplementation(async (opts: { sprintName?: string } = {}) =>
      opts.sprintName === '26_18'
        ? payloadFor('26_18', { stories: [storyGroup(100003, 'Named-sprint story')] })
        : payloadFor('26_17', { tasks: [task(100001, 'Task running this sprint')] }),
    );

    const r = await findGaps({ sprintName: '26_18' });

    expect(resolveNextSprint).not.toHaveBeenCalled();
    expect(r.gaps.map(g => g.workItemId)).toEqual([100003]);
    expect(r.gapsCurrent.map(g => g.workItemId)).toEqual([100001]);
  });

  it('no sprint at all: empty lists and the schedule-a-sprint message', async () => {
    resolveNextSprint.mockResolvedValue(null);
    buildDashboardCached.mockResolvedValue({
      payload: {
        sprint: null,
        workItems: { inProgress: [], upNext: [], done: [] },
        userStories: [],
      },
    });

    const r = await findGaps();

    expect(r.totalGaps).toBe(0);
    expect(r.gaps).toEqual([]);
    expect(r.gapsCurrent).toEqual([]);
    expect(r.prompt).toContain('No sprint to plan yet');
  });
});
