import { describe, it, expect } from 'vitest';
import { hoursAnswer } from './hoursAnswer';

const H = 3600;

describe('hoursAnswer', () => {
  it('says spent, guess and what is left in one line', () => {
    expect(hoursAnswer({ loggedSeconds: 7 * H, guessHours: 8, leftHours: 1 })).toBe('7h spent of an 8h guess · about 1h left');
  });

  it('uses "a" before most numbers', () => {
    expect(hoursAnswer({ loggedSeconds: 2 * H + 30 * 60, guessHours: 4, leftHours: 1.5 })).toBe('2h 30m spent of a 4h guess · about 1.5h left');
  });

  it('drops the left half once past the guess', () => {
    expect(hoursAnswer({ loggedSeconds: 9 * H, guessHours: 8, leftHours: 1 })).toBe('9h spent of an 8h guess');
  });

  it('drops the left half when the board hours are past the guess, like the over-estimate line', () => {
    expect(hoursAnswer({ loggedSeconds: 2 * H, guessHours: 8, leftHours: 1, completedHours: 9 })).toBe('2h spent of an 8h guess');
  });

  it('drops the left half when the board has no hours left set', () => {
    expect(hoursAnswer({ loggedSeconds: 3 * H, guessHours: 6, leftHours: null })).toBe('3h spent of a 6h guess');
  });

  it('says there is no guess yet', () => {
    expect(hoursAnswer({ loggedSeconds: 45 * 60, guessHours: null, leftHours: null })).toBe('45m spent · no guess yet');
    expect(hoursAnswer({ loggedSeconds: 45 * 60, guessHours: 0, leftHours: null })).toBe('45m spent · no guess yet');
  });

  it('still says what is left with no guess', () => {
    expect(hoursAnswer({ loggedSeconds: H, guessHours: null, leftHours: 2 })).toBe('1h spent · about 2h left');
  });
});
