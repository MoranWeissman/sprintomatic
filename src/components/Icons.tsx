import type { ReactElement } from 'react';

/**
 * Small line icons, the same drawn style as ModeGlyphs (currentColor stroke,
 * round ends). One size everywhere: 14px. Use these instead of unicode
 * arrows (▸ ▾ ↗ ↻) or emoji, so every icon looks like it belongs to one set.
 */
export type IconName = 'right' | 'down' | 'up' | 'left' | 'external' | 'refresh' | 'image';

const PATHS: Record<IconName, ReactElement> = {
  right: <path d="M6.5 4 L11 9 L6.5 14" />,
  down: <path d="M4 6.5 L9 11 L14 6.5" />,
  up: <path d="M4 11.5 L9 7 L14 11.5" />,
  left: <path d="M11.5 4 L7 9 L11.5 14" />,
  external: <path d="M7.5 4.5 H4.5 V13.5 H13.5 V10.5 M10 4 H14 V8 M14 4 L8.5 9.5" />,
  refresh: (
    <>
      <path d="M14.4 9 a5.4 5.4 0 1 1 -1.9 -4.1" />
      <path d="M14.5 3.8 v3 h-3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="12" height="10" rx="1.5" />
      <path d="M3.5 12.5 L7.5 8.5 L10.5 11.5 L12 10 L14.5 12.5" />
    </>
  ),
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
