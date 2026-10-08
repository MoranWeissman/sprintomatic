import { describe, it, expect } from 'vitest';
import { selectLiveOutsideSprintIds } from './dashboard';

describe('selectLiveOutsideSprintIds', () => {
  it('returns live-session ids not in the sprint', () => {
    expect(selectLiveOutsideSprintIds([100901, 100], [100, 200]).sort())
      .toEqual([100901]);
  });
  it('empty when every live session is in the sprint', () => {
    expect(selectLiveOutsideSprintIds([100, 200], [100, 200])).toEqual([]);
  });
  it('dedups repeated live ids', () => {
    expect(selectLiveOutsideSprintIds([100901, 100901], [])).toEqual([100901]);
  });
  it('empty when no live sessions', () => {
    expect(selectLiveOutsideSprintIds([], [100])).toEqual([]);
  });
});
