import { describe, it, expect, vi } from 'vitest';

vi.mock('./timers', () => ({ getLocalLoggedMap: () => new Map() }));
import { computeCalibration, estimateHabitLine, MIN_CALIBRATION_SAMPLES } from './estimate-anchor';
import type { WorkItem } from './ado';

function task(id: number, estimate: number, actual: number): WorkItem {
  return {
    id,
    title: `Example task ${id}`,
    type: 'Task',
    state: 'Done',
    originalEstimate: estimate,
    completedWork: actual,
    changedDate: '2026-01-01T00:00:00Z',
  } as WorkItem;
}

describe('estimateHabitLine', () => {
  it('says plainly when there are too few finished tasks', () => {
    expect(estimateHabitLine(0, null)).toMatch(/Not enough finished tasks yet.*none yet/);
    expect(estimateHabitLine(MIN_CALIBRATION_SAMPLES - 1, 2)).toMatch(/4 so far/);
  });

  it('says the guesses are about right near 1x', () => {
    expect(estimateHabitLine(6, 1.05)).toMatch(/usually about right/);
  });

  it('gives the ratio and a worked example when the user runs long', () => {
    expect(estimateHabitLine(8, 1.4)).toBe(
      'You usually take about 1.4x your guess, so a 4-hour guess tends to end up near 5.5 hours (from your last 8 finished tasks).',
    );
  });

  it('says so when the user finishes faster', () => {
    expect(estimateHabitLine(5, 0.7)).toMatch(/finish faster than your guess, about 0.7x/);
  });
});

describe('computeCalibration', () => {
  it('uses the median, so one huge overrun does not speak for the rest', () => {
    const items = [
      task(100001, 2, 3),
      task(100002, 4, 6),
      task(100003, 2, 3),
      task(100004, 1, 1.5),
      task(100005, 1, 10),
    ];
    const cal = computeCalibration(items);
    expect(cal.samples).toBe(5);
    expect(cal.medianRatio).toBe(1.5);
    expect(cal.summary).toMatch(/about 1.5x your guess/);
  });

  it('uses the timer when it ran longer than the board hours say', () => {
    const items = [1, 2, 3, 4, 5].map(i => task(100000 + i, 2, 2));
    const logged = new Map(items.map(w => [w.id, 4 * 3600]));
    const cal = computeCalibration(items, logged);
    expect(cal.medianRatio).toBe(2);
  });

  it('skips tasks with no estimate or no hours', () => {
    const cal = computeCalibration([task(100001, 0, 3), task(100002, 2, 0)]);
    expect(cal.samples).toBe(0);
    expect(cal.summary).toMatch(/Not enough finished tasks/);
  });
});
