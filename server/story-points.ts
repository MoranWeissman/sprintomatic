/**
 * Story Points are a derived view of Effort (hours), never independently entered.
 *
 *   pointsAsDays = effortHours / workdayHours
 *   storyPoints  = round(pointsAsDays * 2) / 2     // nearest half-point
 *
 * Workday hours come from ./user-config (`getWorkdayHours`). Capacity math
 * reads from the same source so effort and capacity can never disagree about
 * a "day."
 */

/**
 * Derive Story Points from Effort hours. Rounds to the nearest 0.5 so the
 * board still reads as "Nd" in half-day increments. Negative effort clamps
 * to 0.
 */
export function deriveStoryPoints(effortHours: number, workdayHours: number): number {
  if (!Number.isFinite(effortHours) || effortHours <= 0) return 0;
  if (!Number.isFinite(workdayHours) || workdayHours <= 0) return 0;
  const days = effortHours / workdayHours;
  return Math.round(days * 2) / 2;
}
