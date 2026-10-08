import { describe, it, expect } from 'vitest';
import { buildNotePrompt } from './notePrompt';

describe('buildNotePrompt', () => {
  it('wraps the note body in a deal-with-this prompt', () => {
    const out = buildNotePrompt('**Review rules model** (#100906) has gone quiet — update Remaining.', '');
    expect(out).toContain('Help me deal with this note from my sprint helper:');
    expect(out).toContain('"**Review rules model** (#100906) has gone quiet — update Remaining."');
    expect(out).toContain("Let's talk it through and take care of it.");
  });

  it('folds in the extra line when present', () => {
    const out = buildNotePrompt('Task X has gone quiet.', 'I think it should move to next sprint.');
    expect(out).toContain('I think it should move to next sprint.');
  });

  it('omits the extra line entirely when blank or whitespace', () => {
    const out = buildNotePrompt('Task X has gone quiet.', '   ');
    expect(out).not.toMatch(/\n\s*\n\s*\n/); // no empty gap left where the extra line would be
    expect(out.trim().endsWith("Let's talk it through and take care of it.")).toBe(true);
  });
});
