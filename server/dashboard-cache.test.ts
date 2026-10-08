import { describe, it, expect, beforeEach, vi } from 'vitest';

// The cache wraps buildDashboard. We replace it with a counter so each build
// is observable, and an optional "gate" promise lets a test hold a background
// refresh open to inspect what happens while it's still in flight.
const h = vi.hoisted(() => ({
  buildCalls: 0,
  gate: null as null | { promise: Promise<void>; resolve: () => void },
  failNext: 0,
  settings: new Map<string, string>(),
}));

vi.mock('./dashboard', () => ({
  buildDashboard: async () => {
    h.buildCalls += 1;
    const tag = h.buildCalls;
    if (h.gate) await h.gate.promise;
    if (h.failNext > 0) {
      h.failNext -= 1;
      throw new Error('Azure DevOps said no');
    }
    return { workItems: [], tag };
  },
}));

// The dirty marker lives in the settings table because the MCP server and the
// vite dev server are DIFFERENT PROCESSES with separate in-memory caches.
vi.mock('./timers', () => ({
  getSetting: (k: string) => h.settings.get(k),
  setSetting: (k: string, v: string) => { h.settings.set(k, v); },
}));

import {
  buildDashboardCached,
  invalidateDashboardCache,
  setLastReadAtForTests,
  startAutoRefresh,
  stopAutoRefresh,
  DASHBOARD_DIRTY_KEY,
} from './dashboard-cache';

function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const tagOf = (payload: unknown) => (payload as { tag: number }).tag;

beforeEach(() => {
  h.settings.clear();
  invalidateDashboardCache();
  h.settings.clear(); // invalidate stamps the marker; start each test clean
  h.buildCalls = 0;
  h.gate = null;
  h.failNext = 0;
});

describe('buildDashboardCached — stale-while-revalidate', () => {
  it('cold cache builds fresh and blocks for the real payload', async () => {
    const r = await buildDashboardCached();
    expect(r.cache).toBe('fresh');
    expect(r.cacheAgeMs).toBe(0);
    expect(h.buildCalls).toBe(1);
    expect(tagOf(r.payload)).toBe(1);
  });

  it('serves the stale payload instantly, then updates from the background refresh', async () => {
    const first = await buildDashboardCached(); // warm: tag 1
    expect(first.cache).toBe('fresh');

    // Hold the next build so we can observe the stale-serve before it finishes.
    h.gate = makeGate();
    const second = await buildDashboardCached();
    expect(second.cache).toBe('stale');
    expect(tagOf(second.payload)).toBe(1); // old payload — refresh not done yet
    expect(h.buildCalls).toBe(2); // background build started

    // Let the background build complete and write its result into the cache.
    h.gate.resolve();
    await new Promise(r => setTimeout(r, 0));
    h.gate = null;

    const third = await buildDashboardCached();
    expect(third.cache).toBe('stale');
    expect(tagOf(third.payload)).toBe(2); // now serves the refreshed payload
  });

  it('runs at most one background refresh at a time', async () => {
    await buildDashboardCached(); // warm: calls = 1
    h.gate = makeGate(); // hold background builds open

    const a = await buildDashboardCached();
    expect(a.cache).toBe('stale');
    expect(h.buildCalls).toBe(2); // one background refresh kicked off

    const b = await buildDashboardCached();
    expect(b.cache).toBe('stale');
    expect(h.buildCalls).toBe(2); // still just the one in-flight refresh

    h.gate.resolve();
  });

  it('invalidate forces the next read to block on a fresh build', async () => {
    await buildDashboardCached(); // calls = 1
    invalidateDashboardCache();
    const r = await buildDashboardCached();
    expect(r.cache).toBe('fresh');
    expect(h.buildCalls).toBe(2);
  });
});

