/**
 * The made-up board the demo runs on: a small team building a recipe app.
 *
 * Everything here is invented. The repo is public, so nothing real may ever
 * land in this file. Dates are worked out from today, so the demo always
 * shows a sprint that is halfway through, whatever day it is opened.
 *
 * Two parts: the board itself (read by server/demo-board.ts) and a few days
 * of past work for the local store (sessions, logs, time), so the Day and
 * Retro pages have something to show the first time the demo opens.
 */
import type BetterSqlite3 from 'better-sqlite3';

export const DEMO_ORG = 'https://dev.azure.com/demo-org';
export const DEMO_PROJECT = 'Recipe Box';
export const DEMO_TEAM = 'Recipe Box Team';
export const DEMO_USER = 'demo.user@example.com';
export const DEMO_USER_NAME = 'Demo User';

export interface DemoIteration {
  id: string;
  name: string;
  path: string;
  attributes: { startDate: string; finishDate: string; timeFrame: 'past' | 'current' | 'future' };
}

export interface DemoItem {
  id: number;
  rev: number;
  parent?: number;
  fields: Record<string, unknown>;
  comments: { id: number; text: string; createdDate: string }[];
}


/** Local midnight, `days` from `d`. */
function dayFrom(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** The date as Azure DevOps writes sprint dates: midnight UTC of that day. */
function adoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00Z`;
}

/**
 * The current sprint starts on the Monday of the week that holds "4 days
 * ago", so it's always a few days in: at least 4 work days have passed,
 * enough for the quiet task below to have gone quiet. Two weeks, Monday to
 * Friday.
 */
export function demoSprintStart(now: Date): Date {
  const back = dayFrom(now, -4);
  const sinceMonday = (back.getDay() + 6) % 7;
  return dayFrom(back, -sinceMonday);
}

const sprintPath = (n: number) => `${DEMO_PROJECT}\\Sprint ${n}`;

export function demoIterations(now: Date): DemoIteration[] {
  const start = demoSprintStart(now);
  const make = (n: number, from: Date, timeFrame: DemoIteration['attributes']['timeFrame']): DemoIteration => ({
    id: `00000000-0000-0000-0000-0000000000${n}`,
    name: `Sprint ${n}`,
    path: sprintPath(n),
    attributes: { startDate: adoDate(from), finishDate: adoDate(dayFrom(from, 11)), timeFrame },
  });
  return [make(23, dayFrom(start, -14), 'past'), make(24, start, 'current'), make(25, dayFrom(start, 14), 'future')];
}

/** Work days (Mon–Fri) of the current sprint before today, oldest first. */
export function demoPastWorkDays(now: Date): Date[] {
  const today = dayFrom(now, 0);
  const days: Date[] = [];
  for (let d = demoSprintStart(now); d < today; d = dayFrom(d, 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(d);
  }
  return days;
}

/** One of the past work days, by position; clamps when the sprint is young. */
function pastDay(now: Date, i: number): Date {
  const days = demoPastWorkDays(now);
  return days[Math.min(i, days.length - 1)] ?? dayFrom(now, -1);
}

/** A local time on one of the past work days, as an ISO string. */
function at(now: Date, dayIndex: number, hour: number, minute = 0): string {
  const d = pastDay(now, dayIndex);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).toISOString();
}

interface Seed {
  id: number;
  type: 'Feature' | 'User Story' | 'Task';
  title: string;
  state: string;
  parent?: number;
  sprint?: number;
  estimate?: number;
  remaining?: number;
  completed?: number;
  points?: number;
  effort?: number;
  description?: string;
  /** Which past work day it last changed on (index), or days before the sprint. */
  changed: number;
}

const SEEDS: Seed[] = [
  {
    id: 100001,
    type: 'Feature',
    title: 'Recipe sharing for home cooks',
    state: 'Active',
    description: 'Let people save recipes from anywhere, share them with friends, and cook from them.',
    changed: 0,
  },
  // A story from last sprint, finished.
  { id: 100017, type: 'User Story', title: 'Search recipes by ingredient', state: 'Closed', parent: 100001, sprint: 23, points: 2, effort: 7, changed: -4 },
  { id: 100018, type: 'Task', title: 'Ingredient search on the server', state: 'Closed', parent: 100017, sprint: 23, estimate: 4, remaining: 0, completed: 5, changed: -5 },
  { id: 100019, type: 'Task', title: 'Search box with suggestions', state: 'Closed', parent: 100017, sprint: 23, estimate: 2, remaining: 0, completed: 2, changed: -4 },

  // This sprint.
  { id: 100012, type: 'User Story', title: 'Sign in with an email link', state: 'Closed', parent: 100001, sprint: 24, points: 1, effort: 4.5, changed: 1 },
  { id: 100013, type: 'Task', title: 'Send the sign-in link by email', state: 'Closed', parent: 100012, sprint: 24, estimate: 3, remaining: 0, completed: 3, changed: 0 },
  { id: 100014, type: 'Task', title: 'Sign out on all devices', state: 'Closed', parent: 100012, sprint: 24, estimate: 1.5, remaining: 0, completed: 2, changed: 1 },

  {
    id: 100002,
    type: 'User Story',
    title: 'Save a recipe from any website',
    state: 'Active',
    parent: 100001,
    sprint: 24,
    points: 2,
    effort: 9,
    description: 'A cook finds a recipe on a blog and saves it to their box with one click, without the ads and the life story.',
    changed: 3,
  },
  { id: 100003, type: 'Task', title: 'Read the recipe out of the page', state: 'Closed', parent: 100002, sprint: 24, estimate: 4, remaining: 0, completed: 4.5, changed: 2 },
  { id: 100004, type: 'Task', title: 'Save button in the browser extension', state: 'Active', parent: 100002, sprint: 24, estimate: 3, remaining: 1.5, completed: 1.5, changed: 4 },
  { id: 100005, type: 'Task', title: 'Clear message when a page has no recipe', state: 'New', parent: 100002, sprint: 24, estimate: 2, remaining: 2, changed: 0 },

  {
    id: 100006,
    type: 'User Story',
    title: 'Share a recipe with a link',
    state: 'Active',
    parent: 100001,
    sprint: 24,
    points: 1,
    effort: 5,
    description: 'Send a friend a link; they see the recipe even without an account.',
    changed: 3,
  },
  { id: 100007, type: 'Task', title: 'Share links that run out after 30 days', state: 'Blocked', parent: 100006, sprint: 24, estimate: 3, remaining: 2, completed: 1, changed: 3 },
  { id: 100008, type: 'Task', title: 'Preview card for shared links', state: 'New', parent: 100006, sprint: 24, estimate: 2, remaining: 2, changed: 0 },

  { id: 100009, type: 'User Story', title: 'Shopping list from a recipe', state: 'Active', parent: 100001, sprint: 24, points: 1, effort: 5, changed: 0 },
  // Gone quiet: started on day 0, timer left on overnight, nothing since.
  // The quiet-task note (server/task-checkup.ts) picks it up.
  { id: 100010, type: 'Task', title: 'Add up the same ingredients', state: 'Active', parent: 100009, sprint: 24, estimate: 4, remaining: 4, changed: 0 },
  { id: 100011, type: 'Task', title: 'Tick items off on the phone', state: 'New', parent: 100009, sprint: 24, estimate: 2, remaining: 2, changed: 0 },

  // Waiting in the backlog for a later sprint.
  { id: 100015, type: 'User Story', title: 'Print a recipe card', state: 'New', parent: 100001, points: 1, effort: 4, changed: -2 },
  { id: 100016, type: 'User Story', title: 'Cooking mode that keeps the screen on', state: 'New', parent: 100001, points: 1, effort: 3, changed: -2 },
];

/** The demo board as of `now`: every item with its fields filled in. */
export function demoItems(now: Date): DemoItem[] {
  const start = demoSprintStart(now);
  return SEEDS.map(s => {
    const changed = s.changed >= 0 ? at(now, s.changed, 16, 30) : dayFrom(start, s.changed).toISOString();
    const created = dayFrom(start, -20).toISOString();
    const fields: Record<string, unknown> = {
      'System.Id': s.id,
      'System.WorkItemType': s.type,
      'System.Title': s.title,
      'System.State': s.state,
      'System.AreaPath': DEMO_PROJECT,
      'System.IterationPath': s.sprint ? sprintPath(s.sprint) : DEMO_PROJECT,
      'System.AssignedTo': { displayName: DEMO_USER_NAME, uniqueName: DEMO_USER },
      'System.CreatedDate': created,
      'System.CreatedBy': { displayName: DEMO_USER_NAME, uniqueName: DEMO_USER },
      'System.ChangedDate': changed,
      'System.ChangedBy': { displayName: DEMO_USER_NAME, uniqueName: DEMO_USER },
    };
    if (s.description) fields['System.Description'] = `<div>${s.description}</div>`;
    if (s.estimate != null) fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] = s.estimate;
    if (s.remaining != null) fields['Microsoft.VSTS.Scheduling.RemainingWork'] = s.remaining;
    if (s.completed != null) fields['Microsoft.VSTS.Scheduling.CompletedWork'] = s.completed;
    if (s.points != null) fields['Microsoft.VSTS.Scheduling.StoryPoints'] = s.points;
    if (s.effort != null) fields['Microsoft.VSTS.Scheduling.Effort'] = s.effort;
    return { id: s.id, rev: 3, parent: s.parent, fields, comments: [] };
  });
}

/* ============================================================ */
/*  A few days of past work for the local store                  */
/* ============================================================ */

interface PastEvent {
  type: 'focus' | 'progress' | 'blocker' | 'decision' | 'note';
  hour: number;
  minute?: number;
  text: string;
  standup?: string;
}

interface PastSession {
  workItemId: number;
  day: number;
  from: [number, number];
  to: [number, number];
  /** The session ended this many work days after it started (a timer left on). */
  endsLater?: number;
  /** When the timer's counted time ran out, if not at `to`. */
  countedTo?: [number, number];
  summary: string;
  events: PastEvent[];
}

const PAST: PastSession[] = [
  {
    workItemId: 100013,
    day: 0,
    from: [9, 15],
    to: [12, 15],
    summary: 'Sign-in links go out by email and work once.',
    events: [
      { type: 'focus', hour: 9, minute: 20, text: 'Starting on the email sign-in link.' },
      { type: 'decision', hour: 10, minute: 30, text: 'Links run out after 15 minutes and work only once.' },
      { type: 'progress', hour: 12, text: 'Sign-in link sent and checked end to end.', standup: 'Finished the email sign-in link. It works once and runs out after 15 minutes.' },
    ],
  },
  {
    workItemId: 100014,
    day: 1,
    from: [9, 0],
    to: [11, 0],
    summary: 'Signing out now signs out every device.',
    events: [
      { type: 'progress', hour: 10, minute: 50, text: 'Sign out clears every device the user is signed in on.', standup: 'Sign out now works on all devices. That closes the sign-in story.' },
    ],
  },
  {
    workItemId: 100003,
    day: 1,
    from: [13, 0],
    to: [16, 0],
    summary: 'Most recipe sites read fine; a few odd ones left.',
    events: [
      { type: 'focus', hour: 13, minute: 5, text: 'Reading recipes out of web pages.' },
      { type: 'progress', hour: 15, minute: 50, text: 'Works on most recipe sites that mark up their recipes.', standup: 'Started reading recipes out of web pages. Most sites already work.' },
    ],
  },
  {
    workItemId: 100003,
    day: 2,
    from: [9, 30],
    to: [11, 0],
    summary: 'Recipe reading done, with a fallback for plain pages.',
    events: [
      { type: 'decision', hour: 10, text: 'Pages without recipe markup fall back to reading the ingredient list by its heading.' },
      { type: 'progress', hour: 10, minute: 55, text: 'Fallback in place; recipe reading is done.', standup: 'Finished reading recipes out of pages, including pages with no recipe markup.' },
    ],
  },
  {
    workItemId: 100007,
    day: 3,
    from: [9, 0],
    to: [10, 0],
    summary: 'Waiting on the hosting team for a place to keep share links.',
    events: [
      { type: 'focus', hour: 9, minute: 5, text: 'Starting on share links that run out.' },
      { type: 'blocker', hour: 9, minute: 55, text: 'Need a storage space for share links from the hosting team. Asked them.', standup: 'Share links are stuck: waiting on the hosting team for somewhere to keep them.' },
    ],
  },
  {
    workItemId: 100004,
    day: 3,
    from: [10, 30],
    to: [12, 0],
    summary: 'Save button shows up on recipe pages.',
    events: [
      { type: 'progress', hour: 11, minute: 55, text: 'The extension shows a Save button on pages with a recipe.', standup: 'The Save button now shows up in the browser on recipe pages.' },
    ],
  },
  {
    workItemId: 100004,
    day: 4,
    from: [13, 30],
    to: [14, 0],
    summary: 'Saving works; the success message is next.',
    events: [
      { type: 'progress', hour: 13, minute: 55, text: 'Clicking Save puts the recipe in the box. Next: a clear success message.', standup: 'Saving from the browser works. Next is the message that says it worked.' },
    ],
  },
  {
    workItemId: 100010,
    day: 0,
    from: [14, 0],
    to: [9, 40],
    endsLater: 1,
    // What the timer really counts: 1h 10m of work, then 2h at most for the
    // quiet stretch after it (server/timers.ts).
    countedTo: [17, 10],
    summary: 'Same ingredients add up when the units match.',
    events: [
      { type: 'focus', hour: 14, minute: 5, text: 'Adding up the same ingredients across recipes.' },
      { type: 'progress', hour: 15, minute: 10, text: 'Same ingredients add up when the units match. Cups and grams are next.', standup: 'Started the shopping list. Same ingredients add up when the units match.' },
    ],
  },
];

/**
 * Fill an empty demo store with the past work above. Does nothing when the
 * store already has sessions, so the user's own demo clicking is kept.
 */
export function seedDemoHistory(db: BetterSqlite3.Database, now = new Date()): void {
  const has = db.prepare(`SELECT 1 FROM sessions LIMIT 1`).get();
  if (has) return;
  const addSession = db.prepare(
    `INSERT INTO sessions (id, work_item_id, started_at, ended_at, client, summary) VALUES (?, ?, ?, ?, 'claude-code', ?)`,
  );
  const addEvent = db.prepare(
    `INSERT INTO session_events (session_id, work_item_id, type, text, created_at, standup_summary) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const addTime = db.prepare(
    `INSERT INTO time_entries (work_item_id, started_at, ended_at, synced_to_ado) VALUES (?, ?, ?, 1)`,
  );
  db.transaction(() => {
    PAST.forEach((s, i) => {
      const id = `demo-session-${i + 1}`;
      const from = at(now, s.day, ...s.from);
      const to = at(now, s.day + (s.endsLater ?? 0), ...s.to);
      addSession.run(id, s.workItemId, from, to, s.summary);
      for (const e of s.events) {
        addEvent.run(id, s.workItemId, e.type, e.text, at(now, s.day, e.hour, e.minute ?? 0), e.standup ?? null);
      }
      addTime.run(s.workItemId, from, s.countedTo ? at(now, s.day, ...s.countedTo) : to);
    });
  })();
}

