import { describe, it, expect } from 'vitest';
import { buildNeedsYou } from './needs-you';
import type { Session } from './sessions';

function sess(over: Partial<Session>): Session {
  return {
    id: 's1',
    workItemId: 1,
    startedAt: '2026-07-01T08:00:00.000Z',
    endedAt: null,
    client: 'claude-code',
    summary: null,
    cwd: 'repo-x',
    waitingNote: null,
    waitingSince: null,
    ...over,
  };
}

describe('buildNeedsYou', () => {
  it('lists waiting sessions with question and pre-formatted displayName', () => {
    const got = buildNeedsYou({
      activeSessions: [
        sess({ workItemId: 10, waitingNote: 'Which cluster?', waitingSince: '2026-07-01T09:00:00.000Z' }),
        sess({ id: 's2', workItemId: 11 }), // live but not waiting
      ],
      recentlyEnded: [],
      titleFor: id => (id === 10 ? 'Deploy the checkout service' : null),
      isDone: () => false,
    });
    expect(got.waiting).toEqual([
      {
        workItemId: 10,
        displayName: '**Deploy the checkout service** (#10)',
        question: 'Which cluster?',
        waitingSince: '2026-07-01T09:00:00.000Z',
      },
    ]);
  });

  it('keeps only ended sessions whose task is really done (a pause is not a finish)', () => {
    const got = buildNeedsYou({
      activeSessions: [],
      recentlyEnded: [
        sess({ id: 'e1', workItemId: 20, endedAt: '2026-07-01T10:00:00.000Z', summary: 'shipped it' }),
        sess({ id: 'e2', workItemId: 21, endedAt: '2026-07-01T10:30:00.000Z', summary: 'paused for lunch' }),
      ],
      titleFor: id => (id === 20 ? 'Fix Datadog values' : 'Paused task'),
      isDone: id => id === 20,
    });
    expect(got.recentlyFinished).toEqual([
      {
        workItemId: 20,
        displayName: '**Fix Datadog values** (#20)',
        summary: 'shipped it',
        endedAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
  });

  it('shows a task once even when an earlier pause session also ended in the window', () => {
    const got = buildNeedsYou({
      activeSessions: [],
      recentlyEnded: [
        sess({ id: 'fin', workItemId: 40, endedAt: '2026-07-01T15:00:00.000Z', summary: 'shipped it' }),
        sess({ id: 'pause', workItemId: 40, endedAt: '2026-07-01T12:00:00.000Z', summary: 'paused for lunch' }),
      ],
      titleFor: () => 'Deploy the checkout service',
      isDone: () => true,
    });
    expect(got.recentlyFinished).toHaveLength(1);
    expect(got.recentlyFinished[0].summary).toBe('shipped it');
    expect(got.recentlyFinished[0].endedAt).toBe('2026-07-01T15:00:00.000Z');
  });

  it('falls back to a bare #id displayName when the title is unknown', () => {
    const got = buildNeedsYou({
      activeSessions: [sess({ workItemId: 30, waitingNote: 'q', waitingSince: '2026-07-01T09:00:00.000Z' })],
      recentlyEnded: [],
      titleFor: () => null,
      isDone: () => false,
    });
    expect(got.waiting[0].displayName).toBe('#30');
  });
});
