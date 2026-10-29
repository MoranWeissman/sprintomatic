import { describe, expect, it } from 'vitest';
import { countTasks, openTasks, removalComment, removalRefusal } from './item-removal';

const kids = [
  { id: 100001, type: 'Task', state: 'Active', remainingWork: 5 },
  { id: 100002, type: 'Task', state: 'New', remainingWork: 2 },
  { id: 100003, type: 'Task', state: 'Closed', remainingWork: 0 },
  { id: 100004, type: 'Task', state: 'Removed' },
  { id: 100005, type: 'Bug', state: 'Active', remainingWork: 9 },
];

describe('countTasks', () => {
  it('counts only tasks, and only open hours', () => {
    expect(countTasks(kids)).toEqual({ open: 2, done: 1, removed: 1, remainingHours: 7 });
  });
  it('is all zeros with no children', () => {
    expect(countTasks([])).toEqual({ open: 0, done: 0, removed: 0, remainingHours: 0 });
  });
});

describe('openTasks', () => {
  it('keeps open tasks only', () => {
    expect(openTasks(kids).map(k => k.id)).toEqual([100001, 100002]);
  });
});

describe('removalRefusal', () => {
  const base = { id: 100010, type: 'User Story', state: 'New', openSessionIds: [] as number[] };
  it('lets an open story through', () => {
    expect(removalRefusal(base)).toBeNull();
  });
  it('refuses features and epics', () => {
    expect(removalRefusal({ ...base, type: 'Feature' })).toMatch(/Feature/);
    expect(removalRefusal({ ...base, type: 'Epic' })).toMatch(/Epic/);
  });
  it('refuses an item already removed or done', () => {
    expect(removalRefusal({ ...base, state: 'Removed' })).toMatch(/already Removed/);
    expect(removalRefusal({ ...base, state: 'Closed' })).toMatch(/finished/);
  });
  it('refuses while a session is open on it', () => {
    expect(removalRefusal({ ...base, openSessionIds: [100010] })).toMatch(/session_end/);
  });
});

describe('removalComment', () => {
  it('carries the reason', () => {
    expect(removalComment(' plans changed ')).toBe('Removed from the board by sprintomatic, not done: plans changed');
  });
  it('still says something with no reason', () => {
    expect(removalComment('')).toMatch(/not done\.$/);
  });
});