describe('cross-process invalidation', () => {
  // The bug: invalidateDashboardCache() clears a Map in the calling process
  // only. A board write from a work chat (MCP process) left the browser's copy
  // (vite process) untouched, so the dashboard kept showing the old value. The
  // two processes share SQLite, so the marker goes there.
  it('invalidate stamps a marker the other process can see', () => {
    invalidateDashboardCache();
    expect(h.settings.get(DASHBOARD_DIRTY_KEY)).toBeTruthy();
  });

  it('a marker newer than the cache forces a real build, not a stale serve', async () => {
    await buildDashboardCached(); // warm this process: calls = 1
    expect(h.buildCalls).toBe(1);

    // Stand in for the OTHER process invalidating: only the shared marker moves,
    // this process's Map still holds its entry.
    h.settings.set(DASHBOARD_DIRTY_KEY, String(Date.now() + 5_000));

    const r = await buildDashboardCached();
    expect(r.cache).toBe('fresh'); // blocked for real data instead of serving stale
    expect(h.buildCalls).toBe(2);
    expect(tagOf(r.payload)).toBe(2);
  });

  it('stops rebuilding once the cache is newer than the marker', async () => {
    h.settings.set(DASHBOARD_DIRTY_KEY, String(Date.now() - 5_000));
    await buildDashboardCached(); // calls = 1, and now newer than the marker
    const r = await buildDashboardCached();
    expect(r.cache).toBe('stale'); // back to normal, no rebuild storm
    expect(h.buildCalls).toBe(2); // just the one background refresh
  });

  it('ignores a marker that is not a usable number', async () => {
    await buildDashboardCached();
    h.settings.set(DASHBOARD_DIRTY_KEY, 'not a timestamp');
    const r = await buildDashboardCached();
    expect(r.cache).toBe('stale'); // garbage must not force a permanent rebuild
  });
});

describe('a background refresh that keeps failing is visible', () => {
  // The nastier half: a failed refresh kept the old payload, cleared the lock,
  // and said nothing. The response still read as a normal stale serve, so the
  // dashboard could show old data forever with no sign anything was wrong.
  it('says nothing after a single blip', async () => {
    await buildDashboardCached(); // warm
    h.failNext = 1;
    const r = await buildDashboardCached(); // kicks a refresh that throws
    await new Promise(res => setTimeout(res, 0));
    expect(r.refreshError).toBeNull();

    const after = await buildDashboardCached();
    expect(after.refreshError).toBeNull(); // one failure is not worth shouting about
  });

  it('surfaces the error once refreshes keep failing', async () => {
    await buildDashboardCached(); // warm
    h.failNext = 5;

    // Each read kicks one background refresh; let each settle before the next.
    for (let i = 0; i < 3; i += 1) {
      await buildDashboardCached();
      await new Promise(res => setTimeout(res, 0));
    }

    const r = await buildDashboardCached();
    expect(r.refreshError).toContain('Azure DevOps said no');
    expect(r.payload).toBeTruthy(); // still serves what it has
  });

  it('clears the error as soon as a refresh works again', async () => {
    await buildDashboardCached();
    h.failNext = 5;
    for (let i = 0; i < 3; i += 1) {
      await buildDashboardCached();
      await new Promise(res => setTimeout(res, 0));
    }
    expect((await buildDashboardCached()).refreshError).toBeTruthy();
    // That read kicked another refresh; let it settle, or the next read finds
    // the lock still held and never starts the one that succeeds.
    await new Promise(res => setTimeout(res, 0));

    h.failNext = 0;
    await buildDashboardCached(); // kicks a refresh that works
    await new Promise(res => setTimeout(res, 0));
    expect((await buildDashboardCached()).refreshError).toBeNull();
  });
});

/**
 * Why this matters: a dev server ran for weeks and its five-minute poll kept
 * asking a broken board thousands of times, for numbers nobody was looking at.
 */
describe('the background poll stands down when nobody is looking', () => {
  it('skips the refresh after a long quiet spell, and resumes on the next read', async () => {
    vi.useFakeTimers();
    try {
      await buildDashboardCached(); // one key in the cache, read clock set now
      const afterFirst = h.buildCalls;

      startAutoRefresh(1000);
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(h.buildCalls).toBeGreaterThan(afterFirst); // somebody is around

      const busy = h.buildCalls;
      setLastReadAtForTests(Date.now() - 31 * 60 * 1000); // nobody for half an hour
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      expect(h.buildCalls).toBe(busy); // stood down

      await buildDashboardCached(); // he opens the page again
      const resumed = h.buildCalls;
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(h.buildCalls).toBeGreaterThan(resumed); // working again
    } finally {
      stopAutoRefresh();
      vi.useRealTimers();
    }
  });
});
