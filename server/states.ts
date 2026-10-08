/**
 * The one place that answers "what does this board state mean?".
 *
 * Azure DevOps state names vary by process template and by work item type, so
 * the rule used to be hand-written wherever it was needed — and the copies
 * drifted apart. This module is the union of everything those copies knew.
 * Pure: no database, no network, no imports.
 *
 * A state name we have never seen comes back as `'unknown'`, on purpose. The
 * house rule is that a fact the board did not back must not be filled in with
 * a plausible default — the caller drops that half of the sentence instead.
 */

/** What a board state means, or `'unknown'` when we have nothing to go on. */
export type BoardStateKind = 'done' | 'active' | 'waiting' | 'blocked' | 'unknown';

/** Finished, one way or another. `Removed` sits here too: it is off the list. */
const DONE = new Set(['done', 'closed', 'resolved', 'completed', 'removed']);

/** Somebody is working on it right now. `going` is the word the dashboard and
 *  the assistant's greeting use for the same thing. */
const ACTIVE = new Set(['active', 'in progress', 'committed', 'doing', 'going']);

/** On the list, nobody has started it. Verified names for this user's tenant. */
const WAITING = new Set(['new', 'approved', 'ready for dev', 'accepted']);

/** Stuck. Tasks and stories say `Blocked`; features say `On Hold`. */
const BLOCKED = new Set(['blocked', 'on hold']);

/** Taken off the board entirely — not finished, just gone. */
const REMOVED = new Set(['removed']);

/** Extra names for "this is never going to be worked on", on top of DONE. */
const CANCELLED = new Set(['canceled', 'cancelled', 'cut']);

function normalize(state: string | null | undefined): string {
  return (state ?? '').trim().toLowerCase();
}

export function classifyBoardState(state: string | null | undefined): BoardStateKind {
  const s = normalize(state);
  if (s === '') return 'unknown';
  if (BLOCKED.has(s)) return 'blocked';
  if (DONE.has(s)) return 'done';
  if (ACTIVE.has(s)) return 'active';
  if (WAITING.has(s)) return 'waiting';
  return 'unknown';
}

export function isDoneState(state: string | null | undefined): boolean {
  return classifyBoardState(state) === 'done';
}

export function isActiveState(state: string | null | undefined): boolean {
  return classifyBoardState(state) === 'active';
}

export function isWaitingState(state: string | null | undefined): boolean {
  return classifyBoardState(state) === 'waiting';
}

export function isBlockedState(state: string | null | undefined): boolean {
  return classifyBoardState(state) === 'blocked';
}

/** True only for an item pulled off the board, not for one that finished. */
export function isRemovedState(state: string | null | undefined): boolean {
  return REMOVED.has(normalize(state));
}

/** Finished, removed or cancelled — nothing here is worth offering to pull. */
export function isDeadState(state: string | null | undefined): boolean {
  const s = normalize(state);
  return DONE.has(s) || CANCELLED.has(s);
}
