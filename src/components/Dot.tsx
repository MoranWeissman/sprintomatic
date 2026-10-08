import type { CSSProperties } from 'react';

interface DotProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export function Dot({ size = 4, color = 'currentColor', style }: DotProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        ...style,
      }}
    />
  );
}
