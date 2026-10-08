import { describe, it, expect } from 'vitest';
import { buildDiscoveryBlock } from './dashboard';
import type { FeatureKind } from './workspace';

describe('buildDiscoveryBlock', () => {
  const af = { id: 100001, title: 'Feature One', folderPath: '/w/100001-feature-one', setAt: '2026-07-19T10:00:00.000Z' };
  const noKinds = () => null;
  const kindsFrom = (map: Record<number, FeatureKind>) => (id: number) => map[id] ?? null;

  it('maps active feature to displayName + folderPath', () => {
    const b = buildDiscoveryBlock({
      activeFeature: af,
      managedIds: [100001],
      fetched: [{ id: 100001, title: 'Feature One' }],
      hasWorkspace: true,
      kindOf: noKinds,
    });
    expect(b.activeFeature).toEqual({
      id: 100001,
      displayName: '**Feature One** (#100001)',
      folderPath: '/w/100001-feature-one',
    });
    expect(b.hasWorkspace).toBe(true);
  });

  it('keeps the active feature out of managed — the card already shows it in "On now" — while managedCount still counts it', () => {
    const b = buildDiscoveryBlock({
      activeFeature: af,
      managedIds: [100001, 100002],
      fetched: [
        { id: 100001, title: 'Feature One' },
        { id: 100002, title: 'Feature Two' },
      ],
      hasWorkspace: true,
      kindOf: noKinds,
    });
    expect(b.managed).toEqual([{ id: 100002, displayName: '**Feature Two** (#100002)' }]);
    expect(b.managedCount).toBe(2);
  });

  it("drops a 'grouping' feature entirely — list AND count. A grouping feature is board-only; it never shows on a Discovery & Design surface", () => {
    const b = buildDiscoveryBlock({
      activeFeature: af,
      managedIds: [100001, 100002],
      fetched: [
        { id: 100001, title: 'Feature One' },
        { id: 100002, title: 'Feature Two' },
      ],
      hasWorkspace: true,
      kindOf: kindsFrom({ 100001: 'handed', 100002: 'grouping' }),
    });
    expect(b.managed).toEqual([]);
    expect(b.managedCount).toBe(1);
  });

  it("keeps a feature with no declared kind — only an answered 'grouping' hides it", () => {
    const b = buildDiscoveryBlock({
      activeFeature: null,
      managedIds: [100001, 100002],
      fetched: [
        { id: 100001, title: 'Feature One' },
        { id: 100002, title: 'Feature Two' },
      ],
      hasWorkspace: true,
      kindOf: kindsFrom({ 100002: 'grouping' }),
    });
    expect(b.managed.map(m => m.id)).toEqual([100001]);
    expect(b.managedCount).toBe(1);
  });

  it('lists every managed feature when none of them is active or grouping', () => {
    const b = buildDiscoveryBlock({
      activeFeature: null,
      managedIds: [100001, 100002],
      fetched: [
        { id: 100001, title: 'Feature One' },
        { id: 100002, title: 'Feature Two' },
      ],
      hasWorkspace: true,
      kindOf: noKinds,
    });
    expect(b.managed.map(m => m.id)).toEqual([100001, 100002]);
    expect(b.managedCount).toBe(2);
  });

  it('null active feature when none set', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [], fetched: [], hasWorkspace: true, kindOf: noKinds });
    expect(b.activeFeature).toBeNull();
    expect(b.managed).toEqual([]);
    expect(b.managedCount).toBe(0);
  });

  it('falls back to #id displayName when a managed id has no fetched title', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [100003], fetched: [], hasWorkspace: true, kindOf: noKinds });
    expect(b.managed).toEqual([{ id: 100003, displayName: '#100003' }]);
  });

  it('hasWorkspace false passes through', () => {
    const b = buildDiscoveryBlock({ activeFeature: null, managedIds: [], fetched: [], hasWorkspace: false, kindOf: noKinds });
    expect(b.hasWorkspace).toBe(false);
  });
});
