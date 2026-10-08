import { describe, it, expect } from 'vitest';
import { classifyIterationLevel, isSprintLevel } from './planning-cockpit';
import { classifyPastSprint, backlogPathForNewFeature } from './iteration-paths';

describe('backlogPathForNewFeature', () => {
  const ROOT = 'MyProject';

  it('drops the sprint segment so a Feature sits at quarter level', () => {
    expect(backlogPathForNewFeature('MyProject\\2026\\Q3\\26_16', ROOT)).toBe(
      'MyProject\\2026\\Q3',
    );
  });

  it('falls back to the project root when the sprint is unknown', () => {
    expect(backlogPathForNewFeature(null, ROOT)).toBe(ROOT);
    expect(backlogPathForNewFeature('', ROOT)).toBe(ROOT);
  });

  it('falls back to the project root when there is no parent to climb to', () => {
    expect(backlogPathForNewFeature(ROOT, ROOT)).toBe(ROOT);
  });

  it('falls back to the project root when the parent is still a sprint path', () => {
    // A deeper tree than the user's: dropping one segment lands on another
    // sprint-shaped path, which is not a backlog level.
    expect(backlogPathForNewFeature('MyProject\\2026\\Q3\\26_16\\sub', ROOT)).toBe(ROOT);
  });

  it('keeps a parent that classifies as year or backlog', () => {
    expect(backlogPathForNewFeature('MyProject\\2026\\26_16', ROOT)).toBe('MyProject\\2026');
    expect(backlogPathForNewFeature('MyProject\\Backlog\\26_16', ROOT)).toBe(
      'MyProject\\Backlog',
    );
  });
});

describe('classifyIterationLevel', () => {
  it('classifies the tree levels', () => {
    expect(classifyIterationLevel('MyProject')).toBe('backlog');
    expect(classifyIterationLevel('MyProject\\Backlog')).toBe('backlog');
    expect(classifyIterationLevel('MyProject\\2026')).toBe('year');
    expect(classifyIterationLevel('MyProject\\2026\\Q2')).toBe('quarter');
    expect(classifyIterationLevel('MyProject\\2026\\Q2\\26_12')).toBe('sprint');
    expect(classifyIterationLevel('')).toBe(null);
  });

  it('isSprintLevel is true only for a concrete named sprint', () => {
    expect(isSprintLevel('MyProject\\2026\\Q2\\26_12')).toBe(true);
    expect(isSprintLevel('MyProject\\2026')).toBe(false);
    expect(isSprintLevel('MyProject\\Backlog')).toBe(false);
  });
});

describe('classifyPastSprint', () => {
  const ITS = [
    { path: 'MyProject\\2026\\Q2\\26_11', finishDate: '2026-06-10T00:00:00Z' },
    { path: 'MyProject\\2026\\Q2\\26_13', finishDate: '2026-07-10T00:00:00Z' },
  ];
  const NOW = new Date('2026-06-25T09:00:00Z');

  it('true for a sprint that already finished', () => {
    expect(classifyPastSprint(ITS, 'MyProject\\2026\\Q2\\26_11', NOW)).toBe(true);
  });
  it('false for a current/future sprint', () => {
    expect(classifyPastSprint(ITS, 'MyProject\\2026\\Q2\\26_13', NOW)).toBe(false);
  });
  it('false for backlog / year / quarter paths', () => {
    expect(classifyPastSprint(ITS, 'MyProject\\2026', NOW)).toBe(false);
    expect(classifyPastSprint(ITS, 'MyProject\\Backlog', NOW)).toBe(false);
  });
  it('false for an unknown sprint path not in the list', () => {
    expect(classifyPastSprint(ITS, 'MyProject\\2026\\Q1\\26_09', NOW)).toBe(false);
  });
});
