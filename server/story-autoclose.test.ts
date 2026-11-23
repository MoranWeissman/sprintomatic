import { describe, expect, it, vi } from 'vitest';

vi.mock('./dashboard-cache', () => ({ invalidateDashboardCache: vi.fn() }));
vi.mock('./db', () => ({ getDb: vi.fn() }));

import { autoCloseParentStory, shouldAutoClose, sweepFinishedStories, type AutoCloseDeps, type StoryLike } from './story-autoclose';

const t = (state: string) => ({ type: 'Task', state });
const story = (over: Partial<StoryLike> = {}): StoryLike => ({
  id: 100002, title: 'Example story', type: 'User Story', state: 'Active',
  parent: { id: 100009 }, children: [t('Closed'), t('Closed')], ...over,
});
const task: StoryLike = { id: 100001, title: 'Example task', type: 'Task', state: 'Closed', parent: { id: 100002 }, children: [] };

function deps(parent: StoryLike, over: Partial<AutoCloseDeps> = {}): AutoCloseDeps & { closeStory: ReturnType<typeof vi.fn> } {
  return {
    getItem: async id => (id === task.id ? task : parent),
    closeStory: vi.fn(async () => 'Closed'),
    gate: () => null,
    listOpenStories: async () => [parent],
    ...over,
  } as AutoCloseDeps & { closeStory: ReturnType<typeof vi.fn> };
}

describe('closing the last task closes the story', () => {
  it('last task closed: the story closes and the line says so', async () => {
    const d = deps(story());
    expect(await autoCloseParentStory(100001, d)).toBe('All tasks are done, so I closed **Example story** (#100002) too.');
    expect(d.closeStory).toHaveBeenCalledWith(100002);
  });

  it('one task still open: the story stays', async () => {
    const d = deps(story({ children: [t('Closed'), t('Active')] }));
    expect(await autoCloseParentStory(100001, d)).toBeNull();
    expect(d.closeStory).not.toHaveBeenCalled();
  });

  it('only removed tasks left besides done ones: the story still closes', async () => {
    const d = deps(story({ children: [t('Closed'), t('Removed'), t('Removed')] }));
    expect(await autoCloseParentStory(100001, d)).toContain('so I closed');
    expect(d.closeStory).toHaveBeenCalled();
  });

  it('only removed tasks, none done: the story is left alone', () => {
    expect(shouldAutoClose(story({ children: [t('Removed')] }))).toBe(false);
  });

  it('a Feature or Epic parent is never touched', async () => {
    for (const type of ['Feature', 'Epic']) {
      const d = deps(story({ type }));
      expect(await autoCloseParentStory(100001, d)).toBeNull();
      expect(d.closeStory).not.toHaveBeenCalled();
    }
  });

  it('a story with no tasks is never touched', async () => {
    const d = deps(story({ children: [] }));
    expect(await autoCloseParentStory(100001, d)).toBeNull();
    expect(d.closeStory).not.toHaveBeenCalled();
  });

  it('a Bug closes the same way', () => {
    expect(shouldAutoClose(story({ type: 'Bug' }))).toBe(true);
  });

  it('a blocked story or one in testing is left alone', () => {
    expect(shouldAutoClose(story({ state: 'Blocked' }))).toBe(false);
    expect(shouldAutoClose(story({ state: 'In Testing' }))).toBe(false);
    expect(shouldAutoClose(story({ state: 'Closed' }))).toBe(false);
  });

  it('the story close fails: no throw, the line says it is still open and why', async () => {
    const d = deps(story(), { closeStory: vi.fn(async () => { throw new Error('the board does not allow Active to Closed'); }) });
    const line = await autoCloseParentStory(100001, d);
    expect(line).toBe('All tasks of **Example story** (#100002) are done, but closing it on the board failed, so it is still open: the board does not allow Active to Closed');
  });

  it('a design story held by its own rules stays open and says why', async () => {
    const d = deps(story(), { gate: () => 'Next: hold the design review.' });
    expect(await autoCloseParentStory(100001, d)).toBe('All tasks of **Example story** (#100002) are done, but it stays open: Next: hold the design review.');
    expect(d.closeStory).not.toHaveBeenCalled();
  });

  it('a task with no parent: nothing to say', async () => {
    const d = deps(story(), { getItem: async () => ({ ...task, parent: null }) });
    expect(await autoCloseParentStory(100001, d)).toBeNull();
  });
});

describe('the greeting closes stories finished some other way', () => {
  it('closes each finished story and skips the rest', async () => {
    const done = story();
    const open = story({ id: 100003, title: 'Still going', children: [t('Active')] });
    const d = deps(done, { listOpenStories: async () => [done, open] });
    expect(await sweepFinishedStories(d)).toEqual(['All tasks of **Example story** (#100002) were done, so I closed it.']);
    expect(d.closeStory).toHaveBeenCalledTimes(1);
  });

  it('a story held by its own rules is skipped quietly', async () => {
    const d = deps(story(), { gate: () => 'Next: push the stories.' });
    expect(await sweepFinishedStories(d)).toEqual([]);
  });

  it('a failed board read means no lines, no throw', async () => {
    const d = deps(story(), { listOpenStories: async () => { throw new Error('signed out'); } });
    expect(await sweepFinishedStories(d)).toEqual([]);
  });
});
