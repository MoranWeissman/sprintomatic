import { describe, it, expect } from 'vitest';
import { noGuessLine } from './noGuess';

describe('noGuessLine', () => {
  it('says nothing when every open task has a guess', () => {
    expect(noGuessLine(0)).toBeNull();
  });
  it('names one task or many', () => {
    expect(noGuessLine(1)).toBe("1 open task has no guess, so it isn't in this number.");
    expect(noGuessLine(3)).toBe("3 open tasks have no guess, so they aren't in this number.");
  });
});
