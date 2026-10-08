/**
 * What else happens around a block or an unblock.
 *
 * Moving the state on the board is only half of it. The rest — the tag, the
 * discussion comment the delivery manager reads, the session that holds the
 * log entry, the stopwatch — depends on whether the board actually moved. Two
 * cases must stay quiet: saying "it's blocked" twice, and clearing a block
 * that was never there.
 *
 * The decision is pulled out here so it can be tested on its own: a result
 * from the write layer goes in, four yes/no answers come out. Nothing in this
 * file touches Azure DevOps, the database or the clock.
 */

import type { BlockResult, UnblockResult } from './writes.js';

export interface BlockPlan {
  /** Add or remove the 'Blocked' tag on the board. */
  changeTag: boolean;
  /** Open (or reuse) a session, so the log entry has somewhere to live. */
  openSession: boolean;
  /** Write the log entry and mirror it into the board's discussion. */
  postComment: boolean;
  /** What the stopwatch does: stop it, start it, or leave it alone. */
  clock: 'stop' | 'start' | 'leave';
  /**
   * Short line for the payload when we deliberately post nothing, so the
   * reply says why instead of going silent. Null when a comment is posted.
   */
  commentSkipped: string | null;
}

/**
 * Blocking something.
 *
 * The tag and the session run either way. The tag is the second, quieter
 * signal, and an item can carry the blocked state without it (somebody set
 * the state by hand on the board) — rewriting it costs one line of history
 * and nothing else, and it makes the two signals agree. The clock always
 * stops: a stopwatch left running on something stuck is wrong however many
 * times the user says it.
 *
 * Saying it a second time changes nothing on the board, so it must not leave
 * a second discussion comment and must not write a second entry in the log.
 */
export function planBlock(result: BlockResult): BlockPlan {
  return {
    changeTag: true,
    openSession: true,
    postComment: !result.alreadyBlocked,
    clock: 'stop',
    commentSkipped: result.alreadyBlocked ? 'already blocked — no second comment' : null,
  };
}

/**
 * Clearing a block.
 *
 * When nothing came off a block, nothing else should happen either. Two cases
 * land there: the item was never blocked, or it is still blocked and we have
 * no record of where it came from. Either way the board is untouched — so no
 * comment for the manager to read, no tag pulled off an item that still needs
 * it, and above all no clock started on something that is still stuck.
 */
export function planUnblock(result: UnblockResult): BlockPlan {
  const restored = result.outcome === 'restored';
  return {
    changeTag: restored,
    openSession: restored,
    postComment: restored,
    clock: restored ? 'start' : 'leave',
    commentSkipped: restored ? null : 'nothing changed on the board',
  };
}
