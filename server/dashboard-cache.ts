/**
 * Stale-while-revalidate cache around `buildDashboard`.
 *
 * Every /api/dashboard hit talks to Azure DevOps (work items aren't cached by
 * design — see project_build_state). That makes each load ~2.7s. To keep the
 * dashboard feeling instant for an ADHD-friendly experience, this module
 * memoizes the last successful payload per sprint key in process memory:
 *
 *  - If a cached payload exists, it's returned immediately (`cache: 'stale'`)
 *    and a fresh `buildDashboard` is kicked off in the background to update
 *    the cache for the next hit. The client refetches once on `stale` to pick
 *    up the fresh data shortly after.
 *  - If there's no cache (cold process, first hit ever), we await the real
 *    build, store it, return it (`cache: 'fresh'`).
 *  - At most one background refresh per key runs at a time.
 *
 * Writes (effort/state edits, dismiss-note, schedule changes) call
 * `invalidateDashboardCache()` so the next hit blocks for a real fetch and
 * never serves a payload that contradicts a known change.
 */
import { buildDashboard, type BuildOptions, type DashboardPayload } from './dashboard';
import { getSetting, setSetting } from './timers';

/**
 * Shared "something changed" marker, in the settings table.
 *
 * The cache below is a plain Map in process memory, and there are TWO processes:
 * the MCP server (`npm run mcp`) and the vite dev server that answers
 * /api/dashboard. Each holds its own Map. So `invalidateDashboardCache()` called
 * from a work chat cleared a cache nobody was reading from, and the browser kept
 * serving its own copy — the stale dashboard the user lost time to three times.
 *
 * The two processes already share SQLite, so the marker goes there: invalidating
 * stamps a timestamp, and any process whose cached entry is older than the stamp
 * treats it as cold. No ports, no HTTP between the two, no new moving parts.
 */
export const DASHBOARD_DIRTY_KEY = 'dashboard_dirty_at';

/** Consecutive failed background refreshes before we tell anyone. One blip is
 *  noise; a run of them means the dashboard is quietly frozen. */
const FAILURES_BEFORE_REPORTING = 3;

interface CacheEntry {
  payload: DashboardPayload;
  at: number;
  refreshing: Promise<unknown> | null;
  /** Consecutive background-refresh failures for this key. Reset on success. */
  failures: number;
  /** Message from the most recent failure, kept so it can be surfaced. */
  lastError: string | null;
}

const cache = new Map<string, CacheEntry>();

/** Millis of the shared dirty marker, or 0 when unset/garbage. Never throws —
 *  a broken marker must not force a permanent rebuild. */
