import { describe, it, expect } from 'vitest';
import {
  parseFeatureFolder,
  listTouchedFeatureFolders,
  deriveDndStatus,
  groupByDndStatus,
  type FeatureListEntry,
} from './discovery-list';

describe('parseFeatureFolder', () => {
  it('parses <id>-<slug>', () => {
    expect(parseFeatureFolder('100901-declarative-cd')).toEqual({ id: 100901 });
  });
  it('parses a bare <id> (symbol-only title case)', () => {
    expect(parseFeatureFolder('100901')).toEqual({ id: 100901 });
  });
  it('rejects a non-feature folder', () => {
    expect(parseFeatureFolder('notes')).toBeNull();
  });
  it('rejects digits glued to letters', () => {
    expect(parseFeatureFolder('12ab')).toBeNull();
  });
});

describe('listTouchedFeatureFolders', () => {
  const readdir = (dir: string): string[] => {
    if (dir === '/ws') return ['100901-declarative-cd', 'notes', '999'];
    if (dir === '/ws2') return ['100901-declarative-cd', 'design-system-500'];
    if (dir === '/missing') throw new Error('ENOENT');
    return [];
  };
  it('keeps only feature folders, joins the path', () => {
    expect(listTouchedFeatureFolders(['/ws'], readdir)).toEqual([
      { id: 100901, folderPath: '/ws/100901-declarative-cd' },
      { id: 999, folderPath: '/ws/999' },
    ]);
  });
  it('skips a workspace whose readdir throws', () => {
    expect(listTouchedFeatureFolders(['/missing', '/ws'], readdir)).toEqual([
      { id: 100901, folderPath: '/ws/100901-declarative-cd' },
      { id: 999, folderPath: '/ws/999' },
    ]);
  });
  it('de-dupes by id across workspaces (first wins)', () => {
    const out = listTouchedFeatureFolders(['/ws', '/ws2'], readdir);
    expect(out.filter(f => f.id === 100901)).toEqual([
      { id: 100901, folderPath: '/ws/100901-declarative-cd' },
    ]);
  });
});

describe('deriveDndStatus', () => {
  it('closed only when the board story is closed', () => {
    expect(deriveDndStatus({ hasDiscovery: true, boardClosed: true })).toBe('closed');
  });
  it('a filled-in discovery is still IN PROGRESS until the story closes', () => {
    // The whole point of the fix: a complete file does NOT mean "done".
    expect(deriveDndStatus({ hasDiscovery: true, boardClosed: false })).toBe('in-progress');
  });
  it('in-progress when a doc exists and the story is open', () => {
    expect(deriveDndStatus({ hasDiscovery: true, boardClosed: false })).toBe('in-progress');
  });
  it('not-started when no doc', () => {
    expect(deriveDndStatus({ hasDiscovery: false, boardClosed: false })).toBe('not-started');
  });
});

describe('groupByDndStatus', () => {
  const mk = (id: number, dndStatus: FeatureListEntry['dndStatus']): FeatureListEntry => ({
    id, displayName: `**F${id}** (#${id})`, folderPath: `/ws/${id}`, dndStatus, boardState: null, dayLabel: null,
  });
  it('orders sections and omits empty ones', () => {
    const out = groupByDndStatus([mk(1, 'closed'), mk(2, 'in-progress'), mk(3, 'closed')]);
    expect(out.map(s => s.status)).toEqual(['in-progress', 'closed']);
    expect(out[0].features.map(f => f.id)).toEqual([2]);
    expect(out[1].features.map(f => f.id)).toEqual([1, 3]);
  });
});
