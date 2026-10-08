import { useCallback, useEffect, useState } from 'react';
import type { ModeId } from './api';

const MODES: ModeId[] = ['day', 'plan', 'demo', 'retro', 'dnd'];
const DEFAULT_MODE: ModeId = 'day';

function modeFromUrl(): ModeId {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const m = new URL(window.location.href).searchParams.get('mode');
  return MODES.includes(m as ModeId) ? (m as ModeId) : DEFAULT_MODE;
}

/**
 * Workspace mode state, synced to the `?mode=` query param so deep-links work
 * and the back button moves between modes naturally.
 */
export function useMode(): [ModeId, (next: ModeId) => void] {
  const [mode, setModeState] = useState<ModeId>(modeFromUrl);

  useEffect(() => {
    const handler = () => setModeState(modeFromUrl());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const setMode = useCallback((next: ModeId) => {
    if (!MODES.includes(next)) return;
    setModeState(next);
    const url = new URL(window.location.href);
    if (next === DEFAULT_MODE) url.searchParams.delete('mode');
    else url.searchParams.set('mode', next);
    window.history.pushState(null, '', url.toString());
  }, []);

  return [mode, setMode];
}
