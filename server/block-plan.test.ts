import { describe, it, expect } from 'vitest';
import { planBlock, planUnblock } from './block-plan';
import type { BlockResult, UnblockResult } from './writes';

const blocked = (over: Partial<BlockResult> = {}): BlockResult => ({
  fromState: 'Active',
  toState: 'Blocked',
  alreadyBlocked: false,
  message: 'Marked blocked. It was Active before.',
  ...over,
});

const unblocked = (over: Partial<UnblockResult> = {}): UnblockResult => ({
  toState: 'Active',
  restored: true,
  outcome: 'restored',
  message: 'Put back on Active.',
  ...over,
});

describe('planBlock', () => {
  it('a fresh block does everything and stops the clock', () => {
    expect(planBlock(blocked())).toEqual({
      changeTag: true,
      openSession: true,
      postComment: true,
      clock: 'stop',
      commentSkipped: null,
    });
  });

  it('saying it a second time posts no second comment', () => {
    const p = planBlock(blocked({ alreadyBlocked: true, toState: 'Blocked' }));
    expect(p.postComment).toBe(false);
    expect(p.commentSkipped).toBe('already blocked — no second comment');
  });

  it('the tag and the session still run on a repeat block', () => {
    const p = planBlock(blocked({ alreadyBlocked: true }));
    expect(p.changeTag).toBe(true);
    expect(p.openSession).toBe(true);
  });

  it('never starts the clock, however many times the block is repeated', () => {
    expect(planBlock(blocked()).clock).toBe('stop');
    expect(planBlock(blocked({ alreadyBlocked: true })).clock).toBe('stop');
  });
});

describe('planUnblock', () => {
  it('a real unblock pulls the tag, opens a session, comments and starts the clock', () => {
    expect(planUnblock(unblocked())).toEqual({
      changeTag: true,
      openSession: true,
      postComment: true,
      clock: 'start',
      commentSkipped: null,
    });
  });

  it('an item that was never blocked is left completely alone', () => {
    const p = planUnblock(unblocked({
      outcome: 'was-not-blocked',
      restored: false,
      message: 'It was not blocked.',
    }));
    expect(p).toEqual({
      changeTag: false,
      openSession: false,
      postComment: false,
      clock: 'leave',
      commentSkipped: 'nothing changed on the board',
    });
  });

  it('no clock starts on something still stuck when we forgot where it came from', () => {
    const p = planUnblock(unblocked({
      outcome: 'prior-state-unknown',
      restored: false,
      message: 'Still blocked and we do not know the state it came from.',
    }));
    expect(p.clock).toBe('leave');
    expect(p.changeTag).toBe(false);
  });

  it('the outcome decides, not the restored flag', () => {
    // Today the two always agree. Pinning which one the branch reads, so a
    // future change to writes.ts cannot quietly flip the meaning.
    const p = planUnblock(unblocked({ outcome: 'was-not-blocked', restored: true }));
    expect(p.postComment).toBe(false);
  });
});
