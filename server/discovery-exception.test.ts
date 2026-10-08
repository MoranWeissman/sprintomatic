// server/discovery-exception.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./timers', () => ({
  getSetting: (k: string) => store.get(k) ?? null,
  setSetting: (k: string, v: string) => { store.set(k, v); },
}));

import { getStoryExceptions, recordStoryException, isStoryException } from './discovery-exception';

beforeEach(() => store.clear());

describe('discovery story exceptions', () => {
  it('empty by default and on garbage', () => {
    expect(getStoryExceptions()).toEqual([]);
    store.set('discovery_story_exceptions', 'not json');
    expect(getStoryExceptions()).toEqual([]);
  });
  it('records and reports, deduped', () => {
    recordStoryException(123);
    recordStoryException(123);
    recordStoryException(456);
    expect(getStoryExceptions().sort()).toEqual([123, 456]);
    expect(isStoryException(123)).toBe(true);
    expect(isStoryException(999)).toBe(false);
  });
});
