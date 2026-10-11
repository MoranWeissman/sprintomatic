/**
 * Azure DevOps writes a sprint's start and finish as midnight UTC of a
 * calendar day ("2026-10-05T00:00:00Z"). That is a date, not a moment.
 * `new Date()` on it gives the evening before for anyone west of UTC, so the
 * sprint would start a day early. Read it as local midnight of that day.
 *
 * Plain code with no imports: the dashboard page uses it too.
 */
export function sprintDate(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
