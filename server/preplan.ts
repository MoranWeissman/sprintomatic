/**
 * Sprint goals for the Plan page — local only, never written to Azure DevOps.
 * Saved per sprint in the settings table under `preplan_<sprint>` (the key
 * name is kept so goals saved before still load).
 */

import { getSetting, setSetting } from './timers';
import { buildDashboardCached } from './dashboard-cache';

export interface PrePlanGoal {
  text: string;
  owner: string | null;
  isMine: boolean;
}

export function prePlanSettingsKey(sprintName: string): string {
  return `preplan_${sprintName}`;
}

/**
 * Coerce stored goals into PrePlanGoal[]. Accepts the legacy `string[]` shape
 * (each string → {text, owner:null, isMine:false}) and partial/full records.
 * Drops entries with empty text. Anything not an array → [].
 */
export function normalizeGoals(raw: unknown): PrePlanGoal[] {
  if (!Array.isArray(raw)) return [];
  const out: PrePlanGoal[] = [];
  for (const g of raw) {
    if (typeof g === 'string') {
      const text = g.trim();
      if (text) out.push({ text, owner: null, isMine: false });
    } else if (g && typeof g === 'object' && typeof (g as { text?: unknown }).text === 'string') {
      const text = (g as { text: string }).text.trim();
      if (!text) continue;
      const owner = (g as { owner?: unknown }).owner;
      out.push({
        text,
        owner: typeof owner === 'string' && owner.trim() ? owner.trim() : null,
        isMine: (g as { isMine?: unknown }).isMine === true,
      });
    }
  }
  return out;
}

export function getGoals(sprintName: string): PrePlanGoal[] {
  const raw = getSetting(prePlanSettingsKey(sprintName));
  if (!raw) return [];
  try {
    return normalizeGoals((JSON.parse(raw) as { goals?: unknown }).goals);
  } catch {
    return [];
  }
}

/** Replaces the sprint's whole goal list. */
export function saveGoals(sprintName: string, goals: PrePlanGoal[]): void {
  setSetting(prePlanSettingsKey(sprintName), JSON.stringify({ goals }));
}

export async function currentSprintGoals(): Promise<{ sprintName: string; goals: PrePlanGoal[] }> {
  const { payload } = await buildDashboardCached();
  const sprintName = payload.sprint?.name ?? '';
  return { sprintName, goals: getGoals(sprintName) };
}
