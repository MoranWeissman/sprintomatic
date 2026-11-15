import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards for the 2026-11 type scale: the small sizes all come from the
// --fs-* tokens, so no raw px sizes under 18px, no half-pixel steps, and
// small text (11px) never pairs with the faintest grey (--ink-4).
const css = readFileSync(fileURLToPath(new URL('./dashboard.css', import.meta.url)), 'utf8');

describe('dashboard.css type scale', () => {
  it('uses tokens for every font size under 18px', () => {
    const raw = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
    expect(raw.filter(n => n < 18)).toEqual([]);
  });

  it('has no half-pixel font sizes', () => {
    expect(css.match(/font-size:\s*\d+\.\d+px/g)).toBeNull();
  });

  it('never puts 11px text in the faintest grey', () => {
    const bad = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => /font-size: var\(--fs-label\)/.test(m[2]) && /color: var\(--ink-4\)/.test(m[2]))
      .map(m => m[1].trim());
    expect(bad).toEqual([]);
  });

  it('has a reduced-motion rule that turns off animation everywhere', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{\s*animation: none !important;/);
  });
});
