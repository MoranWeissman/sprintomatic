import { describe, it, expect } from 'vitest';
import { describeEditOutcome } from './edit-outcome';

describe('describeEditOutcome', () => {
  it('says nothing when the very first write failed', () => {
    const r = describeEditOutcome(['title', 'remainingWork'], {});
    expect(r.landed).toEqual([]);
    expect(r.message).toBeNull();
  });

  it('names both halves when an edit stopped part-way', () => {
    const r = describeEditOutcome(
      ['title', 'state', 'remainingWork'],
      { title: 'New title', state: 'Active' },
    );
    expect(r.landed).toEqual(['title', 'state']);
    expect(r.missed).toEqual(['remainingWork']);
    expect(r.message).toContain('Changed on the board: title, state.');
    expect(r.message).toContain('Not changed: remainingWork.');
  });

  it('leaves storyPoints out — it rides along with effort, nobody asked for it', () => {
    const r = describeEditOutcome(
      ['effort', 'tags'],
      { effort: 16, storyPoints: 2 },
    );
    expect(r.landed).toEqual(['effort']);
    expect(r.missed).toEqual(['tags']);
    expect(r.message).not.toContain('storyPoints');
  });

  it('an effort-only write that rode along still counts as something landing', () => {
    const r = describeEditOutcome(['effort', 'iterationPath'], { effort: 8, storyPoints: 1 });
    expect(r.message).not.toBeNull();
  });

  it('storyPoints alone reads as nothing landed', () => {
    // Cannot happen today (effort is written first, in the same call), but if
    // it ever did, the reply must not claim a field the user never asked for.
    const r = describeEditOutcome(['effort'], { storyPoints: 3 });
    expect(r.landed).toEqual([]);
    expect(r.message).toBeNull();
  });

  it('reports nothing missed when every asked-for field landed', () => {
    const r = describeEditOutcome(['title'], { title: 'x' });
    expect(r.missed).toEqual([]);
    expect(r.message).toContain('Not changed: .');
  });

  it('a field that landed but was never asked for does not turn up as missed', () => {
    const r = describeEditOutcome(['title'], { title: 'x', description: 'y' });
    expect(r.landed).toEqual(['title', 'description']);
    expect(r.missed).toEqual([]);
  });
});
