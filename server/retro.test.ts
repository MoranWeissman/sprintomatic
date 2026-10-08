import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The store half reads settings via getDb(); swap in a fresh in-memory db.
const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import {
  buildRetroDraft,
  saveRetro,
  getSavedRetro,
  getPreviousRetro,
  type RetroInputs,
} from './retro';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );`);
  h.db.value = db;
});

const base: RetroInputs = {
  sprintName: '26_18',
  stories: [],
  tasks: [],
  blockerEvents: [],
  decisionEvents: [],
  daysOffCount: 0,
};

const keys = (d: ReturnType<typeof buildRetroDraft>) => d.candidates.map(c => c.key);

describe('buildRetroDraft — went well', () => {
  it('a closed story becomes a went-well line with its name', () => {
    const d = buildRetroDraft({
      ...base,
      stories: [{ id: 100001, title: 'Ship the export', state: 'Closed' }],
    });
    const c = d.candidates.find(x => x.key === 'story-closed-100001')!;
    expect(c.bucket).toBe('well');
    expect(c.text).toContain('**Ship the export** (#100001)');
  });

  it('estimates-landed fires only when 3+ measured tasks ALL came in close', () => {
    const task = (id: number, est: number, done: number) => ({
      id, title: `t${id}`, state: 'Closed', originalEstimate: est, completedWork: done,
    });
    const all = buildRetroDraft({ ...base, tasks: [task(1, 4, 4), task(2, 2, 3), task(3, 6, 5)] });
    expect(keys(all)).toContain('estimates-landed');

    const two = buildRetroDraft({ ...base, tasks: [task(1, 4, 4), task(2, 2, 3)] });
    expect(keys(two)).not.toContain('estimates-landed');

    const miss = buildRetroDraft({ ...base, tasks: [task(1, 4, 4), task(2, 2, 3), task(3, 4, 9)] });
    expect(keys(miss)).not.toContain('estimates-landed');
  });
});

describe('buildRetroDraft — got in the way', () => {
  it('a block becomes one line quoting the first entry, with entry-count evidence', () => {
    const d = buildRetroDraft({
      ...base,
      blockerEvents: [
        { workItemId: 100002, title: 'Wire the login page', text: 'waiting on the platform team for a client id' },
      ],
    });
    const c = d.candidates.find(x => x.key === 'blocked-100002')!;
    expect(c.bucket).toBe('way');
    expect(c.text).toContain('**Wire the login page** (#100002)');
    expect(c.text).toContain('waiting on the platform team');
    expect(keys(d)).not.toContain('talk-reblocked-100002'); // once is not a pattern
  });

  it('blocked twice on the same item also raises a talking point', () => {
    const d = buildRetroDraft({
      ...base,
      blockerEvents: [
        { workItemId: 100002, title: 'Wire the login page', text: 'first block' },
        { workItemId: 100002, title: 'Wire the login page', text: 'stuck again' },
      ],
    });
    expect(keys(d)).toContain('blocked-100002');
    const talk = d.candidates.find(x => x.key === 'talk-reblocked-100002')!;
    expect(talk.bucket).toBe('talk');
    expect(talk.text).toContain('2 times');
  });

  it('a finished task well past its estimate becomes an overrun line', () => {
    const d = buildRetroDraft({
      ...base,
      tasks: [{ id: 100003, title: 'Fix the sync', state: 'Done', originalEstimate: 4, completedWork: 9 }],
    });
    const c = d.candidates.find(x => x.key === 'overran-100003')!;
    expect(c.text).toBe('**Fix the sync** (#100003) took 9h against an estimate of 4h.');
  });

  it('small misses stay quiet: under 1.5x or under 2h over is not an overrun', () => {
    const d = buildRetroDraft({
      ...base,
      tasks: [
        { id: 1, title: 'a', state: 'Done', originalEstimate: 4, completedWork: 5 },   // 1.25x
        { id: 2, title: 'b', state: 'Done', originalEstimate: 1, completedWork: 2.4 }, // 2.4x but +1.4h
      ],
    });
    expect(keys(d).filter(k => k.startsWith('overran-'))).toHaveLength(0);
  });

  it('an unfinished story becomes a carries-into-next-sprint line', () => {
    const d = buildRetroDraft({
      ...base,
      stories: [{ id: 100004, title: 'Big migration', state: 'Active' }],
    });
    const c = d.candidates.find(x => x.key === 'open-100004')!;
    expect(c.bucket).toBe('way');
    expect(c.text).toContain('carry into the next sprint');
  });
});

describe('buildRetroDraft — the sprint line', () => {
  it('counts stories, tasks and days off', () => {
    const d = buildRetroDraft({
      ...base,
      stories: [
        { id: 1, title: 'a', state: 'Closed' },
        { id: 2, title: 'b', state: 'Active' },
      ],
      tasks: [{ id: 3, title: 'c', state: 'Done' }],
      daysOffCount: 2,
    });
    expect(d.sprintLine).toBe('Sprint 26_18: 1 of 2 stories finished, 1 of 1 tasks done, 2 working days off.');
  });

  it('says nothing about days off when there were none', () => {
    const d = buildRetroDraft(base);
    expect(d.sprintLine).not.toContain('days off');
  });
});

describe('saved retros', () => {
  const items = [
    { key: 'story-closed-1', bucket: 'well' as const, text: 'A was finished.', decision: 'keep' as const },
    { key: 'open-2', bucket: 'way' as const, text: 'B is not finished.', decision: 'drop' as const },
  ];

  it('save + read back round-trips, and saving again replaces', () => {
    saveRetro('26_18', items);
    expect(getSavedRetro('26_18')!.items).toHaveLength(2);
    saveRetro('26_18', items.slice(0, 1));
    expect(getSavedRetro('26_18')!.items).toHaveLength(1);
    expect(getSavedRetro('26_19')).toBeNull();
  });

  it('previous retro is the newest saved one that is NOT the current sprint', () => {
    saveRetro('26_17', items);
    saveRetro('26_18', items.slice(0, 1));
    const prev = getPreviousRetro('26_18')!;
    expect(prev.sprintName).toBe('26_17');
    expect(getPreviousRetro('26_17')!.sprintName).toBe('26_18');
  });
});

describe('buildRetroDraft — polish rules', () => {
  it("strips the log's own BLOCKED: prefix so the line doesn't say it twice", () => {
    const d = buildRetroDraft({
      ...base,
      blockerEvents: [{ workItemId: 100005, title: 'Create the app', text: 'BLOCKED: no access to the org' }],
    });
    const c = d.candidates.find(x => x.key === 'blocked-100005')!;
    expect(c.text).toBe('**Create the app** (#100005) got stuck: no access to the org');
  });

  it('3+ finished tasks earn a plain went-well volume line', () => {
    const done = (id: number) => ({ id, title: `t${id}`, state: 'Done' });
    const d = buildRetroDraft({ ...base, tasks: [done(1), done(2), done(3), { id: 4, title: 't4', state: 'New' }] });
    const c = d.candidates.find(x => x.key === 'tasks-done')!;
    expect(c.bucket).toBe('well');
    expect(c.text).toBe('3 of 4 tasks were finished.');
  });

  it('under 3 finished tasks the volume line stays quiet', () => {
    const d = buildRetroDraft({ ...base, tasks: [{ id: 1, title: 't1', state: 'Done' }] });
    expect(keys(d)).not.toContain('tasks-done');
  });
});
