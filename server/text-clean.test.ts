// server/text-clean.test.ts
import { describe, it, expect } from 'vitest';
import { stripToolCallJunk } from './text-clean';

describe('stripToolCallJunk', () => {
  it('leaves clean text alone', () => {
    expect(stripToolCallJunk('Wrote the parser and the test for it.')).toBe('Wrote the parser and the test for it.');
    expect(stripToolCallJunk('  trims the edges  ')).toBe('trims the edges');
    expect(stripToolCallJunk('')).toBe('');
  });

  it('keeps a lone < and normal HTML-ish bits', () => {
    expect(stripToolCallJunk('a < b, so the check passed')).toBe('a < b, so the check passed');
    expect(stripToolCallJunk('the <b>bold</b> word stays')).toBe('the <b>bold</b> word stays');
    expect(stripToolCallJunk('5 < 6 > 4')).toBe('5 < 6 > 4');
  });

  it('cuts the live sample down to the real text', () => {
    const live = 'Split the parser out into its own file.</text>\n<parameter name="remainingHoursAfter">2';
    expect(stripToolCallJunk(live)).toBe('Split the parser out into its own file.');
  });

  it('cuts at a parameter tag that starts mid-text', () => {
    expect(stripToolCallJunk('done for today <parameter name="x">3')).toBe('done for today');
  });

  it('cuts at the other leaked tags too', () => {
    expect(stripToolCallJunk('all good</standupSummary> junk')).toBe('all good');
    expect(stripToolCallJunk('ask him this</question> junk')).toBe('ask him this');
    // </body> is NOT a cut point on purpose — the HTML demo pages are a real
    // topic in session logs ("fixed the missing </body> tag").
    expect(stripToolCallJunk('fixed the missing </body> tag')).toBe('fixed the missing </body> tag');
    expect(stripToolCallJunk('a nudge</parameter> junk')).toBe('a nudge');
    expect(stripToolCallJunk('the note <invoke name="foo">')).toBe('the note');
    expect(stripToolCallJunk('the note </invoke>')).toBe('the note');
  });

  it('does not care about upper or lower case', () => {
    expect(stripToolCallJunk('real text</TEXT>\n<PARAMETER NAME="x">1')).toBe('real text');
    expect(stripToolCallJunk('real text<Parameter  Name="x">1')).toBe('real text');
  });
});
