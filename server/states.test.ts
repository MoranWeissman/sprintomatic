import { describe, it, expect } from 'vitest';
import {
  classifyBoardState,
  isActiveState,
  isBlockedState,
  isDeadState,
  isDoneState,
  isRemovedState,
  isWaitingState,
} from './states';

describe('board states — done', () => {
  it.each(['Done', 'Closed', 'Resolved', 'Completed', 'Removed'])(
    'counts %s as done',
    state => {
      expect(isDoneState(state)).toBe(true);
      expect(classifyBoardState(state)).toBe('done');
    },
  );

  it('does not count a state nobody is working on yet as done', () => {
    expect(isDoneState('New')).toBe(false);
  });
});

describe('board states — being worked on', () => {
  it.each(['Active', 'In Progress', 'Committed', 'Doing'])(
    'counts %s as being worked on',
    state => {
      expect(isActiveState(state)).toBe(true);
      expect(classifyBoardState(state)).toBe('active');
    },
  );

  it('does not count a finished state as being worked on', () => {
    expect(isActiveState('Closed')).toBe(false);
  });
});

describe('board states — not started yet', () => {
  it.each(['New', 'Approved', 'Ready For Dev', 'Accepted'])(
    'counts %s as not started yet',
    state => {
      expect(isWaitingState(state)).toBe(true);
      expect(classifyBoardState(state)).toBe('waiting');
    },
  );
});

describe('board states — blocked', () => {
  it.each(['Blocked', 'On Hold'])('counts %s as blocked', state => {
    expect(isBlockedState(state)).toBe(true);
    expect(classifyBoardState(state)).toBe('blocked');
  });

  it('does not count a plain active state as blocked', () => {
    expect(isBlockedState('Active')).toBe(false);
  });
});

describe('board states — taken off the board', () => {
  it('knows Removed is off the board', () => {
    expect(isRemovedState('Removed')).toBe(true);
  });

  it('does not treat a closed item as taken off the board', () => {
    expect(isRemovedState('Closed')).toBe(false);
  });
});

describe('board states — never going to happen', () => {
  it.each(['Done', 'Closed', 'Resolved', 'Completed', 'Removed', 'Canceled', 'Cancelled', 'Cut'])(
    'counts %s as never going to happen',
    state => {
      expect(isDeadState(state)).toBe(true);
    },
  );

  it('a story still being worked on is not dead', () => {
    expect(isDeadState('Active')).toBe(false);
  });
});

describe('board states — case does not matter', () => {
  it.each([
    ['closed', 'done'],
    ['CLOSED', 'done'],
    ['in progress', 'active'],
    ['IN PROGRESS', 'active'],
    ['on hold', 'blocked'],
    ['ready for dev', 'waiting'],
  ] as const)('reads %s as %s', (state, kind) => {
    expect(classifyBoardState(state)).toBe(kind);
  });

  it('ignores space around the state name', () => {
    expect(classifyBoardState('  Active  ')).toBe('active');
    expect(isDoneState(' closed ')).toBe(true);
  });
});

describe('board states — nothing to go on', () => {
  it.each([null, undefined, '', '   '])('reads %s as unknown', state => {
    expect(classifyBoardState(state)).toBe('unknown');
    expect(isDoneState(state)).toBe(false);
    expect(isActiveState(state)).toBe(false);
    expect(isWaitingState(state)).toBe(false);
    expect(isBlockedState(state)).toBe(false);
  });

  it('a state name the board never taught us stays unknown, not a guess', () => {
    expect(classifyBoardState('Waiting for Testing')).toBe('unknown');
    expect(isDoneState('Waiting for Testing')).toBe(false);
    expect(isActiveState('Waiting for Testing')).toBe(false);
    expect(isWaitingState('Waiting for Testing')).toBe(false);
  });
});
