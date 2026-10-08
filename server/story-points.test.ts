import { describe, it, expect } from 'vitest';
import { deriveStoryPoints } from './story-points';

describe('deriveStoryPoints', () => {
  it('treats one workday of effort as one point', () => {
    expect(deriveStoryPoints(9, 9)).toBe(1);
    expect(deriveStoryPoints(18, 9)).toBe(2);
    expect(deriveStoryPoints(45, 9)).toBe(5);
  });

  it('rounds to the nearest half point', () => {
    expect(deriveStoryPoints(13.5, 9)).toBe(1.5); // exactly 1.5 days
    expect(deriveStoryPoints(6, 9)).toBe(0.5); // 0.667 days -> 0.5
    expect(deriveStoryPoints(11, 9)).toBe(1); // 1.22 days -> 1.0
    expect(deriveStoryPoints(4, 9)).toBe(0.5); // 0.44 days -> 0.5
  });

  it('respects a non-default workday length', () => {
    expect(deriveStoryPoints(8, 8)).toBe(1);
    expect(deriveStoryPoints(4, 8)).toBe(0.5);
  });

  it('returns 0 for non-positive or invalid input', () => {
    expect(deriveStoryPoints(0, 9)).toBe(0);
    expect(deriveStoryPoints(-5, 9)).toBe(0);
    expect(deriveStoryPoints(Number.NaN, 9)).toBe(0);
    expect(deriveStoryPoints(9, 0)).toBe(0);
    expect(deriveStoryPoints(9, -1)).toBe(0);
  });
});
