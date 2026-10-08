import type { ModeId } from '../lib/api';
import { ModeGlyph } from './ModeGlyphs';

const COPY: Record<Exclude<ModeId, 'day' | 'dnd' | 'retro'>, { title: string; line: string; slice: string }> = {
  plan: {
    title: 'Plan',
    line: 'Drag candidate stories into the next sprint, estimate inline, watch capacity run out.',
    slice: 'Coming in slice 4d',
  },
  demo: {
    title: 'Demo',
    line: 'Everything you closed this sprint, grouped and draggable into a presentation order.',
    slice: 'Coming in slice 4b — up next',
  },
};

export function ModePlaceholder({ mode }: { mode: Exclude<ModeId, 'day' | 'dnd' | 'retro'> }) {
  const copy = COPY[mode];
  return (
    <div className="mode-placeholder">
      <div className="mode-placeholder-card">
        <span className="mode-placeholder-icon">
          <ModeGlyph mode={mode} />
        </span>
        <h2 className="mode-placeholder-title">{copy.title}</h2>
        <p className="mode-placeholder-line">{copy.line}</p>
        <p className="mode-placeholder-slice">{copy.slice}</p>
      </div>
    </div>
  );
}
