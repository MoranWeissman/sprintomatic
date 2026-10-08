import { describe, it, expect } from 'vitest';
import { boardStateClass } from './boardStateClass';

describe('boardStateClass', () => {
  it('says going for the states that mean somebody is working on it', () => {
    for (const s of ['Active', 'In Progress', 'Doing', 'Committed']) {
      expect(boardStateClass(s)).toBe('going');
    }
  });

  it('says done for the states that mean it is finished or off the board', () => {
    for (const s of ['Done', 'Closed', 'Resolved', 'Completed', 'Removed']) {
      expect(boardStateClass(s)).toBe('done');
    }
  });

  it('says waiting for the states that mean nobody has started it', () => {
    for (const s of ['New', 'Approved']) {
      expect(boardStateClass(s)).toBe('waiting');
    }
  });

  // Tasks and stories say Blocked, features say On Hold.
  it('says blocked for both spellings of stuck', () => {
    expect(boardStateClass('Blocked')).toBe('blocked');
    expect(boardStateClass('On Hold')).toBe('blocked');
  });

  // The bug this ordering prevents: a blocked item reading as finished.
  it('lets blocked win over done', () => {
    expect(boardStateClass('Blocked')).not.toBe('done');
  });

  it('ignores case and stray spaces', () => {
    expect(boardStateClass('  active ')).toBe('going');
  });

  // Deliberate: today's screen has nowhere to show "we don't know".
  it('falls back to waiting for a state name we do not know', () => {
    expect(boardStateClass('Needs Review')).toBe('waiting');
    expect(boardStateClass('')).toBe('waiting');
    expect(boardStateClass(undefined)).toBe('waiting');
  });
});
