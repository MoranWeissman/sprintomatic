import { describe, expect, it } from 'vitest';
import { outsideSprintRefusal } from './outside-sprint';
import { resolveIterationInput, sameIterationPath } from './iteration-paths';

const SPRINT = { name: '26_21', path: 'Proj\\2026\\Q4\\26_21' };
const NAME = '**Write the setup guide** (#100001)';

describe('outsideSprintRefusal', () => {
  it('says nothing when the task is in the current sprint', () => {
    expect(outsideSprintRefusal({ displayName: NAME, itemPath: 'proj\\2026\\q4\\26_21', sprint: SPRINT, action: 'start' })).toBeNull();
  });

  it('says nothing when the current sprint is unknown', () => {
    expect(outsideSprintRefusal({ displayName: NAME, itemPath: 'Proj\\2026\\Q3', sprint: null, action: 'start' })).toBeNull();
  });

  it('stops a start on a task sitting in a quarter, and offers the move', () => {
    const msg = outsideSprintRefusal({ displayName: NAME, itemPath: 'Proj\\2026\\Q3', sprint: SPRINT, action: 'start' })!;
    expect(msg).toContain('sits in Q3');
    expect(msg).toContain('iterationPath "26_21"');
    expect(msg).toContain('outsideSprintOk: true');
    expect(msg).toContain('Nothing was started');
  });

  it('stops a close on a task left in an old sprint', () => {
    const msg = outsideSprintRefusal({ displayName: NAME, itemPath: 'Proj\\2026\\Q4\\26_20', sprint: SPRINT, action: 'close' })!;
    expect(msg).toContain('sits in 26_20');
    expect(msg).toContain('session is still open');
  });
});

describe('resolveIterationInput', () => {
  const ITS = [
    { name: '26_20', path: 'Proj\\2026\\Q4\\26_20' },
    { name: '26_21', path: 'Proj\\2026\\Q4\\26_21' },
  ];

  it('passes a full path through as it is', () => {
    expect(resolveIterationInput('Proj\\2026\\Q3', ITS)).toEqual({ path: 'Proj\\2026\\Q3' });
  });

  it('finds the full path for a bare sprint name', () => {
    expect(resolveIterationInput(' 26_21 ', ITS)).toEqual({ path: 'Proj\\2026\\Q4\\26_21' });
  });

  it('refuses a name the board does not have', () => {
    expect(resolveIterationInput('26_99', ITS)).toHaveProperty('error');
  });

  it('refuses a name that matches two sprints', () => {
    const r = resolveIterationInput('26_21', [...ITS, { name: '26_21', path: 'Proj\\2027\\Q4\\26_21' }]);
    expect(r).toHaveProperty('error');
  });
});

describe('sameIterationPath', () => {
  it('ignores case and stray spaces', () => {
    expect(sameIterationPath(' Proj\\2026\\Q4\\26_21', 'proj\\2026\\q4\\26_21')).toBe(true);
    expect(sameIterationPath('Proj\\2026\\Q4\\26_21', 'Proj\\2026\\Q4\\26_20')).toBe(false);
  });
});
