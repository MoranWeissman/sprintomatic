/**
 * The speed bump for starting work on a task that has no hours estimate.
 *
 * task_create allows "estimate later" (0 hours), which leaves Original
 * Estimate blank. That is fine while a task waits in the backlog, but once
 * work starts the board needs a number to compare the real hours against.
 * So session_start stops and asks first, unless the caller brings the
 * estimate along. Only Tasks — bugs and other types don't carry hours here.
 * Pure — the caller reads the board.
 */
export function missingEstimateRefusal(args: {
  displayName: string;
  type: string;
  originalEstimate: number | null | undefined;
  estimateHours: number | undefined;
}): string | null {
  const { displayName, type, originalEstimate, estimateHours } = args;
  if (type.trim().toLowerCase() !== 'task') return null;
  if (originalEstimate != null && originalEstimate > 0) return null;
  if (estimateHours != null && estimateHours > 0) return null;
  return `${displayName} has no hours estimate yet. Before starting, call estimate_anchor to see how similar tasks went, propose a number to the user, and when they agree call session_start again with estimateHours set to it. That fills in the Original Estimate (and the hours left, if blank). Nothing was started.`;
}
