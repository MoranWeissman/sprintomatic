import type { CSSProperties, ReactNode } from 'react';

interface MonoProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Mono({ children, className = '', style }: MonoProps) {
  return (
    <span className={`mono ${className}`.trim()} style={style}>
      {children}
    </span>
  );
}
