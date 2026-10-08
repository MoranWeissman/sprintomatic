import { describe, it, expect } from 'vitest';
import { BUILT_IN_RULES, isExported, parseWordList, rulesFromWords, scanFiles } from './release-scan';

describe('parseWordList', () => {
  it('skips blank lines and comments, trims the rest', () => {
    expect(parseWordList('# employer\n  Acme Corp  \n\n100001\n')).toEqual(['Acme Corp', '100001']);
  });
});

describe('rulesFromWords', () => {
  it('matches a word in any case', () => {
    const hits = scanFiles([{ path: 'a.ts', text: 'built at ACME corp' }], rulesFromWords(['acme corp']));
    expect(hits).toHaveLength(1);
  });

  it('matches a word with regex characters literally', () => {
    const [rule] = rulesFromWords(['IDP - Dev.Ops']);
    expect(rule.test.test('IDP - DevXOps')).toBe(false);
    expect(rule.test.test('in IDP - Dev.Ops today')).toBe(true);
  });

  it('matches a ticket id only as a whole number', () => {
    const [rule] = rulesFromWords(['100001']);
    expect(rule.test.test('see #100001')).toBe(true);
    expect(rule.test.test('id-100001x')).toBe(true);
    expect(rule.test.test('1100001')).toBe(false);
    expect(rule.test.test('1000012')).toBe(false);
  });

  it('treats a re: line as a regular expression', () => {
    const [rule] = rulesFromWords(['re:\\b9\\d{5}\\b']);
    expect(rule.test.test('see #900123')).toBe(true);
    expect(rule.test.test('see #100123')).toBe(false);
  });
});

describe('built-in rules', () => {
  const scan = (text: string) => scanFiles([{ path: 'a.ts', text }], BUILT_IN_RULES);

  it('catches a home folder path', () => {
    expect(scan("const p = '/Users/someone/projects'")[0].label).toBe('home folder path'); // release-scan: ok
  });

  it('catches a real email address', () => {
    expect(scan('owner: someone@acme.io')[0].label).toBe('email address'); // release-scan: ok
  });

  it('lets example and attribution addresses through', () => {
    expect(scan('someone@example.com')).toEqual([]);
    expect(scan("origin: 'git@github.com:o/r.git'")).toEqual([]);
    expect(scan('Co-Authored-By: Claude <noreply@anthropic.com>')).toEqual([]);
  });
});

describe('scanFiles', () => {
  it('reports the path and 1-based line of every hit', () => {
    const hits = scanFiles([{ path: 'x.md', text: 'fine\nAcme here\nfine' }], rulesFromWords(['acme']));
    expect(hits).toEqual([{ label: 'acme', path: 'x.md', line: 2, text: 'Acme here' }]);
  });
});

describe('isExported', () => {
  it('keeps the private design history out', () => {
    expect(isExported('docs/superpowers/specs/a.md')).toBe(false);
    expect(isExported('docs/configuration.md')).toBe(true);
  });

  it("keeps the repo's own notes out, but only those exact files", () => {
    expect(isExported('CLAUDE.md')).toBe(false);
    expect(isExported('docs/oss-roadmap.md')).toBe(false);
    expect(isExported('docs/post-review-roadmap.md')).toBe(false);
    expect(isExported('scripts/export.ts')).toBe(false);
    expect(isExported('server/CLAUDE.md.test.ts')).toBe(true);
  });
});
