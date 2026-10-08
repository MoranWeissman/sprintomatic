/**
 * Ask the board up front which state names it uses, instead of learning them
 * on the first move (see setStateBucket in ./writes).
 *
 * Azure DevOps puts every state in a category — Proposed, InProgress,
 * Resolved, Completed, Removed — whatever the process template calls it. So
 * "waiting" is the first Proposed state, "going" the first InProgress one, and
 * "done" the first Completed one. "Blocked" has no category of its own: it is
 * an InProgress state with that name, or nothing at all.
 *
 * Tasks are what get moved most, so the probe reads the Task type. The names
 * go in the same `state_<bucket>` settings the move code already reads first.
 */
import { loadAdoConfig } from './config';
import { getAdoClient } from './ado-client';
import { setSetting } from './timers';
import { STATE_BUCKET_CHAIN, type StateBucket } from './writes';

export interface BoardStateInfo {
  name: string;
  category: string;
}

export type BucketStates = Record<StateBucket, string | null>;

const BLOCKED_NAMES = new Set(STATE_BUCKET_CHAIN.blocked.map(s => s.toLowerCase()));

/** Pure: which of the board's states fills each bucket. Null when none fits. */
export function pickBucketStates(states: BoardStateInfo[]): BucketStates {
  const blocked = states.find(s => BLOCKED_NAMES.has(s.name.toLowerCase()))?.name ?? null;
  const first = (category: string) =>
    states.find(s => s.category === category && s.name !== blocked)?.name ?? null;
  return {
    waiting: first('Proposed'),
    going: first('InProgress'),
    blocked,
    done: first('Completed'),
  };
}

/** Read the Task states from the board, store what was found, return it. */
export async function probeBoardStates(): Promise<BucketStates> {
  const cfg = await loadAdoConfig();
  const uri = `${cfg.organization}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemtypes/Task/states?api-version=7.1`;
  const body = await getAdoClient().rest<{ value?: BoardStateInfo[] }>({ method: 'GET', uri });
  const picked = pickBucketStates(body?.value ?? []);
  for (const [bucket, name] of Object.entries(picked)) {
    if (name) setSetting(`state_${bucket}`, name);
  }
  return picked;
}
