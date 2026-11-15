/**
 * A helper note is written once, but numbers in it ("3 hours left") go out of
 * date as the sprint moves. When a note with numbers is a day old or more,
 * this returns a plain line saying so. Ticket ids (#123) don't count as numbers.
 */
export function oldNoteLine(body: string, createdAt: string, now: Date = new Date()): string | null {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days < 1) return null;
  if (!/\d/.test(body.replace(/#\d+/g, ''))) return null;
  const when = days === 1 ? 'yesterday' : `${days} days ago`;
  return `Written ${when}, so its numbers may be out of date.`;
}
