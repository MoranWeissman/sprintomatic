import { describe, it, expect } from 'vitest';
import { chipWord } from './prWait';

describe('chipWord', () => {
  it('says waiting for PR when the tag is on an open task', () => {
    expect(chipWord('work', 'in work', ['Waiting for PR'])).toBe('waiting for PR');
    expect(chipWord('wait', 'not started', ['waiting for pr'])).toBe('waiting for PR');
  });
  it('keeps the usual word for done or stuck tasks, or no tag', () => {
    expect(chipWord('done', 'done', ['Waiting for PR'])).toBe('done');
    expect(chipWord('stuck', 'stuck', ['Waiting for PR'])).toBe('stuck');
    expect(chipWord('work', 'in work', ['Other'])).toBe('in work');
    expect(chipWord('work', 'in work')).toBe('in work');
  });
});
