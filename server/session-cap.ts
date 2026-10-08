/**
 * How many work sessions may run in parallel, and whether a new one would
 * exceed that. Pure + config-only — no DB access here; the caller passes the
 * live session list in. The cap exists to stop parallel sessions piling up
 * unnoticed (the ADHD "where am I even working?" problem).
 */
import { configValue } from './user-config';
import type { Session } from './sessions';

/** env SH_MAX_PARALLEL_SESSIONS → setting max_parallel_sessions → default 4. */
export const DEFAULT_MAX_PARALLEL_SESSIONS = 4;

export function maxParallelSessions(): number {
  const raw = configValue('SH_MAX_PARALLEL_SESSIONS', 'max_parallel_sessions') ?? '';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PARALLEL_SESSIONS;
}

/**
 * True only when STARTING a session on `workItemId` would push the number of
 * distinct running items past `max`. Re-touching an item that already has an
 * open session is never over the cap (startSession is idempotent).
 */
export function parallelCapExceeded(opts: {
  activeSessions: Session[];
  workItemId: number;
  max: number;
}): boolean {
  const alreadyOpen = opts.activeSessions.some(s => s.workItemId === opts.workItemId);
  if (alreadyOpen) return false;
  const distinctItems = new Set(opts.activeSessions.map(s => s.workItemId));
  return distinctItems.size >= opts.max;
}
