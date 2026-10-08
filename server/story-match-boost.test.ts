import { describe, it, expect } from 'vitest';
import { matchStoryToContext } from './story-match';
import type { SprintStory } from './story-match';

const stories: SprintStory[] = [
  { storyId: 1, title: 'Rework login flow', featureId: 100 },
  { storyId: 2, title: 'Payment retries', featureId: 200 },
  { storyId: 3, title: 'Login audit log', featureId: 100 },
];

describe('repo-link boost in story matching', () => {
  it('lifts stories under a linked feature above unrelated ones', () => {
    const r = matchStoryToContext({ cwd: '/home/x/some-unrelated-name' }, stories, [200]);
    expect(r.allStories[0].storyId).toBe(2);
    expect(r.allStories[0].hitTokens).toContain('(repo-link)');
    // Boost alone clears the confidence threshold when nothing else scores.
    expect(r.topMatch?.storyId).toBe(2);
  });

  it('changes nothing without linked ids', () => {
    const r = matchStoryToContext({ cwd: '/home/x/some-unrelated-name' }, stories);
    expect(r.allStories.every(s => !s.hitTokens.includes('(repo-link)'))).toBe(true);
  });

  it('two stories under the same linked feature: equal scores, title decides', () => {
    const r = matchStoryToContext({ cwd: '/home/x/login-service' }, stories, [100]);
    // #1 and #3 both get the boost and both hit "login", so they tie on score
    // and the title sort puts "Login audit log" ahead of "Rework login flow".
    expect(r.allStories.map(s => s.storyId)).toEqual([3, 1, 2]);
    expect(r.allStories[0].score).toBe(r.allStories[1].score);
    expect(r.allStories[1].hitTokens).toContain('(repo-link)');
  });

  it('lifts a story the repo named directly, with no feature above it', () => {
    const loose: SprintStory[] = [
      { storyId: 7, title: 'Tidy the runner' },
      { storyId: 8, title: 'Rename the queue' },
    ];
    const r = matchStoryToContext({ cwd: '/home/x/nothing-alike' }, loose, [], [8]);
    expect(r.allStories[0].storyId).toBe(8);
    expect(r.allStories[0].hitTokens).toContain('(repo-link)');
    expect(r.topMatch?.storyId).toBe(8);
  });

  it('a story listed both ways is boosted once, not twice', () => {
    const r = matchStoryToContext({ cwd: '/home/x/nothing-alike' }, stories, [200], [2]);
    expect(r.allStories[0].storyId).toBe(2);
    expect(r.allStories[0].score).toBe(6);
  });
});
