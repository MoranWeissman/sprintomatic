import { describe, expect, it } from 'vitest';
import { repoHintFor, sessionReminderFor, activeFeatureField, repoLinkFor } from './orient';
import type { RepoLinkDeps } from './orient';
import type { WorkItemDetail } from './ado';
import type { FoundRepoLink } from './repo-link';
import { workspaceOfferFor } from './workspace';

describe('sessionReminderFor', () => {
  it('returns a reminder when no session is open', () => {
    const msg = sessionReminderFor(0);
    expect(msg).not.toBeNull();
    expect(msg).toContain('session_start');
  });

  it('returns null when a session is already open', () => {
    expect(sessionReminderFor(1)).toBeNull();
  });

  it('returns null when several sessions are open', () => {
    expect(sessionReminderFor(3)).toBeNull();
  });
});

describe('repoHintFor', () => {
  it('says it matches this chat when repos agree', () => {
    expect(repoHintFor('sprintomatic', 'sprintomatic')).toBe(
      'started from `sprintomatic` — matches this chat',
    );
  });
  it("marks a different repo as another chat's work", () => {
    expect(repoHintFor('infra-repo', 'sprintomatic')).toBe(
      "started from `infra-repo` — a different chat's work",
    );
  });
  it('names the repo without a claim when this chat is unknown', () => {
    expect(repoHintFor('infra-repo', null)).toBe(
      'started from `infra-repo`',
    );
  });
  it('shows the last folder name only, never the whole path', () => {
    expect(repoHintFor('/home/x/projects/work/sprintomatic', null)).toBe(
      'started from `sprintomatic`',
    );
  });
  it('counts a feature folder under the session folder as this chat', () => {
    const root = '/home/x/projects/work/sprintomatic';
    expect(repoHintFor(root, `${root}/100901-cd-and/design`)).toBe(
      'started from `sprintomatic` — matches this chat',
    );
  });
  it('says repo unknown for old sessions with no cwd', () => {
    expect(repoHintFor(null, 'sprintomatic')).toBe('repo unknown (older session)');
    expect(repoHintFor(null, null)).toBe('repo unknown (older session)');
  });
});

describe('workspaceOfferFor', () => {
  const ALLOWED = ['.git', '.DS_Store', '.sprintomatic-home'];
  it('offers for an empty, unknown, non-declined folder', () => {
    const r = workspaceOfferFor({ cwd: '/tmp/new', entries: [], known: false, declined: false });
    expect(r.shouldOffer).toBe(true);
    expect(r.reason).toBe('empty-unknown');
  });
  it('treats allowlisted dotfiles as still-empty', () => {
    const r = workspaceOfferFor({ cwd: '/tmp/new', entries: ALLOWED, known: false, declined: false });
    expect(r.shouldOffer).toBe(true);
  });
  it('does NOT offer when the folder has real content', () => {
    const r = workspaceOfferFor({ cwd: '/tmp/x', entries: ['README.md'], known: false, declined: false });
    expect(r.shouldOffer).toBe(false);
  });
  it('does NOT offer a known workspace', () => {
    expect(workspaceOfferFor({ cwd: '/w', entries: [], known: true, declined: false }).shouldOffer).toBe(false);
  });
  it('does NOT offer a declined path', () => {
    expect(workspaceOfferFor({ cwd: '/w', entries: [], known: false, declined: true }).shouldOffer).toBe(false);
  });
  it('does NOT offer when cwd is null', () => {
    expect(workspaceOfferFor({ cwd: null, entries: [], known: false, declined: false }).shouldOffer).toBe(false);
  });
});

describe('activeFeatureField', () => {
  it('maps a record to a names-before-numbers displayName', () => {
    expect(activeFeatureField({
      id: 100901,
      title: 'Declarative CD',
      folderPath: '/w/space/100901-declarative-cd',
      setAt: '2026-07-16T10:00:00.000Z',
    })).toEqual({
      id: 100901,
      displayName: '**Declarative CD** (#100901)',
      folderPath: '/w/space/100901-declarative-cd',
    });
  });

  it('returns null when there is no active feature', () => {
    expect(activeFeatureField(null)).toBeNull();
  });
});

// NOTE: buildOrientPacket integration tests would require mocking DB, dashboard
// cache, sessions, etc. The discovery field is type-checked (tsc) and tested
// indirectly via MCP server smoke tests. The pure discovery functions are unit
// tested in discovery.test.ts.


