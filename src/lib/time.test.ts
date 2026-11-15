import { describe, expect, it } from 'vitest';
import { sprintDays, workingDayCount } from './time';

const day = (state: string, isOff = false) => ({ state, isOff });

describe('workingDayCount', () => {
  it('counts working days only, with today in both so-far and left', () => {
    const days = [day('past'), day('past', true), day('today'), day('future'), day('future', true)];
    expect(workingDayCount(days)).toEqual({ soFar: 2, total: 3, left: 2 });
  });

  it('a day off today counts in neither', () => {
    const days = [day('past'), day('today', true), day('future'), day('future')];
    expect(workingDayCount(days)).toEqual({ soFar: 1, total: 3, left: 2 });
  });
});

describe('sprintDays', () => {
  it('gives each day a full date so two same letters can be told apart', () => {
    // Tuesday 10 November 2026, local time.
    const sprint = { startDate: new Date(2026, 10, 10), totalDays: 8, workingDays: [1, 2, 3, 4, 5] };
    const days = sprintDays(sprint, new Date(2026, 10, 12, 10));
    expect(days[0].label).toBe('T');
    expect(days[0].dateLabel).toBe('Tuesday 10 November');
    expect(days[2].dateLabel).toBe('Thursday 12 November');
    expect(days[2].state).toBe('today');
    expect(days[7].label).toBe('T');
    expect(days[7].dateLabel).toBe('Tuesday 17 November');
  });
});
