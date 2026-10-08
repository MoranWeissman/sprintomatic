import { describe, it, expect } from 'vitest';
import { readFocusPicks, reconcilePicks, MAX_FOCUS_PANELS } from '../lib/focusPicks';

describe('readFocusPicks', () => {
  it('parses a JSON id list', () => {
    expect(readFocusPicks('["10","20"]', null)).toEqual(['10', '20']);
  });
  it('migrates a legacy single pick when no list exists', () => {
    expect(readFocusPicks(null, '42')).toEqual(['42']);
  });
  it('empty / unreadable → empty list (caller falls back to auto-pick)', () => {
    expect(readFocusPicks(null, null)).toEqual([]);
    expect(readFocusPicks('not json', null)).toEqual([]);
  });
  it('never returns more than MAX_FOCUS_PANELS', () => {
    expect(readFocusPicks('["1","2","3","4","5","6"]', null)).toHaveLength(MAX_FOCUS_PANELS);
  });
});

describe('reconcilePicks', () => {
  it('drops picks whose session is no longer live, keeping order', () => {
    expect(reconcilePicks(['10', '20', '30'], ['30', '10'])).toEqual(['10', '30']);
  });
  it('returns empty when nothing picked is still live', () => {
    expect(reconcilePicks(['10'], ['99'])).toEqual([]);
  });
});
