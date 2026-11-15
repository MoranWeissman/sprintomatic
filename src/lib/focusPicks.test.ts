import { describe, it, expect } from 'vitest';
import { autoPickTask, readFocusPicks, reconcilePicks } from './focusPicks';

const t = (id: string, state: string) => ({ id, state });

describe('autoPickTask', () => {
  it('skips a stuck task when a running one exists', () => {
    const live = [t('100001', 'Blocked'), t('100002', 'Active')];
    expect(autoPickTask(live)?.id).toBe('100002');
  });

  it('keeps the first task when none is stuck', () => {
    const live = [t('100001', 'Active'), t('100002', 'Active')];
    expect(autoPickTask(live)?.id).toBe('100001');
  });

  it('falls back to a stuck task only when every live task is stuck', () => {
    const live = [t('100001', 'Blocked'), t('100002', 'Blocked')];
    expect(autoPickTask(live)?.id).toBe('100001');
  });

  it('returns nothing when no task is live', () => {
    expect(autoPickTask([])).toBeUndefined();
  });
});

describe('readFocusPicks', () => {
  it('migrates a single legacy pick', () => {
    expect(readFocusPicks(null, '100001')).toEqual(['100001']);
  });

  it('drops a broken stored list', () => {
    expect(readFocusPicks('not json', null)).toEqual([]);
  });
});

describe('reconcilePicks', () => {
  it('keeps only picks that are still live, in the chosen order', () => {
    expect(reconcilePicks(['100003', '100001', '100002'], ['100001', '100003'])).toEqual(['100003', '100001']);
  });
});
