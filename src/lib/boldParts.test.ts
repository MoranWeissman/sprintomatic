import { describe, expect, it } from 'vitest';
import { boldParts } from './boldParts';

describe('boldParts', () => {
  it('turns **marks** into bold parts', () => {
    expect(boldParts('**Example task** (#100001) is late')).toEqual([
      { text: 'Example task', bold: true },
      { text: ' (#100001) is late', bold: false },
    ]);
  });

  it('leaves plain text and a lone star alone', () => {
    expect(boldParts('5 * 2 hours')).toEqual([{ text: '5 * 2 hours', bold: false }]);
  });
});
