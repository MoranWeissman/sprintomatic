import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DemoAdoClient } from './demo-board';
import { DEMO_ORG, demoIterations, demoPastWorkDays, seedDemoHistory } from './demo-data';

// A Sunday, so the sprint is a week in and the history has five work days.
const NOW = new Date(2026, 9, 11, 10, 0);
const board = () => new DemoAdoClient(() => NOW);
const base = `${DEMO_ORG}/Recipe%20Box`;
const SPRINT = 'Recipe Box\\Sprint 24';

const query = (c: DemoAdoClient, where: string) =>
  c.queryWorkItems({
    wiql: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me ${where} ORDER BY [System.ChangedDate] DESC`,
    fields: [],
    organization: DEMO_ORG,
    project: 'Recipe Box',
  });

describe('demo board', () => {
  it('has a current sprint that started a few days ago', async () => {
    const res = await board().rest<{ value: { path: string; attributes: { startDate: string } }[] }>({
      method: 'GET',
      uri: `${base}/Recipe%20Box%20Team/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`,
    });
    expect(res.value.map(i => i.path)).toEqual([SPRINT]);
    expect(res.value[0].attributes.startDate).toBe('2026-10-05T00:00:00Z');
    expect(demoIterations(NOW)).toHaveLength(3);
  });

  it('filters WIQL by sprint, type and state', async () => {
    const c = board();
    const sprint = await query(c, `AND [System.IterationPath] = '${SPRINT}'`);
    expect(sprint.length).toBe(13);
    const openStories = await query(
      c,
      `AND [System.WorkItemType] = 'User Story' AND [System.State] NOT IN ('Closed', 'Removed') AND [System.IterationPath] <> '${SPRINT}'`,
    );
    expect(openStories.map(w => w.id).sort()).toEqual([100015, 100016]);
    const done = await query(
      c,
      `AND [System.Parent] = 100017 AND [System.State] IN ('Closed') AND [Microsoft.VSTS.Scheduling.OriginalEstimate] > 0`,
    );
    expect(done.map(w => w.id).sort()).toEqual([100018, 100019]);
  });

  it('changes state with a PATCH and turns down a state it does not have', async () => {
    const c = board();
    const uri = `${base}/_apis/wit/workitems/100005?api-version=7.1`;
    await c.rest({ method: 'PATCH', uri, body: [{ op: 'add', path: '/fields/System.State', value: 'Active' }], contentKind: 'json-patch' });
    const after = await c.rest<{ fields: Record<string, unknown> }>({ method: 'GET', uri: `${base}/_apis/wit/workitems/100005?fields=System.State&api-version=7.1` });
    expect(after.fields).toEqual({ 'System.State': 'Active' });
    await expect(
      c.rest({ method: 'PATCH', uri, body: [{ op: 'add', path: '/fields/System.State', value: 'Doing' }] }),
    ).rejects.toThrow(/not a valid state/);
  });

  it('creates a task under a story', async () => {
    const c = board();
    const created = await c.rest<{ id: number; fields: Record<string, unknown> }>({
      method: 'POST',
      uri: `${base}/_apis/wit/workitems/$Task?api-version=7.1`,
      contentKind: 'json-patch',
      body: [
        { op: 'add', path: '/fields/System.Title', value: 'A new demo task' },
        { op: 'add', path: '/fields/System.IterationPath', value: SPRINT },
        { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${DEMO_ORG}/_apis/wit/workItems/100009` } },
      ],
    });
    expect(created.id).toBeGreaterThan(100019);
    expect(created.fields['System.WorkItemType']).toBe('Task');
    const kids = await query(c, `AND [System.Parent] = 100009`);
    expect(kids.map(w => w.id)).toContain(created.id);
    const story = await c.rest<{ relations: { rel: string; url: string }[] }>({ method: 'GET', uri: `${base}/_apis/wit/workitems/100009?$expand=all&api-version=7.1` });
    expect(story.relations.some(r => r.url.endsWith(`/workItems/${created.id}`))).toBe(true);
  });

  it('keeps comments', async () => {
    const c = board();
    const uri = `${base}/_apis/wit/workItems/100004/comments?api-version=7.1-preview.4`;
    await c.rest({ method: 'POST', uri, body: { text: 'Hello' } });
    const res = await c.rest<{ comments: { text: string }[] }>({ method: 'GET', uri });
    expect(res.comments.map(x => x.text)).toEqual(['Hello']);
  });

  it('names a request it does not know', async () => {
    await expect(board().rest({ method: 'GET', uri: `${base}/_apis/git/repositories` })).rejects.toThrow(
      /doesn't know this request: GET \/demo-org\/Recipe Box\/_apis\/git\/repositories/,
    );
  });
});

describe('demo history', () => {
  it('fills an empty store once, on past work days', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, work_item_id INTEGER, started_at TEXT, ended_at TEXT, client TEXT, summary TEXT);
      CREATE TABLE session_events (id INTEGER PRIMARY KEY, session_id TEXT, work_item_id INTEGER, type TEXT, text TEXT, created_at TEXT, standup_summary TEXT);
      CREATE TABLE time_entries (id INTEGER PRIMARY KEY, work_item_id INTEGER, started_at TEXT, ended_at TEXT, synced_to_ado INTEGER);
    `);
    seedDemoHistory(db, NOW);
    seedDemoHistory(db, NOW);
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(n('sessions')).toBe(7);
    expect(n('time_entries')).toBe(7);
    expect(demoPastWorkDays(NOW).map(d => d.getDay())).toEqual([1, 2, 3, 4, 5]);
    const latest = db.prepare(`SELECT MAX(ended_at) AS t FROM sessions`).get() as { t: string };
    expect(new Date(latest.t) < NOW).toBe(true);
  });
});
