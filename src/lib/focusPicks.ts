/** Focus can show 1–4 self-chosen panels. This owns the sticky pick list. */
export const MAX_FOCUS_PANELS = 4;

const KEY = 'sh.focus.picks';
const LEGACY_KEY = 'sh.focus.pick';

/** Parse the stored list; migrate a single legacy pick; clamp to the max. */
export function readFocusPicks(raw: string | null, legacy: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_FOCUS_PANELS);
      }
    } catch {
      /* fall through to empty */
    }
    return [];
  }
  if (legacy) return [legacy];
  return [];
}

export function loadFocusPicks(): string[] {
  try {
    return readFocusPicks(localStorage.getItem(KEY), localStorage.getItem(LEGACY_KEY));
  } catch {
    return [];
  }
}

export function writeFocusPicks(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX_FOCUS_PANELS)));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* private-mode storage — in-memory state still drives this render */
  }
}

/** Keep only still-live picks, preserving the user's chosen order. */
export function reconcilePicks(picks: string[], liveIds: string[]): string[] {
  const live = new Set(liveIds);
  return picks.filter(id => live.has(id));
}
