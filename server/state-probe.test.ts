import { describe, it, expect } from 'vitest';
import { pickBucketStates } from './state-probe';

describe('pickBucketStates', () => {
  it('maps a board with a Blocked state', () => {
    expect(pickBucketStates([
      { name: 'New', category: 'Proposed' },
      { name: 'Active', category: 'InProgress' },
      { name: 'Blocked', category: 'InProgress' },
      { name: 'Closed', category: 'Completed' },
      { name: 'Removed', category: 'Removed' },
    ])).toEqual({ waiting: 'New', going: 'Active', blocked: 'Blocked', done: 'Closed' });
  });

  it('never picks Blocked as the "going" state, even when it comes first', () => {
    expect(pickBucketStates([
      { name: 'Blocked', category: 'InProgress' },
      { name: 'In Progress', category: 'InProgress' },
    ]).going).toBe('In Progress');
  });

  it('leaves a bucket empty when the board has nothing for it', () => {
    const picked = pickBucketStates([
      { name: 'To Do', category: 'Proposed' },
      { name: 'Doing', category: 'InProgress' },
      { name: 'Done', category: 'Completed' },
    ]);
    expect(picked).toEqual({ waiting: 'To Do', going: 'Doing', blocked: null, done: 'Done' });
  });
});
