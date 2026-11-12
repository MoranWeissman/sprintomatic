/**
 * Rings and bars that show counts split by state. One colour per state,
 * the same everywhere: in work, not started, stuck, done.
 */
import type { ReactNode } from 'react';

export type GaugeState = 'work' | 'wait' | 'stuck' | 'done';
export type GaugePart = { state: GaugeState; count: number };

/** A ring split into pieces, one per state, with a label in the middle. */
export function Ring({
  parts,
  size = 64,
  width = 6,
  total: totalIn,
  children,
}: {
  parts: GaugePart[];
  size?: number;
  width?: number;
  /** What a full ring stands for. Default: the parts added up. */
  total?: number;
  children?: ReactNode;
}) {
  const r = (size - width) / 2;
  const c = 2 * Math.PI * r;
  const shown = parts.filter(p => p.count > 0);
  const total = totalIn ?? shown.reduce((s, p) => s + p.count, 0);
  const gap = shown.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <span className="g-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="g-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={width} />
        {total > 0 &&
          shown.map(p => {
            const len = (c * p.count) / total;
            const el = (
              <circle
                key={p.state}
                className={`g-ring-part g-${p.state}`}
                cx={size / 2}
                cy={size / 2}
                r={r}
                strokeWidth={width}
                strokeDasharray={`${Math.max(len - gap, 0.1)} ${c}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      {children != null && <span className="g-ring-label">{children}</span>}
    </span>
  );
}

/** A ring that fills to a share (0..1) in one state colour. */
export function ShareRing({
  share,
  state,
  size = 200,
  width = 12,
  children,
}: {
  share: number;
  state: GaugeState;
  size?: number;
  width?: number;
  children?: ReactNode;
}) {
  const s = Math.max(0, Math.min(1, share));
  return (
    <Ring parts={[{ state, count: s }]} total={1} size={size} width={width}>
      {children}
    </Ring>
  );
}

/** A flat bar split into pieces, one per state. */
export function SegBar({ parts }: { parts: GaugePart[] }) {
  return (
    <span className="g-seg" aria-hidden="true">
      {parts.filter(p => p.count > 0).map(p => (
        <span key={p.state} className={`g-${p.state}`} style={{ flex: p.count }} />
      ))}
    </span>
  );
}

/** Hours spent against a guess, as a bar. Past the guess turns it stuck-red. */
export function HoursBar({ spent, guess }: { spent: number; guess: number | null }) {
  const pct = guess && guess > 0 ? Math.min(100, (spent / guess) * 100) : 0;
  const over = guess != null && guess > 0 && spent > guess;
  return (
    <span className="g-hbar" aria-hidden="true">
      <span className={over ? 'g-stuck' : 'g-work'} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** "3h 10m", "45m", "0m". */
export function fmtHours(seconds: number): string {
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
