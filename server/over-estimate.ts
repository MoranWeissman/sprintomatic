/**
 * "This task is going over" — the logged time on a task has passed its
 * estimate. Pure, so the dashboard and the chat nudge use the same rule.
 *
 * Logged time is the larger of the timer's total and the board's
 * Completed Work: the timer is the honest number while work goes on, and
 * the board number covers hours that were entered by hand.
 */
export interface OverEstimate {
  loggedHours: number;
  estimateHours: number;
}

const GRACE_HOURS = 0.25;

export function overEstimate(t: {
  originalEstimate?: number | null;
  completedWork?: number | null;
  loggedSeconds: number;
}): OverEstimate | null {
  const estimate = t.originalEstimate ?? 0;
  if (estimate <= 0) return null;
  const logged = Math.max(t.loggedSeconds / 3600, t.completedWork ?? 0);
  // A quarter hour of grace, so "2 hours against 2 hours" never shows up.
  if (logged - estimate < GRACE_HOURS) return null;
  return { loggedHours: roundHalf(logged), estimateHours: roundHalf(estimate) };
}

/** The plain words for it, shared by the task view and the chat. */
export function overEstimateText(o: OverEstimate): string {
  return `About ${o.loggedHours} hours logged against an estimate of ${o.estimateHours} hours.`;
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}
