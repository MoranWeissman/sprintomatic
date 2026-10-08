import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store reads the live SQLite via getDb(). Swap in a fresh in-memory db
// per test so getSetting/setSetting work against test state.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  getPrePlanState,
  prePlanSettingsKey,
  savePrePlanState,
  suggestCall,
  suggestGoalIndex,
  summarizeCoverage,
  workingDaysBetween,
  selectCarriedStories,
  buildCards,
  normalizeGoals,
  setGoals,
  type PrePlanGoal,
} from './preplan';
import { setSetting } from './timers';
import type { UserStoryGroup } from './dashboard';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE helper_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      dismissed_at TEXT,
      pinned_at    TEXT,
      work_item_id INTEGER
    );
    CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
  `);
  return db;
}

beforeEach(() => {
  h.db.value = makeDb();
});

const NOW = new Date('2026-06-25T12:00:00Z'); // a Thursday

describe('normalizeGoals (legacy migration)', () => {
  it('turns a legacy string[] into goal records (owner null, isMine false)', () => {
    expect(normalizeGoals(['Ship X', 'Finish Y'])).toEqual([
      { text: 'Ship X', owner: null, isMine: false },
      { text: 'Finish Y', owner: null, isMine: false },
    ]);
  });
  it('passes through proper goal records', () => {
    const recs: PrePlanGoal[] = [{ text: 'A', owner: 'Gleb', isMine: false }];
    expect(normalizeGoals(recs)).toEqual(recs);
  });
  it('fills missing owner/isMine on partial records', () => {
    expect(normalizeGoals([{ text: 'A' }])).toEqual([{ text: 'A', owner: null, isMine: false }]);
  });
  it('returns [] for non-arrays and drops empty/blank text', () => {
    expect(normalizeGoals(undefined)).toEqual([]);
    expect(normalizeGoals([{ owner: 'x' }, '', '  '])).toEqual([]);
  });
});

describe('workingDaysBetween', () => {
  it('counts Sun-Thu and skips Fri/Sat', () => {
    // Sun 2026-06-21 -> Thu 2026-06-25 = 4 working days elapsed
    expect(workingDaysBetween(new Date('2026-06-21T12:00:00Z'), NOW)).toBe(4);
  });
  it('is 0 for the same day', () => {
    expect(workingDaysBetween(NOW, NOW)).toBe(0);
  });
});

describe('suggestCall', () => {
  it('suggests at-risk when blocked', () => {
    expect(
      suggestCall({ blocked: true, lastActivityAt: NOW.toISOString(), remainingHours: 5, now: NOW }),
    ).toBe('at-risk');
  });
  it('suggests at-risk when idle 3+ working days with hours left', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-21T12:00:00Z', // 4 working days ago
        remainingHours: 5,
        now: NOW,
      }),
    ).toBe('at-risk');
  });
  it('suggests on-track when recently active', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-24T12:00:00Z', // 1 working day ago
        remainingHours: 5,
        now: NOW,
      }),
    ).toBe('on-track');
  });
  it('suggests on-track when idle but no hours remain', () => {
    expect(
      suggestCall({
        blocked: false,
        lastActivityAt: '2026-06-21T12:00:00Z',
        remainingHours: 0,
        now: NOW,
      }),
    ).toBe('on-track');
  });
  it('suggests at-risk when never active but hours remain and sprint has run', () => {
    // null activity is treated as "no activity yet" -> at-risk only if hours remain
    expect(
      suggestCall({ blocked: false, lastActivityAt: null, remainingHours: 5, now: NOW }),
    ).toBe('at-risk');
  });
  it('never returns carries-over', () => {
    const r = suggestCall({ blocked: true, lastActivityAt: null, remainingHours: 99, now: NOW });
    expect(r).not.toBe('carries-over');
  });
});

describe('suggestGoalIndex', () => {
  const goals: PrePlanGoal[] = [
    { text: 'Improve checkout rollout confidence', owner: null, isMine: false },
    { text: 'Migrate Datadog helm values', owner: null, isMine: false },
  ];
  it('matches the obvious goal by shared words', () => {
    expect(suggestGoalIndex('Validate checkout rollout from prod', goals)).toBe(0);
  });
  it('returns null when overlap is weak', () => {
    expect(suggestGoalIndex('Unrelated database backup chore', goals)).toBeNull();
  });
  it('returns null when there are no goals', () => {
    expect(suggestGoalIndex('anything', [])).toBeNull();
  });
});

describe('summarizeCoverage', () => {
  const goals: PrePlanGoal[] = [
    { text: 'Goal A', owner: null, isMine: false },
    { text: 'Goal B', owner: null, isMine: false },
    { text: 'Goal C', owner: null, isMine: false },
  ];
  it('counts stories per goal and flags uncovered goals', () => {
    const cards = [{ goalIndex: 0 }, { goalIndex: 0 }, { goalIndex: 2 }];
    const cov = summarizeCoverage(cards, goals);
    expect(cov).toEqual([
      { index: 0, text: 'Goal A', storyCount: 2 },
      { index: 1, text: 'Goal B', storyCount: 0 },
      { index: 2, text: 'Goal C', storyCount: 1 },
    ]);
  });
  it('returns empty when there are no goals', () => {
    expect(summarizeCoverage([{ goalIndex: null }], [])).toEqual([]);
  });
});

describe('pre-plan state I/O', () => {
  it('returns empty state when nothing saved', () => {
    expect(getPrePlanState('26_99')).toEqual({ goals: [], stories: {} });
  });

  it('round-trips goals and per-story calls/links', () => {
    savePrePlanState('26_99', {
      goals: [
        { text: 'Goal A', owner: null, isMine: false },
        { text: 'Goal B', owner: null, isMine: false },
      ],
      stories: { '100908': { call: 'carries-over', goalIndex: 1 } },
    });
    const back = getPrePlanState('26_99');
    expect(back.goals).toEqual([
      { text: 'Goal A', owner: null, isMine: false },
      { text: 'Goal B', owner: null, isMine: false },
    ]);
    expect(back.stories['100908']).toEqual({ call: 'carries-over', goalIndex: 1 });
  });

  it('keys per sprint', () => {
    expect(prePlanSettingsKey('26_13')).toBe('preplan_26_13');
  });

  it('returns empty state on corrupt JSON', () => {
    // write junk under the key via setSetting directly, then read
    setSetting(prePlanSettingsKey('26_corrupt'), '{not json');
    expect(getPrePlanState('26_corrupt')).toEqual({ goals: [], stories: {} });
  });
});

function story(p: Partial<UserStoryGroup> & { id: string }): UserStoryGroup {
  return {
    id: p.id,
    title: p.title ?? `Story ${p.id}`,
    type: p.type ?? 'User Story',
    state: p.state ?? 'Active',
    url: '',
    tasks: p.tasks ?? [],
    totalEstimateHours: 0,
    completedHours: 0,
    remainingHours: p.remainingHours ?? 0,
    counts: { inProgress: 0, upNext: 0, done: 0 },
    recentActivity: p.recentActivity ?? [],
    hasActiveSession: p.hasActiveSession ?? false,
    tags: p.tags,
  } as UserStoryGroup;
}

describe('selectCarriedStories', () => {
  it('keeps active stories, drops done and features and never-started', () => {
    const stories = [
      story({ id: '1', state: 'Active' }),
      story({ id: '2', state: 'Closed' }),
      story({ id: '3', type: 'Feature', state: 'Active' }),
      story({ id: '4', state: 'New', hasActiveSession: false }),
      story({ id: '5', state: 'New', hasActiveSession: true }), // started via live session
    ];
    expect(selectCarriedStories(stories).map(s => s.id)).toEqual(['1', '5']);
  });
});

describe('buildCards', () => {
  const NOW2 = new Date('2026-06-25T12:00:00Z');
  it('uses saved call/link when present, else suggestion', () => {
    const stories = [
      story({ id: '1', title: 'Rollout checkout service', state: 'Active', remainingHours: 4,
        recentActivity: [{ id: 1, sessionId: 's', workItemId: 1, type: 'progress', text: '', createdAt: '2026-06-24T12:00:00Z' }] }),
      story({ id: '2', state: 'Blocked', remainingHours: 3 }),
    ];
    const state = { goals: [{ text: 'Improve checkout rollout', owner: null, isMine: false }], stories: { '1': { call: 'carries-over' as const, goalIndex: 0 } } };
    const cards = buildCards(stories, state, NOW2);
    // story 1: saved call wins, not suggested
    expect(cards[0].call).toBe('carries-over');
    expect(cards[0].callIsSuggested).toBe(false);
    expect(cards[0].goalIndex).toBe(0);
    // story 2: no saved state -> suggestion (blocked => at-risk), marked suggested
    expect(cards[1].call).toBe('at-risk');
    expect(cards[1].callIsSuggested).toBe(true);
    expect(cards[1].blocked).toBe(true);
    expect(cards[1].displayName).toBe('**Story 2** (#2)');
  });

  it('preserves explicit null goalIndex when saved', () => {
    const stories = [
      story({ id: '10', title: 'Improve checkout rollout confidence', state: 'Active', remainingHours: 2 }),
    ];
    const state = { goals: [{ text: 'Improve checkout rollout confidence', owner: null, isMine: false }], stories: { '10': { goalIndex: null } } };
    const cards = buildCards(stories, state, NOW2);
    // The title strongly matches the goal, but saved null must be preserved (user chose "no goal")
    expect(cards[0].goalIndex).toBeNull();
  });

  it('detects blocked via tag when state is Active', () => {
    const stories = [
      story({ id: '20', state: 'Active', tags: ['Blocked'], remainingHours: 5 }),
    ];
    const state = { goals: [], stories: {} };
    const cards = buildCards(stories, state, NOW2);
    expect(cards[0].blocked).toBe(true);
    expect(cards[0].call).toBe('at-risk');
  });
});

describe('setGoals (replace + link safety)', () => {
  const base = {
    goals: [{ text: 'old', owner: null, isMine: false }],
    stories: {
      '1': { call: 'on-track' as const, goalIndex: 0 },
      '2': { call: 'at-risk' as const, goalIndex: 2 }, // points past a shorter new list
      '3': { call: 'on-track' as const, goalIndex: null },
    },
  };
  it('replaces goals and keeps in-range links, resets out-of-range to null', () => {
    const next = setGoals(base, [
      { text: 'g0', owner: 'Gleb', isMine: false },
      { text: 'g1', owner: 'The user', isMine: true },
    ]);
    expect(next.goals).toHaveLength(2);
    expect(next.stories['1'].goalIndex).toBe(0);   // 0 < 2 → kept
    expect(next.stories['2'].goalIndex).toBeNull(); // 2 >= 2 → reset
    expect(next.stories['3'].goalIndex).toBeNull(); // already null
    expect(next.stories['1'].call).toBe('on-track'); // calls untouched
  });
  it('resets all links when goals cleared', () => {
    const next = setGoals(base, []);
    expect(next.goals).toEqual([]);
    expect(next.stories['1'].goalIndex).toBeNull();
  });
  it('does not mutate the input state', () => {
    const snapshot = JSON.stringify(base);
    setGoals(base, []);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
  it('keeps goalIndex ABSENT for stories that never had one (suggestions stay live)', () => {
    const state = {
      goals: [],
      stories: { '9': { call: 'at-risk' as const } },
    };
    const next = setGoals(state, [{ text: 'g0', owner: null, isMine: false }]);
    expect('goalIndex' in next.stories['9']).toBe(false);
  });
});
