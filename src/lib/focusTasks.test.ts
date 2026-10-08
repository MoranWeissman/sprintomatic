import { describe, it, expect } from 'vitest';
import { focusPanelTasks } from './focusTasks';

const t = (id: string) => ({ id });

describe('focusPanelTasks', () => {
  it('leaves the list alone when the live task is already in it', () => {
    const story = [t('1'), t('2'), t('3')];
    const out = focusPanelTasks(t('2'), story);
    expect(out.map(x => x.id)).toEqual(['1', '2', '3']); // same order, no duplicate
  });

  // The bug: a story sitting in the sprint while its tasks sit in the backlog.
  // The story group then arrives with tasks the live task isn't part of, so
  // the panel had nothing to resolve the drill-in against and the click died.
  it('adds the live task when the story group is missing it', () => {
    const out = focusPanelTasks(t('100911'), [t('100912')]);
    expect(out.map(x => x.id)).toEqual(['100911', '100912']);
  });

  it('gives back just the live task when the story group has none', () => {
    expect(focusPanelTasks(t('100911'), []).map(x => x.id)).toEqual(['100911']);
  });

  it('matches ids across string and number shapes', () => {
    const out = focusPanelTasks({ id: '7' }, [{ id: 7 as unknown as string }]);
    expect(out).toHaveLength(1); // not treated as two different tasks
  });
});