/* ------------------------------------------------------------------ *
 * repoLinkFor — the one place in the greeting that reads the board and
 * the disk. The side-effecting bits are injected, so these tests use
 * plain fakes: no ADO, no workspace folders.
 * ------------------------------------------------------------------ */

function fakeItem(id: number, title: string, state = 'Active'): WorkItemDetail {
  return {
    id, rev: 1, type: 'Feature', title, state,
    iterationPath: 'P', areaPath: 'P',
    createdDate: '2026-08-01T00:00:00Z', changedDate: '2026-08-01T00:00:00Z',
    children: [], related: [], url: '', webUrl: '',
  };
}

function deps(over: Partial<RepoLinkDeps> = {}): RepoLinkDeps {
  return {
    readLink: () => null,
    fetchWorkItem: async (id: number) => fakeItem(id, `F${id}`),
    featureFolders: () => [],
    folderStage: () => ({ stage: 'in design', demoBuilt: false }),
    ...over,
  };
}

function link(over: Partial<FoundRepoLink> = {}): FoundRepoLink {
  return { features: [], stories: [], dir: '/repos/thing', ...over };
}

describe('repoLinkFor', () => {
  it('says null when the folder has no link file', async () => {
    expect(await repoLinkFor('/repos/thing', deps())).toBeNull();
    expect(await repoLinkFor(null, deps())).toBeNull();
  });

  it('fills the block for a linked feature that has a workspace folder', async () => {
    const block = await repoLinkFor('/repos/thing', deps({
      readLink: () => link({ features: [100901] }),
      fetchWorkItem: async () => ({
        ...fakeItem(100901, 'GitHub CD'),
        children: [
          { id: 1, title: 'S1', type: 'User Story', state: 'Closed', url: '' },
          { id: 2, title: 'S2', type: 'Task', state: 'Active', url: '' },
        ],
      }),
      featureFolders: () => [{ id: 100901, folderPath: '/ws/100901-github-cd' }],
      folderStage: () => ({ stage: 'design pushed', demoBuilt: true }),
    }));
    expect(block!.notes).toEqual([]);
    expect(block!.features).toHaveLength(1);
    const f = block!.features[0];
    expect(f.displayName).toBe('**GitHub CD** (#100901)');
    expect(f.folderPath).toBe('/ws/100901-github-cd');
    // Only the child User Story counts; the Task is not a story.
    expect(f.stories.counts).toEqual({ done: 1, going: 0, waiting: 0, blocked: 0 });
    expect(f.whereWeStand).toBe(
      '**GitHub CD** (#100901) is past design and its stories are on the board; '
      + '1 of 1 story is done, and the demo is built.',
    );
  });

  it('an id the board turns down becomes a note, and the rest still comes through', async () => {
    const block = await repoLinkFor('/repos/thing', deps({
      readLink: () => link({ features: [111, 222] }),
      featureFolders: () => [{ id: 222, folderPath: '/ws/222-good' }],
      fetchWorkItem: async (id: number) => {
        if (id === 111) throw new Error('404');
        return fakeItem(222, 'Good One');
      },
    }));
    expect(block!.features.map(f => f.id)).toEqual([222]);
    expect(block!.notes).toHaveLength(1);
    expect(block!.notes[0]).toContain('#111');
    expect(block!.notes[0]).toContain('/repos/thing');
  });

  it('a linked feature with no workspace folder: a note, and it is still listed', async () => {
    const block = await repoLinkFor('/repos/thing', deps({
      readLink: () => link({ features: [100901] }),
      fetchWorkItem: async () => fakeItem(100901, 'GitHub CD'),
      featureFolders: () => [],
    }));
    expect(block!.features[0].folderPath).toBeNull();
    // Unknown, NOT "no discovery yet" — a missing folder must never turn into
    // a claim about the work. The sentence drops the stage half instead.
    expect(block!.features[0].stage).toBeNull();
    expect(block!.features[0].whereWeStand).not.toContain('discovery');
    expect(block!.notes[0]).toBe(
      '**GitHub CD** (#100901) is linked from this repo but has no folder in '
      + "any workspace, so its stage can't be read.",
    );
  });

  it('more ids than we read: says how many are left out, for both lists', async () => {
    const block = await repoLinkFor('/repos/thing', deps({
      readLink: () => link({ features: [1, 2, 3, 4, 5, 6], stories: [11, 12, 13, 14, 15] }),
      fetchWorkItem: async (id: number) => fakeItem(id, `F${id}`),
    }));
    expect(block!.features.map(f => f.id)).toEqual([1, 2, 3, 4]);
    expect(block!.stories).toHaveLength(4);
    expect(block!.notes[0]).toBe(
      'The link file at /repos/thing names 6 features. Only the first 4 are '
      + 'read here, so 2 are left out of this greeting.',
    );
    expect(block!.notes[1]).toBe(
      'The link file at /repos/thing names 5 stories. Only the first 4 are '
      + 'read here, so 1 is left out of this greeting.',
    );
  });

  it('never throws, whatever the board or the folders do', async () => {
    await expect(repoLinkFor('/repos/thing', deps({
      readLink: () => link({ features: [1], stories: [2] }),
      fetchWorkItem: async () => { throw new Error('board is down'); },
      featureFolders: () => [],
    }))).resolves.toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Days off in the greeting: the pre-formatted question and the
 * capacity sentence's days-off clause. Pure functions, plain fakes.
 * ------------------------------------------------------------------ */

import { daysOffQuestionFor, formatDayRange, plainCapacitySummary } from './orient';
import type { Capacity } from './capacity';

describe('formatDayRange', () => {
  it('names a single day', () => {
    expect(formatDayRange('2026-08-27', '2026-08-27')).toBe('Thu 27 Aug');
  });
  it('names a multi-day range with both ends', () => {
    expect(formatDayRange('2026-08-31', '2026-09-04')).toBe('Mon 31 Aug – Fri 4 Sep');
  });
});

describe('daysOffQuestionFor', () => {
  it('is null when there is nothing to ask', () => {
    expect(daysOffQuestionFor([])).toBeNull();
    expect(daysOffQuestionFor([], [])).toBeNull();
  });

  it('asks about a single all-day entry in the singular', () => {
    expect(daysOffQuestionFor([{ start: '2026-08-27', end: '2026-08-27' }])).toBe(
      "Your calendar has an all-day entry on Thu 27 Aug. Is that you being off? "
      + "Say so and I'll count it out of the sprint.",
    );
  });

  it('joins several ranges naturally', () => {
    expect(
      daysOffQuestionFor([
        { start: '2026-08-27', end: '2026-08-27' },
        { start: '2026-08-31', end: '2026-09-04' },
      ]),
    ).toBe(
      'Your calendar has all-day entries on Thu 27 Aug and Mon 31 Aug – Fri 4 Sep. '
      + "Are any of those you being off? Say which and I'll count them out of the sprint.",
    );
  });

  it('appends a note about a stored day off the feed no longer backs', () => {
    const q = daysOffQuestionFor(
      [{ start: '2026-08-31', end: '2026-09-04' }],
      ['2026-08-27'],
    );
    expect(q).toContain('an all-day entry on Mon 31 Aug – Fri 4 Sep');
    expect(q).toContain(
      'You have Thu 27 Aug stored as a day off, but the calendar no longer shows an '
      + "all-day entry there — if that time off was canceled, tell me and I'll put the day back.",
    );
  });

  it('speaks up about an unbacked stored day off even with nothing else to ask', () => {
    expect(daysOffQuestionFor([], ['2026-08-27'])).toContain('stored as a day off');
  });
});

describe('plainCapacitySummary — days off clause', () => {
  const cap = (over: Partial<Capacity>): Capacity => ({
    sprintStart: '2026-08-23T00:00:00.000Z',
    sprintEnd: '2026-09-03T00:00:00.000Z',
    workingDays: 9,
    workingDaysRemaining: 5,
    workdayHours: 9,
    workingHoursTotal: 81,
    workingHoursRemaining: 45,
    meetingHours: { busy: 10, tentative: 0, oof: 0, weighted: 10 },
    availableHours: 71,
    availableHoursRemaining: 40,
    daysOff: 0,
    plannedHours: 70,
    difference: -1,
    hasUrl: true,
    ...over,
  });

  it('says nothing about days off when there are none', () => {
    expect(plainCapacitySummary(cap({ daysOff: 0 }))).not.toContain('day off');
  });

  it('mentions days off in one plain clause when there are some', () => {
    expect(plainCapacitySummary(cap({ daysOff: 2 }))).toContain(
      'available after meetings and 2 days off',
    );
  });

  it('uses the singular for one day off', () => {
    expect(plainCapacitySummary(cap({ daysOff: 1 }))).toContain(
      'available after meetings and 1 day off',
    );
  });

  it('stays null when no calendar is wired up', () => {
    expect(plainCapacitySummary(cap({ hasUrl: false, daysOff: 2 }))).toBeNull();
  });
});
