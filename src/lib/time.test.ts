import { describe, expect, it } from 'vitest';
import { workingDayCount } from './time';

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
