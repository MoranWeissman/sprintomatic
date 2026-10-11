import { describe, it, expect } from 'vitest';
import { sprintDate } from './sprint-date';

describe('sprintDate', () => {
  // Holds in every time zone: run the suite with TZ=America/New_York to see it.
  it('reads a board date as that calendar day, at local midnight', () => {
    const d = sprintDate('2026-10-05T00:00:00Z');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 5, 0]);
    expect(d.getDay()).toBe(1);
  });
});