function dirtyAtMs(): number {
  const raw = getSetting(DASHBOARD_DIRTY_KEY);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function keyFor(opts: BuildOptions): string {
  return opts.sprintName ?? '__current__';
}

export interface CachedDashboardResult {
  payload: DashboardPayload;
  cache: 'fresh' | 'stale';
  cacheAgeMs: number;
  /**
   * Set when background refreshes have failed {@link FAILURES_BEFORE_REPORTING}
   * times in a row, i.e. the payload being served is frozen and won't
   * self-correct. Null in the normal case.
   *
   * Before this existed a failing refresh was swallowed: the old payload stayed,
   * the lock cleared, and the response still looked like an ordinary stale
   * serve. The dashboard could show wrong data indefinitely with nothing to see.
   */
  refreshError: string | null;
}

export async function buildDashboardCached(opts: BuildOptions = {}): Promise<CachedDashboardResult> {
  lastReadAt = Date.now();
  const key = keyFor(opts);
  const entry = cache.get(key);

  // A marker newer than this entry means another process changed something we
  // can't see. Drop the entry and block for real data rather than serving a
  // payload we already know contradicts a write.
  if (entry && entry.at < dirtyAtMs()) {
    cache.delete(key);
    return freshBuild(key, opts);
  }

  if (entry) {
    if (!entry.refreshing) {
      entry.refreshing = buildDashboard(opts)
        .then(fresh => {
          cache.set(key, { payload: fresh, at: Date.now(), refreshing: null, failures: 0, lastError: null });
        })
        .catch((e: unknown) => {
          // Keep the stale entry but count the failure, so a run of them stops
          // being invisible. Clear the lock either way so a later request retries.
          const still = cache.get(key);
          if (still) {
            still.refreshing = null;
            still.failures += 1;
            still.lastError = e instanceof Error ? e.message : String(e);
          }
        });
    }
    return {
      payload: entry.payload,
      cache: 'stale',
      cacheAgeMs: Date.now() - entry.at,
      refreshError: refreshErrorFor(entry),
    };
  }

  return freshBuild(key, opts);
}

function refreshErrorFor(entry: CacheEntry): string | null {
  if (entry.failures < FAILURES_BEFORE_REPORTING || !entry.lastError) return null;
  // A try-count means nothing to a reader ("2474 tries"); how long it has been
  // stale does. The cache retries on a timer, so the age is the honest number.
  const staleFor = humanAge(Date.now() - entry.at);
  return `These numbers are ${staleFor} old — the dashboard hasn't been able to refresh since. ${entry.lastError}`;
}

async function freshBuild(key: string, opts: BuildOptions): Promise<CachedDashboardResult> {
  const payload = await buildDashboard(opts);
  cache.set(key, { payload, at: Date.now(), refreshing: null, failures: 0, lastError: null });
  return { payload, cache: 'fresh', cacheAgeMs: 0, refreshError: null };
}

/**
 * Drop cached payloads so the next request blocks on a real Azure DevOps fetch —
 * in THIS process, and in every other one, via the shared marker.
 */
export function invalidateDashboardCache(): void {
  cache.clear();
  try {
    setSetting(DASHBOARD_DIRTY_KEY, String(Date.now()));
  } catch {
    // Writing the marker is best-effort. Losing it costs cross-process freshness
    // for one write; throwing here would break the board edit that called us.
  }
}

/**
 * Background auto-refresh — re-reads the dashboard on a fixed interval so the
 * Outlook-derived 'available hours' tile catches new or removed meetings even
 * when nobody's looking at the dashboard. Every interval tick invalidates the
 * cache and warms a fresh build; the next dashboard hit serves the warm copy.
 *
 * 2026-06-03: hard-coded to 5 minutes. The user asked for this to be settings-
 * configurable later — see [[feedback-capacity-preferences]] / future settings
 * work. Today's interval is the simplest behavior that closes the obvious gap
 * (open the dashboard at 9, meeting added at 11, glance back at 11:05 — see
 * the new number).
 */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How long after the last real read the background refresh keeps going.
 *
 * A dashboard left open in a browser tab nobody looks at — or a dev server
 * running for weeks — went on asking the board every five minutes forever. When
 * the board was broken that was thousands of failing calls nobody would ever
 * read the result of. So the timer stands down once nobody has asked for a
 * while, and the next real read starts it working again by itself.
 */
const IDLE_STANDDOWN_MS = 30 * 60 * 1000;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
/** When the API last asked for a payload — the "is anyone there?" signal. */
let lastReadAt = Date.now();

export function startAutoRefresh(intervalMs: number = AUTO_REFRESH_INTERVAL_MS): void {
  if (autoRefreshTimer != null) return; // idempotent — fine to call repeatedly
  autoRefreshTimer = setInterval(() => {
    // Nobody has looked in a while — stop bothering the board until they do.
    if (Date.now() - lastReadAt > IDLE_STANDDOWN_MS) return;
    // Walk every key currently cached and re-build it. We don't pre-warm
    // sprints that have never been looked at — only refresh what's already
    // been requested at least once.
    for (const key of Array.from(cache.keys())) {
      const opts: BuildOptions = key === '__current__' ? {} : { sprintName: key };
      buildDashboard(opts)
        .then(fresh => {
          cache.set(key, { payload: fresh, at: Date.now(), refreshing: null, failures: 0, lastError: null });
        })
        .catch((e: unknown) => {
          // Count it like a user-driven refresh failure, so a board that's been
          // failing quietly in the background still gets reported on the next
          // read instead of looking healthy.
          const still = cache.get(key);
          if (still) {
            still.failures += 1;
            still.lastError = e instanceof Error ? e.message : String(e);
          }
        });
    }
  }, intervalMs);
  // Don't keep the Node process alive just for the timer.
  if (typeof autoRefreshTimer.unref === 'function') autoRefreshTimer.unref();
}

/** For tests: pretend the last read happened this long ago. */
export function setLastReadAtForTests(at: number): void {
  lastReadAt = at;
}

export function stopAutoRefresh(): void {
  if (autoRefreshTimer != null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

/** "12 minutes" / "3 hours" / "2 days" — enough for a warning line. */
function humanAge(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
