/**
 * The release check: finds private words in the files that would go into the
 * public repo. Pure — the caller reads the files and the word list.
 *
 * The word list itself is private (it names the user's employer, org and
 * tenant), so it never lives in the repo. It sits next to the data home and
 * the CLI in scripts/release-scan.ts reads it from there.
 */

export interface ScanRule {
  label: string;
  test: RegExp;
}

export interface ScanHit {
  label: string;
  path: string;
  line: number;
  text: string;
}

/**
 * Paths that stay in the private repo and never get exported: the design
 * history, the files about this repo's own history and its owner, and the
 * script that builds the public copy.
 * Entries ending in "/" are folders; the rest are exact file paths.
 */
const NOT_EXPORTED = ['docs/superpowers/', 'CLAUDE.md', 'docs/oss-roadmap.md', 'docs/post-review-roadmap.md', 'scripts/export.ts'];

export function isExported(path: string): boolean {
  return !NOT_EXPORTED.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/** One term per line. Blank lines and `#` comments are skipped. */
export function parseWordList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Words match anywhere, any case. Numbers (real ticket ids) match only as a
 * whole number, so `100001` does not fire inside `1100001`. A line starting
 * with `re:` is a regular expression, for shapes like "every id this board
 * hands out".
 */
export function rulesFromWords(words: string[]): ScanRule[] {
  return words.map((w) => ({
    label: w,
    test: w.startsWith('re:')
      ? new RegExp(w.slice(3))
      : /^\d+$/.test(w)
        ? new RegExp(`(?<!\\d)${w}(?!\\d)`)
        : new RegExp(escape(w), 'i'),
  }));
}

/** Leaks that need no word list: any home folder path, any real email address. */
export const BUILT_IN_RULES: ScanRule[] = [
  { label: 'home folder path', test: /\/Users\/[A-Za-z]/ },
  {
    label: 'email address',
    test: /(?<![\w.+-])(?!git@)[\w.+-]+@(?!example\.(?:com|org)\b|anthropic\.com\b|users\.noreply\.github\.com\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
  },
];

/**
 * A line carrying this mark is skipped. Only for lines that MUST look like a
 * leak, such as this check's own tests. Every use is easy to grep for.
 */
const OK_MARK = /release-scan: ok/;

export function scanFiles(files: { path: string; text: string }[], rules: ScanRule[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((text, i) => {
      for (const r of rules) {
        if (OK_MARK.test(text)) continue;
        if (r.test.test(text)) hits.push({ label: r.label, path: f.path, line: i + 1, text: text.trim() });
      }
    });
  }
  return hits;
}
