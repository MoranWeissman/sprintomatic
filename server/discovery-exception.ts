// server/discovery-exception.ts
/**
 * Remembers which stories were the deliberate "discover a single story instead
 * of the whole feature" exception, so a later look-back sees it was a conscious
 * one-off. Settings-backed, defensively parsed — mirrors getManagedFeatureIds
 * in server/workspace.ts. The spoken confirm is driven by the seeded skill; the
 * code only remembers the flagged ids.
 */
import { getSetting, setSetting } from './timers';

const DISCOVERY_STORY_EXCEPTIONS_KEY = 'discovery_story_exceptions';

export function getStoryExceptions(): number[] {
  const raw = getSetting(DISCOVERY_STORY_EXCEPTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];
  } catch {
    return [];
  }
}

export function recordStoryException(storyId: number): void {
  const ids = getStoryExceptions();
  if (!ids.includes(storyId)) {
    ids.push(storyId);
    setSetting(DISCOVERY_STORY_EXCEPTIONS_KEY, JSON.stringify(ids));
  }
}

export function isStoryException(storyId: number): boolean {
  return getStoryExceptions().includes(storyId);
}
