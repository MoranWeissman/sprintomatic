import type { ReactElement } from 'react';
import type { ModeId } from '../lib/api';

/** Tiny SVG glyphs for each mode + the schedule gear. 18×18 box, currentColor stroke. */
const GLYPHS: Record<ModeId | 'gear', ReactElement> = {
  day: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="11" r="3.5" />
      <path d="M9 4.5 v1.6 M14.5 11 h-1.6 M5.1 11 h-1.6 M12.5 7.5 l1.1 -1.1 M5.5 7.5 l-1.1 -1.1" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <rect x="3.4" y="3.4" width="11.2" height="11.2" rx="1.2" />
      <path d="M5.8 7.2 h6.4 M5.8 10 h6.4 M5.8 12.8 h3.8" />
    </svg>
  ),
  demo: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 5.8 v6.4 l5.4 -3.2 z" />
    </svg>
  ),
  retro: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.4 9 a5.4 5.4 0 1 1 -1.9 -4.1" />
      <path d="M14.5 3.8 v3 h-3" />
    </svg>
  ),
  dnd: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="9" r="5.4" />
      <path d="M11.2 6.8 l-1.4 3.4 l-3.4 1.4 l1.4 -3.4 z" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="2.2" />
      <path d="M9 3.4 v1.6 M9 13 v1.6 M3.4 9 h1.6 M13 9 h1.6 M5.1 5.1 l1.1 1.1 M11.8 11.8 l1.1 1.1 M5.1 12.9 l1.1 -1.1 M11.8 6.2 l1.1 -1.1" />
    </svg>
  ),
};

export function ModeGlyph({ mode }: { mode: ModeId | 'gear' }) {
  return <span className="glyph">{GLYPHS[mode]}</span>;
}
