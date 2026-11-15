import { describe, it, expect } from 'vitest';
import { oldNoteLine } from './noteAge';

const now = new Date('2026-11-15T12:00:00.000Z');

describe('oldNoteLine', () => {
  it('says nothing for a note under a day old', () => {
    expect(oldNoteLine('3 hours left', '2026-11-15T01:00:00.000Z', now)).toBeNull();
  });
  it('says yesterday for a one-day-old note with numbers', () => {
    expect(oldNoteLine('3 hours left', '2026-11-14T10:00:00.000Z', now)).toBe(
      'Written yesterday, so its numbers may be out of date.',
    );
  });
  it('counts the days after that', () => {
    expect(oldNoteLine('Only 2 tasks open', '2026-11-12T10:00:00.000Z', now)).toBe(
      'Written 3 days ago, so its numbers may be out of date.',
    );
  });
  it('ignores notes without numbers, and ticket ids are not numbers', () => {
    expect(oldNoteLine('Ask about the review', '2026-11-01T10:00:00.000Z', now)).toBeNull();
    expect(oldNoteLine('**Add dark mode** (#100001) needs a look', '2026-11-01T10:00:00.000Z', now)).toBeNull();
  });
  it('says nothing for a bad date', () => {
    expect(oldNoteLine('3 hours', 'not a date', now)).toBeNull();
  });
});
