import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: { value: null as null | InstanceType<typeof Database> } }));
vi.mock('./db', () => ({ getDb: () => h.db.value }));

import { cleanPrUrl, addTaskPr, removeTaskPrs, taskPrCount, checkTaskPrs, type PrState } from './task-prs';

const PR = 'https://github.com/example-org/example-repo/pull/7';

beforeEach(() => {
  h.db.value = new Database(':memory:');
  h.db.value.exec(`CREATE TABLE task_prs (
    work_item_id INTEGER NOT NULL, pr_url TEXT NOT NULL, title TEXT NOT NULL,
    added_at TEXT NOT NULL, checked_at TEXT, pr_state TEXT,
    PRIMARY KEY (work_item_id, pr_url))`);
});

describe('cleanPrUrl', () => {
  it('keeps a PR link and drops what comes after the number', () => {
    expect(cleanPrUrl(`${PR}/files`)).toBe(PR);
    expect(cleanPrUrl(` ${PR} `)).toBe(PR);
  });
  it('refuses links that are not PRs', () => {
    expect(cleanPrUrl('https://github.com/example-org/example-repo')).toBeNull();
    expect(cleanPrUrl('https://example.com/pull/7')).toBeNull();
  });
});

describe('task PRs', () => {
  it('adds, counts and removes', () => {
    addTaskPr(100001, 'Fix login', PR);
    addTaskPr(100001, 'Fix login', PR); // twice is fine
    addTaskPr(100001, 'Fix login', `${PR.slice(0, -1)}8`);
    expect(taskPrCount(100001)).toBe(2);
    expect(removeTaskPrs(100001, PR)).toBe(1);
    expect(removeTaskPrs(100001)).toBe(0);
  });

  it('names merged and closed PRs by task, and remembers a merge', async () => {
    addTaskPr(100001, 'Fix login', PR);
    addTaskPr(100002, 'Add logout', `${PR.slice(0, -1)}8`);
    const states: Record<string, PrState> = { [PR]: 'MERGED', [`${PR.slice(0, -1)}8`]: 'CLOSED' };
    const getState = vi.fn(async (u: string) => states[u]);
    const r = await checkTaskPrs({ getState });
    expect(r.merged.map(m => m.line)).toEqual(['The PR for **Fix login** (#100001) merged. Close the task?']);
    expect(r.closed.map(m => m.line)).toEqual(['The PR for **Add logout** (#100002) was closed without merging.']);
    expect(r.checkError).toBeNull();
    // A merged PR isn't asked about again.
    await checkTaskPrs({ getState });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('asks about an open PR at most every ten minutes', async () => {
    addTaskPr(100001, 'Fix login', PR);
    const getState = vi.fn(async () => 'OPEN' as PrState);
    const t0 = new Date('2026-11-15T09:00:00.000Z');
    await checkTaskPrs({ now: t0, getState });
    await checkTaskPrs({ now: new Date(t0.getTime() + 5 * 60_000), getState });
    expect(getState).toHaveBeenCalledTimes(1);
    await checkTaskPrs({ now: new Date(t0.getTime() + 11 * 60_000), getState });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('says nothing about a PR it could not check, and says why', async () => {
    addTaskPr(100001, 'Fix login', PR);
    const r = await checkTaskPrs({ getState: async () => { throw new Error('not signed in'); } });
    expect(r.merged).toEqual([]);
    expect(r.checkError).toContain('not signed in');
  });
});
