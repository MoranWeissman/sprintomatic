import { describe, it, expect, vi } from 'vitest';

// The nudge's wrapper reads the DB and the dashboard cache; only the pure
// parts are tested here, so stub those modules out.
vi.mock('./db', () => ({ getDb: () => null }));
vi.mock('./dashboard-cache', () => ({ peekDashboardPayload: () => null }));

import { overEstimate, overEstimateText } from './over-estimate';
import { pickOverEstimate } from './over-estimate-nudge';

describe('overEstimate', () => {
  it('is null while the logged time is within the estimate', () => {
    expect(overEstimate({ originalEstimate: 4, completedWork: 0, loggedSeconds: 4 * 3600 })).toBeNull();
  });

  it('gives a quarter hour of grace', () => {
    expect(overEstimate({ originalEstimate: 2, completedWork: 2, loggedSeconds: 2.1 * 3600 })).toBeNull();
  });

  it('fires when the timer passes the estimate', () => {
    expect(overEstimate({ originalEstimate: 4, completedWork: 0, loggedSeconds: 5.2 * 3600 })).toEqual({
      loggedHours: 5,
      estimateHours: 4,
    });
  });

  it('also counts hours entered on the board by hand', () => {
    expect(overEstimate({ originalEstimate: 2, completedWork: 3, loggedSeconds: 0 })).not.toBeNull();
  });

  it('says nothing for a task with no estimate', () => {
    expect(overEstimate({ originalEstimate: null, completedWork: 9, loggedSeconds: 0 })).toBeNull();
  });

  it('has plain words', () => {
    expect(overEstimateText({ loggedHours: 5.5, estimateHours: 4 })).toBe(
      'About 5.5 hours logged against an estimate of 4 hours.',
    );
  });
});

describe('pickOverEstimate', () => {
  const tasks = new Map([
    [100001, { id: 100001, title: 'Example task', originalEstimate: 2, completedWork: 0 }],
    [100002, { id: 100002, title: 'Other task', originalEstimate: 8, completedWork: 0 }],
  ]);
  const logged = new Map([
    [100001, 3 * 3600],
    [100002, 1 * 3600],
  ]);

  it('names only the open task that went over', () => {
    const r = pickOverEstimate([100001, 100002], tasks, logged, new Set());
    expect(r.ids).toEqual([100001]);
    expect(r.text).toContain('**Example task** (#100001): About 3 hours logged against an estimate of 2 hours.');
  });

  it('says it once per task', () => {
    const r = pickOverEstimate([100001], tasks, logged, new Set([100001]));
    expect(r).toEqual({ ids: [], text: null });
  });
});
