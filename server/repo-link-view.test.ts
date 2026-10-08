import { describe, it, expect } from 'vitest';
import { stageFor, repoLinkBlock } from './repo-link-view';
import type { RepoLinkFeatureInput } from './repo-link-view';

describe('stageFor', () => {
  it('walks the ladder in order', () => {
    expect(stageFor({ hasDiscovery: false, discoveryFinished: false, hasDesignDoc: false, designPushed: false }))
      .toBe('no discovery yet');
    expect(stageFor({ hasDiscovery: true, discoveryFinished: false, hasDesignDoc: false, designPushed: false }))
      .toBe('in discovery');
    expect(stageFor({ hasDiscovery: true, discoveryFinished: true, hasDesignDoc: false, designPushed: false }))
      .toBe('discovery done');
    expect(stageFor({ hasDiscovery: true, discoveryFinished: true, hasDesignDoc: true, designPushed: false }))
      .toBe('in design');
    expect(stageFor({ hasDiscovery: true, discoveryFinished: true, hasDesignDoc: true, designPushed: true }))
      .toBe('design pushed');
  });

  it('design signals win even if discovery flags look odd (files can lag)', () => {
    expect(stageFor({ hasDiscovery: false, discoveryFinished: false, hasDesignDoc: true, designPushed: true }))
      .toBe('design pushed');
  });
});

function feat(over: Partial<RepoLinkFeatureInput> = {}): RepoLinkFeatureInput {
  return {
    id: 100901,
    title: 'GitHub CD',
    boardState: 'Active',
    folderPath: '/ws/100901-github-cd',
    stage: 'design pushed',
    demoBuilt: true,
    childStories: [
      { id: 1, title: 'S1', state: 'Closed' },
      { id: 2, title: 'S2', state: 'Resolved' },
      { id: 3, title: 'S3', state: 'Active' },
      { id: 4, title: 'S4', state: 'New' },
      { id: 5, title: 'S5', state: 'Blocked' },
      { id: 6, title: 'S6', state: 'Removed' },   // never counted
      { id: 7, title: 'T7', state: 'Doing' },
    ],
    ...over,
  };
}

describe('repoLinkBlock', () => {
  it('rolls child stories up by state, skipping Removed', () => {
    const block = repoLinkBlock([feat()], [], []);
    const f = block.features[0];
    expect(f.displayName).toBe('**GitHub CD** (#100901)');
    expect(f.stories.counts).toEqual({ done: 2, going: 2, waiting: 1, blocked: 1 });
    // open = everything not done/removed, each with displayName + state
    expect(f.stories.open.map(s => s.displayName)).toEqual([
      '**S3** (#3)', '**S4** (#4)', '**S5** (#5)', '**T7** (#7)',
    ]);
  });

  it('writes one plain-English whereWeStand sentence', () => {
    const block = repoLinkBlock([feat()], [], []);
    expect(block.features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901) is past design and its stories are on the board; ' +
      '2 of 6 stories are done, 2 are being worked on, 1 is waiting, 1 is blocked, ' +
      'and the demo is built.',
    );
  });

  it('reads naturally with no stories yet', () => {
    const block = repoLinkBlock([feat({ childStories: [], stage: 'in discovery', demoBuilt: false })], [], []);
    expect(block.features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901) is in discovery; no stories on the board yet.',
    );
  });

  it('carries loose linked stories and notes through', () => {
    const block = repoLinkBlock([], [{ id: 9, title: 'Loose', state: 'Active' }], ['note a']);
    expect(block.stories).toEqual([{ displayName: '**Loose** (#9)', state: 'Active' }]);
    expect(block.notes).toEqual(['note a']);
    expect(block.features).toEqual([]);
  });

  it('a feature closed on the board says so first, never a stage', () => {
    const closed = feat({ boardState: 'Closed', demoBuilt: false });
    expect(repoLinkBlock([closed], [], []).features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901) is closed on the board; 2 of 6 stories are done, '
      + '2 are being worked on, 1 is waiting, and 1 is blocked.',
    );
  });

  it('uses the real board word, and stops there when there are no stories', () => {
    // "is removed on the board" is not English — a removed feature reads
    // "was taken off the board".
    const cases: Array<[string, string]> = [
      ['Done', 'is done on the board'],
      ['Resolved', 'is resolved on the board'],
      ['REMOVED', 'was taken off the board'],
    ];
    for (const [state, phrase] of cases) {
      const done = feat({ boardState: state, childStories: [], demoBuilt: false });
      expect(repoLinkBlock([done], [], []).features[0].whereWeStand).toBe(
        `**GitHub CD** (#100901) ${phrase}.`,
      );
    }
  });

  it('stage unknown: says nothing about the work, only what the board shows', () => {
    const noFolder = feat({ stage: null, folderPath: null, boardState: 'Active', demoBuilt: false });
    expect(repoLinkBlock([noFolder], [], []).features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901): 2 of 6 stories are done, 2 are being worked on, '
      + '1 is waiting, and 1 is blocked.',
    );
  });

  it('stage unknown and no stories: still no claim about the work', () => {
    const bare = feat({ stage: null, folderPath: null, boardState: 'Active', childStories: [], demoBuilt: false });
    expect(repoLinkBlock([bare], [], []).features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901): no stories on the board yet.',
    );
  });

  it('design pushed but the board shows no stories: no half-sentence that argues with itself', () => {
    const gone = feat({ childStories: [], demoBuilt: false });
    expect(repoLinkBlock([gone], [], []).features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901) is past design; no stories on the board yet.',
    );
  });

  it('reads naturally when the feature has a single story', () => {
    const one = feat({
      childStories: [{ id: 1, title: 'S1', state: 'Active' }],
      stage: 'in design',
      demoBuilt: false,
    });
    expect(repoLinkBlock([one], [], []).features[0].whereWeStand).toBe(
      '**GitHub CD** (#100901) is in design; 0 of 1 story is done, and 1 is being worked on.',
    );
  });
});
